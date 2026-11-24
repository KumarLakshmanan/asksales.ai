/**
 * Social Follower Sync Service
 * 
 * Periodically syncs follower counts from Facebook, Twitter/X, and LinkedIn
 * via their respective APIs. Stores counts in channel_credentials.session_data.
 */

import { db } from '../models/db.js';
import { eq, and, sql } from 'drizzle-orm';
import { channelCredentialsTable } from '../models/channelCredentials/schema.js';
import { logger } from '../utils/logger.js';

// ─── Facebook Follower Sync ──────────────────────────────────────────────────

async function syncFacebookFollowersForUser(userId: number): Promise<{ followersCount: number | null; fanCount: number | null }> {
  try {
    const { FacebookMessengerService } = await import('./FacebookMessengerService.js');
    const service = new FacebookMessengerService();
    const initialized = await service.initializeForUser(userId);
    if (!initialized) return { followersCount: null, fanCount: null };

    const pageInfo = await service.getPageInfo();
    if (!pageInfo.success) {
      logger.warn({ userId, error: pageInfo.error }, '[SocialFollowerSync] Facebook page info fetch failed');
      return { followersCount: null, fanCount: null };
    }

    const followersCount = pageInfo.followersCount ?? null;
    const fanCount = pageInfo.fanCount ?? null;

    // Update session_data with follower counts
    await db.execute(sql`
      UPDATE channel_credentials
      SET session_data = COALESCE(session_data, '{}'::jsonb) || ${JSON.stringify({
        followersCount,
        fanCount,
        followersLastSyncedAt: new Date().toISOString(),
        pageName: pageInfo.name || undefined,
        pageCategory: pageInfo.category || undefined,
        pagePicture: pageInfo.picture || undefined,
      })}::jsonb,
      updated_at = NOW()
      WHERE user_id = ${userId} AND platform IN ('facebook_api', 'facebook') AND is_active = true
    `);

    // Also update account_name if not set
    if (pageInfo.name) {
      await db.execute(sql`
        UPDATE channel_credentials
        SET account_name = COALESCE(NULLIF(account_name, ''), ${pageInfo.name})
        WHERE user_id = ${userId} AND platform IN ('facebook_api', 'facebook') AND is_active = true AND (account_name IS NULL OR account_name = '')
      `);
    }

    logger.info({ userId, followersCount, fanCount }, '[SocialFollowerSync] Facebook followers synced');
    return { followersCount, fanCount };
  } catch (err) {
    logger.error({ err, userId }, '[SocialFollowerSync] Facebook sync error');
    return { followersCount: null, fanCount: null };
  }
}

// ─── Twitter/X Follower Sync ─────────────────────────────────────────────────

