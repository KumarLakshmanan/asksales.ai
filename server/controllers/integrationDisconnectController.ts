import { businessOwnerUserId } from '../tenancy/businessContext.js';
 
import type { AuthenticatedRequest } from '../types/express.js';
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unified Integration Disconnect Controller
 *
 * Single endpoint to disconnect any integration platform without callers
 * having to know the per-platform table layout / token storage scheme.
 *
 * MED-14 / Improvement #2:
 *   DELETE /api/integrations/:platform/disconnect
 *
 * Acts as the authoritative entry point — sets channel_credentials.is_active=false,
 * clears tokens from api_credentials, and emits an audit log entry.
 */

 
import type { Response } from 'express';
import { db } from '../models/db';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { disconnectAdsForUser } from '../models/metaPageConnections/functions.js';
import { activeWhatsAppWabaIds, revokeWhatsAppCreditLinesAfterDisconnect } from '../services/whatsapp/WhatsAppCreditLineDisconnect.js';


// Platforms supported by the unified disconnect endpoint.
// Adding a new platform? Append the slug + the channel_credentials.platform values
// it should mark inactive (multiple aliases supported per slug).
const PLATFORM_TO_CHANNEL_KEYS: Record<string, string[]> = {
  instagram: ['instagram_api', 'instagram_browser', 'instagram'],
  facebook:  ['facebook_api', 'facebook'],
  whatsapp:  ['whatsapp', 'whatsapp_browser'],
  twitter:   ['twitter', 'twitter_api', 'twitter_browser'],
  linkedin:  ['linkedin', 'linkedin_api', 'linkedin_browser'],
  gmail:     ['gmail', 'gmail_api'],
  meta:      ['meta', 'meta_ads'],
  google_ads:['google_ads'],
  msg91:     ['msg91_sms'],
  sms:       ['msg91_sms'],
};

const PLATFORM_TO_API_CREDENTIAL_KEYS: Record<string, string[]> = {
  gmail:      ['gmail', 'gmail_smtp'],
  email:      ['resend', 'sendgrid', 'gmail_smtp', 'smtp'],
  msg91:      ['msg91'],
  sms:        ['msg91'],
  twitter:    ['twitter_api'],
  linkedin:   ['linkedin_api'],
  google_ads: ['google_ads'],
};

/**
 * DELETE /api/integrations/:platform/disconnect
 *
 * Marks the connection inactive (we keep the row for audit / re-activation).
 * Returns counts of rows touched so the client can confirm the action took effect.
 */
export async function disconnectIntegration(req: AuthenticatedRequest, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { platform } = req.params;
  const slug = String(platform || '').toLowerCase().replace(/-/g, '_');

  const channelKeys = PLATFORM_TO_CHANNEL_KEYS[slug] || [];
  const apiKeys = PLATFORM_TO_API_CREDENTIAL_KEYS[slug] || [];

  if (channelKeys.length === 0 && apiKeys.length === 0) {
    return res.status(400).json({
      error: `Unknown platform "${slug}". Supported: ${Object.keys({ ...PLATFORM_TO_CHANNEL_KEYS, ...PLATFORM_TO_API_CREDENTIAL_KEYS }).join(', ')}`,
    });
  }

  let channelRowsTouched = 0;
  let apiRowsTouched = 0;
  let disconnectedWabaIds: string[] = [];

  try {
    await db.transaction(async (tx: typeof db) => {
    if (channelKeys.includes('whatsapp')) disconnectedWabaIds = await activeWhatsAppWabaIds(tx, userId);
    if (channelKeys.length > 0) {
      const result = await tx.execute(sql`
        UPDATE channel_credentials
           SET is_active = false,
               deactivation_reason = 'user_disconnect',
               deactivated_at = NOW(),
               updated_at = NOW()
         WHERE user_id = ${userId}
           AND platform IN (${sql.join(channelKeys.map(key => sql`${key}`), sql`, `)})
           AND is_active = true
      `);
      channelRowsTouched = (result as any).rowCount || 0;
    }

    if (apiKeys.length > 0) {
      const result = await tx.execute(sql`
        UPDATE api_credentials
           SET is_active = false,
               updated_at = NOW()
         WHERE user_id = ${userId}
           AND service_name IN (${sql.join(apiKeys.map(key => sql`${key}`), sql`, `)})
           AND is_active = true
      `);
      apiRowsTouched = (result as any).rowCount || 0;
    }

    });

    if (slug === 'meta') {
      await disconnectAdsForUser(userId);
    }
    await revokeWhatsAppCreditLinesAfterDisconnect(userId, disconnectedWabaIds);

    logger.info(
      { userId, platform: slug, channelRowsTouched, apiRowsTouched },
      '[IntegrationDisconnect] Disconnected platform'
    );

    return res.json({
      success: true,
      platform: slug,
      channelRowsTouched,
      apiRowsTouched,
      remoteRevocationAttempted: false,
      message:
        channelRowsTouched + apiRowsTouched > 0
          ? `Disconnected ${slug} successfully.`
          : `No active ${slug} connection found to disconnect.`,
    });
  } catch (error: any) {
    logger.error({ err: error, userId, platform: slug }, '[IntegrationDisconnect] Failed');
    return res.status(500).json({ error: 'Failed to disconnect. Please try again.' });
  }
}
