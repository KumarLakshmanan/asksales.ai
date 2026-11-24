/* eslint-disable @typescript-eslint/no-explicit-any */
/** WhatsApp Cloud API webhook verification, inbound messages and delivery statuses. */
import { Request, Response } from 'express';
import { db } from '../../models/db';
import { sql } from 'drizzle-orm';
import { logger } from '../../utils/logger.js';
import { redactWebhookText, sanitizedWebhookPreview, serializeSanitizedWebhookPayload } from '../../utils/webhookPayloadSanitizer.js';
import { recordAutomationReceipt, notifyAutomationReceiptUpdate } from '../../services/automations/AutomationReceipts.js';
import { findUserIdFromToken, verifyUserToken } from './shared.js';

/**
 * Handle WhatsApp webhook
 */
export const handleWhatsAppWebhook = async (req: Request, res: Response) => {
  try {
    const { userToken } = req.params;

    // Handle verification challenge
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe") {
        const userId = await verifyUserToken(userToken, token as string, 'whatsapp');
        if (userId) {
          logger.info({ userId }, '[WebhooksController] WhatsApp webhook verified');
          return res.status(200).send(challenge);
        }
      }
      return res.sendStatus(403);
    }

    const userId = await findUserIdFromToken(userToken, 'whatsapp');
    if (!userId) {
      logger.info('[WebhooksController] No user found for WhatsApp webhook token');
      return res.sendStatus(404);
    }

    const body = req.body;
    logger.info({ userId, bodyPreview: sanitizedWebhookPreview(body) }, '[WebhooksController] WhatsApp webhook received (legacy path)');

    // Persist raw event log (legacy behavior preserved for audit)
    await processWhatsAppWebhook(userId, body).catch((error: unknown) => {
      logger.warn({ err: error }, '[WebhooksController] WhatsApp audit unavailable');
    });

    // C3: Forward to the unified processor so sentiment/ticket/auto-reply pipeline runs.
    // We delegate to the canonical webhook handler (`/api/whatsapp/webhook`) by re-invoking
    // its logic with the same body. We bypass the signature check because legacy tokens
    // already proved authenticity via the per-user URL token.
      const { handleWebhook } = await import('../whatsappController.js');

      const fakeReq: any = {
        body,
        rawBody: (req as Request & { rawBody?: Buffer }).rawBody,
        headers: req.headers,
        ip: req.ip,
        // Mark this so the canonical handler can skip signature for legacy callers
        _legacyTokenAuth: true,
      };

      // Forward the response too: persistence failures must be retried by Meta.
      return await handleWebhook(fakeReq, res);

  } catch (error: any) {
    logger.error({ err: error }, '[WebhooksController] Error handling WhatsApp webhook');
    if (!res.headersSent) res.sendStatus(500);
  }
};

/**
 * Process WhatsApp webhook events
 */

export async function processWhatsAppWebhook(userId: number, body: any): Promise<void> {
  if (body.object !== 'whatsapp_business_account') {
    return;
  }

  const entries = body.entry || [];

  for (const entry of entries) {
    const changes = entry.changes || [];

    for (const change of changes) {
      if (change.field === 'messages') {
        const value = change.value;
        const metadata = value.metadata;
        const messages = value.messages || [];
        const statuses = value.statuses || [];
        const contacts = value.contacts || [];

        // Process incoming messages
        for (const message of messages) {
          await processWhatsAppMessage(userId, message, metadata, contacts);
        }

        // Process message status updates
        for (const status of statuses) {
          await processWhatsAppStatus(userId, status, metadata);
        }
      }
    }
  }
}

/**
 * Process WhatsApp message
 */

