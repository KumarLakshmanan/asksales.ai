/* eslint-disable @typescript-eslint/no-explicit-any */
/** Instagram and Facebook webhook verification, intake and event processing. */
import { applyMetaMessageMutation, persistMetaEcho, reconcileSocialReceipt } from '../../services/SocialMessagePersistence.js';
import { getInstagramWebhookSigningSecrets } from '../../services/integrations/InstagramLogin.js';
import { Request, Response } from 'express';
import { db } from '../../models/db';
import { sql } from 'drizzle-orm';
import { timingSafeEqual } from '../../utils/secureCompare.js';
import { logger } from '../../utils/logger.js';
import { resolveInstagramProviderAccountId } from '../../services/instagramAccountSelectionService.js';
import { getWebhookVerifyToken, getAdminAppSecret, verifyMetaSignature } from '../instagramWebhookController';
import { logWebhookEvent } from '../../utils/webhookLogger.js';
import { recordWebhookDrop } from '../../services/webhookHealthService.js';
import { redactWebhookText, sanitizedWebhookPreview, serializeSanitizedWebhookPayload } from '../../utils/webhookPayloadSanitizer.js';
import { getUserAppSecretFromPayload, findUserIdFromToken, verifyUserToken } from './shared.js';
import { saveWebhookToConversation } from './conversation.js';

/**
 * Handle Instagram webhook
 */
export const handleInstagramWebhook = async (req: Request, res: Response) => {
  try {
    const { userToken } = req.params;

    // Handle verification challenge (for Meta webhooks)
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe") {
        const userId = await verifyUserToken(userToken, token as string, 'instagram');
        if (userId) {
          logger.info({ userId }, '[WebhooksController] Instagram webhook verified');
          return res.status(200).send(challenge);
        }
        // Also allow admin-configured verify token for backward compatibility
        const adminVerifyToken = await getWebhookVerifyToken();
        if (timingSafeEqual(String(token), adminVerifyToken)) {
          return res.status(200).send(challenge);
        }
      }
      return res.sendStatus(403);
    }

    // Verify X-Hub-Signature-256 on POST requests — STRICT mode (C2).
    // Same policy as Facebook handler above.
    const instAdminSecrets = await getInstagramWebhookSigningSecrets();
    const instAdminSecret = instAdminSecrets[0] || null;
    const instAdminSignatureOk = instAdminSecrets.some(secret => verifyMetaSignature(req, secret));
    const instUserSecret = !instAdminSignatureOk
      ? await getUserAppSecretFromPayload(req.body, 'instagram_api')
      : null;
    const instSignatureOk = instAdminSignatureOk
      || (!!instUserSecret && verifyMetaSignature(req, instUserSecret));
    const appSecret = instAdminSecret || instUserSecret;
    if (!appSecret) {
      // C1: Don't silently swallow. Counter + EventBus alert raised.
      // We still ACK 200 because Meta will unsubscribe the page on repeated 5xx.
      logWebhookEvent({ platform: 'instagram', eventType: 'signature_unverifiable', pageId: req.body?.entry?.[0]?.id || null, signatureValid: false, processed: false });
      void recordWebhookDrop({ platform: 'instagram', reason: 'missing_app_secret', severity: 'critical', context: { pageId: req.body?.entry?.[0]?.id || null } });
      return res.status(200).send('EVENT_RECEIVED');
    }
    if (!instSignatureOk) {
      logger.warn('[WebhooksController] Instagram webhook invalid X-Hub-Signature-256');
      logWebhookEvent({ platform: 'instagram', eventType: 'signature_rejected', pageId: req.body?.entry?.[0]?.id || null, signatureValid: false, processed: false });
      void recordWebhookDrop({ platform: 'instagram', reason: 'invalid_signature', severity: 'error' });
      return res.status(403).json({ error: 'Invalid signature' });
    }

    // Resolve ownership before persisting and acknowledging the callback.
    const userId = await findUserIdFromToken(userToken, 'instagram');
    if (!userId) {
      logger.info('[WebhooksController] No user found for Instagram webhook token');
      logWebhookEvent({ platform: 'instagram', eventType: 'user_not_found', payload: {}, processed: false });
      return res.sendStatus(404);
    }

    const body = req.body;
    logger.info({ userId, bodyPreview: sanitizedWebhookPreview(body) }, '[WebhooksController] Instagram webhook received');
    logWebhookEvent({ platform: 'instagram', eventType: 'incoming', pageId: body?.entry?.[0]?.id || null, userId, payload: body, signatureValid: undefined, processed: false });

    await processInstagramWebhook(userId, body);
    res.status(200).send('EVENT_RECEIVED');
    logWebhookEvent({ platform: 'instagram', eventType: 'processed', pageId: body?.entry?.[0]?.id || null, userId, processed: true });

  } catch (error: any) {
    logger.error({ err: error }, '[WebhooksController] Error handling Instagram webhook');
    if (!res.headersSent) res.sendStatus(500);
  }
};

