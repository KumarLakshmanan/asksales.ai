import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { Request, Response } from 'express';
import { db } from '../models/db.js';
import { eq, and } from 'drizzle-orm';
import { channelCredentialsTable } from '../models/channelCredentials/schema.js';
import { logger } from '../utils/logger.js';
import { encryptValue } from '../services/SecretsManager.js';

/**
 * Save or update YouTube channel credentials for the authenticated user.
 * Credentials are stored in channel_credentials with platform = 'youtube'.
 *
 * Body: { accessToken, refreshToken?, channelId?, channelName? }
 */
export async function saveYouTubeCredentials(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { accessToken, refreshToken, channelId, channelName } = req.body;

    if (!accessToken) {
      return res.status(400).json({ error: 'YouTube access token is required' });
    }

    // Verify the token by hitting the YouTube Data API channels list
    try {
      const verifyRes = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!verifyRes.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body = await verifyRes.json() as any;
        const msg = body?.error?.message || 'Token is invalid or does not have YouTube access';
        return res.status(400).json({ error: `Invalid credentials: ${msg}` });
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      logger.warn({ err }, '[YouTubeCredentials] Failed to verify token with Google API');
      return res.status(400).json({ error: 'Failed to verify token with YouTube API' });
    }

    const existing = await db
      .select()
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, 'youtube')
        )
      )
      .limit(1);

    const sessionData = {
      channelId: channelId || '',
      connectedAt: new Date().toISOString(),
    };

    if (existing.length > 0) {
      await db
        .update(channelCredentialsTable)
        .set({
          accessToken: encryptValue(accessToken),
          refreshToken: refreshToken ? encryptValue(refreshToken) : existing[0].refreshToken,
          accountIdentifier: channelId || existing[0].accountIdentifier,
          accountName: channelName || existing[0].accountName,
          credentialType: 'manual',
          isActive: true,
          sessionData,
          lastRefreshedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(channelCredentialsTable.id, existing[0].id));
    } else {
      await db.insert(channelCredentialsTable).values({
        userId,
        platform: 'youtube',
        accessToken: encryptValue(accessToken),
        refreshToken: refreshToken ? encryptValue(refreshToken) : null,
        accountIdentifier: channelId || '',
        accountName: channelName || 'YouTube Channel',
        credentialType: 'manual',
        isActive: true,
        sessionData,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    logger.info({ userId }, '[YouTubeCredentials] Saved YouTube credentials');
    return res.json({ success: true, message: 'YouTube credentials saved successfully' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, '[YouTubeCredentials] Failed to save credentials');
    return res.status(500).json({ error: 'Unable to save YouTube credentials. Please try again.' });
  }
}

/**
 * Get the YouTube connection status for the authenticated user.
 */
export async function getYouTubeCredentials(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const rows = await db
      .select()
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, 'youtube'),
          eq(channelCredentialsTable.isActive, true)
        )
      )
      .limit(1);

    if (!rows[0]) {
      return res.json({ connected: false });
    }

    return res.json({
      connected: true,
      channelId: rows[0].accountIdentifier,
      channelName: rows[0].accountName,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connectedAt: (rows[0].sessionData as any)?.connectedAt,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[YouTubeCredentials] Failed to get credentials');
    return res.status(500).json({ error: 'Unable to load YouTube credentials. Please try again.' });
  }
}

/**
 * Disconnect YouTube from the authenticated user.
 */
export async function disconnectYouTube(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    await db
      .update(channelCredentialsTable)
      .set({ isActive: false, deactivationReason: 'user_disconnected', deactivatedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, 'youtube')
        )
      );

    return res.json({ success: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[YouTubeCredentials] Failed to disconnect');
    return res.status(500).json({ error: 'Unable to disconnect YouTube. Please try again.' });
  }
}
