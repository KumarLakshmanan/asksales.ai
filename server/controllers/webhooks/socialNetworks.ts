/* eslint-disable @typescript-eslint/no-explicit-any */
/** Twitter (X) and LinkedIn webhook verification and processing. */
import { Request, Response } from 'express';
import { db } from '../../models/db';
import { sql } from 'drizzle-orm';
import { logger } from '../../utils/logger.js';
import { redactWebhookText, sanitizedWebhookPreview, serializeSanitizedWebhookPayload } from '../../utils/webhookPayloadSanitizer.js';
import { linkedInChallengeResponse, twitterChallengeResponse, verifyLinkedInWebhookSignature, verifyTwitterWebhookSignature } from '../../utils/socialWebhookSignatures.js';
import { findUserIdFromToken, tenantWebhookAppSecret, resolveWebhookProviderAccount } from './shared.js';
import { saveWebhookToConversation } from './conversation.js';

/**
 * Handle Twitter/X webhook (Account Activity API)
 * Receives DM events from Twitter's Account Activity API
 */
export const handleTwitterWebhook = async (req: Request, res: Response) => {
  try {
    const { userToken } = req.params;
    const userId = await findUserIdFromToken(userToken, 'twitter');
    if (!userId) {
      logger.info('[WebhooksController] No user found for Twitter webhook token');
      return req.method === 'GET' ? res.sendStatus(403) : res.status(200).send('EVENT_RECEIVED');
    }

    const consumerSecret = await tenantWebhookAppSecret(userId, 'twitter_api');
    if (!consumerSecret) {
      logger.warn({ userId }, '[WebhooksController] Twitter webhook app secret is unavailable');
      return res.status(503).json({ error: 'Twitter webhook signing is not configured' });
    }

    // Handle CRC challenge (Twitter webhook verification)
    if (req.method === "GET") {
      const crcToken = req.query.crc_token as string;
      if (typeof crcToken === 'string' && crcToken.length > 0 && crcToken.length <= 1024) {
        return res.status(200).json({
          response_token: twitterChallengeResponse(crcToken, consumerSecret),
        });
      }
      return res.sendStatus(403);
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.sendStatus(405);
    }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!verifyTwitterWebhookSignature(
      rawBody,
      req.get('x-twitter-webhooks-signature'),
      consumerSecret,
    )) {
      logger.warn({ userId }, '[WebhooksController] Twitter webhook signature rejected');
      return res.status(401).json({ error: 'Invalid Twitter webhook signature' });
    }

    const body = req.body;
    const receivingAccountId = typeof body?.for_user_id === 'string'
      ? body.for_user_id
      : typeof body?.for_user_id === 'number'
        ? String(body.for_user_id)
        : '';
    if (!receivingAccountId || !await resolveWebhookProviderAccount(userId, 'twitter_api', receivingAccountId)) {
      logger.warn({ userId }, '[WebhooksController] Twitter webhook account binding rejected');
      return res.status(403).json({ error: 'Twitter webhook account is not connected to this workspace' });
    }
    logger.info({ userId, bodyPreview: sanitizedWebhookPreview(body) }, '[WebhooksController] Twitter webhook received');

    await processTwitterWebhook(userId, body, receivingAccountId);
    return res.status(200).send('EVENT_RECEIVED');

  } catch (error: any) {
    logger.error({ err: error }, '[WebhooksController] Error handling Twitter webhook');
    if (!res.headersSent) return res.status(500).json({ error: 'Unable to process the Twitter webhook' });
  }
};

/**
 * Process Twitter webhook events
 */