/**
 * Process Instagram webhook events
 */

export async function processInstagramWebhook(userId: number, body: any): Promise<void> {
  const object = body.object;

  if (object === 'instagram' || object === 'page') {
    const entries = body.entry || [];

    for (const entry of entries) {
      const pageId = entry.id;

      // Handle messaging events (DM replies)
      if (entry.messaging || entry.standby) {
        for (const messagingEvent of [...(entry.messaging || []), ...(entry.standby || []).filter((event: any) => event.message?.is_echo)]) {
          await processInstagramMessage(userId, messagingEvent, pageId, 'instagram');
        }
      }

      // Handle changes (comments, likes, follows)
      if (entry.changes) {
        for (const change of entry.changes) {
          await processInstagramChange(userId, change, pageId, entry.time);
        }
      }
    }
  }
}

/**
 * Process Instagram message
 */

export async function processInstagramMessage(userId: number, event: any, pageId: string, channel: string): Promise<void> {
  if (event.message?.is_deleted || event.message_edit) {
    const accountId = await resolveInstagramProviderAccountId(userId,pageId);
    if (accountId) await applyMetaMessageMutation(userId,'instagram',accountId,event);
    return;
  }
  const senderId = event.sender?.id;
  const recipientId = event.recipient?.id;
  const timestamp = event.timestamp;

  if (event.read || event.delivery) {
    const accountId = await resolveInstagramProviderAccountId(userId, pageId);
    if (accountId) await reconcileSocialReceipt({ userId, channel: 'instagram', accountId, recipientId: senderId,
      state: event.read ? 'read' : 'delivered', messageIds: event.read?.mid ? [event.read.mid] : event.delivery?.mids,
      watermark: event.read?.watermark || event.delivery?.watermark || timestamp });
  }
  if (event.postback && !event.message) {
    const accountId = await resolveInstagramProviderAccountId(userId, pageId);
    if (!accountId || !senderId || !timestamp) return;
    const { instagramPostbackMessageId, instagramPostbackText } = await import('../../services/instagramAutomations/InstagramAutomationRuntime.js');
    await saveWebhookToConversation(userId, { channel: 'instagram', providerAccountId: accountId,
      externalSenderId: senderId, messageId: instagramPostbackMessageId(event), timestamp,
      messageText: await instagramPostbackText(userId, accountId, event.postback.payload || '', event.postback.title || 'Menu selection'),
      eventType: 'message', rawData: event });
    return;
  }
  if (event.message) {
    const providerAccountId = await resolveInstagramProviderAccountId(userId, pageId);
    const message = event.message;
    if (message.is_self) return;
    if (message.is_echo) {
      if (providerAccountId) await persistMetaEcho(userId, 'instagram', providerAccountId, event);
      return;
    }
    logger.info({
      userId,
      senderId,
      messageId: message.mid,
    }, '[WebhooksController] Instagram DM received');

    // Store the message in webhook events table
    try {
      await db.execute(sql`
        INSERT INTO instagram_webhook_events (
          event_type, page_id, sender_id, recipient_id, message_id,
          message_text, timestamp, raw_data, processed_at, user_id
        ) VALUES (
          'message', ${pageId}, ${senderId}, ${recipientId}, ${message.mid},
          ${redactWebhookText(message.text)}, ${new Date(timestamp)}, ${serializeSanitizedWebhookPayload(event)}, NOW(), ${userId}
        )
      `).catch((error: unknown) => logger.warn({ err: error }, 'Social webhook audit unavailable'));

      // Save to outreach conversation
      await saveWebhookToConversation(userId, {
        channel,
        externalSenderId: senderId,
        messageText: message.text || '',
        messageId: message.mid,
        timestamp,
        eventType: 'message',
        providerAccountId: providerAccountId || undefined,
        rawData: event,
      });
    } catch (dbError) {
      logger.error({ err: dbError }, '[WebhooksController] Failed to store Instagram message');
      throw dbError;
    }
  }

  // Handle message read receipts
  if (event.read) {
    logger.info({ userId, senderId, watermark: event.read.watermark }, '[WebhooksController] Instagram message read');
  }

  // Handle message reactions
  if (event.reaction) {
    logger.info({ userId, senderId, reaction: event.reaction.reaction }, '[WebhooksController] Instagram reaction');

    try {
      await db.execute(sql`
        INSERT INTO instagram_webhook_events (
          event_type, page_id, sender_id, message_id,
          raw_data, timestamp, processed_at, user_id
        ) VALUES (
          'reaction', ${pageId}, ${senderId}, ${event.reaction.mid},
          ${serializeSanitizedWebhookPayload(event)}, NOW(), NOW(), ${userId}
        )
      `);
    } catch (error) {
      logger.error({ err: error }, '[WebhooksController] Failed to store reaction');
    }
  }
}

