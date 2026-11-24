import type { KnowledgeQuery } from './types.js';
import { normalizeKnowledgeFactText } from './KnowledgeFactNormalization.js';

const FOLLOWUP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'by', 'can', 'could', 'do', 'does', 'earlier', 'for',
  'from', 'give', 'here', 'how', 'i', 'in', 'into', 'is', 'it', 'just', 'me', 'my', 'of', 'on', 'or', 'our',
  'please', 'same', 'tell', 'that', 'the', 'these', 'they', 'this', 'those', 'to', 'turn', 'two', 'use', 'used',
  'using', 'we', 'what', 'when', 'which', 'with', 'would', 'you', 'your', 'above', 'previous', 'previously',
  'draft', 'email', 'message', 'reply', 'format', 'formatted', 'formatting', 'reformat', 'rewrite', 'short',
  'shorter', 'bold', 'heading', 'numbered', 'number', 'list', 'bullet', 'bullets', 'item', 'items', 'line',
  'lines', 'keep', 'published', 'approved', 'knowledge', 'fact', 'facts', 'qualification', 'qualifications',
  'answer', 'customer', 'only', 'every', 'all', 'details', 'information', 'respond', 'response', 'concise',
]);

const REFERENCE_CUE = /\b(?:those|these|that|them|it|above|previous(?:ly)?|earlier|before|same)\b/i;
const PRESENTATION_CUE = /\b(?:format|reformat|rewrite|turn|numbered|bullets?|heading|shorter|summari[sz]e|draft|email|message|reply)\b/i;

function topicTerms(value: string): Set<string> {
  return new Set(normalizeKnowledgeFactText(value).match(/[\p{L}\p{N}]{2,}/gu)
    ?.filter(term => !FOLLOWUP_WORDS.has(term)) || []);
}

/** Pick the user question whose subject best matches a referential follow-up.
 * Assistant replies are deliberately excluded: they can provide presentation
 * context, but never become the retrieval subject or factual evidence. */
export function relevantPriorKnowledgeQuestion(query: KnowledgeQuery): string | null {
  if (!REFERENCE_CUE.test(query.redactedText)) return null;
  const priorQuestions = (query.redactedHistory || [])
    .filter(turn => turn.role === 'user' && turn.content.trim() && !REFERENCE_CUE.test(turn.content))
    .map(turn => turn.content.trim().slice(0, 1_500));
  if (!priorQuestions.length) return null;

  const currentTerms = topicTerms(query.redactedText);
  if (!currentTerms.size) return priorQuestions.at(-1) || null;

  const scored = priorQuestions.map((content, index) => ({
    content,
    index,
    overlap: [...topicTerms(content)].filter(term => currentTerms.has(term)).length,
  })).filter(candidate => candidate.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.index - a.index);
  return scored[0]?.content || null;
}

/** Resolve presentation-only follow-ups for retrieval, not as evidence. The
 * prior user question supplies search terms; every fact must still come from
 * currently authorized published knowledge. Ticket-only lanes provide no history. */
export function contextualKnowledgeQuestion(query: KnowledgeQuery): string {
  const text = query.redactedText;
  if (!REFERENCE_CUE.test(text) || !PRESENTATION_CUE.test(text)) return text;
  const previous = relevantPriorKnowledgeQuestion(query);
  return previous ? `Previous user question: ${previous}\nCurrent request: ${text}` : text;
}
