import { sql } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import type { PipelineContext } from '../pipeline/ChannelGateway.js';
import { sanitizeStructuredForModel } from './PrivacyVaultService.js';

/** Called inside the existing effect ledger, only after successful delivery.
 * Preserve enquiries for the owner without a support ticket or ownership change. */
export async function recordNonHandoffEnquiry(ctx: PipelineContext, type: string, payload: Record<string, unknown>): Promise<void> {
  const { userId, conversationId } = ctx.message;
  const entry = { type, details: sanitizeStructuredForModel(payload).value,
    sourceMessageId: ctx.message.messageId || ctx.message.rawMessageId,
    recordedAt: new Date().toISOString(), handoffCreated: false };
  const data = JSON.stringify(entry);
  const result = ctx.message.channel === 'web' && conversationId < 0
    ? await db.execute(sql`
        UPDATE support_chat_sessions s SET metadata=jsonb_set(COALESCE(s.metadata,'{}'::jsonb),
          '{nonHandoffEnquiries}', COALESCE(s.metadata->'nonHandoffEnquiries','[]'::jsonb) || jsonb_build_array(${data}::jsonb)),updated_at=NOW()
        FROM team_members m WHERE s.id=${Math.abs(conversationId)} AND s.member_id=m.id AND m.user_id=${userId} RETURNING s.id`)
    : await db.execute(sql`
        UPDATE outreach_conversations SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),
          '{nonHandoffEnquiries}', COALESCE(metadata->'nonHandoffEnquiries','[]'::jsonb) || jsonb_build_array(${data}::jsonb)),updated_at=NOW()
        WHERE id=${conversationId} AND user_id=${userId} RETURNING id`);
  if (result.rows.length !== 1) throw new Error('The enquiry could not be recorded in its owned conversation.');
  if (conversationId > 0) {
    await db.execute(sql`
      INSERT INTO crm_activities (user_id,contact_id,type,subject,body,outreach_conversation_id,outreach_message_id,metadata,idempotency_key,created_at,updated_at)
      SELECT ${userId},c.id,'support_enquiry',${type === 'callback' ? 'Callback preference recorded (no handoff)' : 'Customer enquiry recorded (no handoff)'},NULL,
        ${conversationId},${ctx.message.messageId || null},${data}::jsonb,
        ${`support-enquiry:${conversationId}:${ctx.message.messageId || ctx.message.rawMessageId}:${type}`},NOW(),NOW()
      FROM outreach_conversations o JOIN crm_contacts c ON c.user_id=o.user_id
        AND (c.id=o.crm_contact_id OR (o.crm_contact_id IS NULL AND c.lead_id=o.lead_id))
      WHERE o.id=${conversationId} AND o.user_id=${userId} AND c.deleted_at IS NULL LIMIT 1
      ON CONFLICT (business_profile_id, user_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`);
  }
}