/**
 * Process Instagram change events (comments, likes, follows)
 */

export async function processInstagramChange(userId: number, change: any, pageId: string, entryTime?: number): Promise<void> {
  const field = change.field;
  const value = change.value;
  const providerAccountId = await resolveInstagramProviderAccountId(userId, pageId);
  const parsedTime = Number(entryTime);
  const occurredAt = Number.isFinite(parsedTime) && parsedTime > 0
    ? (parsedTime < 1e12 ? parsedTime * 1000 : parsedTime)
    : Date.now();

  logger.info({ userId, field }, '[WebhooksController] Instagram change');

  try {
    switch (field) {
      case 'comments':
        if (value.from?.id === providerAccountId || value.from?.id === pageId) return;
        await db.execute(sql`
          INSERT INTO instagram_webhook_events (
            event_type, page_id, sender_id, comment_id, comment_text,
            media_id, timestamp, raw_data, processed_at, user_id
          ) VALUES (
            'comment', ${pageId}, ${value.from?.id || null}, ${value.id},
            ${redactWebhookText(value.text)}, ${value.media?.id || null},
            ${new Date(occurredAt)}, ${serializeSanitizedWebhookPayload(value)}, NOW(), ${userId}
          )
        `).catch((error: unknown) => logger.warn({ err: error }, 'Social comment audit unavailable'));

        // Save comment to outreach
        await saveWebhookToConversation(userId, {
          channel: 'instagram',
          externalSenderId: value.from?.id,
          messageText: value.text || '',
          messageId: value.id,
          timestamp: occurredAt,
          eventType: 'comment',
          providerAccountId: providerAccountId || undefined,
          rawData: value,
        });
        break;

      case 'likes':
        await db.execute(sql`
          INSERT INTO instagram_webhook_events (
            event_type, page_id, sender_id, media_id,
            timestamp, raw_data, processed_at, user_id
          ) VALUES (
            'like', ${pageId}, ${value.from?.id || null}, ${value.media?.id || null},
            NOW(), ${serializeSanitizedWebhookPayload(value)}, NOW(), ${userId}
          )
        `);
        break;

      case 'follows':
        await db.execute(sql`
          INSERT INTO instagram_webhook_events (
            event_type, page_id, sender_id,
            timestamp, raw_data, processed_at, user_id
          ) VALUES (
            'follow', ${pageId}, ${value.from?.id || null},
            NOW(), ${serializeSanitizedWebhookPayload(value)}, NOW(), ${userId}
          )
        `);

        // Save follow event to outreach
        await saveWebhookToConversation(userId, {
          channel: 'instagram',
          externalSenderId: value.from?.id,
          messageText: '[New follower]',
          messageId: `follow_${value.from?.id}_${Date.now()}`,
          timestamp: Date.now(),
          eventType: 'follow',
          providerAccountId: providerAccountId || undefined,
          rawData: value,
        });
        break;

      case 'mentions':
        await db.execute(sql`
          INSERT INTO instagram_webhook_events (
            event_type, page_id, media_id, comment_id,
            timestamp, raw_data, processed_at, user_id
          ) VALUES (
            'mention', ${pageId}, ${value.media_id || null}, ${value.comment_id || null},
            NOW(), ${serializeSanitizedWebhookPayload(value)}, NOW(), ${userId}
          )
        `);
        break;

      default:
        logger.info({ field }, '[WebhooksController] Unhandled Instagram field');
    }
  } catch (error) {
    logger.error({ err: error, field }, '[WebhooksController] Failed to store Instagram event');
    throw error;
  }
}

