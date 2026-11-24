import { sql } from 'drizzle-orm';
import { db } from '../../../../models/db.js';
import type { PipelineContext } from '../ChannelGateway.js';
import type { PipelineStage } from '../PipelineStage.js';

const OPT_OUT = /^(?:(?:please\s+)?(?:stop(?:\s+(?:all|messages?|messaging))?|unsubscribe(?:\s+me)?|opt\s+(?:me\s+)?out|cancel\s+(?:all\s+)?messages?|remove\s+me|end\s+messages?|no\s+more\s+messages?|do\s+not\s+(?:message|contact)\s+me|dont\s+(?:message|contact)\s+me|quit))[.!?\s]*$/i;

export function isNormalizedOptOutRequest(value: string): boolean {
  const normalized = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\b(?:don't|do not)\b/g, 'dont')
    .replace(/\s+/g, ' ')
    .trim();
  return OPT_OUT.test(normalized);
}

/** Applies channel-agnostic opt-out before any classifier or generative model. */
export class OptOutStage implements PipelineStage {
  name = 'OptOut';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (!isNormalizedOptOutRequest(ctx.message.inboundText)) return ctx;
    return applyOptOut(ctx);
  }
}

/** Shared implementation: identity, tenant ownership, and the durable mutation
 * are exactly the same for protocol commands and semantic withdrawal. */
export async function applyOptOut(ctx: PipelineContext): Promise<PipelineContext> {

    if (ctx.message.metadata?.dryRun !== true) {
      await db.transaction(async (tx: typeof db) => {
        const modeUpdate = ctx.message.channel === 'web' && ctx.message.conversationId < 0
          ? await tx.execute(sql`
              UPDATE support_chat_sessions scs
              SET automation_mode = 'opted_out', opted_out_at = NOW(), updated_at = NOW()
              FROM team_members tm
              WHERE scs.id = ${Math.abs(ctx.message.conversationId)}
                AND tm.id = scs.member_id
                AND tm.user_id = ${ctx.message.userId}
              RETURNING scs.id
            `)
          : await tx.execute(sql`
              UPDATE outreach_conversations
              SET status = 'unsubscribed', automation_mode = 'opted_out', updated_at = NOW()
              WHERE id = ${ctx.message.conversationId}
                AND user_id = ${ctx.message.userId}
              RETURNING id
            `);
        if (modeUpdate.rows.length !== 1) throw new Error('Opt-out conversation ownership could not be verified.');
        await tx.execute(sql`
          UPDATE handoff_queue
          SET status = 'resolved',
              resolution = 'customer_opt_out',
              resolved_at = NOW(),
              updated_at = NOW(),
              version = version + 1
          WHERE user_id = ${ctx.message.userId}
            AND conversation_id = ${ctx.message.conversationId}
            AND status IN ('waiting', 'assigned', 'in_progress')
        `);
      });
    }
    ctx.agentResult = {
      replyText: ctx.message.metadata?.dryRun === true
        ? 'Opt-out recognized in this test. No contact preferences were changed.'
        : 'You have been unsubscribed from automated messages. You can contact us again at any time if you need support.',
      escalated: false,
      confidence: 1,
    };
    ctx.metadata = {
      ...ctx.metadata,
      skipAgentGeneration: true,
      suppressBusinessEffects: true,
      systemDirective: 'opt_out_confirmation',
    };
    return ctx;
}

/** Runs only after safety/policy and NLU, without an additional provider call.
 * Exact STOP continues to run before models, even during provider outages. */
export class SemanticOptOutStage implements PipelineStage {
  name = 'SemanticOptOut';
  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.skipAgentGeneration || ctx.nlu?.contactPreference !== 'opt_out'
      || ctx.nlu.contactPreferenceVerified !== true
      || !Number.isFinite(ctx.nlu.classificationConfidence) || ctx.nlu.classificationConfidence < 0.95) return ctx;
    return applyOptOut(ctx);
  }
}