export async function processWhatsAppMessage(userId: number, message: any, metadata: any, _contacts: any[]): Promise<void> {
  const from = message.from;
  const timestamp = message.timestamp;
  const messageId = message.id;
  const messageType = message.type;

  let messageText = '';
  switch (messageType) {
    case 'text':
      messageText = message.text?.body || '';
      break;
    case 'image':
      messageText = `[Image] ${message.image?.caption || ''}`;
      break;
    case 'video':
      messageText = `[Video] ${message.video?.caption || ''}`;
      break;
    case 'audio':
      messageText = '[Audio message]';
      break;
    case 'document':
      messageText = `[Document] ${message.document?.filename || ''}`;
      break;
    case 'location':
      messageText = `[Location] ${message.location?.name || 'Shared location'}`;
      break;
    case 'contacts':
      messageText = '[Contact card]';
      break;
    case 'interactive':
      messageText = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '[Interactive message]';
      break;
    default:
      messageText = `[${messageType}]`;
  }

  logger.info({
    userId,
    from,
    messageType,
  }, '[WebhooksController] WhatsApp message received');

  try {
    // Store in webhook events table
    await db.execute(sql`
      INSERT INTO instagram_webhook_events (
        event_type, page_id, sender_id, message_id, message_text,
        timestamp, raw_data, processed_at, user_id
      ) VALUES (
        'whatsapp_message', ${metadata.phone_number_id}, ${from}, ${messageId},
        ${redactWebhookText(messageText)}, ${new Date(parseInt(timestamp) * 1000)},
        ${serializeSanitizedWebhookPayload({ message, metadata, contacts: _contacts })}, NOW(), ${userId}
      )
      ON CONFLICT DO NOTHING
    `);

    // NOTE: WhatsApp conversation/message persistence is handled exclusively by the canonical
    // handleWebhook() path (whatsappController.ts) which is called immediately after this legacy
    // path. Calling saveWebhookToConversation() here for WhatsApp would create duplicate
    // conversations. The canonical path handles lead creation, conversation upsert, and
    // message storage with full idempotency checks.
  } catch (error) {
    logger.error({ err: error }, '[WebhooksController] Failed to store WhatsApp message');
  }
}

/**
 * Process WhatsApp status updates
 */