/**
 * Handle Facebook webhook
 */
export const handleFacebookWebhook = async (req: Request, res: Response) => {
  try {
    const { userToken } = req.params;

    // Handle verification challenge
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe") {
        const userId = await verifyUserToken(userToken, token as string, 'facebook');
        if (userId) {
          logger.info({ userId }, '[WebhooksController] Facebook webhook verified');
          return res.status(200).send(challenge);
        }
        // Also allow admin-configured verify token for backward compatibility
        const adminVerifyToken = await getWebhookVerifyToken();
        if (timingSafeEqual(String(token), adminVerifyToken)) {
          return res.status(200).send(challenge);
        }
      }
      return res.sendStatus(403);
    }

    // Verify X-Hub-Signature-256 on POST requests — STRICT mode (C2).
    // We always 200 to Meta so the page stays subscribed, but we silently drop
    // any payload we cannot cryptographically verify.
    const fbAdminSecret = await getAdminAppSecret();
    const fbUserSecret = !fbAdminSecret || !verifyMetaSignature(req, fbAdminSecret)
      ? await getUserAppSecretFromPayload(req.body, 'facebook_api')
      : null;
    const fbSignatureOk = (fbAdminSecret && verifyMetaSignature(req, fbAdminSecret))
      || (!!fbUserSecret && verifyMetaSignature(req, fbUserSecret));
    if (!fbAdminSecret && !fbUserSecret) {
      // C1: Don't silently swallow. Counter + EventBus alert raised.
      logWebhookEvent({ platform: 'facebook', eventType: 'signature_unverifiable', pageId: req.body?.entry?.[0]?.id || null, signatureValid: false, processed: false });
      void recordWebhookDrop({ platform: 'facebook', reason: 'missing_app_secret', severity: 'critical', context: { pageId: req.body?.entry?.[0]?.id || null } });
      return res.status(200).send('EVENT_RECEIVED');
    }
    if (!fbSignatureOk) {
      logger.warn('[WebhooksController] Facebook webhook invalid X-Hub-Signature-256');
      logWebhookEvent({ platform: 'facebook', eventType: 'signature_rejected', pageId: req.body?.entry?.[0]?.id || null, signatureValid: false, processed: false });
      void recordWebhookDrop({ platform: 'facebook', reason: 'invalid_signature', severity: 'error' });
      return res.status(403).json({ error: 'Invalid signature' });
    }

    // Resolve ownership before persisting and acknowledging the callback.
    const userId = await findUserIdFromToken(userToken, 'facebook');
    if (!userId) {
      logger.info('[WebhooksController] No user found for Facebook webhook token');
      logWebhookEvent({ platform: 'facebook', eventType: 'user_not_found', payload: {}, processed: false });
      return res.sendStatus(404);
    }

    const body = req.body;
    logger.info({ userId, bodyPreview: sanitizedWebhookPreview(body) }, '[WebhooksController] Facebook webhook received');
    logWebhookEvent({ platform: 'facebook', eventType: 'incoming', pageId: body?.entry?.[0]?.id || null, userId, payload: body, signatureValid: undefined, processed: false });

    await processFacebookWebhook(userId, body);
    res.status(200).send('EVENT_RECEIVED');
    logWebhookEvent({ platform: 'facebook', eventType: 'processed', pageId: body?.entry?.[0]?.id || null, userId, processed: true });

  } catch (error: any) {
    logger.error({ err: error }, '[WebhooksController] Error handling Facebook webhook');
    if (!res.headersSent) res.sendStatus(500);
  }
};