async function syncTwitterFollowersForUser(userId: number): Promise<{ followersCount: number | null }> {
  try {
    const { getTwitterApiForUser } = await import('./TwitterApiService.js');
    const service = await getTwitterApiForUser(userId);
    if (!service) return { followersCount: null };

    // Use the existing apiRequest to call /users/me with public_metrics
    // TwitterApiService.apiRequest is private, so we add a public method wrapper
    // Instead, use getUserByUsername with the stored username or call /users/me directly
    const creds = await db.select()
      .from(channelCredentialsTable)
      .where(and(
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.isActive, true),
      ))
      .limit(2);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const twitterCred = creds.find((c: any) => c.platform === 'twitter_api' || c.platform === 'twitter');
    if (!twitterCred?.accessToken) return { followersCount: null };

    // Call Twitter API v2 /users/me to get public_metrics
    const response = await fetch('https://api.x.com/2/users/me?user.fields=public_metrics,profile_image_url,description', {
      headers: {
        'Authorization': `Bearer ${twitterCred.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorData = await response.json().catch(() => null) as any;
      logger.warn({ userId, status: response.status, error: errorData }, '[SocialFollowerSync] Twitter API error');
      return { followersCount: null };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await response.json() as any;
    const publicMetrics = data.data?.public_metrics;
    const followersCount = publicMetrics?.followers_count ?? null;
    const followingCount = publicMetrics?.following_count ?? null;
    const tweetCount = publicMetrics?.tweet_count ?? null;
    const profileImageUrl = data.data?.profile_image_url ?? null;
    const description = data.data?.description ?? null;
    const username = data.data?.username ?? null;
    const name = data.data?.name ?? null;

    // Update session_data with follower counts and profile info
    await db.execute(sql`
      UPDATE channel_credentials
      SET session_data = COALESCE(session_data, '{}'::jsonb) || ${JSON.stringify({
        followersCount,
        followingCount,
        tweetCount,
        profileImageUrl,
        description,
        followersLastSyncedAt: new Date().toISOString(),
      })}::jsonb,
      updated_at = NOW()
      WHERE user_id = ${userId} AND platform IN ('twitter_api', 'twitter') AND is_active = true
    `);

    // Update account_name and account_identifier if available
    if (name || username) {
      await db.execute(sql`
        UPDATE channel_credentials
        SET account_name = COALESCE(NULLIF(account_name, ''), ${name || username}),
            account_identifier = COALESCE(NULLIF(account_identifier, ''), ${username || ''})
        WHERE user_id = ${userId} AND platform IN ('twitter_api', 'twitter') AND is_active = true AND (account_name IS NULL OR account_name = '')
      `);
    }

    logger.info({ userId, followersCount, followingCount }, '[SocialFollowerSync] Twitter followers synced');
    return { followersCount };
  } catch (err) {
    logger.error({ err, userId }, '[SocialFollowerSync] Twitter sync error');
    return { followersCount: null };
  }
}

// ─── LinkedIn Follower Sync ──────────────────────────────────────────────────

async function syncLinkedInFollowersForUser(userId: number): Promise<{ followersCount: number | null }> {
  try {
    const creds = await db.select()
      .from(channelCredentialsTable)
      .where(and(
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.isActive, true),
      ))
      .limit(2);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const linkedInCred = creds.find((c: any) => c.platform === 'linkedin_api' || c.platform === 'linkedin');
    if (!linkedInCred?.accessToken) return { followersCount: null };

    // First get the user's person URN
    const profileResponse = await fetch('https://api.linkedin.com/v2/me?fields=id,firstName,lastName', {
      headers: {
        'Authorization': `Bearer ${linkedInCred.accessToken}`,
        'LinkedIn-Version': '202401',
      },
    });

    if (!profileResponse.ok) {
      logger.warn({ userId, status: profileResponse.status }, '[SocialFollowerSync] LinkedIn profile fetch failed');
      return { followersCount: null };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profileData = await profileResponse.json() as any;
    const personId = profileData.id;
    if (!personId) return { followersCount: null };

    const firstName = profileData.firstName?.localized?.en_US || '';
    const lastName = profileData.lastName?.localized?.en_US || '';
    const fullName = `${firstName} ${lastName}`.trim();

    // Try to get network size (connections count) — requires r_network_size scope
    let connectionsCount: number | null = null;
    try {
      const networkResponse = await fetch(
        `https://api.linkedin.com/v2/networkSizes/urn:li:person:${personId}?edgeType=CompanyFollowedByMember`,
        {
          headers: {
            'Authorization': `Bearer ${linkedInCred.accessToken}`,
            'LinkedIn-Version': '202401',
          },
        }
      );

      if (networkResponse.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const networkData = await networkResponse.json() as any;
        connectionsCount = networkData.firstDegreeSize ?? null;
      }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (networkErr) {
      // LinkedIn may not grant this scope — non-blocking
      logger.info({ userId }, '[SocialFollowerSync] LinkedIn network size not available (scope may not be granted)');
    }

    // Try alternative: Get 1st-degree connections count
    if (connectionsCount === null) {
      try {
        const connResponse = await fetch(
          'https://api.linkedin.com/v2/connections?q=viewer&start=0&count=0',
          {
            headers: {
              'Authorization': `Bearer ${linkedInCred.accessToken}`,
              'LinkedIn-Version': '202401',
            },
          }
        );

        if (connResponse.ok) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const connData = await connResponse.json() as any;
          connectionsCount = connData._total ?? connData.paging?.total ?? null;
        }
      } catch {
        // Connections endpoint may also be restricted
      }
    }

    // Update session_data with profile info and connection count
    await db.execute(sql`
      UPDATE channel_credentials
      SET session_data = COALESCE(session_data, '{}'::jsonb) || ${JSON.stringify({
        followersCount: connectionsCount,
        personId,
        profileName: fullName,
        followersLastSyncedAt: new Date().toISOString(),
      })}::jsonb,
      updated_at = NOW()
      WHERE user_id = ${userId} AND platform IN ('linkedin_api', 'linkedin') AND is_active = true
    `);

    // Update account_name if not set
    if (fullName) {
      await db.execute(sql`
        UPDATE channel_credentials
        SET account_name = COALESCE(NULLIF(account_name, ''), ${fullName})
        WHERE user_id = ${userId} AND platform IN ('linkedin_api', 'linkedin') AND is_active = true AND (account_name IS NULL OR account_name = '')
      `);
    }

    logger.info({ userId, connectionsCount, personId }, '[SocialFollowerSync] LinkedIn connections synced');
    return { followersCount: connectionsCount };
  } catch (err) {
    logger.error({ err, userId }, '[SocialFollowerSync] LinkedIn sync error');
    return { followersCount: null };
  }
}

