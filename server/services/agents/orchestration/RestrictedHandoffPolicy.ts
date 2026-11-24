import type { PipelineContext } from '../pipeline/ChannelGateway.js';
import { buildExternalBookingSearchUrl } from '../../booking/ExternalBookingSearchUrl.js';
import { safeExternalBookingUrl } from '../../booking/ExternalBookingUrl.js';
import { confidentSemanticIntent } from './SupportSemanticIntent.js';
import { KNOWLEDGE_UNCERTAINTY_REPLY } from './KnowledgeUncertaintyReply.js';
import { hasCustomerHandoffConsent, prepareHandoffOffer } from './HandoffConsent.js';

export interface RestrictedHandoffPolicy {
  mode: 'customer_requests_only';
  bookingSearchUrl?: string;
}

/** Loaded from the active owner's configuration, never inbound message metadata. */
export function restrictedHandoffPolicy(ctx: PipelineContext): RestrictedHandoffPolicy | null {
  const value = ctx.metadata?.ownerHandoffPolicy;
  return value?.mode === 'customer_requests_only' ? value : null;
}

export function permittedHandoffReason(ctx: PipelineContext): string | null {
  if (hasCustomerHandoffConsent(ctx)) return 'customer_requested_human';
  if (!restrictedHandoffPolicy(ctx)) return 'existing_policy';
  const nlu = ctx.nlu;
  if (!nlu || nlu.classificationConfidence < 0.75 || nlu.riskFactors.includes('classification_unavailable')) return null;
  const request = confidentSemanticIntent(nlu.semanticRequest);
  if (request?.explicit && request.action === 'human') return 'customer_requested_human';
  if (request?.explicit && request.action === 'refund') return 'refund_request';
  const intents = [nlu.intent, ...(nlu.secondaryIntents || [])];
  // A menu selection/consent answer is not itself an explicit person request.
  // The classifier can label ordinary booking answers (for example a callback
  // time) as `speak_to_human`. That label is only a ticket signal when the
  // model confirms an explicit current human request above;
  // otherwise the active playbook must continue collecting its fields.
  if (!ctx.metadata?.activePlaybookSelection && request?.explicit !== false) {
    if (intents.includes('refund_request')) return 'refund_request';
  }
  const severeFactors = ['extreme_dissatisfaction', 'repeated_unresolved_complaint', 'relationship_breakdown', 'chargeback_threat', 'legal_threat', 'brand_damage'];
  // Financial/safety risk and relationship severity are different dimensions.
  // A repeated unresolved breakdown can still be labelled medium financial risk.
  const repeatedBreakdown = ['repeated_unresolved_complaint', 'relationship_breakdown']
    .every(factor => nlu.riskFactors.includes(factor));
  if (intents.includes('complaint') && (['high', 'critical'].includes(nlu.riskLevel) || repeatedBreakdown)
    && nlu.sentiment.label === 'negative' && nlu.sentiment.score <= -0.8
    && nlu.riskFactors.some(factor => severeFactors.includes(factor))) return 'severe_customer_relationship';
  return null;
}

/** Replace rejected drafts with fixed safe copy. Never continue a failed tool,
 * bypass a safety check, forward the rejected draft, or claim staff were notified. */
export function prepareNonHandoffFallback(ctx: PipelineContext, reason: string): void {
  const lower = reason.toLowerCase();
  let replyText = 'I’m having trouble completing that request right now. Please try again shortly.';
  const safetyFailure = /safety|sensitive|privacy|credential|critical risk|moderation|prompt injection|prohibited/.test(lower);
  if (safetyFailure) {
    replyText = 'I can’t safely process that request. Please avoid sharing passwords, one-time codes or full payment-card details.';
    if (ctx.nlu?.riskFactors.some(factor => /self_harm|physical_harm|suicide|credible_violence/.test(factor))
      || /self_harm|credible_violence/.test(lower)) {
      replyText = 'I’m sorry you’re facing this. If you or someone else is in immediate danger, contact local emergency services or someone you trust nearby now.';
    }
  } else if (ctx.nlu?.intent === 'complaint' && /risk policy|human review/.test(lower)) {
    replyText = 'I’m sorry this has been frustrating. Could you tell me what remains unresolved so I can help?';
  } else if (/evidence|verified information|knowledge|confidence|conflicting/.test(lower)) {
    replyText = KNOWLEDGE_UNCERTAINTY_REPLY;
  }
  const policy = restrictedHandoffPolicy(ctx);
  const bookingFailure = /availability|checkout|booking/.test(lower)
    || ['availability.check', 'checkout.continue'].includes(ctx.metadata?.playbookDirective?.capability?.name);
  if (!safetyFailure && bookingFailure && policy?.bookingSearchUrl) {
    const base = safeExternalBookingUrl(policy.bookingSearchUrl);
    if (base) {
      // Strip any unexpected query data; this fallback supports public search only.
      const clean = new URL(base);
      for (const key of [...clean.searchParams.keys()]) if (key !== 'propertyId') clean.searchParams.delete(key);
      clean.hash = '';
      const fields = ctx.metadata?.playbookDirective?.journey?.fields || {};
      const value = (key: string) => fields[key]?.status === 'collected' ? fields[key].value : undefined;
      const url = buildExternalBookingSearchUrl({ baseUrl: clean.toString(),
        checkIn: String(value('stay.checkIn') || ''), checkOut: String(value('stay.checkOut') || ''),
        adults: value('stay.adults'), children: value('stay.children'), rooms: value('stay.rooms'),
        stayType: value('stay.stayType') === 'dayuse' ? 'dayuse' : 'overnight',
      }) || clean.toString();
      replyText = `I couldn’t confirm availability or complete checkout here. You can check current availability and book securely here: ${url}\nNo booking or payment has been confirmed in this chat.`;
    }
  }
  ctx.agentResult = { replyText, confidence: 1, escalated: false, outcome: 'clarification',
    groundingStatus: 'not_required', toolCallsExecuted: [], effectProposals: [] };
  ctx.verifiedMedia = [];
  if (ctx.guardrailResult) ctx.guardrailResult = { ...ctx.guardrailResult, finalText: replyText };
  ctx.metadata = { ...ctx.metadata, handoffSuppressed: { reason, policy: 'customer_requests_only' },
    suppressBusinessEffects: true, mediaOnlyResponse: false,
    ...(ctx.metadata?.playbookDirective ? { playbookDirective: { ...ctx.metadata.playbookDirective, choice: undefined } } : {}),
  };
  if (replyText === KNOWLEDGE_UNCERTAINTY_REPLY) {
    prepareHandoffOffer(ctx, 'I’m not sure about that from the information I have.');
    if (ctx.guardrailResult) ctx.guardrailResult.finalText = ctx.agentResult!.replyText;
  }
}