export async function processTwitterWebhook(userId: number, body: any, providerAccountId: string): Promise<void> {
  // Handle direct_message_events (Account Activity API v1.1 format)
  const dmEvents = body.direct_message_events || [];
  const users = body.users || {};

  for (const event of dmEvents) {
    if (event.type !== 'message_create') continue;

    const senderId = String(event.message_create?.sender_id || '');
    const recipientId = event.message_create?.target?.recipient_id;
    const messageData = event.message_create?.message_data;

    // Skip messages sent by us (outbound)
    // The for_user_id indicates which user's activity we're receiving
    if (body.for_user_id && senderId === body.for_user_id) continue;

    const senderUser = users[senderId] || {};
    const messageText = typeof messageData?.text === 'string' && messageData.text.length > 0
      ? messageData.text
      : '[Media/Attachment]';
    const messageId = String(event.id || '');
    const parsedTimestamp = Number.parseInt(String(event.created_timestamp), 10);
    const timestamp = Number.isFinite(parsedTimestamp) && parsedTimestamp > 0
      ? parsedTimestamp
      : Date.now();
    if (!senderId || !messageId || messageId.length > 255) {
      throw new Error('Twitter/X DM event is missing a stable sender or event ID.');
    }

    logger.info({
      userId,
      senderId,
    }, '[WebhooksController] Twitter DM received');

    try {
      await db.execute(sql`
        INSERT INTO instagram_webhook_events (
          event_type, page_id, sender_id, message_id, message_text,
          timestamp, raw_data, processed_at, user_id
        ) VALUES (
          'twitter_dm', ${recipientId}, ${senderId}, ${messageId},
          ${redactWebhookText(messageText)}, ${new Date(timestamp)},
          ${serializeSanitizedWebhookPayload(event)}, NOW(), ${userId}
        )
        ON CONFLICT (event_type, message_id) WHERE message_id IS NOT NULL
        DO UPDATE SET processed_at = NOW(), user_id = EXCLUDED.user_id
      `);

      await saveWebhookToConversation(userId, {
        channel: 'twitter',
        providerAccountId,
        externalSenderId: senderId,
        senderName: senderUser.name || senderUser.screen_name || senderId,
        messageText,
        messageId,
        timestamp,
        eventType: 'message',
        rawData: event,
      });
    } catch (error) {
      logger.error({ err: error }, '[WebhooksController] Failed to store Twitter DM');
      throw error;
    }
  }

  // Handle follow events
  const followEvents = body.follow_events || [];
  for (const event of followEvents) {
    if (event.type !== 'follow') continue;
    const source = event.source || {};

    logger.info({ userId, follower: source.screen_name }, '[WebhooksController] Twitter follow event');

    try {
      await db.execute(sql`
        INSERT INTO instagram_webhook_events (
          event_type, sender_id, message_text,
          timestamp, raw_data, processed_at, user_id
        ) VALUES (
          'twitter_follow', ${source.id}, ${'[REDACTED_PII] followed'},
          NOW(), ${serializeSanitizedWebhookPayload(event)}, NOW(), ${userId}
        )
      `);
    } catch (error) {
      logger.error({ err: error }, '[WebhooksController] Failed to store Twitter follow event');
    }
  }
}

/**
 * Handle LinkedIn webhook
 * Receives messaging events from LinkedIn's webhook system
 */