// ─── Public Sync Entrypoints (called by BullMQ workers) ─────────────────────

export async function processFacebookFollowerSync(): Promise<void> {
  try {
    const users = await db.select({ userId: channelCredentialsTable.userId })
      .from(channelCredentialsTable)
      .where(and(
        sql`${channelCredentialsTable.platform} IN ('facebook_api', 'facebook')`,
        eq(channelCredentialsTable.isActive, true)
      ));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uniqueUserIds = [...new Set(users.map((u: any) => u.userId).filter((id: any): id is number => id !== null))];
    if (uniqueUserIds.length === 0) return;

    // Limit to 50 users per cycle to avoid exceeding BullMQ job timeout
    const maxUsersPerCycle = 50;
    const userIdsToProcess = uniqueUserIds.slice(0, maxUsersPerCycle);
    if (uniqueUserIds.length > maxUsersPerCycle) {
      logger.warn({ total: uniqueUserIds.length, processing: maxUsersPerCycle }, '[SocialFollowerSync] Facebook sync limited per cycle');
    }

    logger.info({ userCount: userIdsToProcess.length }, '[SocialFollowerSync] Starting Facebook follower sync cycle');

    for (const userId of userIdsToProcess) {
      try {
        await syncFacebookFollowersForUser(userId as number);
      } catch (err) {
        logger.error({ err, userId }, '[SocialFollowerSync] Facebook sync error for user');
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (err) {
    logger.error({ err }, '[SocialFollowerSync] Facebook sync cycle failed');
  }
}

export async function processTwitterFollowerSync(): Promise<void> {
  try {
    const users = await db.select({ userId: channelCredentialsTable.userId })
      .from(channelCredentialsTable)
      .where(and(
        sql`${channelCredentialsTable.platform} IN ('twitter_api', 'twitter')`,
        eq(channelCredentialsTable.isActive, true)
      ));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uniqueUserIds = [...new Set(users.map((u: any) => u.userId).filter((id: any): id is number => id !== null))];
    if (uniqueUserIds.length === 0) return;

    const maxUsersPerCycle = 50;
    const userIdsToProcess = uniqueUserIds.slice(0, maxUsersPerCycle);
    if (uniqueUserIds.length > maxUsersPerCycle) {
      logger.warn({ total: uniqueUserIds.length, processing: maxUsersPerCycle }, '[SocialFollowerSync] Twitter sync limited per cycle');
    }

    logger.info({ userCount: userIdsToProcess.length }, '[SocialFollowerSync] Starting Twitter follower sync cycle');

    for (const userId of userIdsToProcess) {
      try {
        await syncTwitterFollowersForUser(userId as number);
      } catch (err) {
        logger.error({ err, userId }, '[SocialFollowerSync] Twitter sync error for user');
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (err) {
    logger.error({ err }, '[SocialFollowerSync] Twitter sync cycle failed');
  }
}

export async function processLinkedInFollowerSync(): Promise<void> {
  try {
    const users = await db.select({ userId: channelCredentialsTable.userId })
      .from(channelCredentialsTable)
      .where(and(
        sql`${channelCredentialsTable.platform} IN ('linkedin_api', 'linkedin')`,
        eq(channelCredentialsTable.isActive, true)
      ));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uniqueUserIds = [...new Set(users.map((u: any) => u.userId).filter((id: any): id is number => id !== null))];
    if (uniqueUserIds.length === 0) return;

    const maxUsersPerCycle = 50;
    const userIdsToProcess = uniqueUserIds.slice(0, maxUsersPerCycle);
    if (uniqueUserIds.length > maxUsersPerCycle) {
      logger.warn({ total: uniqueUserIds.length, processing: maxUsersPerCycle }, '[SocialFollowerSync] LinkedIn sync limited per cycle');
    }

    logger.info({ userCount: userIdsToProcess.length }, '[SocialFollowerSync] Starting LinkedIn follower sync cycle');

    for (const userId of userIdsToProcess) {
      try {
        await syncLinkedInFollowersForUser(userId as number);
      } catch (err) {
        logger.error({ err, userId }, '[SocialFollowerSync] LinkedIn sync error for user');
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } catch (err) {
    logger.error({ err }, '[SocialFollowerSync] LinkedIn sync cycle failed');
  }
}
