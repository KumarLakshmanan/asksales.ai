import { applyMetaMessageMutation, persistMetaEcho, reconcileSocialReceipt } from '../services/SocialMessagePersistence.js';
import { isDirectInstagramLogin } from '../utils/instagramOAuthCredential.js';
import { getInstagramWebhookSigningSecrets } from '../services/integrations/InstagramLogin.js';
import { resolveInstagramProviderAccountId, resolveInstagramAccountContext } from '../services/instagramAccountSelectionService.js';
import { withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
/**
 * Instagram Webhook Controller
 * Handles Instagram/Facebook webhook events for comments, likes, DM replies, and followers
 * 
 * This controller processes:
 * - Direct message replies from Instagram users
 * - Message delivery and read receipts
 * - Comments on posts
 * - New followers
 * - Story mentions
 * 
 * Webhook Setup:
 * 1. Configure webhook URL in Meta App Dashboard: {APP_URL}/api/webhooks/instagram
 * 2. Set verify token to match INSTAGRAM_WEBHOOK_VERIFY_TOKEN env variable
 * 3. Subscribe to: messages, message_echoes, messaging_postbacks, messaging_optins, message_deliveries, message_reads
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../models/db';
import { sql, eq, and } from 'drizzle-orm';
import { channelCredentialsTable } from '../models/channelCredentials/schema';
import { logger } from '../utils/logger.js';
import { getInstagramApiForUser } from '../services/instagramGraphApiService';
import { getActiveAdminCredential } from '../models/adminApiCredentials/functions';
import { getGraphApiVersion } from '../utils/metaApiVersion.js';
import { logWebhookEvent } from '../utils/webhookLogger.js';
import { timingSafeEqual } from '../utils/secureCompare.js';
import { boundMetaPageToken, decryptMetaSecret } from '../utils/metaCredentialSecrets.js';
import {
  redactWebhookText,
  sanitizeWebhookPayload,
  serializeSanitizedWebhookPayload,
} from '../utils/webhookPayloadSanitizer.js';

type MetaMessagingPlatform = 'facebook' | 'instagram';

interface MetaWebhookOwner {
  userId: number;
  businessProfileId: number;
  receivingAccountIdentifier: string | null;
}

/**
 * Resolve a callback to exactly one active tenant binding.
 *
 * meta_page_connections is the preferred routing registry, but historical
 * reconnects can leave its per-platform activity flag stale while the official
 * channel credential remains selected and active.  In that case the exact
 * provider account/page identity is a safe fallback.  Ambiguous ownership is
 * rejected rather than risking cross-tenant delivery.
 */
async function resolveMetaWebhookOwner(
  platform: MetaMessagingPlatform,
  routingId: string,
): Promise<MetaWebhookOwner | null> {
  return withSystemScope('Resolve signed Meta provider account', async () => {
    const credentialPlatform = platform === 'instagram' ? 'instagram_api' : 'facebook_api';
    const result = await db.execute(sql`SELECT DISTINCT user_id,business_profile_id FROM (
      SELECT user_id,business_profile_id FROM meta_page_connections WHERE is_active=TRUE
        AND (${platform}='instagram' AND instagram_active=TRUE AND (page_id=${routingId} OR instagram_account_id=${routingId})
          OR ${platform}='facebook' AND facebook_active=TRUE AND page_id=${routingId})
      UNION ALL SELECT user_id,business_profile_id FROM channel_credentials WHERE platform=${credentialPlatform} AND is_active=TRUE
        AND (account_identifier=${routingId} OR session_data->>'pageId'=${routingId} OR session_data->>'instagramAccountId'=${routingId})
    ) bindings WHERE business_profile_id IS NOT NULL LIMIT 2`);
    if (result.rows.length!==1) return null;
    const row = result.rows[0];
    return { userId:Number(row.user_id), businessProfileId:Number(row.business_profile_id), receivingAccountIdentifier:routingId };
  });
}

// Webhook verification token — try admin config first, fallback to env
let resolvedVerifyToken: string | null = null;
async function getWebhookVerifyToken(): Promise<string> {
  if (resolvedVerifyToken) return resolvedVerifyToken;
  try {
    const adminCred = await getActiveAdminCredential('meta_app');
    if (adminCred) {
      const config = adminCred.config as { webhookVerifyToken?: string } | null;
      if (config?.webhookVerifyToken) {
        resolvedVerifyToken = config.webhookVerifyToken;
        return resolvedVerifyToken;
      }
    }
  } catch (_) { /* fallback */ }
  // SECURITY: do NOT fall back to a hardcoded literal — anyone who reads source
  // could verify a webhook subscription against this server. Require explicit
  // env override only; if neither admin config nor env is set, return empty so
  // the verify call fails (Meta will retry with the real token after admin sets it).
  return process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || '';
}

// Export for reuse in webhooksController
export { getWebhookVerifyToken };

/**
 * Get Meta App Secret from admin config for signature verification.
 * Returns null if not configured; unverified webhook payloads are then dropped.
 * Always reads fresh from DB to pick up credential updates without restart.
 * 
 * Meta ALWAYS signs webhooks with the secret of the Facebook App that hosts
 * the webhook subscription (apiSecret), regardless of the payload's object type.
 * The instagramAppSecret is only used for Instagram Graph API calls, not webhook signing.
 */
export async function getAdminAppSecret(_objectType?: string): Promise<string | null> {
  try {
    const adminCred = await getActiveAdminCredential('meta_app');
    if (!adminCred) return null;
    // Meta signs webhooks with the Facebook app's secret (apiSecret)
    if (adminCred?.apiSecret) {
      return adminCred.apiSecret;
    }
    // Fallback: try instagramAppSecret (legacy — only works if it happens to match)
    const config = adminCred.config as { instagramAppSecret?: string } | null;
    if (config?.instagramAppSecret) return config.instagramAppSecret;
  } catch (_) { /* not configured */ }
  return null;
}

/**
 * Get user-level app secret from channel_credentials based on IG account ID or page ID in payload.
 * Returns the appSecret stored in sessionData for the matching user credential.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getUserAppSecretFromPayload(body: any): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries: any[] = body?.entry || [];
    for (const entry of entries) {
      const accountId = entry.id;
      if (!accountId) continue;

      // Primary: look up in channel_credentials by exact accountIdentifier
      const rows = await db
        .select({ apiSecret: channelCredentialsTable.apiSecret, sessionData: channelCredentialsTable.sessionData })
        .from(channelCredentialsTable)
        .where(and(
          eq(channelCredentialsTable.platform, 'instagram_api'),
          eq(channelCredentialsTable.accountIdentifier, String(accountId)),
          eq(channelCredentialsTable.isActive, true)
        ))
        .limit(1);
      if (rows.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sd = rows[0].sessionData as any;
        if (rows[0].apiSecret) return decryptMetaSecret(rows[0].apiSecret);
        if (sd?.appSecret) return decryptMetaSecret(sd.appSecret as string);
      }

      // Fallback: the webhook entry.id may be the Instagram account ID from meta_page_connections
      // (not the channel_credentials accountIdentifier which may differ). Look up the user via
      // meta_page_connections, then find their channel_credentials.
      const { findUserByInstagramAccountId, findUserByPageId } = await import('../models/metaPageConnections/functions.js');
      const pageConn = await findUserByPageId(String(accountId), 'instagram') || await findUserByInstagramAccountId(String(accountId), 'instagram');
      if (pageConn) {
        const ccRows = await db
          .select({ apiSecret: channelCredentialsTable.apiSecret, sessionData: channelCredentialsTable.sessionData })
          .from(channelCredentialsTable)
          .where(and(
            eq(channelCredentialsTable.userId, pageConn.userId),
            eq(channelCredentialsTable.platform, 'instagram_api'),
            eq(channelCredentialsTable.isActive, true)
          ))
          .limit(1);
        if (ccRows.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sd = ccRows[0].sessionData as any;
          if (ccRows[0].apiSecret) return decryptMetaSecret(ccRows[0].apiSecret);
          if (sd?.appSecret) return decryptMetaSecret(sd.appSecret as string);
        }
      }
    }

    // Final fallback: use meta_app app secret from admin_api_credentials
    try {
      const { getActiveAdminCredential } = await import('../models/adminApiCredentials/functions.js');
      const metaCred = await getActiveAdminCredential('meta_app');
      if (metaCred?.config) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cfg = metaCred.config as any;
        if (cfg.appSecret) return cfg.appSecret as string;
        if (cfg.instagramAppSecret) return cfg.instagramAppSecret as string;
      }
    } catch (_) { /* ignore */ }
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * Verify X-Hub-Signature-256 header from Meta webhook payload.
 * Returns true only when a signature is present and matches the configured secret.
 */
