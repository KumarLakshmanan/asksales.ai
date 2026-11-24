import { assertRecipientNotSuppressed } from './outreach/RecipientSuppressionService.js';
import { assertCustomerDeliveryRuntime, deliverySetupFailure } from './assistants/CustomerDeliveryGate.js';
/**
 * SMS Service
 * Handles sending SMS messages via MSG91
 */

import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ChannelCredentialModel } from '../models/channelCredentials/functions';
import { db } from '../models/db.js';
import { logger } from '../utils/logger.js';
import { decryptChannelCredentialSecret } from '../utils/channelCredentialSecrets.js';
import { normalizeMSG91Phone, validateMSG91Settings } from '../../shared/msg91.js';
import { inspectMSG91Credential } from '../utils/msg91Credentials.js';
import { verifyMSG91Configuration } from './integrations/MSG91ProviderService.js';
import { inboundContactResolver } from './InboundContactResolver.js';
import {
  privacyVaultService,
  redactPiiWithStableTokens,
} from './agents/orchestration/PrivacyVaultService.js';

interface SendSMSResult {
  success: boolean;
  code?: string;
  reason?: string;
  setupUrl?: string;
  messageId?: string;
  error?: string;
  deliveryAttempted?: boolean;
  outcomeUncertain?: boolean;
  retryable?: boolean;
}

/** The caller's final claim/policy check runs after adapter preparation and
 * immediately before the external effect. Existing callers need no callback. */
export interface SMSDispatchOptions {
  beforeProvider?: () => Promise<void>;
}

/**
 * Send an SMS message via MSG91
 */
