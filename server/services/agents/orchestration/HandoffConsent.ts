import { createHash } from 'node:crypto';
import type { PipelineContext } from '../pipeline/ChannelGateway.js';
import { matchExactPlaybookChoice, type SupportChoiceManifest } from './SupportChoiceDelivery.js';
import { confidentSemanticIntent } from './SupportSemanticIntent.js';

export const HANDOFF_QUESTION = 'Would you like me to connect you with a human support agent?';
export const HANDOFF_FIELD = 'support.handoffConsent';
export const HANDOFF_DECLINE_ACK = 'Okay, I’ll keep helping you here. What would you like to know?';
const HANDOFF_REPLY_HINT = 'Reply Yes to connect, or No to continue chatting with me.';

/** Recognize the fixed server offer, never an owner-defined journey choice. */
export function validatedHandoffChoice(value: unknown): SupportChoiceManifest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const choice = value as SupportChoiceManifest;
  if (choice.schemaVersion !== 1 || choice.fieldKey !== HANDOFF_FIELD || choice.allowFreeText !== true
    || typeof choice.prompt !== 'string' || !choice.prompt.endsWith(HANDOFF_QUESTION)
    || choice.fallbackText !== `${choice.prompt}\n\n${HANDOFF_REPLY_HINT}`
    || !Array.isArray(choice.options) || choice.options.length !== 2
    || !choice.options.every(option => option && typeof option === 'object')) return undefined;
  const [yes, no] = choice.options;
  const token = /^handoff_v1_([a-f0-9]{24})_yes$/.exec(yes.id);
  if (!token || no.id !== `handoff_v1_${token[1]}_no`
    || yes.value !== 'true' || no.value !== 'false' || yes.label !== 'Yes' || no.label !== 'No') return undefined;
  return choice;
}

/** Match presentation of an already trusted manifest, never infer consent evidence from email text. */
export function matchesHandoffOfferReply(reply: string, value: unknown): boolean {
  const choice = validatedHandoffChoice(value);
  if (!choice) return false;
  const displayText = (text: string) => text
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/?p\s*>/gi, '\n')
    .replace(/&nbsp;/gi, ' ').replace(/&rsquo;/gi, '’').replace(/&#39;|&#x27;|&apos;/gi, "'")
    .normalize('NFKC').replace(/\s+/g, ' ').trim();
  return [choice.prompt, choice.fallbackText].some(text => displayText(reply) === displayText(text));
}

/** Only the fixed acknowledgement of a verified, declined current offer can skip classification. */
export function isHandoffDeclineAcknowledgement(ctx: PipelineContext): boolean {
  return !ctx.metadata?.activeHandoff && ctx.metadata?.handoffOfferValidated === true && ctx.metadata?.handoffConsentRejected === true
    && ctx.metadata?.skipAgentGeneration === true && ctx.metadata?.suppressBusinessEffects === true
    && ctx.agentResult?.replyText === HANDOFF_DECLINE_ACK && ctx.agentResult?.handoff?.required === false && ctx.agentResult?.escalated === false
    && !ctx.agentResult?.effectProposals?.length && !ctx.agentResult?.toolCallsExecuted?.length;
}

/** Ambiguous answers restrict permission; these aliases never grant it. */
function bareHandoffAnswer(text: string): boolean | undefined {
  const exact = matchExactPlaybookChoice({ key: HANDOFF_FIELD, type: 'boolean', prompt: HANDOFF_QUESTION, required: true, pii: 'none' }, text);
  if (typeof exact?.value === 'boolean') return exact.value;
  const normalized = text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  const tokens = normalized.split(/\s+/);
  if (!normalized) return undefined;
  if (tokens.every(token => ['no','n','nope','false','do','not','don','t','decline','thanks','thank','you'].includes(token))) return false;
  if (tokens.every(token => ['yes','y','yeah','yep','sure','ok','okay','absolutely','certainly','confirm','confirmed','true','i','agree','please','do','thanks','thank','you','sí','si','oui','ja','ஆம்','ஆமாம்','haan'].includes(token))) return true;
  return undefined;
}

/** Consent comes from the current customer turn, never a refund, risk score,
 * callback consent, generated promise, or caller-supplied metadata. */
export function hasCustomerHandoffConsent(ctx: PipelineContext): boolean {
  if (ctx.metadata?.handoffConsentRejected) return false;
  if (ctx.metadata?.verifiedHandoffConsent === true) return true;
  const answer = bareHandoffAnswer(ctx.message.inboundText || '');
  if (answer === false || (answer === true && ctx.metadata?.handoffOfferValidated !== true)) return false;
  const request = confidentSemanticIntent(ctx.nlu?.semanticRequest);
  return Boolean(ctx.nlu && ctx.nlu.classificationConfidence >= 0.75
    && !ctx.nlu.riskFactors?.includes('classification_unavailable')
    && request?.action === 'human' && request.explicit);
}

export function prepareHandoffOffer(ctx: PipelineContext, preface = 'I can’t complete that request confidently right now.'): void {
  const prompt = `${preface.trim()} ${HANDOFF_QUESTION}`;
  const token = createHash('sha256').update([
    ctx.message.userId, ctx.message.conversationId, ctx.message.channel,
    ctx.message.rawMessageId || ctx.message.messageId || ctx.metadata?.turnId || 'preview',
  ].join(':')).digest('hex').slice(0, 24);
  const choice: SupportChoiceManifest = {
    schemaVersion: 1, fieldKey: HANDOFF_FIELD, prompt,
    fallbackText: `${prompt}\n\n${HANDOFF_REPLY_HINT}`,
    allowFreeText: true,
    options: [
      { id: `handoff_v1_${token}_yes`, value: 'true', label: 'Yes', shortLabel: 'Yes' },
      { id: `handoff_v1_${token}_no`, value: 'false', label: 'No', shortLabel: 'No' },
    ],
  };
  ctx.agentResult = { replyText: prompt, confidence: 1, escalated: false,
    handoff: { required: false }, outcome: 'clarification', groundingStatus: 'not_required',
    effectProposals: [], toolCallsExecuted: [], claimEvidence: [] };
  ctx.verifiedMedia = [];
  ctx.approvedDocument = undefined;
  ctx.metadata = { ...ctx.metadata, handoffChoice: choice, handoffOffer: true,
    suppressBusinessEffects: true, skipAgentGeneration: true, mediaOnlyResponse: false };
  // Do not reuse the interrupted journey's choice or commit its transition.
  if (ctx.metadata.playbookDirective) ctx.metadata.playbookDirective = {
    ...ctx.metadata.playbookDirective, choice: undefined, compliance: { verbatim: prompt },
  };
}

export function isHandoffOffer(ctx: PipelineContext): boolean {
  return ctx.metadata?.handoffOffer === true && ctx.metadata?.suppressBusinessEffects === true
    && ctx.agentResult?.replyText === ctx.metadata?.handoffChoice?.prompt
    && !ctx.agentResult?.effectProposals?.length && !ctx.agentResult?.toolCallsExecuted?.length;
}
