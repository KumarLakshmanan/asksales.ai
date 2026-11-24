import type { KnowledgePurpose } from './types.js';

export const KNOWLEDGE_PURPOSES: readonly KnowledgePurpose[] = [
  'support_answer',
  'outreach_reply',
  'content_draft',
  'proposal',
  'hotel_policy',
  'internal_assist',
] as const;

/**
 * `support_answer` is the shared factual scope used by the legacy knowledge
 * library and by Q&A entries. Purpose-specific scopes narrow newer content,
 * but must not make shared published facts invisible to specialist consumers.
 */
export function retrievalScopesForPurpose(purpose: KnowledgePurpose): KnowledgePurpose[] {
  return purpose === 'support_answer' ? [purpose] : [purpose, 'support_answer'];
}

/** Existing documents are factual sources for every governed product surface;
 * Q&A entries stay limited to conversational and internal assistance. */
export function usageScopesForSourceType(sourceType: string): KnowledgePurpose[] {
  return sourceType === 'qa'
    ? ['support_answer', 'outreach_reply', 'internal_assist']
    : [...KNOWLEDGE_PURPOSES];
}
