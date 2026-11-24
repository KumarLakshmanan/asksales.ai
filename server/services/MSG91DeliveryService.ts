import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { db } from '../models/db.js';
import { currentBusinessScope } from '../tenancy/businessContext.js';
import { normalizeMSG91Phone } from '../../shared/msg91.js';
import { redactWebhookText, sanitizeWebhookPayload } from '../utils/webhookPayloadSanitizer.js';
import {recordAutomationReceipt,notifyAutomationReceiptUpdate} from './automations/AutomationReceipts.js';

export class MSG91DeliveryError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = 'INVALID_SMS_DELIVERY_REPORT') {
    super(message);
    this.name = 'MSG91DeliveryError';
  }
}

export interface MSG91DeliveryReport {
  requestId: string;
  senderId: string;
  phone: string;
  status: 'sent' | 'delivered' | 'failed';
  occurredAt?: Date;
  failureReason?: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MSG91DeliveryError('Each delivery report must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function scalar(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const field = value[key];
    if ((typeof field === 'string' || typeof field === 'number') && String(field).trim()) return String(field).trim();
  }
  return '';
}

function timestamp(value: string): Date | undefined {
  if (!value) return undefined;
  // MSG91's legacy report dates use IST; the new webhook can emit epoch or ISO dates.
  const date = /^\d{10}$/.test(value) ? new Date(Number(value) * 1000)
    : /^\d{13}$/.test(value) ? new Date(Number(value))
      : new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}+05:30` : value);
  if (!Number.isFinite(date.getTime())) throw new MSG91DeliveryError('The delivery report timestamp is invalid.');
  return date;
}

/** Accept the customizable OnReportReceived JSON and the legacy V4 report envelope. */
export function normalizeMSG91DeliveryReports(payload: unknown): MSG91DeliveryReport[] {
  let body = payload;
  if (body && typeof body === 'object' && !Array.isArray(body) && 'data' in body) {
    const data = (body as Record<string, unknown>).data;
    try { body = typeof data === 'string' ? JSON.parse(data) : data; }
    catch { throw new MSG91DeliveryError('The delivery report data is not valid JSON.'); }
  }
  const groups = Array.isArray(body) ? body : [body];
  const reports = groups.flatMap(value => {
    const group = object(value);
    return Array.isArray(group.report) ? group.report.map(item => ({ ...group, ...object(item) })) : [group];
  });
  if (!reports.length || reports.length > 200) throw new MSG91DeliveryError('Provide between 1 and 200 SMS delivery reports.');
  return reports.map(report => {
    const requestId = scalar(report, ['requestId', 'request_id']);
    const senderId = scalar(report, ['senderId', 'sender_id']);
    const phone = normalizeMSG91Phone(scalar(report, ['telNum', 'number', 'mobile', 'mobiles', 'phone']));
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId) || !/^[A-Z0-9]{6}$/.test(senderId) || !phone) {
      throw new MSG91DeliveryError('A provider requestId, six-character senderId, and recipient phone are required.');
    }
    const rawStatus = scalar(report, ['status', 'eventName', 'event', 'desc']).toLowerCase();
    const status: MSG91DeliveryReport['status'] | undefined = ['0', 'sent'].includes(rawStatus) ? 'sent'
      : ['1', 'delivered'].includes(rawStatus) ? 'delivered'
        : ['2', '9', '16', '17', '20', '25', 'failed', 'rejected', 'blocked', 'ndnc', 'country blocked'].includes(rawStatus) ? 'failed' : undefined;
    if (!status) throw new MSG91DeliveryError('The SMS delivery status is unsupported.');
    return {
      requestId, senderId, phone, status,
      occurredAt: timestamp(scalar(report, ['deliveryTime', 'date', 'ts', 'timestamp'])),
      ...(status === 'failed' ? { failureReason: (redactWebhookText(scalar(report, ['failureReason', 'failedReason', 'desc'])) || 'MSG91 reported that SMS delivery failed.').slice(0, 500) } : {}),
    };
  });
}

export async function processMSG91DeliveryReports(userId: number, payload: unknown) {
  const scope = currentBusinessScope();
  if (!scope || scope.userId !== userId) throw new MSG91DeliveryError('A business-bound SMS callback is required.', 403, 'SMS_CALLBACK_SCOPE_REQUIRED');
  const reports = normalizeMSG91DeliveryReports(payload);
  let automationMatchesTotal=0;
  const outcome=await db.transaction(async (tx: Pick<NodePgDatabase, 'execute'>) => {
    let matched = 0;
    let unmatched = 0;
    let duplicates = 0;
    for (const report of reports) {
      const receiptKey = createHash('sha256').update(`${userId}:${scope.businessProfileId}:${report.requestId}:${report.senderId}:${report.phone}:${report.status}`).digest('hex');
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${receiptKey}, 0))`);
      const previous = await tx.execute<{ id: number; processed: boolean }>(sql`
        SELECT id, processed FROM webhook_events
        WHERE user_id = ${userId} AND business_profile_id = ${scope.businessProfileId}
          AND platform = 'msg91' AND payload->>'receiptKey' = ${receiptKey} LIMIT 1
      `);
      if (previous.rows[0]?.processed) { duplicates++; matched++; continue; }
      const occurredAt = (report.occurredAt || new Date()).toISOString();
      const automationMatches=await recordAutomationReceipt(userId,{channel:'sms',accountId:report.senderId,messageId:report.requestId,
        status:report.status,occurredAt:report.occurredAt,recipient:report.phone},tx);
      automationMatchesTotal+=automationMatches;
      const smsRecipient = sql`COALESCE(NULLIF(m.metadata->>'smsRecipient', ''),
        NULLIF(m.metadata->'outreachCreation'->'delivery'->>'phone', ''), NULLIF(c.external_thread_id, ''), l.phone)`;
      const inbox = await tx.execute(sql`
        UPDATE outreach_messages m SET
          status = CASE WHEN m.status IN ('delivered', 'read') THEN m.status
            WHEN m.status = 'failed' AND ${report.status} = 'sent' THEN m.status ELSE ${report.status} END,
          delivered_at = CASE WHEN ${report.status} = 'delivered' THEN COALESCE(m.delivered_at, ${occurredAt}::timestamp) ELSE m.delivered_at END,
          failed_at = CASE WHEN ${report.status} = 'delivered' THEN NULL
            WHEN ${report.status} = 'failed' AND m.status NOT IN ('delivered', 'read') THEN COALESCE(m.failed_at, ${occurredAt}::timestamp) ELSE m.failed_at END,
          error_message = CASE WHEN m.status IN ('delivered', 'read') THEN m.error_message
            WHEN ${report.status} = 'failed' THEN ${report.failureReason || null}
            WHEN ${report.status} = 'delivered' THEN NULL ELSE m.error_message END,
          updated_at = NOW()
        FROM outreach_conversations c, leads l
        WHERE m.conversation_id = c.id AND c.lead_id = l.id AND c.channel = 'sms' AND m.direction = 'outbound'
          AND m.user_id = ${userId} AND c.user_id = ${userId} AND l.user_id = ${userId}
          AND m.business_profile_id = ${scope.businessProfileId} AND c.business_profile_id = ${scope.businessProfileId} AND l.business_profile_id = ${scope.businessProfileId}
          AND (m.provider_message_id = ${report.requestId} OR m.external_message_id = ${report.requestId})
          AND (COALESCE(m.provider_account_id, c.provider_account_id) IS NULL OR COALESCE(m.provider_account_id, c.provider_account_id) = ${report.senderId})
          AND (regexp_replace(${smsRecipient}, '[^0-9]', '', 'g') = ${report.phone}
            OR (length(regexp_replace(${smsRecipient}, '[^0-9]', '', 'g')) = 10
              AND '91' || regexp_replace(${smsRecipient}, '[^0-9]', '', 'g') = ${report.phone}))
        RETURNING m.id
      `);
      // Reviewed campaigns retain the actual destination and account on the
      // job. Never substitute an edited CRM number for that delivery snapshot.
      const history = await tx.execute(sql`
        UPDATE sent_messages m SET
          delivery_status = CASE WHEN m.delivery_status IN ('delivered', 'read') THEN m.delivery_status
            WHEN m.delivery_status = 'failed' AND ${report.status} = 'sent' THEN m.delivery_status ELSE ${report.status} END,
          status = CASE WHEN m.status IN ('delivered', 'read') THEN m.status
            WHEN m.status = 'failed' AND ${report.status} = 'sent' THEN m.status ELSE ${report.status} END,
          delivered_at = CASE WHEN ${report.status} = 'delivered' THEN COALESCE(m.delivered_at, ${occurredAt}::timestamp) ELSE m.delivered_at END,
          updated_at = NOW()
        FROM leads l
        WHERE m.lead_id = l.id AND m.channel = 'sms' AND m.message_id = ${report.requestId}
          AND m.user_id = ${userId} AND l.user_id = ${userId}
          AND m.business_profile_id = ${scope.businessProfileId} AND l.business_profile_id = ${scope.businessProfileId}
          AND (
            (m.campaign_id IS NULL AND (regexp_replace(l.phone, '[^0-9]', '', 'g') = ${report.phone}
              OR (length(regexp_replace(l.phone, '[^0-9]', '', 'g')) = 10 AND '91' || regexp_replace(l.phone, '[^0-9]', '', 'g') = ${report.phone})))
            OR EXISTS (
              SELECT 1 FROM outreach_jobs job
              WHERE job.user_id = ${userId} AND job.business_profile_id = ${scope.businessProfileId}
                AND job.campaign_id = m.campaign_id AND job.lead_id = m.lead_id AND job.channel = 'sms'
                AND job.external_message_id = m.message_id
                AND job.metadata->'deliveryReview'->>'version' = '1'
                AND job.metadata->'deliveryReview'->>'channel' = 'sms'
                AND job.metadata->'deliveryReview'->>'stepNumber' = m.sequence_step::text
                AND job.metadata->'deliveryReview'->>'providerAccountId' = ${report.senderId}
                AND regexp_replace(job.metadata->'deliveryReview'->>'recipient', '[^0-9]', '', 'g') = ${report.phone}
            )
          )
        RETURNING m.id
      `);
      const found = inbox.rows.length > 0 || history.rows.length > 0 || automationMatches>0;
      if (found) matched++; else unmatched++;
      const error = found ? null : 'No tracked SMS matches this provider receipt and recipient.';
      if (previous.rows[0]) {
        await tx.execute(sql`UPDATE webhook_events SET processed = ${found}, error = ${error}
          WHERE id = ${previous.rows[0].id} AND user_id = ${userId} AND business_profile_id = ${scope.businessProfileId}`);
      } else {
        const sanitized = JSON.stringify({ ...(sanitizeWebhookPayload({ ...report, occurredAt }) as Record<string, unknown>), receiptKey });
        await tx.execute(sql`INSERT INTO webhook_events (platform, event_type, user_id, business_profile_id, payload, signature_valid, processed, error)
          VALUES ('msg91', ${`sms_delivery_${report.status}`}, ${userId}, ${scope.businessProfileId}, ${sanitized}::jsonb, TRUE, ${found}, ${error})`);
      }
    }
    return { matched, unmatched, duplicates };
  });
  if(automationMatchesTotal) await notifyAutomationReceiptUpdate(userId);
  return outcome;
}