export async function processWhatsAppStatus(userId: number, status: any, metadata: any): Promise<void> {
  const statusName = typeof status.status === 'string'
    && ['sent', 'delivered', 'read', 'failed'].includes(status.status)
    ? status.status
    : null;
  if (!statusName || typeof status.id !== 'string' || status.id.length === 0) {
    logger.warn({ userId }, '[WebhooksController] Ignoring invalid WhatsApp status update');
    return;
  }
  const parsedTimestamp = Number.parseInt(String(status.timestamp), 10);
  const statusTimestamp = Number.isFinite(parsedTimestamp)
    ? new Date(parsedTimestamp * 1000)
    : new Date();
  const failureReason = statusName === 'failed'
    ? String(status.errors?.[0]?.message || 'WhatsApp delivery failed').slice(0, 1000)
    : null;

  logger.info({
    userId,
    messageId: status.id,
    status: statusName,
    recipientId: status.recipient_id,
  }, '[WebhooksController] WhatsApp status update');

  try {
    let automationMatches=0;
    await db.transaction(async (tx: typeof db) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`wa-receipt:${userId}:${metadata.phone_number_id}:${status.id}`}))`);
      automationMatches=await recordAutomationReceipt(userId,{channel:'whatsapp',accountId:String(metadata.phone_number_id || ''),messageId:status.id,status:statusName,occurredAt:statusTimestamp},tx);
      await tx.execute(sql`
        UPDATE outreach_messages
        SET status = CASE
              WHEN ${statusName} = 'read' THEN 'read'
              WHEN ${statusName} = 'delivered' AND status != 'read' THEN 'delivered'
              WHEN ${statusName} = 'sent' AND status NOT IN ('delivered', 'read', 'failed') THEN 'sent'
              WHEN ${statusName} = 'failed' AND status NOT IN ('delivered', 'read') THEN 'failed'
              ELSE status
            END,
            delivered_at = CASE
              WHEN ${statusName} IN ('delivered', 'read') THEN COALESCE(delivered_at, ${statusTimestamp})
              ELSE delivered_at
            END,
            read_at = CASE WHEN ${statusName} = 'read' THEN COALESCE(read_at, ${statusTimestamp}) ELSE read_at END,
            failed_at = CASE WHEN ${statusName} = 'failed' THEN COALESCE(failed_at, ${statusTimestamp}) ELSE failed_at END,
            error_message = CASE WHEN ${statusName} = 'failed' THEN ${failureReason} WHEN ${statusName} IN ('delivered', 'read') THEN NULL ELSE error_message END,
            updated_at = NOW()
        WHERE user_id = ${userId}
          AND direction = 'outbound'
          AND conversation_id IN (SELECT id FROM outreach_conversations
            WHERE user_id=${userId} AND channel='whatsapp' AND provider_account_id=${String(metadata.phone_number_id || '')})
          AND (waba_message_id = ${status.id}
            OR provider_message_id = ${status.id}
            OR external_message_id = ${status.id}
            OR (${statusName} IN ('delivered','read') AND status='pending' AND provider_call_state='not_started'
              AND external_message_id IS NULL AND metadata->'outreachQueue'->>'lastFailureReceipt'=${status.id}))
      `);

      // Older sends are tracked only in sent_messages. Without this they stay
      // "sent" forever and reports count rejected messages as accepted.
      // A delivered or read receipt is final; a later failure never overrides it.
      if (statusName !== 'sent') await tx.execute(sql`
        UPDATE sent_messages
        SET delivery_status = CASE WHEN ${statusName} IN ('delivered','read') THEN 'delivered' ELSE 'failed' END,
            delivered_at = CASE WHEN ${statusName} IN ('delivered','read') THEN COALESCE(delivered_at, ${statusTimestamp}) ELSE delivered_at END,
            bounced_at = CASE WHEN ${statusName} = 'failed' THEN COALESCE(bounced_at, ${statusTimestamp}) ELSE bounced_at END,
            bounce_reason = CASE WHEN ${statusName} = 'failed' THEN ${failureReason} ELSE bounce_reason END,
            updated_at = NOW()
        WHERE user_id = ${userId} AND channel = 'whatsapp' AND message_id = ${status.id}
          AND (${statusName} <> 'failed' OR (delivered_at IS NULL AND COALESCE(delivery_status,'') <> 'delivered'))
      `);

      if (statusName === 'failed') {
        const { planWhatsAppProviderRetry } = await import('../../services/outreach/WhatsAppProviderRetry.js');
        await planWhatsAppProviderRetry(tx,userId,status.id,String(metadata.phone_number_id || ''),status.errors?.[0]?.code);
      }

      await tx.execute(sql`
        INSERT INTO instagram_webhook_events (
          event_type, page_id, message_id, recipient_id,
          timestamp, raw_data, processed_at, user_id
        ) VALUES (
          ${`whatsapp_${statusName}`}, ${metadata.phone_number_id}, ${status.id}, ${status.recipient_id},
          ${statusTimestamp},
          ${serializeSanitizedWebhookPayload({ status, metadata })}, NOW(), ${userId}
        )
        ON CONFLICT (event_type, message_id) WHERE message_id IS NOT NULL
        DO UPDATE SET
          recipient_id = EXCLUDED.recipient_id,
          timestamp = EXCLUDED.timestamp,
          raw_data = EXCLUDED.raw_data,
          processed_at = EXCLUDED.processed_at,
          user_id = EXCLUDED.user_id
      `);
      await tx.execute(sql`SELECT reconcile_support_notification_provider_delivery(
        ${status.id}, ${statusName}, ${statusTimestamp}, ${failureReason})`);
    });
    if (automationMatches) await notifyAutomationReceiptUpdate(userId);
  } catch (error) {
    logger.error({ err: error }, '[WebhooksController] Failed to store WhatsApp status');
    throw error;
  }

  // Platform-billed WABAs: settle the message charge from Meta's pricing.
  // Runs after the status commits because wallet settlement opens its own
  // transaction. It is idempotent, so a failure is thrown for Meta to retry.
  try {
    const { settleWhatsAppChargeFromStatus } = await import('../../services/whatsapp/WhatsAppBillingService.js');
    await settleWhatsAppChargeFromStatus({
      phoneNumberId: String(metadata.phone_number_id || ''), wamid: status.id, status: statusName, pricing: status.pricing,
      errors: Array.isArray(status.errors) ? status.errors : null,
    });
  } catch (error) {
    logger.error({ err: error, messageId: status.id }, '[WebhooksController] WhatsApp charge settlement failed');
    throw error;
  }
}