export async function sendSMS(
  userId: number,
  to: string,
  message: string,
  flowIdOverride?: string,
  providerAccountId?: string,
  options?: SMSDispatchOptions,
): Promise<SendSMSResult> {
  let deliveryAttempted = false;
  let finalCheckFailed = false;
  try {
    assertCustomerDeliveryRuntime('sms');
    const formattedPhone = normalizeMSG91Phone(to);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !formattedPhone) {
      return { success: false, error: 'Enter a valid recipient phone number with its country code.', deliveryAttempted: false, outcomeUncertain: false };
    }
    if (!message.trim() || message.length > 10_000) {
      return { success: false, error: 'SMS message text must be between 1 and 10,000 characters.', deliveryAttempted: false, outcomeUncertain: false };
    }
    await assertRecipientNotSuppressed(userId,'sms',formattedPhone);
    // Get MSG91 credentials for this user
    const credential = providerAccountId
      ? await ChannelCredentialModel.findActiveAccountByIdentifier(userId, 'msg91_sms', providerAccountId)
      : await ChannelCredentialModel.findByUserAndPlatform(userId, 'msg91_sms');

    const readiness = inspectMSG91Credential(credential);
    if (!credential || !readiness.ready) {
      return { success: false, error: readiness.issue || 'MSG91 is not ready to send SMS.', deliveryAttempted: false, outcomeUncertain: false };
    }
    const authKey = decryptChannelCredentialSecret(credential.apiSecret);
    const smsSettings = readiness.settings;
    const senderId = smsSettings.senderId;
    const flowId = flowIdOverride || smsSettings.flowId;
    const messageVariable = smsSettings.messageVariable;
    const account = credential.accountIdentifier || senderId;

    if (providerAccountId && account !== providerAccountId) {
      return { success: false, error: 'The reviewed SMS sender is no longer selected.', deliveryAttempted: false, outcomeUncertain: false };
    }

    const invalid = validateMSG91Settings({ ...smsSettings, flowId });
    if (invalid) return { success: false, error: invalid, deliveryAttempted: false, outcomeUncertain: false };
    if (flowId !== smsSettings.flowId) {
      const verified = await verifyMSG91Configuration(authKey, { ...smsSettings, flowId });
      if (!verified.success) return { success: false, error: verified.error, deliveryAttempted: false, outcomeUncertain: false };
    }

    try {
      await options?.beforeProvider?.();
    } catch (error) {
      finalCheckFailed = true;
      throw error;
    }
    // No awaited preparation may follow the caller's final durable claim.
    deliveryAttempted = true;
    const response = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: {
        'authkey': authKey,
        'accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        template_id: flowId,
        short_url: '0',
        recipients: [{
          mobiles: formattedPhone,
          [messageVariable]: message,
        }],
      }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });

    let data: { type?: string; status?: string; hasError?: boolean; request_id?: unknown; message?: unknown; code?: unknown } = {};
    try {
      const body = await response.json();
      if (body && typeof body === 'object' && !Array.isArray(body)) data = body;
    } catch {
      if (response.ok || response.status >= 500) throw new Error('Provider receipt unavailable');
    }

    if (response.ok && data.type === 'success' && data.hasError !== true) {
      const receipt = data.request_id || data.message;
      if (typeof receipt !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(receipt.trim())) {
        return { success: false, error: 'MSG91 accepted the request without a usable receipt. Check delivery in MSG91 before retrying.', deliveryAttempted: true, outcomeUncertain: true };
      }
      // A bookkeeping failure after provider acceptance must never encourage a duplicate SMS.
      await ChannelCredentialModel.updateAccount(userId, 'msg91_sms', credential.id, { lastUsedAt: new Date() })
        .catch(() => logger.warn({ userId, credentialId: credential.id }, '[SMSService] Could not update sender last-used time'));

      return {
        success: true,
        messageId: receipt.trim(),
        deliveryAttempted: true,
        outcomeUncertain: false,
      };
    } else {
      const rejected = data.type === 'error' || data.status === 'error' || data.hasError === true
        || (response.status >= 400 && response.status < 500);
      const authRejected = response.status === 401 || response.status === 403 || String(data.code) === '106';
      if (authRejected) {
        await ChannelCredentialModel.updateAccount(userId, 'msg91_sms', credential.id, {
          providerVerifiedAt: null, readinessErrorCode: 'MSG91_AUTH_FAILED', lastReadinessCheckAt: new Date(),
        }).catch(() => logger.warn({ userId, credentialId: credential.id }, '[SMSService] Could not record rejected Auth Key'));
      }
      return {
        success: false,
        error: authRejected ? 'MSG91 rejected the Auth Key. Update the connection in Integrations → SMS.'
          : rejected ? 'MSG91 rejected this SMS. Check the template, message content, recipient, and account balance in MSG91.'
            : 'MSG91 did not confirm this request. Check delivery in MSG91 before retrying.',
        deliveryAttempted: true,
        outcomeUncertain: response.status>=500 || !rejected,
        retryable:rejected && response.status===429,
      };
    }
  } catch (error) {
    // The caller owns policy invalidation and infrastructure retry semantics.
    const setup = deliverySetupFailure(error);
    if (setup) return setup;
    // A failed final check has never entered the provider boundary.
    if (finalCheckFailed) throw error;
    logger.error({ userId, deliveryAttempted }, '[SMSService] Error sending SMS');
    return {
      success: false,
      error: deliveryAttempted ? 'MSG91 did not confirm this request. Check delivery in MSG91 before retrying.' : 'SMS could not be prepared. Check your MSG91 connection.',
      deliveryAttempted,
      outcomeUncertain: deliveryAttempted,
    };
  }
}

export interface InboundSMSPayload {
  sender: string;
  message: string;
  requestId: string;
  receivedAt?: string;
  providerAccountId?: string;
}

export interface InboundSMSResult {
  success: true;
  conversationId: number;
  messageId: number;
  duplicate: boolean;
}

export class InboundSMSProcessingError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'InboundSMSProcessingError';
  }
}

function firstScalar(body: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const normalized = String(value).trim();
      if (normalized) return normalized;
    }
  }
  return '';
}

function normalizeReceivedAt(value: string): string {
  if (!value) return '';
  const epoch = /^\d{10}$/.test(value)
    ? Number(value) * 1000
    : /^\d{13}$/.test(value)
      ? Number(value)
      : Number.NaN;
  const parsed = Number.isNaN(epoch) ? Date.parse(value) : epoch;
  if (!Number.isFinite(parsed)) {
    throw new InboundSMSProcessingError('receivedAt must be a valid timestamp.', 400, 'INVALID_SMS_TIMESTAMP');
  }
  return new Date(parsed).toISOString();
}

/**
 * MSG91 lets customers configure callback field names. Accept the documented
 * AskSales shape plus common aliases, then reduce it to a strict internal
 * contract before any tenant data is queried.
 */
