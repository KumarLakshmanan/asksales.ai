import type { Intent } from '../../NLUService.js';
import { handoffService } from '../HandoffService.js';
import type { PipelineContext } from '../ChannelGateway.js';
import type { PipelineStage } from '../PipelineStage.js';

const READ_ONLY_INTENTS = new Set<Intent>(['greeting', 'faq', 'smalltalk']);

export type ActiveHandoff = {
  id: number;
  slaDeadline?: Date | string | null;
  assignedMemberId?: number | null;
  status?: string | null;
  reason?: string | null;
};

/**
 * An open ticket pauses business actions and journey progression, but it must
 * not make the assistant useless for a separate, low-risk read-only question.
 * Safety and NLU run first. Only the deliberately small intent allowlist below
 * may continue to evidence retrieval and generation; every other request keeps
 * the existing human-ownership acknowledgement.
 */
export class TicketAwareHandoffStage implements PipelineStage {
  name = 'TicketAwareHandoff';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.skipAgentGeneration && ctx.agentResult) return ctx;
    const handoff = ctx.metadata?.activeHandoff as ActiveHandoff | undefined;
    if (!handoff?.id) return ctx;

    const nlu = ctx.nlu;
    const readOnlyAllowed = Boolean(
      nlu
      && READ_ONLY_INTENTS.has(nlu.intent)
      && nlu.riskLevel === 'low'
      && nlu.needsHuman !== true,
    );

    if (!readOnlyAllowed) {
      ctx.agentResult = {
        replyText: handoffService.customerAcknowledgement(
          ctx,
          handoff.reason || 'Existing human-owned support request.',
          handoff,
        ),
        intent: nlu?.intent,
        outcome: 'human_handoff',
        escalated: false,
        confidence: 1,
        confidenceReason: 'An active ticket owns non-read-only follow-up requests.',
        groundingStatus: 'not_required',
        claimEvidence: [],
        toolCallsExecuted: [],
        effectProposals: [],
      };
      ctx.metadata = {
        ...ctx.metadata,
        skipAgentGeneration: true,
        suppressBusinessEffects: true,
        systemDirective: 'handoff_follow_up_acknowledgement',
        ticketFollowUpDisposition: 'human_queue',
      };
      return ctx;
    }

    ctx.contextLanes = {
      ...ctx.contextLanes,
      channelRules: [
        ...(ctx.contextLanes?.channelRules || []),
        'ACTIVE SUPPORT TICKET: Answer only the latest low-risk, read-only question. Use verified knowledge for tenant facts. Do not repeat earlier questions. Do not mention the ticket, support team, human agent, waiting, or handoff; the server appends the authoritative ticket status. Do not claim to resolve or modify the ticket, advance a journey, execute tools, make bookings, accept payments, change account state, or create business effects.',
      ],
    };
    ctx.metadata = {
      ...ctx.metadata,
      ticketReadOnlyAnswer: true,
      suppressBusinessEffects: true,
      suspendPlaybookForHandoff: true,
      ticketFollowUpDisposition: 'read_only_ai',
    };
    return ctx;
  }
}
