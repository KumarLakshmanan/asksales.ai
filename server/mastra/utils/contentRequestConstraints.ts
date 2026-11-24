import type { ToolContext } from '../tools/toolRegistry.js';

type ChatMessage = { role: string; content: string; metadata?: unknown };
export type RequestConstraintContext = Pick<ToolContext, 'userId' | 'threadId' | 'savedToolActions' | 'intentAnalysis'>;

/** Resolve an exact AI-selected review against owned state, not user phrases. */
export function scopeGenerationRequest(
  toolName: string,
  messages: ChatMessage[],
  context?: RequestConstraintContext,
): { messages: ChatMessage[]; defaults: Record<string, unknown> } {
  const latest = messages.filter(message => message.role === 'user').at(-1);
  const request = context?.intentAnalysis?.semanticRequest;
  const selected = request?.taskRelation === 'follow_up' && request.generationReviewId !== null
    ? context?.savedToolActions?.find(action => action.widgetId === request.generationReviewId
      && action.toolName === toolName && ['active', 'draft'].includes(action.status)
      && (action.userId === undefined || action.userId === context.userId)
      && (action.threadId === undefined || action.threadId === context.threadId))
    : undefined;
  return { messages: latest ? [latest] : [], defaults: selected?.submittedValues || selected?.formValues || {} };
}

// Email types sent to lists of people who did not write first.
const BULK_EMAIL_TYPES = new Set(['cold_outreach', 'newsletter', 'promotional']);

/**
 * Review-card defaults for an email draft. The card is where the user decides,
 * so it opens with the safe choice and the sender actually used:
 * - Bulk email keeps the unsubscribe link on unless the user switched it off
 *   on an earlier revision of this review; the model's own `false` is not a
 *   user decision.
 * - An empty sender business shows the conversation's business profile, the
 *   same profile the draft is generated against.
 */
export function applyEmailReviewDefaults(
  args: Record<string, unknown>,
  defaults: Record<string, unknown> = {},
  businessName?: string | null,
): Record<string, unknown> {
  const next = { ...args };
  const emailType = typeof next.email_type === 'string' ? next.email_type : 'cold_outreach';
  if (BULK_EMAIL_TYPES.has(emailType) && next.include_unsubscribe === false && defaults.include_unsubscribe !== false) {
    next.include_unsubscribe = true;
  }
  const sender = typeof next.sender_business_name === 'string' ? next.sender_business_name.trim() : '';
  const profileName = typeof businessName === 'string' ? businessName.trim().slice(0, 120) : '';
  if (!sender && profileName) next.sender_business_name = profileName;
  return next;
}

/** Apply validated model constraints and exact saved defaults, never parse prose. */
export function enforceSocialPostMediaConstraints(
  args: Record<string, unknown>,
  _messages: ChatMessage[],
  defaults: Record<string, unknown> = {},
  context?: RequestConstraintContext,
): Record<string, unknown> {
  const constrained = { ...args };
  for (const key of ['auto_generate_image', 'auto_generate_video', 'include_image_prompt', 'include_video_prompt']) {
    if (typeof defaults[key] === 'boolean') constrained[key] = defaults[key];
  }
  if (typeof defaults.post_format === 'string') constrained.post_format = defaults.post_format;
  if (typeof defaults.length === 'string') constrained.length = defaults.length;
  if (typeof defaults.cta_text === 'string') constrained.cta_text = defaults.cta_text;
  const generation = context?.intentAnalysis?.semanticRequest?.generation;
  if (!generation) return constrained;
  if (generation.format !== null) constrained.post_format = generation.format;
  for (const kind of ['image', 'video'] as const) {
    const enabled = generation.format === 'text' ? false : generation[kind];
    if (enabled !== null) {
      constrained[`auto_generate_${kind}`] = enabled;
      constrained[`include_${kind}_prompt`] = enabled;
    }
  }
  if (generation.exactCta !== null) constrained.cta_text = generation.exactCta;
  if (generation.length != null && (generation.lengthIntent === 'set'
    || (generation.lengthIntent !== 'preserve' && typeof defaults.length !== 'string'))) {
    constrained.length = generation.length;
  }
  return constrained;
}