export const handleLinkedInWebhook = async (req: Request, res: Response) => {
  try {
    const { userToken } = req.params;
    const userId = await findUserIdFromToken(userToken, 'linkedin');
    if (!userId) {
      logger.info('[WebhooksController] No user found for LinkedIn webhook token');
      return req.method === 'GET' ? res.sendStatus(403) : res.status(200).send('EVENT_RECEIVED');
    }

    const clientSecret = await tenantWebhookAppSecret(userId, 'linkedin_api');
    if (!clientSecret) {
      logger.warn({ userId }, '[WebhooksController] LinkedIn webhook app secret is unavailable');
      return res.status(503).json({ error: 'LinkedIn webhook signing is not configured' });
    }

    // Handle LinkedIn webhook validation challenge
    if (req.method === "GET") {
      const challenge = req.query.challengeCode || req.query.challenge;
      if (typeof challenge === 'string' && challenge.length > 0 && challenge.length <= 1024) {
        return res.status(200).json({
          challengeCode: challenge,
          challengeResponse: linkedInChallengeResponse(challenge, clientSecret),
        });
      }
      return res.sendStatus(403);
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.sendStatus(405);
    }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!verifyLinkedInWebhookSignature(rawBody, req.get('x-li-signature'), clientSecret)) {
      logger.warn({ userId }, '[WebhooksController] LinkedIn webhook signature rejected');
      return res.status(401).json({ error: 'Invalid LinkedIn webhook signature' });
    }

    const receivingAccountId = await resolveWebhookProviderAccount(userId, 'linkedin_api');
    if (!receivingAccountId) {
      logger.warn({ userId }, '[WebhooksController] LinkedIn webhook account binding is ambiguous or unavailable');
      return res.status(409).json({ error: 'Select one verified LinkedIn receiving account for this webhook' });
    }

    const body = req.body;
    logger.info({ userId, bodyPreview: sanitizedWebhookPreview(body) }, '[WebhooksController] LinkedIn webhook received');

    await processLinkedInWebhook(userId, body, receivingAccountId);
    return res.status(200).send('EVENT_RECEIVED');

  } catch (error: any) {
    logger.error({ err: error }, '[WebhooksController] Error handling LinkedIn webhook');
    if (!res.headersSent) return res.status(500).json({ error: 'Unable to process the LinkedIn webhook' });
  }
};

/**
 * Process LinkedIn webhook events
 */

export async function processLinkedInWebhook(userId: number, body: any, providerAccountId: string): Promise<void> {
  // LinkedIn webhook payload format varies by event type
  // Messages come via the messaging endpoint events
  const events = body.elements || (Array.isArray(body) ? body : [body]);

  for (const event of events) {
    const eventType = event.eventType || event.type || 'unknown';

    if (eventType === 'MESSAGING' || event.entity?.includes('message')) {
      const message = event.data || event;
      const senderId = String(message.from?.['com.linkedin.voyager.messaging.MessagingMember']?.miniProfile?.publicIdentifier
        || message.actor || message.from || '');
      const messageText = message.body?.text || message.subject || message.messageBody || '';
      const messageId = String(message.id || event.id || '');
      const rawTimestamp = message.createdAt || event.time;
      const parsedTimestamp = typeof rawTimestamp === 'number'
        ? rawTimestamp
        : Date.parse(String(rawTimestamp || ''));
      const timestamp = Number.isFinite(parsedTimestamp) && parsedTimestamp > 0
        ? parsedTimestamp
        : Date.now();
      if (!senderId || !messageId || messageId.length > 255) {
        throw new Error('LinkedIn message event is missing a stable sender or event ID.');
      }

      logger.info({
        userId,
        senderId,
      }, '[WebhooksController] LinkedIn message received');

      try {
        await db.execute(sql`
          INSERT INTO instagram_webhook_events (
            event_type, sender_id, message_id, message_text,
            timestamp, raw_data, processed_at, user_id
          ) VALUES (
            'linkedin_message', ${String(senderId)}, ${String(messageId)},
            ${redactWebhookText(String(messageText))}, ${new Date(typeof timestamp === 'number' ? timestamp : Date.now())},
            ${serializeSanitizedWebhookPayload(event)}, NOW(), ${userId}
          )
          ON CONFLICT (event_type, message_id) WHERE message_id IS NOT NULL
          DO UPDATE SET processed_at = NOW(), user_id = EXCLUDED.user_id
        `);

        await saveWebhookToConversation(userId, {
          channel: 'linkedin',
          providerAccountId,
          externalSenderId: senderId,
          senderName: message.senderName || senderId,
          messageText: String(messageText),
          messageId,
          timestamp,
          eventType: 'message',
          rawData: event,
        });
      } catch (error) {
        logger.error({ err: error }, '[WebhooksController] Failed to store LinkedIn message');
        throw error;
      }
    }
  }
}
