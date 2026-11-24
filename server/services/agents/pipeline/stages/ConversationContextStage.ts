import { supportConversationContext } from '../../orchestration/SupportConversationMemory.js';
import { sql } from 'drizzle-orm';
import { db } from '../../../../models/db.js';
import { logger } from '../../../../utils/logger.js';
import type { PipelineContext } from '../ChannelGateway.js';
import type { PipelineStage } from '../PipelineStage.js';

function timestamp(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function scopeRowsAfterAiResume(rows: Array<Record<string, unknown>>) {
  const boundaryRow = rows.find((row) => row.ownership_outcome === 'ai_resumed');
  const resumedAt = timestamp(boundaryRow?.ownership_resolved_at);
  if (resumedAt === null) return { rows, resumedAt: null };
  return {
    rows: rows.filter((row) => {
      // These columns store UTC without a timezone. The PostgreSQL driver can
      // interpret them in the process timezone; compare the database epoch
      // instead so a non-UTC worker cannot drop hours of resumed AI history.
      const createdAt = row.created_at_ms != null && Number.isFinite(Number(row.created_at_ms))
        ? Number(row.created_at_ms) : timestamp(row.created_at);
      return createdAt !== null && createdAt >= resumedAt;
    }),
    resumedAt,
  };
}

/** Loads one bounded, redacted history for every runtime surface that did not
 * supply an already-authorized session context. */
export class ConversationContextStage implements PipelineStage {
  name = 'ConversationContext';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.message.metadata?.publicReply || ctx.message.channel.endsWith('_comment')) {
      // Social comments can share a CRM conversation with private messages.
      // Redaction alone does not make private booking/chat facts public.
      ctx.message.metadata={...ctx.message.metadata,conversationHistory:[],historyStatus:'available'};
      ctx.metadata={...ctx.metadata,historyStatus:'available',memorySourceIds:[]};
      return ctx;
    }
    if (Array.isArray(ctx.message.metadata?.conversationHistory)) return ctx;
    try {
      let rows: Array<Record<string, unknown>> = [];
      const isWidget = ctx.message.metadata?.conversationKind === 'support_widget'
        && ctx.message.conversationId < 0;
      if (isWidget) {
        const sessionId = Math.abs(ctx.message.conversationId);
        const result = await db.execute(sql`
          SELECT scm.role, scm.content, scm.id, scm.created_at,
            (EXTRACT(EPOCH FROM scm.created_at) * 1000)::double precision AS created_at_ms,
            scs.metadata #>> '{ownershipResolution,outcome}' AS ownership_outcome,
            scs.metadata #>> '{ownershipResolution,resolvedAt}' AS ownership_resolved_at
          FROM support_chat_messages scm
          JOIN support_chat_sessions scs ON scs.id = scm.session_id
          JOIN team_members tm ON tm.id = scs.member_id
          WHERE scs.id = ${sessionId}
            AND tm.user_id = ${ctx.message.userId}
            AND (${!Array.isArray(ctx.message.metadata?.turnMessageIds)} OR scm.id < ${Math.min(...(ctx.message.metadata?.turnMessageIds || [Number.MAX_SAFE_INTEGER]))}::bigint)
            AND (${Number(ctx.message.metadata?.widgetMessageId || 0)} = 0 OR scm.id < ${Number(ctx.message.metadata?.widgetMessageId || 0)})
          ORDER BY scm.created_at DESC, scm.id DESC
          LIMIT 80
        `);
        rows = result.rows as Array<Record<string, unknown>>;
      } else if (ctx.message.conversationId > 0) {
        const result = await db.execute(sql`
          SELECT message.direction AS role,
            COALESCE(message.redacted_content, message.content) AS content,
            message.id,
            message.created_at,
            (EXTRACT(EPOCH FROM message.created_at) * 1000)::double precision AS created_at_ms,
            conversation.metadata #>> '{ownershipResolution,outcome}' AS ownership_outcome,
            conversation.metadata #>> '{ownershipResolution,resolvedAt}' AS ownership_resolved_at
          FROM outreach_messages message
          JOIN outreach_conversations conversation
            ON conversation.id = message.conversation_id
           AND conversation.user_id = message.user_id
          WHERE message.user_id = ${ctx.message.userId}
            AND message.conversation_id = ${ctx.message.conversationId}
            AND (${!Array.isArray(ctx.message.metadata?.turnMessageIds)} OR message.id < ${Math.min(...(ctx.message.metadata?.turnMessageIds || [Number.MAX_SAFE_INTEGER]))}::bigint)
            AND ${['whatsapp', 'instagram', 'facebook'].includes(ctx.message.channel.replace(/_comment$/, ''))
              ? sql`(message.direction='inbound' OR message.status IN ('sent','delivered','read')) AND COALESCE(message.metadata->>'deleted','false') <> 'true'`
              : sql`message.status <> 'draft'`}
            AND (${ctx.message.messageId || 0} = 0 OR message.id < ${ctx.message.messageId || 0})
          ORDER BY ${['whatsapp', 'instagram', 'facebook'].includes(ctx.message.channel.replace(/_comment$/, ''))
            ? sql`COALESCE(message.sent_at,message.created_at)` : sql`message.created_at`} DESC, message.id DESC
          LIMIT 80
        `);
        rows = result.rows as Array<Record<string, unknown>>;
      }
      // Messages received while an operator owned the conversation remain in
      // the durable conversation and ticket, but they are not authorization
      // for the AI to answer them after the ticket closes. Start resumed AI
      // context at the recorded ownership-resolution boundary.
      const scoped = scopeRowsAfterAiResume(rows);
      if (scoped.resumedAt !== null) {
        ctx.metadata = {
          ...ctx.metadata,
          ownershipResumed: true,
          historyScopedAfterOwnershipResume: true,
          ownershipResumeBoundary: new Date(scoped.resumedAt).toISOString(),
        };
      }
      const { messages: history, memory } = supportConversationContext(scoped.rows.reverse().map(row => ({ ...row, role: row.role, content: row.content })), 8);
      ctx.message.metadata = { ...ctx.message.metadata, conversationHistory: history, historyStatus: 'available' };
      ctx.metadata = { ...ctx.metadata, historyStatus: 'available', memorySourceIds: memory.references.map(ref => ref.sourceMessageId) };
      if (isWidget && ctx.message.metadata?.dryRun !== true) {
        try {
          await db.execute(sql`UPDATE support_chat_sessions SET summary=${JSON.stringify(memory)}
            WHERE id=${Math.abs(ctx.message.conversationId)} AND member_id IN (SELECT id FROM team_members WHERE user_id=${ctx.message.userId})`);
        } catch (error) {
          logger.warn({ err: error, conversationId: ctx.message.conversationId }, '[ConversationContextStage] Optional memory cache unavailable');
        }
      }
    } catch (error) {
      logger.warn({ err: error, conversationId: ctx.message.conversationId }, '[ConversationContextStage] History lookup unavailable');
      ctx.message.metadata = { ...ctx.message.metadata, conversationHistory: [], historyStatus: 'unavailable' };
      ctx.metadata = { ...ctx.metadata, historyStatus: 'unavailable' };
    }
    return ctx;
  }
}
