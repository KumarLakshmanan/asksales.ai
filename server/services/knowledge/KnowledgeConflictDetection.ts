import { normalizeKnowledgeFactText } from './KnowledgeFactNormalization.js';

export interface ComparableKnowledgeEvidence {
  evidenceId: string;
  documentId: number;
  authority: string;
  excerpt: string;
}

function factSentences(excerpt: string): string[] {
  return normalizeKnowledgeFactText(excerpt).split(/\n+|;|(?<=[.!?])\s+/u);
}

/** Recorded diagnostics may only be cleared after an untruncated comparison. */
export function knowledgeConflictTextFullyCompared(excerpt: string): boolean {
  return factSentences(excerpt).length <= 200;
}

/** Identify narrow, directly comparable disagreements; never choose a winner.
 * This intentionally does not claim semantic conflict detection for arbitrary
 * paraphrases. Different product names, units and qualifications remain distinct.
 * Publication supplies a candidate document; retrieval keeps the default all-pairs check.
 */
export function conflictingKnowledgeEvidence(
  evidence: ComparableKnowledgeEvidence[],
  candidateDocumentId?: number,
): Set<string> {
  const bySubject = new Map<
    string,
    Array<{ item: ComparableKnowledgeEvidence; values: string }>
  >();
  const conflicts = new Set<string>();
  for (const item of evidence) {
    const sentences = factSentences(item.excerpt).slice(0, 200);
    for (const sentence of sentences) {
      const normalized = sentence
        .replace(/\b(?:does|do|is|are)\s+not\s+/g, 'not ')
        .replace(/\b(?:has|have)\b/g, 'have')
        .replace(/[^\p{L}\p{N} .%-]+/gu, ' ')
        .trim();
      const numbers = normalized.match(/\b\d+(?:\.\d+)?\b/g) || [];
      const negative =
        /\b(?:no|not|never|without|cannot|unavailable|excluded)\b/.test(
          normalized,
        );
      if (
        !numbers.length &&
        !/\b(?:have|included|available|allowed|permitted|required)\b/.test(
          normalized,
        )
      )
        continue;
      const subject = normalized
        .replace(/\b\d+(?:\.\d+)?\b/g, '#')
        .replace(
          /\b(?:no|not|never|without|cannot|unavailable|excluded)\b/g,
          '',
        )
        .replace(/[.!?]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (subject.split(' ').length < 4) continue;
      const key = `${item.authority}:${subject}`;
      const values = JSON.stringify({ numbers, negative });
      const prior = bySubject.get(key) || [];
      for (const other of prior) {
        if (
          other.item.documentId !== item.documentId &&
          (candidateDocumentId === undefined ||
            item.documentId === candidateDocumentId ||
            other.item.documentId === candidateDocumentId) &&
          other.values !== values
        ) {
          conflicts.add(other.item.evidenceId);
          conflicts.add(item.evidenceId);
        }
      }
      prior.push({ item, values });
      bySubject.set(key, prior);
    }
  }
  return conflicts;
}
