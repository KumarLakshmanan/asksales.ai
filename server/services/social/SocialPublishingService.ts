import { isDirectInstagramLogin } from '../../utils/instagramOAuthCredential.js';
/**
 * Social Publishing Service
 *
 * Publishes content to Facebook Page feeds and Instagram Business feeds
 * using the Meta Graph API (v25.0+).
 *
 * Supported post types:
 *  - Instagram: photo post, Reel, carousel
 *  - Facebook: text post, photo post, video post
 *
 * Credentials are loaded from channel_credentials table:
 *  - platform = 'instagram_api'  → Instagram publishing
 *  - platform = 'facebook_page'  → Facebook Page publishing
 *
 * Both use the Graph API via the same graphRequest() helper.
 */

import { db } from '../../models/db.js';
import { eq, and, sql, desc } from 'drizzle-orm';
import { channelCredentialsTable } from '../../models/channelCredentials/schema.js';
import { metaPageConnectionsTable } from '../../models/metaPageConnections/schema.js';
import { boundMetaPageToken, decryptMetaSecret, encryptMetaSecret } from '../../utils/metaCredentialSecrets.js';
import { getGraphApiVersion, getGraphApiBase } from '../../utils/metaApiVersion.js';
import { logger } from '../../utils/logger.js';
import { ChannelCredentialModel } from '../../models/channelCredentials/functions.js';
import type { InstagramPublishingOptions } from '../../utils/instagramPublishingOptions.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SocialPlatform = 'facebook' | 'instagram';

export type InstagramPostType = 'post' | 'reel' | 'carousel' | 'story';
export type FacebookPostType = 'text' | 'photo' | 'video';

export interface InstagramPublishInput extends InstagramPublishingOptions {
  /** Exact credential selected and approved by the user. */
  credentialId?: number;
  /** Account ID captured in the reviewed publish snapshot. */
  expectedAccountId?: string;
  postType: InstagramPostType;
  /** Required for post / first carousel image */
  imageUrls?: string[];
  /** Required for reel */
  videoUrl?: string;
  videoUrls?: string[];
  caption?: string;
  /** Cover image URL for Reels (optional) */
  coverUrl?: string;
  /** Thumbnail offset in seconds for Reels (optional) */
  thumbOffset?: number;
}

export interface FacebookPublishInput {
  /** Exact credential selected and approved by the user. */
  credentialId?: number;
  /** Page ID captured in the reviewed publish snapshot. */
  expectedAccountId?: string;
  postType: FacebookPostType;
  message?: string;
  /** Required for photo post */
  imageUrl?: string;
  imageUrls?: string[];
  /** Required for video post */
  videoUrl?: string;
  title?: string;
  description?: string;
}

export interface PublishResult {
  success: boolean;
  platformPostId?: string;   // e.g. Instagram media ID or Facebook post ID
  postUrl?: string;          // Direct URL to the published post
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  ambiguous?: boolean;
  providerRequestId?: string;
  retryAfterSeconds?: number;
}

// ─── Credential loaders ───────────────────────────────────────────────────────

type GraphHost = 'facebook' | 'instagram';
interface MetaCreds {
  graphHost?: GraphHost;
  credentialId: number;
  accessToken: string;
  accountId: string;         // Instagram Business Account ID or Facebook Page ID
  pageAccessToken?: string;  // Preferred token for page-level operations
  platform?: 'facebook_page' | 'facebook_api' | 'instagram_api';
}

async function loadInstagramCreds(userId: number, credentialId?: number): Promise<MetaCreds | null> {
  const r = credentialId
    ? await ChannelCredentialModel.findActiveAccountById(userId, 'instagram_api', credentialId)
    : await ChannelCredentialModel.findByUserAndPlatform(userId, 'instagram_api');
  if (!r) return null;
  return {
    credentialId: r.id,
    // Prefer the system user token (stored in access_token) which works for Instagram posting
    accessToken: decryptMetaSecret(r.accessToken),
    accountId: r.accountIdentifier || '',
    pageAccessToken: decryptMetaSecret(boundMetaPageToken(r) || r.accessToken),
    platform: 'instagram_api',
    graphHost: isDirectInstagramLogin(r) ? 'instagram' : 'facebook',
  };
}

