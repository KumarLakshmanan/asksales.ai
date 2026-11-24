import { handoffService } from '../HandoffService.js';
import type { PipelineContext } from '../ChannelGateway.js';
import type { PipelineStage } from '../PipelineStage.js';
import { isEvidenceFreeClarification } from '../../../knowledge/KnowledgeClaimVerifier.js';
import type { ActiveHandoff } from './TicketAwareHandoffStage.js';

// Keep the authoritative ownership notice compact: it shares the channel's
// response budget with verified facts and mandatory source terms.
const TICKET_OPEN_SUFFIX = 'Your support ticket remains open for the team to review.';
const MODEL_TICKET_CLAIM = /\b(?:support ticket|support team|human (?:agent|representative|specialist)|queued|handoff|while you wait)\b/i;

export function stripModelTicketOwnershipClaims(replyText: string): string {
  return replyText
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z])/u))
    .filter((line) => !MODEL_TICKET_CLAIM.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


/** Final deterministic boundary for read-only answers produced during a live
 * handoff. No model-proposed tool or effect survives this stage. Unsupported
 * knowledge is replaced with the existing ticket acknowledgement instead of
 * creating a duplicate ticket. */
export class TicketAwareResponseStage implements PipelineStage {
  name = 'TicketAwareResponse';

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.ticketReadOnlyAnswer !== true) return ctx;
    const handoff = ctx.metadata?.activeHandoff as ActiveHandoff | undefined;
    const result = ctx.agentResult;
    if (!handoff?.id || !result) return ctx;

    const knowledgeFailed = ['insufficient_knowledge', 'retrieval_unavailable', 'conflict_detected', 'stale_only', 'access_denied']
      .includes(String(result.groundingStatus || ''));
    const clarificationOnly = !result.claimEvidence?.length
      && isEvidenceFreeClarification(String(result.replyText || ''));
    const factualVerificationMissing = ctx.nlu?.intent === 'faq'
      && ctx.metadata?.mediaOnlyResponse !== true && !clarificationOnly
      && result.answerVerification?.mayDeliver !== true;
    const verificationFailed = result.answerVerification?.mayDeliver === false || factualVerificationMissing;
    if (result.escalated || knowledgeFailed || verificationFailed) {
      ctx.agentResult = {
        replyText: handoffService.customerAcknowledgement(
          ctx,
          handoff.reason || 'Existing human-owned support request.',
          handoff,
        ),
        intent: ctx.nlu?.intent,
        outcome: 'human_handoff',
        escalated: false,
        confidence: 1,
        confidenceReason: 'The read-only answer was not sufficiently verified; the existing ticket remains authoritative.',
        groundingStatus: 'not_required',
        claimEvidence: [],
        toolCallsExecuted: [],
        effectProposals: [],
      };
      ctx.metadata = {
        ...ctx.metadata,
        ticketReadOnlyFallback: true,
        ticketFollowUpDisposition: 'human_queue',
      };
      return ctx;
    }

    const rawAnswer = String(result.replyText || '');
    const answer = stripModelTicketOwnershipClaims(rawAnswer);
    if (!answer) {
      ctx.agentResult = {
        replyText: handoffService.customerAcknowledgement(
          ctx,
          handoff.reason || 'Existing human-owned support request.',
          handoff,
        ),
        intent: ctx.nlu?.intent,
        outcome: 'human_handoff',
        escalated: false,
        confidence: 1,
        confidenceReason: 'The read-only model response contained no deliverable answer after ticket-claim sanitization.',
        groundingStatus: 'not_required',
        claimEvidence: [],
        toolCallsExecuted: [],
        effectProposals: [],
      };
      ctx.metadata = {
        ...ctx.metadata,
        ticketReadOnlyFallback: true,
        ticketFollowUpDisposition: 'human_queue',
      };
      return ctx;
    }
    result.replyText = answer.includes(TICKET_OPEN_SUFFIX)
      ? answer
      : `${answer}\n\n${TICKET_OPEN_SUFFIX}`.trim();
    result.effectProposals = [];
    result.toolCallsExecuted = [];
    result.escalated = false;
    result.handoff = undefined;
    ctx.agentResult = result;
    ctx.metadata = {
      ...ctx.metadata,
      ticketReadOnlyVerified: result.answerVerification?.mayDeliver === true || ctx.metadata?.mediaOnlyResponse === true,
      ticketModelClaimsSanitized: answer !== rawAnswer.trim(),
      suppressBusinessEffects: true,
    };
    return ctx;
  }
}
