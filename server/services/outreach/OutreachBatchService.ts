import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import {
  channelsWithoutReceipts, trackingChannelLabel, type OutreachBatchAdmission, type OutreachBatchSource, type ReceiptSupport,
} from '../../../shared/outreachTracking.js';

const MAX_SKIPPED_REASONS = 50;

export interface OpenOutreachBatch {
  /** Stable per reviewed launch, so a replayed request reuses its record. */
  fingerprint: string;
  channel: string;
  source: OutreachBatchSource;
  requestedCount: number;
  name?: unknown;
  providerAccountId?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  scheduledAt?: Date | null;
  expiresAt?: Date | null;
  preparedOutreachId?: string | null;
}

/** "WhatsApp · spring_sale" unless the sender named the outreach. */
export function outreachBatchName(name: unknown, channel: string, templateName?: string | null): string {
  const given = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  return (given || `${trackingChannelLabel(channel)} · ${templateName || 'Message'}`).slice(0, 200);
}

/** Recipients that were turned away before a message row existed, grouped by the reason shown to the sender. */
export function skippedTally(results: ReadonlyArray<{ status: string; messageId: number; error?: string }>) {
  const reasons: Record<string, number> = Object.create(null);
  let admitted = 0, skipped = 0;
  for (const item of results) {
    if (item.messageId > 0) { admitted++; continue; }
    skipped++;
    const reason = (item.error || 'Could not be queued').slice(0, 200);
    if (reason in reasons || Object.keys(reasons).length < MAX_SKIPPED_REASONS) reasons[reason] = (reasons[reason] || 0) + 1;
    else reasons['Other reasons'] = (reasons['Other reasons'] || 0) + 1;
  }
  return { admitted, skipped, reasons };
}

/** Whether the sending channel reports delivery and read receipts. */
export function receiptSupportFor(channel: string): ReceiptSupport {
  return (channelsWithoutReceipts as readonly string[]).includes(channel) ? 'none' : 'full';
}

const noReceiptChannels = sql.join(channelsWithoutReceipts.map(channel => sql`${channel}`), sql`,`);

/** Creates the record for one outreach launch and returns its id. */
export async function openOutreachBatch(input: OpenOutreachBatch): Promise<string> {
  const scope = requireBusinessScope();
  // Gmail is one way of sending email; tracking reports both as email.
  const channel = input.channel === 'gmail' ? 'email' : input.channel;
  const result = await db.execute(sql`
    INSERT INTO outreach_batches(id,user_id,business_profile_id,name,channel,provider_account_id,template_name,template_language,
      scheduled_at,source,prepared_outreach_id,request_fingerprint,requested_count,expires_at,receipt_support)
    VALUES(${randomUUID()}::uuid,${scope.userId},${scope.businessProfileId},
      ${outreachBatchName(input.name, channel, input.templateName)},${channel},
      ${input.providerAccountId || null},${input.templateName || null},${input.templateLanguage || null},
      ${input.scheduledAt ? input.scheduledAt.toISOString() : null}::timestamptz,${input.source},
      ${input.preparedOutreachId || null}::uuid,${input.fingerprint},${input.requestedCount},
      ${input.expiresAt ? input.expiresAt.toISOString() : null}::timestamptz,${receiptSupportFor(input.channel)})
    ON CONFLICT(business_profile_id,user_id,request_fingerprint) DO UPDATE SET updated_at=now(),
      -- A replay of an interrupted launch is admitting again; a completed one stays completed.
      status=CASE WHEN outreach_batches.status='interrupted' THEN 'admitting' ELSE outreach_batches.status END
    RETURNING id`);
  return String(result.rows[0].id);
}

/** How long a launch may go without a sign of life before tracking reports it as interrupted. */
export const ADMISSION_STALE_MINUTES = 30;

/** Marks a long launch as still alive, so tracking does not report it as interrupted. */
export async function touchOutreachBatch(id: string): Promise<void> {
  const scope = requireBusinessScope();
  await db.execute(sql`UPDATE outreach_batches SET updated_at=now()
    WHERE id=${id}::uuid AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND status='admitting'`);
}

/** Records how admission ended. Counts come from the per-recipient results. */
export async function closeOutreachBatch(id: string, outcome: {
  admission: OutreachBatchAdmission;
  admitted?: number;
  skipped?: number;
  reasons?: Record<string, number>;
}): Promise<void> {
  const scope = requireBusinessScope();
  // An email outreach can go out through more than one mailbox kind; only some of them report receipts.
  const support = sql`(SELECT CASE WHEN COUNT(*)=0 THEN outreach_batches.receipt_support
        WHEN bool_and(c.channel IN(${noReceiptChannels})) THEN 'none'
        WHEN bool_or(c.channel IN(${noReceiptChannels})) THEN 'partial' ELSE 'full' END
      FROM outreach_messages m JOIN outreach_conversations c ON c.id=m.conversation_id
        AND c.user_id=m.user_id AND c.business_profile_id=m.business_profile_id
      WHERE m.batch_id=outreach_batches.id AND m.message_kind='outreach')`;
  await db.execute(sql`
    UPDATE outreach_batches SET status=${outcome.admission},
      admitted_count=COALESCE(${outcome.admitted ?? null}::int,admitted_count),
      skipped_count=COALESCE(${outcome.skipped ?? null}::int,skipped_count),
      skipped_reasons=COALESCE(${outcome.reasons ? JSON.stringify(outcome.reasons) : null}::jsonb,skipped_reasons),
      receipt_support=${outcome.admission === 'queued' ? support : sql`receipt_support`},
      updated_at=now()
    WHERE id=${id}::uuid AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}`);
}
