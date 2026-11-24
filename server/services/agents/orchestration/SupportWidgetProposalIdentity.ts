import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withTenantKnowledgeTransaction } from '../../knowledge/KnowledgeTenantTransaction.js';

/** Bind an authenticated browser session to its own draft-only customer identity.
 * Never match a claimed email/name to an existing lead. This is not verified
 * contact identity and must not establish an outbound delivery destination. */
export async function resolveWidgetProposalIdentity(input: { userId: number; sessionId: number; token: string; create: boolean }) {
  if (![input.userId,input.sessionId].every(id => Number.isSafeInteger(id) && id > 0) || !input.token) return null;
  return withTenantKnowledgeTransaction(input.userId, async tx => {
    const sessions = await tx.execute(sql`SELECT s.id,s.metadata FROM support_chat_sessions s
      JOIN team_members member ON member.id=s.member_id JOIN support_teams team ON team.id=member.team_id
      WHERE s.id=${input.sessionId} AND s.public_token=${input.token} AND s.session_expires_at>NOW()
        AND s.automation_mode='ai_active' AND s.opted_out_at IS NULL
        AND member.user_id=${input.userId} AND team.user_id=${input.userId}
        AND member.is_active=true AND team.is_active=true
        AND NOT EXISTS(SELECT 1 FROM handoff_queue h WHERE h.user_id=${input.userId}
          AND h.conversation_id=${-input.sessionId} AND h.status IN ('waiting','assigned','in_progress'))
      FOR UPDATE OF s`);
    const session = sessions.rows[0]; if (!session) return null;
    const binding = session.metadata?.widgetProposalIdentity;
    if (binding) {
      if (!Number.isSafeInteger(binding.conversationId) || !Number.isSafeInteger(binding.leadId)) return null;
      const existing = await tx.execute(sql`SELECT c.id FROM outreach_conversations c JOIN leads l ON l.id=c.lead_id
        WHERE c.id=${binding.conversationId} AND c.lead_id=${binding.leadId}
          AND c.user_id=${input.userId} AND l.user_id=${input.userId} AND l.deleted_at IS NULL
          AND c.channel='web' AND c.external_thread_id=${`support-widget:${input.sessionId}`}
          AND c.metadata->>'supportWidgetSessionId'=${String(input.sessionId)}
          AND c.automation_mode='ai_active' AND c.status NOT IN ('closed','unsubscribed')`);
      return existing.rows.length ? { conversationId: Number(binding.conversationId), leadId: Number(binding.leadId) } : null;
    }
    if (!input.create) return null;
    const leads = await tx.execute(sql`INSERT INTO leads(uuid,user_id,source,name,status)
      VALUES(${randomUUID()},${input.userId},'support_widget_proposal','Webchat visitor','new') RETURNING id`);
    const leadId = Number(leads.rows[0].id);
    const conversations = await tx.execute(sql`INSERT INTO outreach_conversations
      (user_id,lead_id,channel,external_thread_id,lead_name,subject,metadata)
      VALUES(${input.userId},${leadId},'web',${`support-widget:${input.sessionId}`},'Webchat visitor',
        'Webchat proposal review',${JSON.stringify({ supportWidgetSessionId: input.sessionId, identity: 'session_only', requiresVerifiedDeliveryContact: true })}::jsonb) RETURNING id`);
    const identity = { conversationId: Number(conversations.rows[0].id), leadId };
    await tx.execute(sql`UPDATE support_chat_sessions SET metadata=COALESCE(metadata,'{}'::jsonb)
      ||${JSON.stringify({ widgetProposalIdentity: identity })}::jsonb WHERE id=${input.sessionId}`);
    return identity;
  });
}