export function normalizeInboundSMSPayload(payload: unknown): InboundSMSPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new InboundSMSProcessingError('The SMS webhook body must be a JSON object.', 400, 'INVALID_SMS_PAYLOAD');
  }
  const body = payload as Record<string, unknown>;
  const sender = firstScalar(body, ['sender', 'from', 'mobile', 'msisdn', 'phone']);
  const senderDigits = sender.replace(/\D/g, '');
  const message = firstScalar(body, ['message', 'text', 'content']);
  const requestId = firstScalar(body, ['requestId', 'request_id', 'id', 'uuid']);
  const receivedAt = normalizeReceivedAt(firstScalar(body, ['receivedAt', 'received_at', 'timestamp', 'time']));
  const providerAccountId = firstScalar(body, ['providerAccountId', 'accountIdentifier', 'account_identifier']);

  if (!/^\d{7,15}$/.test(senderDigits)) {
    throw new InboundSMSProcessingError('A complete customer phone number is required.', 400, 'INVALID_SMS_SENDER');
  }
  if (!message || message.length > 10_000) {
    throw new InboundSMSProcessingError('SMS message text must be between 1 and 10,000 characters.', 400, 'INVALID_SMS_MESSAGE');
  }
  // A stable provider receipt is mandatory: MSG91 may retry callbacks and a
  // guessed timestamp cannot safely distinguish two real customer replies.
  if (!requestId || requestId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(requestId)) {
    throw new InboundSMSProcessingError('A stable alphanumeric requestId is required.', 400, 'INVALID_SMS_REQUEST_ID');
  }
  if (providerAccountId && (providerAccountId.length > 255 || /[\r\n]/.test(providerAccountId))) {
    throw new InboundSMSProcessingError('providerAccountId is invalid.', 400, 'INVALID_SMS_ACCOUNT');
  }

  return {
    sender: senderDigits,
    message,
    requestId,
    ...(receivedAt ? { receivedAt } : {}),
    ...(providerAccountId ? { providerAccountId } : {}),
  };
}

/**
 * Process inbound SMS webhook (from MSG91)
 */