async function loadFacebookPageCreds(userId: number, credentialId?: number): Promise<MetaCreds | null> {
  const rows = await db
    .select()
    .from(channelCredentialsTable)
    .where(
      and(
        eq(channelCredentialsTable.userId, userId),
        sql`${channelCredentialsTable.platform} IN ('facebook_page', 'facebook_api')`,
        eq(channelCredentialsTable.isActive, true),
        ...(credentialId ? [eq(channelCredentialsTable.id, credentialId)] : []),
      ),
    )
    .orderBy(desc(channelCredentialsTable.updatedAt))
    .limit(1);

  if (!rows[0]) return null;
  const r = rows[0];
  const [connection] = await db.select({ pageAccessToken: metaPageConnectionsTable.pageAccessToken })
    .from(metaPageConnectionsTable)
    .where(and(
      eq(metaPageConnectionsTable.userId, userId),
      eq(metaPageConnectionsTable.pageId, r.accountIdentifier || ''),
      eq(metaPageConnectionsTable.isActive, true),
      eq(metaPageConnectionsTable.facebookActive, true),
    ))
    .limit(1);
  const pageToken = decryptMetaSecret(boundMetaPageToken(r) || connection?.pageAccessToken || r.accessToken || '');
  return {
    credentialId: r.id,
    accessToken: pageToken,
    accountId: r.accountIdentifier || '',
    pageAccessToken: pageToken,
    platform: r.platform as 'facebook_page' | 'facebook_api',
  };
}

// ─── Core Graph API helper ────────────────────────────────────────────────────

interface GraphError {
  message: string;
  code: number;
  type: string;
  error_subcode?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function graphPost<T = any>(
  endpoint: string,
  params: Record<string, unknown>,
  graphHost: GraphHost = 'facebook',
): Promise<T> {
  const version = await getGraphApiVersion();
  const base = graphHost === 'instagram' ? `https://graph.instagram.com/${version}` : getGraphApiBase(version);
  const url = `${base}${endpoint}`;
  const { access_token: accessToken, ...requestBody } = params;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('Graph API access token is required');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new GraphTransportError(
      error instanceof Error ? error.message : 'Graph API request outcome is unknown',
    );
  }

  let data: T & { error?: GraphError };
  try {
    data = (await response.json()) as T & { error?: GraphError };
  } catch {
    throw new GraphTransportError('Graph API returned an unreadable response; provider outcome is unknown');
  }
  if (!response.ok || data?.error) {
    const err = data?.error;
    throw new GraphApiError(err?.message || `Graph API error: ${response.status} ${response.statusText}`, err);
  }
  // All publication/container writes in this adapter return an ID. A 2xx
  // response without it can still represent an accepted write, so quarantine
  // the outcome instead of making it eligible for another publication.
  const receipt = data as { id?: unknown; post_id?: unknown } | null;
  const hasId = typeof receipt?.id === 'string' && Boolean(receipt.id.trim());
  const hasPhotoPostId = endpoint.endsWith('/photos') && requestBody.published !== false
    && typeof receipt?.post_id === 'string' && Boolean(receipt.post_id.trim());
  if (!hasId && !hasPhotoPostId) {
    throw new GraphTransportError('Graph API accepted the request without a usable receipt; provider outcome is unknown');
  }
  return data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function graphGet<T = any>(
  endpoint: string,
  token: string,
  fields?: string,
  graphHost: GraphHost = 'facebook',
): Promise<T> {
  const version = await getGraphApiVersion();
  const base = graphHost === 'instagram' ? `https://graph.instagram.com/${version}` : getGraphApiBase(version);
  const url = new URL(`${base}${endpoint}`);
  if (fields) url.searchParams.set('fields', fields);

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json()) as T & { error?: GraphError };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!response.ok || (data as any).error) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = (data as any).error;
    throw new GraphApiError(err?.message || `Graph API GET error: ${response.status}`, err);
  }
  return data;
}

