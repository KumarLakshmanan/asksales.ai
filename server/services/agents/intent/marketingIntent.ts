import type { RouterOutput } from '../../../mastra/routerSchema.js';
import { choice } from './decisionContract.js';

export const MARKETING_INTENT_QUESTIONS = { intent: choice(
  'Classify the actual latest marketing goal using the full conversation. Negation and topic changes override historical goals. This is a profile label, never execution authorization.', {
    content_creation: 'Standalone copy, templates, creative assets, or organic posts/publishing. No recipient outreach or paid ads requested.',
    lead_generation: 'Find, review, or select prospects, local businesses, or lead records.',
    outreach: 'Prepare or manage recipient campaigns/sequences; preparing is outreach even if sending is prohibited.',
    performance_marketing: 'Paid ads, paid campaign management, or paid performance analytics.',
    general: 'No specific marketing goal, profile-only work, greeting, or unresolved intent.',
  }) };

/** Only reuse a server-built current-turn router decision. Never accept this
 * value from tool arguments or a request body. Compound goals need their own
 * primary-goal classification rather than an arbitrary first/last agent. */
export function marketingIntentFromRouter(decision?: RouterOutput) {
  if (!decision || decision.needsClarification || decision.action === 'cancel') return undefined;
  const agents = [...new Set(decision.hiredAgents.filter(agent => agent !== 'icp_generation'))];
  if (agents.length !== 1) return undefined;
  const mapping = { content_studio: 'content_creation', lead_generation: 'lead_generation',
    outreach: 'outreach', performance_marketing: 'performance_marketing' } as const;
  return mapping[agents[0] as keyof typeof mapping];
}