/**
 * Process Facebook webhook events
 */

export async function processFacebookWebhook(userId: number, body: any): Promise<void> {
  const object = body.object;

  if (object === 'page') {
    const entries = body.entry || [];

    for (const entry of entries) {
      const pageId = entry.id;

      // Handle messaging events
      if (entry.messaging || entry.standby) {
        for (const messagingEvent of [...(entry.messaging || []), ...(entry.standby || []).filter((event: any) => event.message?.is_echo)]) {
          await processFacebookMessage(userId, messagingEvent, pageId);
        }
      }

      // Handle feed changes (comments, posts)
      if (entry.changes) {
        for (const change of entry.changes) {
          await processFacebookChange(userId, change, pageId);
        }
      }
    }
  }
}

/**
 * Process Facebook message
 */

export async function processFacebookMessage(userId: number, event: any, pageId: string): Promise<void> {
  if (event.message?.is_deleted || event.message_edit) {
    const accountId = pageId;
    if (accountId) await applyMetaMessageMutation(userId,'facebook',accountId,event);
    return;
  }
  const senderId = event.sender?.id;
  const timestamp = event.timestamp;

  if (event.read || event.delivery) {
    const accountId = pageId;
    if (accountId) await reconcileSocialReceipt({ userId, channel: 'facebook', accountId, recipientId: senderId,
      state: event.read ? 'read' : 'delivered', messageIds: event.read?.mid ? [event.read.mid] : event.delivery?.mids,
      watermark: event.read?.watermark || event.delivery?.watermark || timestamp });
  }
  if (event.message) {
    const message = event.message;
    if (message.is_self) return;
    if (message.is_echo) { await persistMetaEcho(userId, 'facebook', pageId, event); return; }
    logger.info({
      userId,
      senderId,
      messageId: message.mid,
    }, '[WebhooksController] Facebook message received');

    try {
      await db.execute(sql`
        INSERT INTO instagram_webhook_events (
          event_type, page_id, sender_id, message_id, message_text,
          timestamp, raw_data, processed_at, user_id
        ) VALUES (
          'facebook_message', ${pageId}, ${senderId}, ${message.mid},
          ${redactWebhookText(message.text)}, ${new Date(timestamp)},
          ${serializeSanitizedWebhookPayload(event)}, NOW(), ${userId}
        )
      `).catch((error: unknown) => logger.warn({ err: error }, 'Social webhook audit unavailable'));

      // Save to outreach conversation
      await saveWebhookToConversation(userId, {
        channel: 'facebook',
        providerAccountId: pageId,
        externalSenderId: senderId,
        messageText: message.text || '',
        messageId: message.mid,
        timestamp,
        eventType: 'message',
        rawData: event,
      });
    } catch (error) {
      logger.error({ err: error }, '[WebhooksController] Failed to store Facebook message');
      throw error;
    }
  }
}

/**
 * Process Facebook change events
 */

export async function processFacebookChange(userId: number, change: any, pageId: string): Promise<void> {
  const field = change.field;
  const value = change.value;

  logger.info({ userId, field }, '[WebhooksController] Facebook change');

  try {
    await db.execute(sql`
      INSERT INTO instagram_webhook_events (
        event_type, page_id, timestamp, raw_data, processed_at, user_id
      ) VALUES (
        ${`facebook_${field}`}, ${pageId}, NOW(),
        ${serializeSanitizedWebhookPayload(value)}, NOW(), ${userId}
      )
    `).catch((error: unknown) => logger.warn({ err: error }, 'Social comment audit unavailable'));

    // Handle feed comments
    if (field === 'feed' && value.item === 'comment' && value.from?.id !== pageId && value.verb !== 'remove') {
      await saveWebhookToConversation(userId, {
        channel: 'facebook',
        providerAccountId: pageId,
        externalSenderId: value.from?.id,
        messageText: value.message || '',
        messageId: value.comment_id,
        timestamp: Date.now(),
        eventType: 'comment',
        rawData: value,
      });
    }
  } catch (error) {
    logger.error({ err: error, field }, '[WebhooksController] Failed to store Facebook event');
    throw error;
  }
}