export async function processInboundSMS(
  userId: number,
  payload: unknown,
): Promise<InboundSMSResult> {
  try {
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new InboundSMSProcessingError('A tenant is required.', 401, 'INVALID_SMS_TENANT');
    }
    const normalized = normalizeInboundSMSPayload(payload);
    const inboundPreview = redactPiiWithStableTokens(normalized.message);
    const payloadDigest = crypto
      .createHash('sha256')
      .update(`${normalized.sender}\n${normalized.message}`)
      .digest('hex');
    const idempotencyKey = `sms-inbound:${crypto
      .createHash('sha256')
      .update(`${userId}:${normalized.requestId}`)
      .digest('hex')}`;
    const occurredAt = normalized.receivedAt ? new Date(normalized.receivedAt) : new Date();

    const persisted = await db.transaction(async (tx: typeof db) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`);
      const accountFilter = normalized.providerAccountId
        ? sql`AND oc.provider_account_id = ${normalized.providerAccountId}`
        : sql``;
      const matches = await tx.execute(sql`
        SELECT oc.id, oc.lead_id, oc.provider_account_id
        FROM outreach_conversations oc
        INNER JOIN leads l
          ON l.id = oc.lead_id
         AND l.user_id = ${userId}
         AND l.deleted_at IS NULL
        WHERE oc.user_id = ${userId}
          AND oc.channel = 'sms'
          AND (
            regexp_replace(COALESCE(oc.external_thread_id, ''), '[^0-9]', '', 'g') = ${normalized.sender}
            OR (
              oc.external_thread_id IS NULL
              AND regexp_replace(COALESCE(l.phone, ''), '[^0-9]', '', 'g') = ${normalized.sender}
            )
          )
          ${accountFilter}
        ORDER BY oc.id DESC
        LIMIT 3
      `);
      if (matches.rows.length === 0) {
        throw new InboundSMSProcessingError(
          'No tracked SMS conversation matches this customer and sender account.',
          404,
          'SMS_CONVERSATION_NOT_FOUND',
        );
      }
      if (matches.rows.length > 1) {
        throw new InboundSMSProcessingError(
          'More than one SMS conversation matches this callback. Include providerAccountId.',
          409,
          'AMBIGUOUS_SMS_CONVERSATION',
        );
      }
      const conversation = matches.rows[0] as {
        id: number | string;
        lead_id: number | string;
        provider_account_id: string | null;
      };
      const conversationId = Number(conversation.id);

      const prior = await tx.execute(sql`
        SELECT id, conversation_id, direction, metadata->>'payloadDigest' AS payload_digest
        FROM outreach_messages
        WHERE user_id = ${userId}
          AND idempotency_key = ${idempotencyKey}
        LIMIT 1
      `);
      if (prior.rows.length > 0) {
        const existing = prior.rows[0] as {
          id: number | string;
          conversation_id: number | string;
          direction: string;
          payload_digest: string | null;
        };
        if (
          Number(existing.conversation_id) !== conversationId
          || existing.direction !== 'inbound'
          || existing.payload_digest !== payloadDigest
        ) {
          throw new InboundSMSProcessingError(
            'This requestId is already bound to another SMS callback.',
            409,
            'SMS_REQUEST_ID_COLLISION',
          );
        }
        return { conversationId, messageId: Number(existing.id), duplicate: true };
      }

      const inserted = await tx.execute(sql`
        INSERT INTO outreach_messages (
          conversation_id, user_id, direction, content, redacted_content,
          status, external_message_id, provider_message_id, provider_account_id,
          message_type, message_kind, idempotency_key, is_read, sent_at,
          provider_call_state, metadata, created_at, updated_at
        ) VALUES (
          ${conversationId}, ${userId}, 'inbound', ${inboundPreview.redactedText},
          ${inboundPreview.redactedText}, 'delivered', ${normalized.requestId},
          ${normalized.requestId}, ${conversation.provider_account_id}, 'text',
          'reply', ${idempotencyKey}, FALSE, ${occurredAt}, 'confirmed',
          ${JSON.stringify({ source: 'msg91_webhook', receivedAt: occurredAt.toISOString(), payloadDigest })}::jsonb,
          ${occurredAt}, NOW()
        )
        RETURNING id
      `);
      const messageId = Number((inserted.rows[0] as { id: number | string }).id);
      await tx.execute(sql`
        UPDATE outreach_conversations
        SET status = 'replied',
            last_message_at = CASE
              WHEN last_message_at IS NULL OR last_message_at <= ${occurredAt} THEN ${occurredAt}
              ELSE last_message_at
            END,
            last_message_by = CASE
              WHEN last_message_at IS NULL OR last_message_at <= ${occurredAt} THEN 'lead'
              ELSE last_message_by
            END,
            last_message_preview = CASE
              WHEN last_message_at IS NULL OR last_message_at <= ${occurredAt} THEN ${inboundPreview.redactedText.slice(0, 200)}
              ELSE last_message_preview
            END,
            total_messages = COALESCE(total_messages, 0) + 1,
            unread_count = COALESCE(unread_count, 0) + 1,
            updated_at = NOW()
        WHERE id = ${conversationId}
          AND user_id = ${userId}
      `);
      return { conversationId, messageId, duplicate: false };
    });

    // These operations are replay-safe. If either fails after the message
    // commit, MSG91's retry resumes privacy protection and CRM reconciliation
    // without incrementing unread/message/reply counters twice.
    await privacyVaultService.protectInbound({
      userId,
      conversationId: persisted.conversationId,
      channel: 'sms',
      rawText: normalized.message,
      providerMessageId: normalized.requestId,
      messageId: persisted.messageId,
      entityType: 'outreach_message',
      entityId: persisted.messageId,
    });
    const reconciled = await inboundContactResolver.reconcile({
      userId,
      conversationId: persisted.conversationId,
      channel: 'sms',
      externalIdentifier: normalized.sender,
      source: 'msg91_sms',
      trust: 'provider',
      recordReply: true,
      messageId: persisted.messageId,
      providerMessageId: normalized.requestId,
    });
    if (!reconciled) {
      throw new InboundSMSProcessingError('The SMS conversation customer is unavailable.', 409, 'SMS_CONTACT_UNAVAILABLE');
    }

    logger.info(
      { userId, conversationId: persisted.conversationId, duplicate: persisted.duplicate },
      '[SMSService] Inbound SMS persisted',
    );
    return { success: true, ...persisted };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    const log = error instanceof InboundSMSProcessingError ? logger.warn.bind(logger) : logger.error.bind(logger);
    log({ err: error, userId }, '[SMSService] Error processing inbound SMS');
    throw error;
  }
}
