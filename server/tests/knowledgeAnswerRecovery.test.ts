import { describe, expect, it } from '@jest/globals';
import { buildAtomicClaimEvidence, recoverSupportedKnowledgeAnswer, verifyKnowledgeClaims } from '../services/knowledge/KnowledgeClaimVerifier.js';
import type { KnowledgeRetrievalResult, KnowledgeRisk } from '../services/knowledge/types.js';

const fact = 'The Club Room accommodates 2 adults with an optional extra bed.';
const retrieval: KnowledgeRetrievalResult = {
  status: 'sufficient', indexVersion: 'test',
  diagnostics: { queryFingerprint: 'test', candidateCount: 1, reranked: false, latencyMs: 1 },
  evidence: [{ evidenceId: 'authorized', documentId: 1, versionId: 1, chunkId: '1',
    title: 'Published room guide', excerpt: fact, authority: 'owner', scores: { fused: 1 } }],
};
function input(addition: string, risk: KnowledgeRisk = 'low') {
  return { audience: 'customer' as const, risk, retrieval,
    claims: buildAtomicClaimEvidence({ replyText: `${fact}\n${addition}`, retrieval }) };
}

describe('verified-fact recovery for low-risk FAQs', () => {
  it('recovers an FAQ after the canonical read-only knowledge tool succeeds', () => {
    const toolOutcomes = [{ name: 'answer_from_knowledge_base', args: {}, status: 'success' as const, success: true,
      confirmedSideEffect: false, reconciliationStatus: 'not_required' as const,
      result: { success: true, grounding_status: 'sufficient', knowledge: fact, sources: retrieval.evidence } }];
    const claims = buildAtomicClaimEvidence({ replyText: `${fact}\nThe room is 690 square feet.`, retrieval, toolOutcomes });
    expect(claims[0].origin).toBe('knowledge');
    expect(recoverSupportedKnowledgeAnswer({ claims, retrieval, toolOutcomes, audience: 'customer', risk: 'low' })?.replyText).toBe(fact);
    expect(recoverSupportedKnowledgeAnswer({ claims, retrieval,
      toolOutcomes: [{ ...toolOutcomes[0], name: 'create_booking' }], audience: 'customer', risk: 'low' })).toBeNull();
  });
  it('grounds owner attachment descriptions only in the low-risk internal reference lane', () => {
    const referenceEvidence = [{ source: 'user_upload:synthetic-file', excerpt: fact }];
    const claims = buildAtomicClaimEvidence({ replyText: fact, referenceEvidence, audience: 'internal', risk: 'low' });
    expect(claims[0]).toMatchObject({ origin: 'reference', evidenceIds: ['user_upload:synthetic-file'] });
    expect(verifyKnowledgeClaims({ claims, referenceEvidence, audience: 'internal', risk: 'low' }).mayDeliver).toBe(true);
    expect(verifyKnowledgeClaims({ claims, referenceEvidence, audience: 'customer', risk: 'low' }).mayDeliver).toBe(false);
    expect(verifyKnowledgeClaims({ claims, referenceEvidence, audience: 'internal', risk: 'transactional' }).unsupportedClaims).toEqual([fact]);
    expect(buildAtomicClaimEvidence({ replyText: fact, referenceEvidence, audience: 'customer', risk: 'low' })[0].origin).toBe('knowledge');
  });
  it('cannot authorize a booking or an unsupported policy from an uploaded reference', () => {
    const referenceEvidence = [{ source: 'user_upload:synthetic-file', excerpt: 'Your booking is confirmed.' }];
    const claims = buildAtomicClaimEvidence({ replyText: 'Your booking is confirmed.', referenceEvidence, audience: 'internal', risk: 'low' });
    expect(verifyKnowledgeClaims({ claims, referenceEvidence, audience: 'internal', risk: 'low' }).unsupportedClaims).toEqual(['Your booking is confirmed.']);
    const policy = buildAtomicClaimEvidence({ replyText: 'All refunds are guaranteed.', referenceEvidence, audience: 'internal', risk: 'low' });
    expect(verifyKnowledgeClaims({ claims: policy, referenceEvidence, audience: 'internal', risk: 'low' }).unsupportedClaims).toEqual(['All refunds are guaranteed.']);
  });
  it('drops independent unsupported additions, not the evidence checks', () => {
    const original = input('The room is 690 square feet. For a group of 9 adults, you would require multiple rooms.');
    expect(verifyKnowledgeClaims(original).mayDeliver).toBe(false);
    const recovered = recoverSupportedKnowledgeAnswer(original);
    expect(recovered?.replyText).toBe(fact);
    expect(recovered?.removedClaimIds).toHaveLength(2);
    expect(recovered?.verification.claims.every((claim) => claim.verdict === 'supported')).toBe(true);
    expect(recovered?.verification.answerGrounding).toBe('grounded');
  });

  it.each(['medium', 'high', 'transactional'] as const)('never recovers %s risk', (risk) => {
    expect(recoverSupportedKnowledgeAnswer(input('The room is 690 square feet.', risk))).toBeNull();
  });

  it.each(['insufficient', 'unavailable', 'conflict_detected', 'stale_only', 'access_denied'] as const)(
    'never recovers %s retrieval', (status) => {
      expect(recoverSupportedKnowledgeAnswer({ ...input('The room is 690 square feet.'), retrieval: { ...retrieval, status } })).toBeNull();
    });

  it.each([
    'This is only permitted if the manager approves.',
    'Children must never use this room without supervision.',
    'Your booking is confirmed.',
    'The price is 5000.',
    'The room is not suitable for wheelchair users.',
  ])('does not erase a consequential qualification: %s', (addition) => {
    expect(recoverSupportedKnowledgeAnswer(input(addition))).toBeNull();
  });

  it('cannot turn an empty or wholly unsupported answer into delivery', () => {
    const original = input('The room is 690 square feet.');
    expect(recoverSupportedKnowledgeAnswer({ ...original, claims: original.claims.slice(1) })).toBeNull();
    expect(recoverSupportedKnowledgeAnswer({ ...original, claims: [] })).toBeNull();
  });

  it('does not trust a model-supplied supported verdict or foreign citation', () => {
    const original = input('The room is 690 square feet.');
    expect(recoverSupportedKnowledgeAnswer({ ...original, claims: original.claims.map((claim) => ({
      ...claim, verdict: 'supported', evidenceIds: ['foreign-document'],
    })) })).toBeNull();
  });
});
