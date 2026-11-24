import type { Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { supportChatMessagesTable } from '../../models/supportChatMessages/schema.js';
import { runSupportConversationJob } from '../../services/agents/orchestration/SupportConversationTurn.js';

export async function processSupportWidgetTurn(job: Job) {
  return runSupportConversationJob('process_support_widget_turn', job.data, async input => {
    const session = (await db.execute(sql`SELECT s.*,m.user_id FROM support_chat_sessions s
      JOIN team_members m ON m.id=s.member_id JOIN support_teams t ON t.id=m.team_id
      WHERE s.id=${Number(input.sessionId)} AND m.user_id=${Number(input.userId)}
        AND m.is_active=true AND t.is_active=true AND s.session_expires_at>NOW()`)).rows[0];
    if (!session) throw new Error('Widget session expired or no longer authorized.');
    const [message] = await db.select().from(supportChatMessagesTable).where(and(
      eq(supportChatMessagesTable.id, Number(input.widgetMessageId)), eq(supportChatMessagesTable.sessionId, Number(input.sessionId)),
    )).limit(1);
    if (!message || message.role !== 'user') throw new Error('Owned widget input not found.');
    const stableRequestId = String(message.requestId).replace(/:user$/, '');
    const { generateWidgetReply } = await import('../../controllers/supportWidgetController.js');
    const result = await generateWidgetReply({
      userId: Number(input.userId), sessionId: Number(session.id), sessionPublicToken: session.public_token,
      userMsg: message, stableRequestId, assistantRequestId: `${stableRequestId}:assistant`,
      guestName: String(session.metadata?.visitorName || 'Guest'),
      currentSession: { leadId: session.lead_id, ticketId: session.ticket_id, metadata: session.metadata },
      protectedInbound: { redactedText: input.inboundText, vaultId: input.privacyPreprotected?.vaultId || null,
        tokenCount: input.privacyPreprotected?.tokenCount || 0, piiTypes: input.privacyPreprotected?.piiTypes || [] },
    });
    return { success: result.success, method: result.data.assistantMessage ? 'ai_reply' : 'no_op', messageId: result.data.assistantMessage?.id || null };
  });
}