export function verifyMetaSignature(req: Request, appSecret: string): boolean {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  if (!signature) {
    logger.warn('[Meta Webhook] Missing X-Hub-Signature-256 header');
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawBody = (req as any).rawBody as Buffer | undefined;
  if (!rawBody) {
    logger.warn('[Meta Webhook] Raw body not available for signature verification');
    return false;
  }

  const expectedSignature = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  const match = receivedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
  if (!match) {
    logger.warn({
      rawBodyLen: rawBody.length,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contentEncoding: (req as any).headers['content-encoding'],
    }, '[Meta Webhook] Signature mismatch');
  }
  return match;
}

/**
 * Verify webhook subscription (GET request from Facebook)
 */
export const verifyWebhook = async (req: Request, res: Response) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    logger.info({ mode, hasToken: typeof token === 'string', hasChallenge: typeof challenge === 'string' }, '[Instagram Webhook] Verification request');

    const verifyToken = await getWebhookVerifyToken();
    if (!verifyToken) {
      logger.error('[Instagram Webhook] Verify token is not configured');
      return res.status(503).json({ error: 'Webhook verification is not configured' });
    }
    if (mode === 'subscribe' && typeof token === 'string' && typeof challenge === 'string' && timingSafeEqual(token, verifyToken)) {
      logger.info('[Instagram Webhook] Webhook verified successfully');
      return res.status(200).send(challenge);
    }

    logger.error('[Instagram Webhook] Verification failed - token mismatch');
    return res.status(403).json({ error: 'Verification failed' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[Instagram Webhook] Verification error');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
};

/**
 * Handle incoming webhook events (POST request from Facebook)
 */
export const handleWebhook = async (req: Request, res: Response) => {
  try {
    // Verify X-Hub-Signature-256 — STRICT mode (C2).
    // We always 200 to Meta so the page stays subscribed, but silently drop any
    // payload we cannot cryptographically verify.
    const objectType = req.body?.object as string | undefined;
    const adminSecrets = objectType === 'instagram' ? await getInstagramWebhookSigningSecrets() : [await getAdminAppSecret(objectType)].filter((secret): secret is string => Boolean(secret));
    const adminSecret = adminSecrets[0] || null;
    logger.info({ objectType, hasAdminSecret: !!adminSecret }, '[Meta Webhook] Resolving signature credential');
    // Try platform secret first; if it fails, fall back to per-user app secret from channel_credentials
    const signatureOk = adminSecrets.some(secret => verifyMetaSignature(req, secret))
      || await (async () => {
        const userSecret = await withSystemScope('Verify Meta account signature', () => getUserAppSecretFromPayload(req.body));
        return !!userSecret && verifyMetaSignature(req, userSecret);
      })();

    if (!adminSecret && !signatureOk) {
      logger.error('[Instagram Webhook] Meta App Secret is NOT configured. Dropping unverified payload. Configure admin Meta credentials to enable webhook processing.');
      logWebhookEvent({
        platform: req.body?.object || 'unknown',
        eventType: 'signature_unverifiable',
        pageId: req.body?.entry?.[0]?.id || null,
        payload: { object: req.body?.object },
        signatureValid: false,
        processed: false,
      });
      return res.status(200).send('EVENT_RECEIVED');
    }
    if (!signatureOk) {
      const sig = req.headers['x-hub-signature-256'];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawBody = (req as any).rawBody as Buffer | undefined;
      logger.warn({
        hasRawBody: !!rawBody,
        rawBodyLen: rawBody?.length,
        sigHeader: sig ? String(sig).substring(0, 20) + '...' : 'MISSING',
        contentType: req.headers['content-type'],
      }, '[Instagram Webhook] Invalid X-Hub-Signature-256 — dropping payload (returning 200 to keep subscription active)');
      logWebhookEvent({
        platform: req.body?.object || 'unknown',
        eventType: 'signature_rejected',
        pageId: req.body?.entry?.[0]?.id || null,
        payload: { object: req.body?.object },
        signatureValid: false,
        processed: false,
      });
      // Return 200 (not 403) so Meta does NOT count this as a failure and disable the subscription.
      // Invalid-signature payloads are silently dropped without processing.
      return res.status(200).send('EVENT_RECEIVED');
    }

    const body = req.body;
    const signatureValid = true;
    const platform = body.object === 'instagram' ? 'instagram' : body.object === 'page' ? 'facebook' : body.object || 'unknown';
    const pageId = body.entry?.[0]?.id || null;

    logger.info({ event: sanitizeWebhookPayload(body) }, '[Instagram Webhook] Received event');

    // Log webhook event for health monitoring
    logWebhookEvent({
      platform,
      eventType: 'incoming',
      pageId,
      payload: body,
      signatureValid,
      processed: false,
    });

    // Acknowledge only after persistence and durable AI dispatch. A failed write
    // must remain retryable at Meta rather than disappearing after an early 200.
    await processWebhookEvent(body);
    logWebhookEvent({ platform, eventType: 'processed', pageId, processed: true });
    res.status(200).send('EVENT_RECEIVED');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[Instagram Webhook] Handler error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
};

/**
 * Process webhook event asynchronously
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processWebhookEvent(body: any): Promise<void> {
  const platform = body.object === 'instagram' ? 'instagram' : body.object === 'page' ? 'facebook' : null;
  if (!platform) return;
  for (const entry of body.entry || []) {
    const owner = await resolveMetaWebhookOwner(platform, String(entry.id));
    if (!owner) continue;
    await withBusinessScope(owner, async () => {
      await logWebhookEvent({ platform, eventType:'incoming', pageId:entry.id, userId:owner.userId,
        payload:{ ...body, entry:[entry] }, signatureValid:true, processed:false });
      try {
      for (const event of [...(entry.messaging || []), ...(entry.standby || []).filter((event: any) => event.message?.is_echo)]) {
        if (platform === 'instagram') await handleMessagingEvent(event, entry.id);
        else await handleFacebookMessagingEvent(event, entry.id);
      }
      for (const change of entry.changes || []) {
        if (platform === 'instagram') await handleChangeEvent(change, entry.id, entry.time);
        else await handleFacebookChangeEvent(change, entry.id, entry.time);
      }
      await logWebhookEvent({ platform, eventType:'processed', pageId:entry.id, userId:owner.userId, processed:true });
      } catch (error) {
        await logWebhookEvent({ platform, eventType:'error', pageId:entry.id, userId:owner.userId,
          processed:false, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    });
  }
}

/**
 * Handle Instagram messaging events (DM replies)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleMessagingEvent(event: any, pageId: string): Promise<void> {
  if (event.message?.is_deleted || event.message_edit) {
    const owner = await resolveMetaWebhookOwner('instagram',pageId);
    if (!owner) return;
    const userId = owner.userId;
    const accountId = await resolveInstagramProviderAccountId(userId,pageId);
    if (accountId) await applyMetaMessageMutation(userId,'instagram',accountId,event);
    return;
  }
  const senderId = event.sender?.id;
  const recipientId = event.recipient?.id;
  const timestamp = event.timestamp;

  if (event.postback && !event.message && senderId && timestamp) {
    const owner = await resolveMetaWebhookOwner('instagram', pageId);
    const accountId = owner ? await resolveInstagramProviderAccountId(owner.userId, pageId) : null;
    if (!owner || !accountId) return;
    const { instagramPostbackMessageId, instagramPostbackText } = await import('../services/instagramAutomations/InstagramAutomationRuntime.js');
    await updateConversationWithReply(senderId,
      await instagramPostbackText(owner.userId, accountId, event.postback.payload || '', event.postback.title || 'Menu selection'),
      instagramPostbackMessageId(event), timestamp, pageId, undefined, event.postback.payload);
    return;
  }

  if (event.message && !event.message.is_self) {
    const message = event.message;

    // Persist messages sent from the connected account without generating a reply.
    if (message.is_echo) {
      const owner = await resolveMetaWebhookOwner('instagram', pageId);
      if (owner) await persistMetaEcho(owner.userId, 'instagram', await resolveInstagramProviderAccountId(owner.userId, pageId) || owner.receivingAccountIdentifier || pageId, event);
      return;
    }

    logger.info({ senderId, messageId: message.mid, pageId }, '[Instagram Webhook] DM received');

    // Store the reply in the database (H1: dedupe on message_id via partial unique index)
    try {
      await db.execute(sql`
        INSERT INTO instagram_webhook_events (
          event_type, page_id, sender_id, recipient_id, message_id, 
          message_text, timestamp, raw_data
        ) VALUES (
          'message', ${pageId}, ${senderId}, ${recipientId}, ${message.mid},
          ${redactWebhookText(message.text)}, ${new Date(timestamp)}, ${serializeSanitizedWebhookPayload(event)}
        )
        ON CONFLICT (event_type, message_id) WHERE message_id IS NOT NULL DO NOTHING
      `);
    } catch (dbError) {
      // Webhook telemetry must never suppress the customer reply path. The
      // production uniqueness boundary is (event_type, message_id), but even a
      // future audit-write failure must not stop canonical conversation work.
      logger.error({ err: dbError, messageId: message.mid }, '[Instagram Webhook] Failed to store message audit');
    }

    // All DM commands, including opt-out, continue through the canonical
    // support runtime. Keep this outside the telemetry insert so an audit-table
    // problem cannot silently consume an otherwise valid customer message.
    await updateConversationWithReply(senderId, message.text, message.mid, timestamp, pageId, message.attachments, message.quick_reply?.payload);
  }

  // Handle message read receipts (H3: insert separate row — NEVER overwrite original message events)
  if (event.read) {
    logger.info({ senderId, watermark: event.read.watermark }, '[Instagram Webhook] Message read');

    try {
      await db.execute(sql`
        INSERT INTO instagram_webhook_events (
          event_type, page_id, sender_id, recipient_id,
          raw_data, timestamp
        ) VALUES (
          'message_read', ${pageId}, ${senderId}, ${recipientId},
          ${serializeSanitizedWebhookPayload(event)}, ${new Date(event.read.watermark || timestamp)}
        )
      `);
      await reconcileMetaMessageReceipt({ pageId, senderId, messageIds: event.read.mid ? [event.read.mid] : undefined, watermark: event.read.watermark || timestamp, state: 'read', platform: 'instagram' });
    } catch (error) {
      logger.error({ err: error }, '[Instagram Webhook] Failed to record read receipt');
    }
  }

  // Handle message reactions
  if (event.reaction) {
    logger.info({ senderId, reaction: event.reaction.reaction, messageId: event.reaction.mid }, '[Instagram Webhook] Message reaction');
    
    try {
      await db.execute(sql`
        INSERT INTO instagram_webhook_events (
          event_type, page_id, sender_id, message_id, 
          raw_data, timestamp, processed_at
        ) VALUES (
          'reaction', ${pageId}, ${senderId}, ${event.reaction.mid},
          ${serializeSanitizedWebhookPayload(event)}, NOW(), NOW()
        )
      `);
    } catch (error) {
      logger.error({ err: error }, '[Instagram Webhook] Failed to store reaction');
    }
  }

  // Handle message deliveries
  if (event.delivery) {
    logger.info({ messageIds: event.delivery.mids, watermark: event.delivery.watermark }, '[Instagram Webhook] Message delivered');
    await reconcileMetaMessageReceipt({ pageId, senderId, messageIds: event.delivery.mids, watermark: event.delivery.watermark || timestamp, state: 'delivered', platform: 'instagram' });
  }
}

async function reconcileMetaMessageReceipt(input: {
  pageId: string;
  senderId?: string;
  messageIds?: string[];
  watermark?: number;
  state: 'delivered' | 'read';
  platform: 'facebook' | 'instagram';
}): Promise<void> {
  const connection = await resolveMetaWebhookOwner(input.platform, input.pageId).catch(() => null);
  if (!connection) return;
  const accountId = input.platform === 'instagram'
    ? await resolveInstagramProviderAccountId(connection.userId, input.pageId) : input.pageId;
  if (!accountId) return;
  await reconcileSocialReceipt({ userId: connection.userId, channel: input.platform, accountId,
    recipientId: input.senderId, messageIds: input.messageIds, watermark: input.watermark, state: input.state });

}

/**
 * Handle Instagram change events (comments, likes, follows)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleChangeEvent(change: any, pageId: string, time: number): Promise<void> {
  const field = change.field;
  const value = change.value;

  logger.info({ field, value: sanitizeWebhookPayload(value) }, '[Instagram Webhook] Change event');

  try {
    switch (field) {
      case 'comments':
        await handleCommentEvent(value, pageId, time);
        break;
      case 'likes':
        await handleLikeEvent(value, pageId, time);
        break;
      case 'follows':
        await handleFollowEvent(value, pageId, time);
        break;
      case 'mentions':
        await handleMentionEvent(value, pageId, time);
        break;
      case 'story_insights':
        await handleStoryInsightsEvent(value, pageId, time);
        break;
      default:
        logger.info({ field }, '[Instagram Webhook] Unhandled field');
    }
  } catch (error) {
    logger.error({ err: error }, '[Instagram Webhook] Error handling change event');
    if (field === 'comments') throw error;
  }
}

/**
 * Handle comment events
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleCommentEvent(value: any, pageId: string, time: number): Promise<void> {
  logger.info({ id: value.id, senderId: value.from?.id, mediaId: value.media?.id }, '[Instagram Webhook] Comment');

  try {
    await db.execute(sql`
      INSERT INTO instagram_webhook_events (
        event_type, page_id, sender_id, comment_id, comment_text,
        media_id, timestamp, raw_data, processed_at
      ) VALUES (
        'comment', ${pageId}, ${value.from?.id || null}, ${value.id},
        ${redactWebhookText(value.text)}, ${value.media?.id || null},
        ${new Date(time)}, ${serializeSanitizedWebhookPayload(value)}, NOW()
      )
    `).catch((error: unknown) => logger.warn({ err: error }, 'Social comment audit unavailable'));

    // Check if the comment is from the page owner itself to prevent recursive loops
    if (value.from?.id === pageId) {
      logger.info({ id: value.id, senderId: value.from?.id }, '[Instagram Webhook] Skipping comment reply generation for self-comment');
      return;
    }

    const { findUserByPageId, findUserByInstagramAccountId } = await import('../models/metaPageConnections/functions.js');
    const pageConnection = await findUserByPageId(pageId, 'instagram') || await findUserByInstagramAccountId(pageId, 'instagram');
    if (pageConnection) {
      if (
        value.from?.id === pageConnection.instagramAccountId ||
        (value.from?.username && pageConnection.instagramUsername && value.from.username.toLowerCase() === pageConnection.instagramUsername.toLowerCase())
      ) {
        logger.info({ id: value.id, senderId: value.from?.id }, '[Instagram Webhook] Skipping comment reply generation for self-comment (via page connection)');
        return;
      }
    }

    // Generate AI reply or auto-reply for the comment
    if (value.text) {
      // Run every public reply through the same privacy/policy/playbook runtime.
      const owner = await resolveMetaWebhookOwner('instagram', pageId);
      if (owner) {
        const accountId = await resolveInstagramProviderAccountId(owner.userId, pageId);
        if (!accountId || value.from?.id === accountId) return;
        const { saveWebhookToConversation } = await import('./webhooksController.js');
        await saveWebhookToConversation(owner.userId, { channel: 'instagram', providerAccountId: accountId,
          externalSenderId: value.from?.id, senderName: value.from?.username, messageText: value.text,
          messageId: value.id, timestamp: time < 1e12 ? time * 1000 : time, eventType: 'comment', rawData: value });
      }
    }
  } catch (error) {
    logger.error({ err: error }, '[Instagram Webhook] Failed to store comment');
    throw error;
  }
}

/**
 * Handle like events
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleLikeEvent(value: any, pageId: string, time: number): Promise<void> {
  logger.info({ mediaId: value.media?.id, senderId: value.from?.id }, '[Instagram Webhook] Like');

  try {
    await db.execute(sql`
      INSERT INTO instagram_webhook_events (
        event_type, page_id, sender_id, media_id, 
        timestamp, raw_data, processed_at
      ) VALUES (
        'like', ${pageId}, ${value.from?.id || null}, ${value.media?.id || null},
        ${new Date(time)}, ${serializeSanitizedWebhookPayload(value)}, NOW()
      )
    `);
  } catch (error) {
    logger.error({ err: error }, '[Instagram Webhook] Failed to store like');
  }
}

/**
 * Handle follow events
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleFollowEvent(value: any, pageId: string, time: number): Promise<void> {
  logger.info({ senderId: value.from?.id }, '[Instagram Webhook] Follow');

  try {
    await db.execute(sql`
      INSERT INTO instagram_webhook_events (
        event_type, page_id, sender_id, 
        timestamp, raw_data, processed_at
      ) VALUES (
        'follow', ${pageId}, ${value.from?.id || null},
        ${new Date(time)}, ${serializeSanitizedWebhookPayload(value)}, NOW()
      )
    `);
  } catch (error) {
    logger.error({ err: error }, '[Instagram Webhook] Failed to store follow');
  }
}

/**
 * Handle mention events
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleMentionEvent(value: any, pageId: string, time: number): Promise<void> {
  logger.info({ mediaId: value.media_id, commentId: value.comment_id }, '[Instagram Webhook] Mention');

  try {
    await db.execute(sql`
      INSERT INTO instagram_webhook_events (
        event_type, page_id, media_id, comment_id,
        timestamp, raw_data, processed_at
      ) VALUES (
        'mention', ${pageId}, ${value.media_id || null}, ${value.comment_id || null},
        ${new Date(time)}, ${serializeSanitizedWebhookPayload(value)}, NOW()
      )
    `);
  } catch (error) {
    logger.error({ err: error }, '[Instagram Webhook] Failed to store mention');
  }
}

/**
 * Handle story insights events
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleStoryInsightsEvent(value: any, pageId: string, time: number): Promise<void> {
  logger.info({ mediaId: value.media_id, impressions: value.impressions, reach: value.reach }, '[Instagram Webhook] Story Insights');

  try {
    await db.execute(sql`
      INSERT INTO instagram_webhook_events (
        event_type, page_id, media_id, 
        timestamp, raw_data, processed_at
      ) VALUES (
        'story_insights', ${pageId}, ${value.media_id || null},
        ${new Date(time)}, ${serializeSanitizedWebhookPayload(value)}, NOW()
      )
    `);
  } catch (error) {
    logger.error({ err: error }, '[Instagram Webhook] Failed to store story insights');
  }
}

/**
 * Handle Facebook messaging events — saves to outreach_conversations + outreach_messages
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleFacebookMessagingEvent(event: any, pageId: string): Promise<void> {
  if (event.message?.is_deleted || event.message_edit) {
    const owner = await resolveMetaWebhookOwner('facebook',pageId);
    if (!owner) return;
    const userId = owner.userId;
    const accountId = pageId;
    if (accountId) await applyMetaMessageMutation(userId,'facebook',accountId,event);
    return;
  }
  const senderId = event.sender?.id;
  const recipientId = event.recipient?.id;
  const timestamp = event.timestamp;

  if (event.delivery) {
    await reconcileMetaMessageReceipt({ pageId, senderId, messageIds: event.delivery.mids, watermark: event.delivery.watermark || timestamp, state: 'delivered', platform: 'facebook' });
  }
  if (event.read) {
    await reconcileMetaMessageReceipt({ pageId, senderId, messageIds: event.read.mid ? [event.read.mid] : undefined, watermark: event.read.watermark || timestamp, state: 'read', platform: 'facebook' });
  }
  if (!event.message || !senderId || event.message.is_self) return;

  const messageText = event.message.text || null;
  const messageId = event.message.mid;

  // Persist messages sent from the connected account without generating a reply.
  if (event.message.is_echo) {
    const owner = await resolveMetaWebhookOwner('facebook', pageId);
    if (owner) await persistMetaEcho(owner.userId, 'facebook', owner.receivingAccountIdentifier || pageId, event);
    return;
  }

  logger.info({ senderId, messageId }, '[Facebook Webhook] Inbound message received');

  // Store raw event
  try {
    await db.execute(sql`
      INSERT INTO instagram_webhook_events (
        event_type, page_id, sender_id, recipient_id, message_id,
        message_text, timestamp, raw_data, processed_at
      ) VALUES (
        'facebook_message', ${pageId}, ${senderId}, ${recipientId},
        ${messageId}, ${redactWebhookText(messageText)}, ${new Date(timestamp)}, ${serializeSanitizedWebhookPayload(event)}, NOW()
      ) ON CONFLICT DO NOTHING
    `);
  } catch (_e) { /* non-critical */ }

  const owner = await resolveMetaWebhookOwner('facebook', pageId);
  if (!owner) throw new Error('No active tenant binding exists for the Facebook Page webhook.');
  const { saveWebhookToConversation } = await import('./webhooksController.js');
  await saveWebhookToConversation(owner.userId, { channel: 'facebook', providerAccountId: pageId,
    externalSenderId: senderId, messageId, messageText: messageText || '', timestamp,
    eventType: 'message', rawData: event });

}

/**
 * Handle Facebook change events
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleFacebookChangeEvent(change: any, pageId: string, time: number): Promise<void> {
  const field = change.field;
  const value = change.value;

  logger.info({ field }, '[Facebook Webhook] Change event');

  try {
    await db.execute(sql`
      INSERT INTO instagram_webhook_events (
        event_type, page_id, timestamp, raw_data, processed_at
      ) VALUES (
        ${`facebook_${field}`}, ${pageId}, ${new Date(time)}, 
        ${serializeSanitizedWebhookPayload(value)}, NOW()
      )
    `);
  } catch (error) {
    logger.error({ err: error }, '[Facebook Webhook] Failed to store change event');
  }
  if (field === 'feed' && value.item === 'comment' && value.verb !== 'remove' && value.from?.id && value.from.id !== pageId) {
    const owner = await resolveMetaWebhookOwner('facebook', pageId);
    if (owner) {
      const { saveWebhookToConversation } = await import('./webhooksController.js');
      await saveWebhookToConversation(owner.userId, { channel: 'facebook', providerAccountId: pageId,
        externalSenderId: value.from.id, senderName: value.from.name, messageText: value.message || '',
        messageId: value.comment_id, timestamp: Number(value.created_time || time) < 1e12 ? Number(value.created_time || time) * 1000 : Number(value.created_time || time),
        eventType: 'comment', rawData: value });
    }
  }

}

/**
 * Update existing conversation with reply
 */
async function updateConversationWithReply(
  senderId: string,
  messageText: string,
  messageId: string,
  timestamp: number,
  pageId: string,
  attachments?: Array<{ type?: string; payload?: { id?: string; url?: string }; url?: string; name?: string }>,
  automationPayload?: string,
): Promise<void> {
  const owner = await resolveMetaWebhookOwner('instagram', pageId);
  if (!owner) throw new Error('No active tenant binding exists for the Instagram webhook account.');
  const account = await resolveInstagramProviderAccountId(owner.userId, pageId);
  if (!account) throw new Error('The receiving Instagram account could not be resolved.');
  const { saveWebhookToConversation } = await import('./webhooksController.js');
  await saveWebhookToConversation(owner.userId, { channel: 'instagram', providerAccountId: account,
    externalSenderId: senderId, messageId, messageText: messageText || '', timestamp,
    eventType: 'message', rawData: { message: { attachments }, automationPayload } });

}

/**
 * @deprecated All support reply generation must use AgentRouter/ChannelGateway.
 * Kept temporarily as a non-operational symbol while downstream deployments
 * are checked for private imports; it intentionally performs no work.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function generateSmartReplySuggestion(
  senderId: string, 
  messageText: string,
  userId?: number,
  conversationId?: number
): Promise<void> {
  logger.warn('[Instagram Webhook] Deprecated direct smart-reply helper suppressed; use the canonical support gateway');
  return;
  /* istanbul ignore next -- unreachable legacy body retained for one compatibility release */
  if (userId === undefined) return;
  try {
    logger.info({ senderId, message: messageText?.substring(0, 50), userId, conversationId }, '[Instagram Webhook] Generating smart reply');
    
    // Import LLM provider
    const { LLMProviderFactory } = await import('../services/agents/LLMProviderFactory');
    const { knowledgeGateway } = await import('../services/knowledge/KnowledgeGateway.js');
    
    const llmProvider = await LLMProviderFactory.createProviderForUser(userId);

    // Get Knowledge Base context using embedding-based semantic search
    let kbContextBlock = '';
    if (userId) {
      try {
        const kbText = await knowledgeGateway.retrieveText({ tenantId: userId as number, purpose: 'outreach_reply', channel: 'instagram', audience: 'customer', redactedText: messageText, redactedHistory: [], entities: {}, risk: 'low' });
        if (kbText) {
          kbContextBlock = `\nKnowledge Base Context (use this to answer questions accurately):\n${kbText}\n`;
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (kbErr: any) {
        logger.warn({ err: kbErr }, '[Instagram Webhook] Error fetching KB context');
      }
    }
    
    const prompt = `Generate a helpful, friendly reply to this Instagram DM:
    
Customer message: "${messageText}"
${kbContextBlock}
Rules:
- Keep the reply concise (1-3 sentences)
- Be professional but friendly
- If asking a question, provide a helpful answer using the knowledge base context
- If expressing interest, acknowledge and offer next steps
- Don't be overly salesy
- Use appropriate emojis sparingly (1-2 max)
- Don't make up facts not in the knowledge base

Reply:`;

    const response = await llmProvider.createChatCompletion({
      model: llmProvider.defaultModel,
      messages: [
        { role: 'system', content: 'You are a helpful customer service assistant responding to Instagram DMs.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 200,
      ...(userId ? {
        loggingContext: {
          userId,
          purpose: 'instagram_smart_reply',
          service: 'InstagramWebhookController',
          action: 'generate_smart_reply',
        },
      } : {}),
    });

    const suggestedReply = response.content?.trim() || '';

    if (suggestedReply && conversationId) {
      // H2: Use sub-select on id — plain UPDATE does NOT support ORDER BY/LIMIT in Postgres.
      await db.execute(sql`
        UPDATE instagram_webhook_events 
        SET ai_reply_generated = true,
            ai_reply_text = ${suggestedReply.substring(0, 2000)},
            updated_at = NOW()
        WHERE id = (
          SELECT id FROM instagram_webhook_events
          WHERE sender_id = ${senderId}
          ORDER BY timestamp DESC
          LIMIT 1
        )
      `);

      logger.info({ reply: suggestedReply.substring(0, 50) }, '[Instagram Webhook] Smart reply generated');
    }
  } catch (error) {
    logger.error({ err: error }, '[Instagram Webhook] Failed to generate smart reply');
  }
}

/** @deprecated Public replies use saveWebhookToConversation via the canonical gateway. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function generateCommentReplySuggestion(
  commentId: string,
  commentText: string,
  username?: string
): Promise<void> {
  logger.warn('[Instagram Webhook] Deprecated direct comment suggestion helper suppressed; use the canonical support gateway');
  return;
  /* istanbul ignore next -- unreachable legacy body retained for one compatibility release */
  try {
    logger.info({ commentId, username, comment: commentText?.substring(0, 50) }, '[Instagram Webhook] Generating comment reply');
    
    const { LLMProviderFactory } = await import('../services/agents/LLMProviderFactory');
    const llmProvider = await LLMProviderFactory.createProviderForUser();
    
    const prompt = `Generate a brief, engaging reply to this Instagram comment:
    
${username ? `Commenter: @${username}` : ''}
Comment: "${commentText}"

Rules:
- Keep the reply concise (1-2 sentences)
- Be authentic and engaging
- Address the commenter by name if available
- Use 1-2 relevant emojis
- If it's a question, provide a helpful answer
- If it's a compliment, thank them warmly

Reply:`;

    const response = await llmProvider.createChatCompletion({
      model: llmProvider.defaultModel,
      messages: [
        { role: 'system', content: 'You are a social media manager replying to Instagram comments.' },
        { role: 'user', content: prompt },
      ],
    });

    const generatedContent = response.content || '';
    if (response.success && generatedContent) {
      logger.info({ commentId, suggestion: generatedContent.substring(0, 100) }, '[Instagram Webhook] Comment reply generated');
      // Store the suggestion for approval (don't auto-reply to comments)
      await db.execute(sql`
        INSERT INTO instagram_webhook_events (event_type, event_data, processed)
        VALUES ('comment_reply_suggestion', ${JSON.stringify({
          commentId,
          commentText,
          username,
          suggestedReply: generatedContent,
          generatedAt: new Date().toISOString(),
        })}::jsonb, false)
      `);
    }
  } catch (error) {
    logger.error({ err: error }, '[Instagram Webhook] Failed to generate comment reply');
  }
}

/**
 * Get webhook events for a user
 */
export const getWebhookEvents = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id;
    const eventType = req.query.eventType as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    let query = sql`
      SELECT * FROM instagram_webhook_events
      WHERE 1=1
    `;

    if (eventType) {
      query = sql`${query} AND event_type = ${eventType}`;
    }

    query = sql`${query} ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${offset}`;

    const events = await db.execute(query);

    res.json({
      success: true,
      events: events.rows || [],
      pagination: { limit, offset },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[Instagram Webhook] Failed to get events');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
};

/**
 * Get webhook statistics
 */
export const getWebhookStats = async (req: Request, res: Response) => {
  try {
    const result = await db.execute(sql`
      SELECT 
        event_type,
        COUNT(*) as count,
        MAX(timestamp) as last_received
      FROM instagram_webhook_events
      WHERE timestamp > NOW() - INTERVAL '7 days'
      GROUP BY event_type
      ORDER BY count DESC
    `);

    res.json({
      success: true,
      stats: result.rows || [],
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[Instagram Webhook] Failed to get stats');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
};

// ─── Keyword Command Automation ─────────────────────────────────────────────

// Predefined keyword triggers → topics for KB search
const KEYWORD_COMMANDS: Record<string, { topic: string; fallbackReply: string }> = {
  'price': { topic: 'pricing plans cost', fallbackReply: 'Thanks for asking about pricing! Let me get that info for you. Could you tell me more about what you\'re looking for? 💰' },
  'pricing': { topic: 'pricing plans cost', fallbackReply: 'Thanks for asking about pricing! Let me get that info for you. Could you tell me more about what you\'re looking for? 💰' },
  'cost': { topic: 'pricing plans cost', fallbackReply: 'Thanks for asking about pricing! Let me get that info for you. Could you tell me more about what you\'re looking for? 💰' },
  'demo': { topic: 'demo demonstration trial', fallbackReply: 'Great, you\'d like a demo! 🎬 I\'ll get someone to reach out to schedule one. Could you share your email?' },
  'trial': { topic: 'demo demonstration trial', fallbackReply: 'Great, you\'d like to try it out! 🎬 I\'ll get someone to reach out. Could you share your email?' },
  'stop': { topic: '', fallbackReply: 'Got it! You\'ve been unsubscribed from automated messages. If you ever want to reconnect, just DM us! 🙏' },
  'unsubscribe': { topic: '', fallbackReply: 'Got it! You\'ve been unsubscribed from automated messages. If you ever want to reconnect, just DM us! 🙏' },
  'help': { topic: 'help support faq', fallbackReply: 'Hi! 👋 Here are some things I can help with:\n• Pricing → type "price"\n• Demo → type "demo"\n• Stop messages → type "stop"\nOr just ask your question!' },
};

/**
 * Detect keyword commands in DM text and auto-reply via Graph API.
 * Returns true if a keyword was detected and handled.
 */
async function _handleKeywordCommand(messageText: string, senderId: string, pageId: string): Promise<boolean> {
  logger.warn({ senderId, pageId }, '[Instagram Webhook] Deprecated keyword auto-reply suppressed; canonical opt-out/playbook pipeline owns this message');
  return false;
  /* istanbul ignore next -- unreachable legacy body retained for one compatibility release */
  const normalizedText = messageText.trim().toLowerCase();
  
  // Check exact match or starts-with for keywords
  let matchedKeyword: string | null = null;
  let commandConfig: { topic: string; fallbackReply: string } = KEYWORD_COMMANDS.help;
  
  for (const [keyword, config] of Object.entries(KEYWORD_COMMANDS)) {
    if (normalizedText === keyword || normalizedText.startsWith(keyword + ' ')) {
      matchedKeyword = keyword;
      commandConfig = config;
      break;
    }
  }

  if (!matchedKeyword) return false;

  logger.info({ senderId, keyword: matchedKeyword }, '[Instagram Webhook] Keyword command detected');

  // Find the user who owns this page
  const credentials = await db.select()
    .from(channelCredentialsTable)
    .where(
      and(
        eq(channelCredentialsTable.platform, 'instagram_api'),
        eq(channelCredentialsTable.isActive, true)
      )
    );

  let matchedCred = null;
  for (const cred of credentials) {
    const sessionData = cred.sessionData as { pageId?: string } | null;
    if (sessionData?.pageId === pageId) {
      matchedCred = cred;
      break;
    }
  }

  if (!matchedCred || !matchedCred.userId) {
    logger.warn({ pageId }, '[Instagram Webhook] No credential found for keyword auto-reply');
    return false;
  }

  const userId = matchedCred.userId;

  // Handle "stop" command: mark as unsubscribed
  if (matchedKeyword === 'stop' || matchedKeyword === 'unsubscribe') {
    try {
      // Update any active outreach conversations to 'unsubscribed'
      await db.execute(sql`
        UPDATE outreach_conversations
        SET status = 'unsubscribed', updated_at = NOW()
        WHERE user_id = ${userId}
        AND channel = 'instagram'
        AND status IN ('active', 'replied')
      `);
    } catch (err) {
      logger.warn({ err }, '[Instagram Webhook] Error updating unsubscribe status');
    }
  }

  // Build reply using Knowledge Base if topic is available
  let replyText = commandConfig.fallbackReply;

  if (commandConfig.topic) {
    try {
      const { knowledgeGateway } = await import('../services/knowledge/KnowledgeGateway.js');
      const { LLMProviderFactory } = await import('../services/agents/LLMProviderFactory');

      const kbContext = await knowledgeGateway.retrieveText({ tenantId: userId, purpose: 'outreach_reply', channel: 'instagram', audience: 'customer', redactedText: commandConfig.topic, redactedHistory: [], entities: {}, risk: 'low' });
      
      if (kbContext) {
        const llmProvider = await LLMProviderFactory.createProviderForUser(userId);
        const response = await llmProvider.createChatCompletion({
          model: llmProvider.defaultModel,
          messages: [
            { role: 'system', content: 'You are a helpful assistant replying to an Instagram DM command. Keep the reply concise (2-4 sentences), friendly, and use the knowledge base context. Use 1-2 emojis.' },
            { role: 'user', content: `The user asked about: "${matchedKeyword}"\n\nKnowledge Base Context:\n${kbContext}\n\nGenerate a helpful reply:` },
          ],
          temperature: 0.7,
          max_tokens: 200,
          loggingContext: {
            userId,
            purpose: 'instagram_keyword_reply',
            service: 'InstagramWebhookController',
          },
        });

        const generatedContent = response.content || '';
        if (response.success && generatedContent) {
          replyText = generatedContent.trim();
        }
      }
    } catch (err) {
      logger.warn({ err }, '[Instagram Webhook] KB lookup failed, using fallback reply');
    }
  }

  // Send auto-reply via Graph API
  try {
    const service = await getInstagramApiForUser(userId);
    const activeService = service;
    if (activeService) {
      await activeService!.sendMessage(senderId, replyText);
      logger.info({ senderId, keyword: matchedKeyword }, '[Instagram Webhook] Auto-reply sent via Graph API');

      // Log the auto-reply
      await db.execute(sql`
        INSERT INTO instagram_webhook_events (
          event_type, page_id, sender_id, message_text, raw_data, timestamp, processed_at
        ) VALUES (
          'keyword_auto_reply', ${pageId}, ${senderId}, ${redactWebhookText(replyText)},
          ${serializeSanitizedWebhookPayload({ keyword: matchedKeyword, reply: replyText })}::jsonb, NOW(), NOW()
        )
      `);

      return true;
    }
  } catch (err) {
    logger.error({ err }, '[Instagram Webhook] Failed to send keyword auto-reply');
  }

  return false;
}

/**
 * Detect keyword commands in comment text and auto-reply.
 * Returns true if handled.
 */
async function _handleCommentKeywordCommand(
  commentId: string,
  commentText: string,
  fromId: string | undefined,
  pageId: string
): Promise<boolean> {
  logger.warn({ commentId, fromId, pageId }, '[Instagram Webhook] Deprecated comment keyword auto-reply suppressed; canonical public-reply pipeline owns this comment');
  return false;
  /* istanbul ignore next -- unreachable legacy body retained for one compatibility release */
  const normalizedText = commentText.trim().toLowerCase();
  
  let matchedKeyword: string | null = null;
  let commandConfig: { topic: string; fallbackReply: string } = KEYWORD_COMMANDS.help;
  
  for (const [keyword, config] of Object.entries(KEYWORD_COMMANDS)) {
    if (normalizedText === keyword || normalizedText.startsWith(keyword + ' ')) {
      matchedKeyword = keyword;
      commandConfig = config;
      break;
    }
  }

  if (!matchedKeyword) return false;

  // Find the owning user
  const credentials = await db.select()
    .from(channelCredentialsTable)
    .where(
      and(
        eq(channelCredentialsTable.platform, 'instagram_api'),
        eq(channelCredentialsTable.isActive, true)
      )
    );

  let matchedCred = null;
  for (const cred of credentials) {
    const sessionData = cred.sessionData as { pageId?: string } | null;
    if (sessionData?.pageId === pageId) {
      matchedCred = cred;
      break;
    }
  }

  if (!matchedCred || !matchedCred.userId) return false;

  const userId = matchedCred.userId;
  let replyText = commandConfig.fallbackReply;

  // Enrich from KB if available
  if (commandConfig.topic) {
    try {
      const { knowledgeGateway } = await import('../services/knowledge/KnowledgeGateway.js');
      const { LLMProviderFactory } = await import('../services/agents/LLMProviderFactory');

      const kbContext = await knowledgeGateway.retrieveText({ tenantId: userId, purpose: 'outreach_reply', channel: 'instagram', audience: 'customer', redactedText: commandConfig.topic, redactedHistory: [], entities: {}, risk: 'low' });
      if (kbContext) {
        const llmProvider = await LLMProviderFactory.createProviderForUser(userId);
        const response = await llmProvider.createChatCompletion({
          model: llmProvider.defaultModel,
          messages: [
            { role: 'system', content: 'You are replying to an Instagram comment. Keep it very brief (1-2 sentences) and helpful. Use 1 emoji max.' },
            { role: 'user', content: `Comment keyword: "${matchedKeyword}"\n\nContext:\n${kbContext}\n\nReply:` },
          ],
          temperature: 0.7,
          max_tokens: 100,
          loggingContext: { userId, purpose: 'instagram_comment_keyword', service: 'InstagramWebhookController' },
        });
        const generatedContent = response.content || '';
        if (response.success && generatedContent) {
          replyText = generatedContent.trim();
        }
      }
    } catch (err) {
      logger.warn({ err }, '[Instagram Webhook] KB lookup for comment failed');
    }
  }

  // Reply to comment via Graph API
  try {
    const accountContext = await resolveInstagramAccountContext(userId);
    const accessToken = accountContext ? decryptMetaSecret(boundMetaPageToken(accountContext!.credential) || accountContext!.credential.accessToken) : '';
    const graphHost = isDirectInstagramLogin(accountContext?.credential) ? 'instagram' : 'facebook';

    if (accessToken) {
      const apiVersion = await getGraphApiVersion();
      const url = `https://graph.${graphHost}.com/${apiVersion}/${commentId}/replies`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: replyText,
        }),
      });

      if (response.ok) {
        logger.info({ commentId, keyword: matchedKeyword }, '[Instagram Webhook] Comment auto-reply sent');
        return true;
      }
    }
  } catch (err) {
    logger.error({ err }, '[Instagram Webhook] Failed to send comment auto-reply');
  }

  return false;
}
