import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { currentBusinessScope } from '../../tenancy/businessContext.js';
import { currentBillingScope } from '../../tenancy/billingContext.js';
import type { InsightsAttribution, InsightsPricingSnapshot } from '../../../shared/insightsBilling.js';
import type { InsightChannel, InsightConversationRef } from '../../../shared/insights.js';
import { currentAssistant } from '../assistants/AssistantContext.js';

export interface UsageContext extends InsightsAttribution {
  attemptId: string;
  operationId: string;
  provider: string;
  model: string;
  pricing?: InsightsPricingSnapshot;
  cachedTokens?: number;
  reasoningTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
}
const active = new AsyncLocalStorage<UsageContext>();
export function currentUsageContext() { return active.getStore(); }
export function withUsageContext<T>(context: UsageContext, work: () => T): T { return active.run(context, work); }

export function insightProcess(purpose: string): string {
  if (/follow.?up/i.test(purpose)) return 'follow_up';
  if (/intent|classif|routing/i.test(purpose)) return 'routing';
  if (/compaction|summari/i.test(purpose)) return 'conversation_compaction';
  if (/embed|knowledge/i.test(purpose)) return 'knowledge';
  if (/image|video|media/i.test(purpose)) return 'media';
  if (/lead|icp|enrich|scrap|validation|fit_score/i.test(purpose)) return 'leads';
  if (/visibility|audit|observation/i.test(purpose)) return 'ai_visibility';
  if (/support|reply|outreach|nlu|response/i.test(purpose)) return 'customer_chat';
  if (/content|campaign|ad_|marketing|proposal/i.test(purpose)) return 'content';
  return 'general_chat';
}
export function insightChannel(value: unknown): Exclude<InsightChannel, 'all'> {
  if (value === 'gmail') return 'email';
  if (value === 'messenger') return 'facebook';
  return ['whatsapp', 'instagram', 'facebook', 'email', 'sms', 'widget', 'workspace'].includes(String(value))
    ? value as Exclude<InsightChannel, 'all'> : 'unattributed';
}
export function validConversationRef(value: unknown): InsightConversationRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const ref = value as InsightConversationRef;
  return ['outreach', 'widget', 'workspace'].includes(ref.kind) && Number.isSafeInteger(ref.id) && ref.id > 0
    ? { kind: ref.kind, id: ref.id } : undefined;
}
export function newUsageContext(input: Partial<UsageContext> & Pick<UsageContext, 'provider' | 'model'>): UsageContext {
  const scope = currentBusinessScope();
  const attemptId = input.attemptId || randomUUID();
  const conversation = validConversationRef(input.conversation);
  return { ...input, attemptId, operationId: input.operationId || attemptId, conversation,
    actorUserId: scope?.actorUserId ?? scope?.userId,
    channel: conversation?.kind === 'widget' ? 'widget' : conversation?.kind === 'workspace' ? 'workspace' : insightChannel(input.channel),
  };
}
/** Only this allowlist enters the projection; arbitrary request metadata is not copied. */
export function usageMetadata(metadata?: Record<string, unknown> | null): Record<string, unknown> {
  const context = currentUsageContext();
  const business = currentBusinessScope();
  const base = { ...metadata };
  // This reserved attribution is server-resolved, never accepted from a caller.
  delete base._assistant;
  const assistant = currentAssistant();
  if (assistant && assistant.provenance.businessProfileId === business?.businessProfileId)
    base._assistant = { ...assistant.provenance, preview: assistant.preview };
  if (!context) return base;
  return { ...base, _insights: {
    attemptId: context.attemptId, operationId: context.operationId, conversation: context.conversation,
    channel: context.channel, contactId: context.contactId, agent: context.agent, process: context.process,
    actorUserId: business?.actorUserId ?? business?.userId, organizationId: currentBillingScope()?.organizationId,
    cachedTokens: context.cachedTokens, reasoningTokens: context.reasoningTokens, pricing: context.pricing,
  } };
}
