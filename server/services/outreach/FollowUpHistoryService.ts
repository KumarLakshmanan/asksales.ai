import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import type { FollowUpChannel } from '../../../shared/followUpChannels.js';
import type { FollowUpActivity, FollowUpAuthorityReview } from '../../../shared/followUpActivity.js';

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function id(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null; }
function step(value: unknown): number | null {
  return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647 ? Number(value) : id(value);
}
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function timestamp(value: unknown): string | null { return value instanceof Date ? value.toISOString() : text(value); }
function authorityReview(value: unknown): FollowUpAuthorityReview | null {
  if (!record(value) || !record(value.origin) || !record(value.identity)) return null;
  const origin = value.origin, identity = value.identity;
  if (origin.table !== 'sent_messages' && origin.table !== 'outreach_messages') return null;
  return {
    reason: typeof value.reason === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(value.reason) ? value.reason : null,
    origin: { table: origin.table, messageId: id(origin.messageId), step: step(origin.step), userId: id(origin.userId), businessProfileId: id(origin.businessProfileId) },
    identity: { userId: id(identity.userId), businessProfileId: id(identity.businessProfileId), businessActorUserId: id(identity.businessActorUserId), billingOrganizationId: id(identity.billingOrganizationId), billingActorUserId: id(identity.billingActorUserId) },
  };
}
/** Explicit public projection: never return recipient addresses, entire payloads or diagnostic errors. */
function review(envelope: SQL, table: 'sent_messages' | 'outreach_messages', origin: SQL, ordinal: SQL, owner: SQL, business: SQL): SQL {
  return sql`CASE WHEN ${envelope}->>'state'='review_required' THEN jsonb_build_object(
    'reason',${envelope}->>'reviewReason',
    'origin',jsonb_build_object('table',${table}::text,'messageId',${origin},'step',${ordinal},'userId',${owner},'businessProfileId',${business}),
    'identity',jsonb_build_object('userId',${envelope}->'payload'->'userId','businessProfileId',${envelope}->'payload'->'businessProfileId',
      'businessActorUserId',${envelope}->'payload'->'businessActorUserId','billingOrganizationId',${envelope}->'payload'->'billingOrganizationId',
      'billingActorUserId',${envelope}->'payload'->'billingActorUserId')) ELSE NULL END`;
}
function item(row: Record<string, unknown>): FollowUpActivity {
  return {
    id: Number(row.id), activityKey: String(row.activityKey), kind: row.kind === 'configured_outbox' ? 'configured_outbox' : row.kind === 'conversation' ? 'conversation' : 'historical',
    channel: String(row.channel), leadName: text(row.leadName), subject: text(row.subject), message: text(row.message) ?? '',
    status: String(row.status), deliveryStatus: text(row.deliveryStatus), followUpStep: step(row.followUpStep),
    sentAt: timestamp(row.sentAt), createdAt: timestamp(row.createdAt), scheduledAt: text(row.scheduledAt),
    recordedMessageId: text(row.recordedMessageId), authorityReview: authorityReview(row.authorityReview),
  };
}