async function graphDelete<T = unknown>(endpoint: string, token: string): Promise<T> {
  const version = await getGraphApiVersion();
  const base = getGraphApiBase(version);
  let response: Response;
  try {
    response = await fetch(`${base}${endpoint}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new GraphTransportError(
      error instanceof Error ? error.message : 'Graph API delete outcome is unknown',
    );
  }
  let data: T & { error?: GraphError };
  try {
    data = await response.json() as T & { error?: GraphError };
  } catch {
    throw new GraphTransportError('Graph API returned an unreadable delete response; provider outcome is unknown');
  }
  if (!response.ok || data.error) {
    const error = data.error;
    throw new GraphApiError(error?.message || `Graph API delete error: ${response.status}`, error);
  }
  return data;
}

/**
 * Custom error class for Graph API errors with structured error info.
 */
class GraphApiError extends Error {
  code?: number;
  type?: string;
  errorSubcode?: number;
  isTokenError: boolean;

  constructor(message: string, error?: GraphError) {
    super(message);
    this.name = 'GraphApiError';
    this.code = error?.code;
    this.type = error?.type;
    this.errorSubcode = error?.error_subcode;
    // Token invalidation errors: code 190, subcodes 460 (password change), 463 (expired), 467 (invalid token)
    this.isTokenError = error?.code === 190 && [460, 463, 467].includes(error?.error_subcode ?? -1);
  }
}

class GraphTransportError extends Error {
  readonly ambiguous = true;
  constructor(message: string) {
    super(message);
    this.name = 'GraphTransportError';
  }
}

function failureResult(error: unknown): PublishResult {
  const err = error instanceof Error ? error : new Error(String(error));
  if (err instanceof GraphTransportError) {
    return {
      success: false,
      error: err.message,
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      ambiguous: true,
      retryable: false,
    };
  }
  if (err instanceof GraphApiError) {
    return {
      success: false,
      error: err.message,
      errorCode: err.code ? `META_${err.code}` : 'META_GRAPH_ERROR',
      retryable: err.code === 4 || err.code === 17 || err.code === 32 || err.code === 613,
      ambiguous: false,
    };
  }
  return {
    success: false,
    error: err.message,
    errorCode: 'PUBLISH_VALIDATION_ERROR',
    retryable: false,
    ambiguous: false,
  };
}

async function instagramPermalink(mediaId: string, token: string, graphHost: GraphHost = 'facebook'): Promise<string | undefined> {
  try {
    const media = await graphGet<{ permalink?: string }>(`/${mediaId}`, token, 'permalink', graphHost);
    return media.permalink;
  } catch (error) {
    logger.warn({ err: error, mediaId }, '[SocialPublishingService] Could not resolve Instagram permalink');
    return undefined;
  }
}

async function facebookPermalink(postId: string, token: string): Promise<string | undefined> {
  try {
    const post = await graphGet<{ permalink_url?: string }>(`/${postId}`, token, 'permalink_url');
    return post.permalink_url;
  } catch (error) {
    logger.warn({ err: error, postId }, '[SocialPublishingService] Could not resolve Facebook permalink');
    return undefined;
  }
}

/**
 * Attempt to refresh a Meta access token by exchanging it for a new long-lived token.
 * Returns the new token or null if refresh failed.
 */
async function attemptTokenRefresh(
  currentToken: string,
  userId: number,
  platform: 'instagram_api' | 'facebook_page' | 'facebook_api',
  credentialId: number,
): Promise<string | null> {
  try {
    if (platform === 'instagram_api') {
      const credential = await ChannelCredentialModel.findActiveAccountById(userId, platform, credentialId);
      if (isDirectInstagramLogin(credential)) {
        const { getInstagramApiForUser } = await import('../instagramGraphApiService.js');
        const service = await getInstagramApiForUser(userId, { credentialId });
        if (!service || !await service.refreshAccessToken()) return null;
        const refreshed = await ChannelCredentialModel.findActiveAccountById(userId, platform, credentialId);
        return refreshed ? decryptMetaSecret(refreshed.accessToken) : null;
      }
    }
    const { getActiveAdminCredential } = await import('../../models/adminApiCredentials/functions.js');
    const adminCred = await getActiveAdminCredential('meta_app');
    if (!adminCred?.apiKey || !adminCred?.apiSecret) {
      logger.warn('[SocialPublishingService] No Meta admin credentials for token refresh');
      return null;
    }

    const apiVersion = await getGraphApiVersion();
    const url = `https://graph.facebook.com/${apiVersion}/oauth/access_token`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: adminCred.apiKey,
        client_secret: adminCred.apiSecret,
        fb_exchange_token: currentToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();

    if (data.error || !data.access_token) {
      logger.warn({ error: data.error }, '[SocialPublishingService] Token refresh failed');
      return null;
    }

    // Update the credential in database
    const { channelCredentialsTable } = await import('../../models/channelCredentials/schema.js');
    const { eq: eqFn } = await import('drizzle-orm');

    await db
      .update(channelCredentialsTable)
      .set({
        accessToken: encryptMetaSecret(data.access_token),
        tokenExpiry: new Date(Date.now() + (data.expires_in || 5184000) * 1000),
        lastRefreshedAt: new Date(),
      })
      .where(
        and(
          eqFn(channelCredentialsTable.id, credentialId),
          eqFn(channelCredentialsTable.userId, userId),
          eqFn(channelCredentialsTable.platform, platform),
        ),
      );

    logger.info({ userId, platform }, '[SocialPublishingService] Token refreshed successfully');
    return data.access_token;
  } catch (err) {
    logger.error({ err, userId, platform }, '[SocialPublishingService] Token refresh exception');
    return null;
  }
}

// ─── Instagram publishing ─────────────────────────────────────────────────────

export function instagramContainerOptions(options: InstagramPublishingOptions, photo = false): Record<string, unknown> {
  return {
    ...(photo && options.altText ? { alt_text: options.altText } : {}),
    ...(options.locationId ? { location_id: options.locationId } : {}),
    ...(options.collaborators?.length ? { collaborators: options.collaborators } : {}),
  };
}

/**
 * Publish a single-image post to an Instagram Business account.
 * Two-step: create media container → publish container.
 * Handles token errors with automatic refresh retry.
 */
async function publishInstagramPhoto(
  creds: MetaCreds,
  imageUrl: string,
  caption: string,
  userId?: number,
  options: InstagramPublishingOptions = {},
): Promise<PublishResult> {
  const igId = creds.accountId;
  let token = creds.pageAccessToken || creds.accessToken;

  try {
    // Step 1: create media container
    const container = await graphPost<{ id: string }>(`/${igId}/media`, { image_url: imageUrl, caption, access_token: token, ...instagramContainerOptions(options, true) }, creds.graphHost
    );

    // Step 2: wait for container to finish processing
    await pollMediaContainerStatus(igId, container.id, token, 60_000, 3_000, undefined, creds.graphHost);

    // Step 3: publish the container
    const published = await graphPost<{ id: string }>(`/${igId}/media_publish`, { creation_id: container.id, access_token: token }, creds.graphHost
    );

    return {
      success: true,
      platformPostId: published.id,
      postUrl: await instagramPermalink(published.id, token, creds.graphHost),
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    // Handle token errors with automatic refresh
    if (err instanceof GraphApiError && err.isTokenError && userId) {
      logger.warn({ userId, error: err.message }, '[SocialPublishingService] Token error, attempting refresh');
      const newToken = await attemptTokenRefresh(token, userId, 'instagram_api', creds.credentialId);
      if (newToken) {
        token = newToken;
        // Retry with new token
        const container = await graphPost<{ id: string }>(`/${igId}/media`, { image_url: imageUrl, caption, access_token: token, ...instagramContainerOptions(options, true) }, creds.graphHost
        );
        await pollMediaContainerStatus(igId, container.id, token, 60_000, 3_000, undefined, creds.graphHost);
        const published = await graphPost<{ id: string }>(`/${igId}/media_publish`, { creation_id: container.id, access_token: token }, creds.graphHost
        );
        return {
          success: true,
          platformPostId: published.id,
          postUrl: await instagramPermalink(published.id, token, creds.graphHost),
        };
      }
    }
    throw err;
  }
}

/**
 * Publish a Reel to Instagram.
 */
async function publishInstagramReel(
  creds: MetaCreds,
  videoUrl: string,
  caption: string,
  coverUrl?: string,
  thumbOffset?: number,
  userId?: number,
  options: InstagramPublishingOptions = {},
): Promise<PublishResult> {
  const igId = creds.accountId;
  let token = creds.pageAccessToken || creds.accessToken;

  const getContainerParams = (tok: string) => {
    const params: Record<string, unknown> = {
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      access_token: tok,
      share_to_feed: options.shareToFeed ?? true,
      ...instagramContainerOptions(options),
    };
    if (coverUrl) params.cover_url = coverUrl;
    if (thumbOffset !== undefined) params.thumb_offset = Math.round(thumbOffset * 1000);
    return params;
  };

  try {
    const container = await graphPost<{ id: string }>(`/${igId}/media`, getContainerParams(token), creds.graphHost);
    await pollMediaContainerStatus(igId, container.id, token, undefined, undefined, undefined, creds.graphHost);
    const published = await graphPost<{ id: string }>(`/${igId}/media_publish`, { creation_id: container.id, access_token: token }, creds.graphHost
    );
    return {
      success: true,
      platformPostId: published.id,
      postUrl: await instagramPermalink(published.id, token, creds.graphHost),
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (err instanceof GraphApiError && err.isTokenError && userId) {
      logger.warn({ userId, error: err.message }, '[SocialPublishingService] Token error on Reels, attempting refresh');
      const newToken = await attemptTokenRefresh(token, userId, 'instagram_api', creds.credentialId);
      if (newToken) {
        token = newToken;
        const container = await graphPost<{ id: string }>(`/${igId}/media`, getContainerParams(token), creds.graphHost);
        await pollMediaContainerStatus(igId, container.id, token, undefined, undefined, undefined, creds.graphHost);
        const published = await graphPost<{ id: string }>(`/${igId}/media_publish`, { creation_id: container.id, access_token: token }, creds.graphHost
        );
        return {
          success: true,
          platformPostId: published.id,
          postUrl: await instagramPermalink(published.id, token, creds.graphHost),
        };
      }
    }
    throw err;
  }
}

/**
 * Publish a carousel post (multiple images) to Instagram.
 */
async function publishInstagramCarousel(
  creds: MetaCreds,
  imageUrls: string[],
  caption: string,
  userId?: number,
  videoUrls: string[] = [],
  options: InstagramPublishingOptions = {},
): Promise<PublishResult> {
  const igId = creds.accountId;
  let token = creds.pageAccessToken || creds.accessToken;

  if (imageUrls.length + videoUrls.length < 2 || imageUrls.length + videoUrls.length > 10) {
    throw new Error('Instagram carousel requires 2–10 images or videos');
  }

  const runPublish = async (tok: string) => {
    const childIds: string[] = [];
    for (const url of imageUrls) {
      const c = await graphPost<{ id: string }>(`/${igId}/media`, { image_url: url, is_carousel_item: true, access_token: tok }, creds.graphHost
      );
      await pollMediaContainerStatus(igId, c.id, tok, 60_000, 3_000, undefined, creds.graphHost);
      childIds.push(c.id);
    }
    for (const url of videoUrls) {
      const child = await graphPost<{ id: string }>(`/${igId}/media`, { media_type: 'VIDEO', video_url: url, is_carousel_item: true, access_token: tok }, creds.graphHost);
      await pollMediaContainerStatus(igId, child.id, tok, undefined, undefined, undefined, creds.graphHost);
      childIds.push(child.id);
    }
    const carousel = await graphPost<{ id: string }>(`/${igId}/media`, { media_type: 'CAROUSEL', caption, children: childIds.join(','), access_token: tok, ...instagramContainerOptions(options) }, creds.graphHost
    );
    await pollMediaContainerStatus(igId, carousel.id, tok, 60_000, 3_000, undefined, creds.graphHost);
    const published = await graphPost<{ id: string }>(`/${igId}/media_publish`, { creation_id: carousel.id, access_token: tok }, creds.graphHost
    );
    return published.id;
  };

  try {
    const publishedId = await runPublish(token);
    return {
      success: true,
      platformPostId: publishedId,
      postUrl: await instagramPermalink(publishedId, token, creds.graphHost),
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (err instanceof GraphApiError && err.isTokenError && userId) {
      logger.warn({ userId, error: err.message }, '[SocialPublishingService] Token error on Carousel, attempting refresh');
      const newToken = await attemptTokenRefresh(token, userId, 'instagram_api', creds.credentialId);
      if (newToken) {
        token = newToken;
        const publishedId = await runPublish(token);
        return {
          success: true,
          platformPostId: publishedId,
          postUrl: await instagramPermalink(publishedId, token, creds.graphHost),
        };
      }
    }
    throw err;
  }
}

/**
 * Publish a story (image or video) to Instagram.
 */
async function publishInstagramStory(
  creds: MetaCreds,
  mediaUrl: string,
  mediaType: 'IMAGE' | 'VIDEO',
  userId?: number,
): Promise<PublishResult> {
  const igId = creds.accountId;
  let token = creds.pageAccessToken || creds.accessToken;

  try {
    const params: Record<string, unknown> = {
      media_type: 'STORY',
      access_token: token,
    };
    if (mediaType === 'VIDEO') {
      params.video_url = mediaUrl;
    } else {
      params.image_url = mediaUrl;
    }

    const container = await graphPost<{ id: string }>(`/${igId}/media`, params, creds.graphHost);

    await pollMediaContainerStatus(igId, container.id, token, mediaType === 'VIDEO' ? 300_000 : 60_000, mediaType === 'VIDEO' ? 5_000 : 3_000, undefined, creds.graphHost
    );

    const published = await graphPost<{ id: string }>(`/${igId}/media_publish`, { creation_id: container.id, access_token: token }, creds.graphHost
    );

    return {
      success: true,
      platformPostId: published.id,
      postUrl: undefined,
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (err instanceof GraphApiError && err.isTokenError && userId) {
      logger.warn({ userId, error: err.message }, '[SocialPublishingService] Token error, attempting refresh');
      const newToken = await attemptTokenRefresh(token, userId, 'instagram_api', creds.credentialId);
      if (newToken) {
        token = newToken;
        const params: Record<string, unknown> = {
          media_type: 'STORY',
          access_token: token,
        };
        if (mediaType === 'VIDEO') {
          params.video_url = mediaUrl;
        } else {
          params.image_url = mediaUrl;
        }
        const container = await graphPost<{ id: string }>(`/${igId}/media`, params, creds.graphHost);
        await pollMediaContainerStatus(igId, container.id, token, mediaType === 'VIDEO' ? 300_000 : 60_000, mediaType === 'VIDEO' ? 5_000 : 3_000, undefined, creds.graphHost
        );
        const published = await graphPost<{ id: string }>(`/${igId}/media_publish`, { creation_id: container.id, access_token: token }, creds.graphHost
        );
        return {
          success: true,
          platformPostId: published.id,
          postUrl: undefined,
        };
      }
    }
    throw err;
  }
}

/**
 * Poll the media container status until FINISHED (or timeout).
 * Required for video/Reels before calling media_publish.
 */
async function pollMediaContainerStatus(
  igId: string,
  containerId: string,
  token: string,
  maxWaitMs = 300_000,   // 5 min max (Reels processing can take longer)
  intervalMs = 5_000,
  abortSignal?: AbortSignal,
  graphHost: GraphHost = 'facebook',
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (abortSignal?.aborted) throw new Error('Instagram polling aborted');
    const status = await graphGet<{ status_code: string; id: string }>(
      `/${containerId}`,
      token,
      'status_code',
      graphHost,
    );
    if (status.status_code === 'FINISHED') return;
    if (status.status_code === 'ERROR') throw new Error('Instagram media container processing failed');
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for Instagram media container to be ready');
}

// ─── Facebook Page publishing ─────────────────────────────────────────────────

async function publishFacebookText(
  creds: MetaCreds,
  message: string,
  userId?: number,
): Promise<PublishResult> {
  const pageId = creds.accountId;
  let token = creds.accessToken;

  try {
    const result = await graphPost<{ id: string }>(
      `/${pageId}/feed`,
      { message, access_token: token },
    );

    const postId = result.id;
    return {
      success: true,
      platformPostId: postId,
      postUrl: await facebookPermalink(postId, token),
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (err instanceof GraphApiError && err.isTokenError && userId) {
      logger.warn({ userId, error: err.message }, '[SocialPublishingService] Token error on FB Text, attempting refresh');
      const newToken = await attemptTokenRefresh(token, userId, creds.platform || 'facebook_page', creds.credentialId);
      if (newToken) {
        token = newToken;
        const result = await graphPost<{ id: string }>(
          `/${pageId}/feed`,
          { message, access_token: token },
        );
        const postId = result.id;
        return {
          success: true,
          platformPostId: postId,
          postUrl: await facebookPermalink(postId, token),
        };
      }
    }
    throw err;
  }
}

async function publishFacebookPhoto(
  creds: MetaCreds,
  imageUrl: string,
  caption: string,
  userId?: number,
): Promise<PublishResult> {
  const pageId = creds.accountId;
  let token = creds.accessToken;

  try {
    const result = await graphPost<{ id: string; post_id?: string }>(
      `/${pageId}/photos`,
      { url: imageUrl, caption, access_token: token },
    );

    const postId = result.post_id || result.id;
    return {
      success: true,
      platformPostId: postId,
      postUrl: await facebookPermalink(postId, token),
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (err instanceof GraphApiError && err.isTokenError && userId) {
      logger.warn({ userId, error: err.message }, '[SocialPublishingService] Token error on FB Photo, attempting refresh');
      const newToken = await attemptTokenRefresh(token, userId, creds.platform || 'facebook_page', creds.credentialId);
      if (newToken) {
        token = newToken;
        const result = await graphPost<{ id: string; post_id?: string }>(
          `/${pageId}/photos`,
          { url: imageUrl, caption, access_token: token },
        );
        const postId = result.post_id || result.id;
        return {
          success: true,
          platformPostId: postId,
          postUrl: await facebookPermalink(postId, token),
        };
      }
    }
    throw err;
  }
}

async function publishFacebookPhotos(creds: MetaCreds, images: string[], message: string): Promise<PublishResult> {
  const media: Array<{ media_fbid: string }> = [];
  for (const url of images) {
    const photo = await graphPost<{ id: string }>(`/${creds.accountId}/photos`, { url, published: false, access_token: creds.accessToken });
    media.push({ media_fbid: photo.id });
  }
  const post = await graphPost<{ id: string }>(`/${creds.accountId}/feed`, { message, attached_media: media, access_token: creds.accessToken });
  return { success: true, platformPostId: post.id, postUrl: await facebookPermalink(post.id, creds.accessToken) };
}

async function publishFacebookVideo(
  creds: MetaCreds,
  videoUrl: string,
  title: string,
  description: string,
  userId?: number,
): Promise<PublishResult> {
  const pageId = creds.accountId;
  let token = creds.accessToken;

  try {
    const result = await graphPost<{ id: string }>(
      `/${pageId}/videos`,
      { file_url: videoUrl, title, description, access_token: token },
    );

    return {
      success: true,
      platformPostId: result.id,
      postUrl: await facebookPermalink(result.id, token),
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (err instanceof GraphApiError && err.isTokenError && userId) {
      logger.warn({ userId, error: err.message }, '[SocialPublishingService] Token error on FB Video, attempting refresh');
      const newToken = await attemptTokenRefresh(token, userId, creds.platform || 'facebook_page', creds.credentialId);
      if (newToken) {
        token = newToken;
        const result = await graphPost<{ id: string }>(
          `/${pageId}/videos`,
          { file_url: videoUrl, title, description, access_token: token },
        );
        return {
          success: true,
          platformPostId: result.id,
          postUrl: await facebookPermalink(result.id, token),
        };
      }
    }
    throw err;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Publish content to Instagram for the given user.
 */
export async function publishToInstagram(
  userId: number,
  input: InstagramPublishInput,
): Promise<PublishResult> {
  const creds = await loadInstagramCreds(userId, input.credentialId);
  if (!creds || !creds.accountId || !creds.accessToken) {
    return {
      success: false,
      error:
        'Instagram account not connected. Please connect your Instagram Business account in Settings → Channels.',
    };
  }
  if (input.expectedAccountId && creds.accountId !== input.expectedAccountId) {
    return {
      success: false,
      error: 'The selected Instagram credential now points to a different account. Review and approve the post again.',
      errorCode: 'PUBLISHING_ACCOUNT_CHANGED',
      retryable: false,
    };
  }

  const caption = input.caption ?? '';

  try {
    switch (input.postType) {
      case 'story': {
        if (input.videoUrl) {
          return await publishInstagramStory(creds, input.videoUrl, 'VIDEO', userId);
        }
        const imageUrl = input.imageUrls?.[0];
        if (!imageUrl) return { success: false, error: 'imageUrl or videoUrl is required for Story' };
        return await publishInstagramStory(creds, imageUrl, 'IMAGE', userId);
      }
      case 'reel': {
        if (!input.videoUrl) return { success: false, error: 'videoUrl is required for Reels' };
        return await publishInstagramReel(creds, input.videoUrl, caption, input.coverUrl, input.thumbOffset, userId, input);
      }
      case 'carousel': {
        return await publishInstagramCarousel(creds, input.imageUrls || [], caption, userId, input.videoUrls || (input.videoUrl ? [input.videoUrl] : []), input);
      }
      case 'post': {
        const imageUrl = input.imageUrls?.[0];
        if (!imageUrl) return { success: false, error: 'imageUrl is required for an Instagram photo post' };
        return await publishInstagramPhoto(creds, imageUrl, caption, userId, input);
      }
      default:
        return {
          success: false,
          error: `Unsupported Instagram post type: ${String(input.postType)}`,
          errorCode: 'UNSUPPORTED_POST_TYPE',
          retryable: false,
        };
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logger.error({ err, userId }, '[SocialPublishingService] Instagram publish error');
    return failureResult(err);
  }
}

/**
 * Publish content to a Facebook Page for the given user.
 */
export async function publishToFacebook(
  userId: number,
  input: FacebookPublishInput,
): Promise<PublishResult> {
  const creds = await loadFacebookPageCreds(userId, input.credentialId);
  if (!creds || !creds.accountId || !creds.accessToken) {
    return {
      success: false,
      error:
        'Facebook Page not connected. Please connect your Facebook Page in Settings → Channels.',
    };
  }
  if (input.expectedAccountId && creds.accountId !== input.expectedAccountId) {
    return {
      success: false,
      error: 'The selected Facebook credential now points to a different Page. Review and approve the post again.',
      errorCode: 'PUBLISHING_ACCOUNT_CHANGED',
      retryable: false,
    };
  }

  try {
    switch (input.postType) {
      case 'video': {
        if (!input.videoUrl) return { success: false, error: 'videoUrl is required for a Facebook video/reel post' };
        return await publishFacebookVideo(
          creds,
          input.videoUrl,
          input.title ?? '',
          input.description ?? input.message ?? '',
          userId,
        );
      }
      case 'photo': {
        const images = input.imageUrls?.length ? input.imageUrls : input.imageUrl ? [input.imageUrl] : [];
        if (!images.length || images.length > 10) return { success: false, error: 'Facebook photo posts require 1–10 images.' };
        if (images.length > 1) return await publishFacebookPhotos(creds, images, input.message ?? input.description ?? '');
        return await publishFacebookPhoto(creds, images[0], input.message ?? input.description ?? '', userId);
      }
      case 'text': {
        if (!input.message) return { success: false, error: 'message is required for a Facebook text post' };
        return await publishFacebookText(creds, input.message, userId);
      }
      default:
        return {
          success: false,
          error: `Facebook ${String(input.postType)} publishing is not supported by this integration.`,
          errorCode: 'UNSUPPORTED_POST_TYPE',
          retryable: false,
        };
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    logger.error({ err, userId }, '[SocialPublishingService] Facebook publish error');
    return failureResult(err);
  }
}

export async function reconcilePublishedOrganicPost(
  userId: number,
  input: {
    platform: SocialPlatform;
    credentialId: number;
    providerPostId: string;
  },
): Promise<{ exists: boolean; postUrl?: string; error?: string; ambiguous?: boolean }> {
  const creds = input.platform === 'instagram'
    ? await loadInstagramCreds(userId, input.credentialId)
    : await loadFacebookPageCreds(userId, input.credentialId);
  if (!creds) return { exists: false, error: 'Selected publishing credential is unavailable.' };
  const token = creds.pageAccessToken || creds.accessToken;
  try {
    if (input.platform === 'instagram') {
      const media = await graphGet<{ id: string; permalink?: string }>(`/${input.providerPostId}`, token, 'id,permalink', creds.graphHost
      );
      return { exists: Boolean(media.id), postUrl: media.permalink };
    }
    const post = await graphGet<{ id: string; permalink_url?: string }>(`/${input.providerPostId}`, token, 'id,permalink_url', creds.graphHost
    );
    return { exists: Boolean(post.id), postUrl: post.permalink_url };
  } catch (error) {
    if (error instanceof GraphApiError && [100, 803].includes(error.code || 0)) {
      return { exists: false };
    }
    return {
      exists: true,
      error: error instanceof Error ? error.message : 'Post reconciliation failed',
      ambiguous: true,
    };
  }
}

export async function findPublishedOrganicPostCandidate(
  userId: number,
  input: {
    platform: SocialPlatform;
    credentialId: number;
    expectedAccountId: string;
    caption: string;
    expectedAt: string;
  },
): Promise<{
  matched: boolean;
  providerPostId?: string;
  postUrl?: string;
  error?: string;
}> {
  const creds = input.platform === 'instagram'
    ? await loadInstagramCreds(userId, input.credentialId)
    : await loadFacebookPageCreds(userId, input.credentialId);
  if (!creds) return { matched: false, error: 'Selected publishing credential is unavailable.' };
  if (creds.accountId !== input.expectedAccountId) {
    return { matched: false, error: 'The publishing credential now points to a different provider account.' };
  }
  const expectedAt = new Date(input.expectedAt).getTime();
  if (!Number.isFinite(expectedAt)) {
    return { matched: false, error: 'The reviewed publish time is invalid.' };
  }
  const inWindow = (value: string) => {
    const observedAt = new Date(value).getTime();
    return Number.isFinite(observedAt)
      && observedAt >= expectedAt - 5 * 60_000
      && observedAt <= expectedAt + 24 * 60 * 60_000;
  };
  const token = creds.pageAccessToken || creds.accessToken;
  try {
    if (input.platform === 'instagram') {
      const response = await graphGet<{
        data?: Array<{ id: string; caption?: string; permalink?: string; timestamp?: string }>;
      }>(`/${creds.accountId}/media?limit=25`, token, 'id,caption,permalink,timestamp', creds.graphHost
      );
      const matches = (response.data || []).filter(item => (
        (item.caption || '').trim() === input.caption.trim()
        && Boolean(item.timestamp && inWindow(item.timestamp))
      ));
      if (matches.length !== 1) return { matched: false };
      return {
        matched: true,
        providerPostId: matches[0].id,
        postUrl: matches[0].permalink,
      };
    }
    const response = await graphGet<{
      data?: Array<{ id: string; message?: string; permalink_url?: string; created_time?: string }>;
    }>(`/${creds.accountId}/feed?limit=25`, token, 'id,message,permalink_url,created_time', creds.graphHost
    );
    const matches = (response.data || []).filter(item => (
      (item.message || '').trim() === input.caption.trim()
      && Boolean(item.created_time && inWindow(item.created_time))
    ));
    if (matches.length !== 1) return { matched: false };
    return {
      matched: true,
      providerPostId: matches[0].id,
      postUrl: matches[0].permalink_url,
    };
  } catch (error) {
    return {
      matched: false,
      error: error instanceof Error ? error.message : 'Provider ambiguity reconciliation failed.',
    };
  }
}

export async function deletePublishedOrganicPost(
  userId: number,
  input: {
    platform: SocialPlatform;
    credentialId: number;
    providerPostId: string;
  },
): Promise<PublishResult> {
  if (input.platform !== 'facebook') {
    return {
      success: false,
      error: 'Instagram remote deletion is not supported by this publishing integration. Delete it in Instagram, then reconcile.',
      errorCode: 'REMOTE_DELETE_UNSUPPORTED',
      retryable: false,
    };
  }
  const creds = await loadFacebookPageCreds(userId, input.credentialId);
  if (!creds) {
    return {
      success: false,
      error: 'Selected Facebook Page credential is unavailable.',
      errorCode: 'PUBLISHING_ACCOUNT_UNAVAILABLE',
      retryable: false,
    };
  }
  try {
    await graphDelete(`/${input.providerPostId}`, creds.pageAccessToken || creds.accessToken);
    return { success: true, platformPostId: input.providerPostId };
  } catch (error) {
    return failureResult(error);
  }
}