export async function readFollowUpActivity(userId: number, channel: FollowUpChannel, limit: number, offset: number): Promise<FollowUpActivity[]> {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) throw new Error('Follow-up history owner does not match the selected business.');
  const business = scope.businessProfileId;
  const pageSize = Math.min(100, Math.max(1, Math.trunc(limit)));
  const pageOffset = Math.max(0, Math.trunc(offset));
  if (channel === 'sms') {
    const outbox = sql`entry.value`;
    const result = await db.execute(sql`SELECT * FROM (
      SELECT s.id,'historical'::text AS kind,'historical:'||s.id::text AS "activityKey",s.lead_name AS "leadName",s.channel,s.subject,s.message,s.status,
        s.delivery_status AS "deliveryStatus",s.follow_up_step::text AS "followUpStep",s.sent_at AS "sentAt",s.created_at AS "createdAt",
        NULL::text AS "scheduledAt",NULLIF(s.message_id,'') AS "recordedMessageId",NULL::jsonb AS "authorityReview"
      FROM sent_messages s WHERE s.user_id=${userId} AND s.business_profile_id=${business} AND s.channel='sms' AND s.is_reply=true AND s.follow_up_step IS NOT NULL
      UNION ALL
      SELECT s.id,'configured_outbox'::text,'configured_outbox:'||s.id::text||':'||entry.key,s.lead_name,s.channel,NULL::text,
        entry.value->'payload'->>'message','review_required'::text,'unconfirmed'::text,entry.key,NULL::timestamp,COALESCE(s.updated_at,s.created_at),NULL::text,NULL::text,
        ${review(outbox,'sent_messages',sql`s.id`,sql`entry.key`,sql`s.user_id`,sql`s.business_profile_id`)}
      FROM sent_messages s CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(s.follow_up_dispatches)='object' THEN s.follow_up_dispatches ELSE '{}'::jsonb END) entry
      WHERE s.user_id=${userId} AND s.business_profile_id=${business} AND s.channel='sms' AND s.is_reply=false AND s.follow_up_dispatches <> '{}'::jsonb AND entry.value->>'state'='review_required'
    ) activity ORDER BY "createdAt" DESC NULLS LAST,id DESC,"activityKey" ASC LIMIT ${pageSize} OFFSET ${pageOffset}`);
    return result.rows.map(item);
  }
  const envelope = sql`m.metadata->'configuredFollowUpDispatch'`;
  const conversation = sql`SELECT m.id,'conversation'::text AS kind,'conversation:'||m.id::text AS "activityKey",c.lead_name AS "leadName",${channel}::text AS channel,
    m.subject,m.content AS message,m.status,
    CASE WHEN m.manual_review_required OR m.provider_call_state='unknown' OR m.error_message LIKE 'Delivery outcome is uncertain%' THEN 'uncertain' ELSE m.status END AS "deliveryStatus",
    m.follow_up_step::text AS "followUpStep",m.sent_at AS "sentAt",m.created_at AS "createdAt",m.metadata->>'scheduledAt' AS "scheduledAt",
    COALESCE(NULLIF(m.provider_message_id,''),NULLIF(m.external_message_id,'')) AS "recordedMessageId",
    ${review(envelope,'outreach_messages',sql`COALESCE(to_jsonb(m.follow_up_origin_message_id),${envelope}->'payload'->'followUpOriginMessageId')`,sql`m.follow_up_step::text`,sql`m.user_id`,sql`m.business_profile_id`)} AS "authorityReview"
    FROM outreach_messages m JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id AND c.business_profile_id=m.business_profile_id
    WHERE m.user_id=${userId} AND m.business_profile_id=${business} AND c.user_id=${userId} AND c.business_profile_id=${business}
      AND ${channel === 'email' ? sql`c.channel IN ('email','gmail')` : sql`c.channel=${channel}`} AND m.direction='outbound' AND m.message_kind='follow_up'`;
  const historicalEmail = sql`SELECT s.id,'historical'::text AS kind,'historical:'||s.id::text AS "activityKey",s.lead_name AS "leadName",s.channel,s.subject,s.message,s.status,
    s.delivery_status AS "deliveryStatus",s.follow_up_step::text AS "followUpStep",s.sent_at AS "sentAt",s.created_at AS "createdAt",NULL::text AS "scheduledAt",NULLIF(s.message_id,'') AS "recordedMessageId",NULL::jsonb AS "authorityReview"
    FROM sent_messages s WHERE s.user_id=${userId} AND s.business_profile_id=${business} AND s.channel='email' AND s.is_reply=true AND s.follow_up_step IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM outreach_messages linked JOIN outreach_conversations linked_conversation
        ON linked_conversation.id=linked.conversation_id AND linked_conversation.user_id=linked.user_id AND linked_conversation.business_profile_id=linked.business_profile_id
        WHERE linked.user_id=${userId} AND linked.business_profile_id=${business} AND linked.message_kind='follow_up'
        AND s.message_id IN (linked.provider_message_id,linked.external_message_id,linked.rfc_message_id))`;
  const result = await db.execute(sql`SELECT * FROM (${conversation} ${channel === 'email' ? sql`UNION ALL ${historicalEmail}` : sql``}) activity
    ORDER BY "createdAt" DESC NULLS LAST,id DESC,"activityKey" ASC LIMIT ${pageSize} OFFSET ${pageOffset}`);
  return result.rows.map(item);
}
