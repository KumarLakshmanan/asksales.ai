import { describe, expect, it } from '@jest/globals';
import { buildAtomicClaimEvidence, evidenceSupportsClaim, verifyKnowledgeClaims } from '../services/knowledge/KnowledgeClaimVerifier.js';
import type { KnowledgeRetrievalResult } from '../services/knowledge/types.js';

describe('knowledge claim contradiction boundaries', () => {
  it.each(['general', 'reference'] as const)('does not trust a model-declared %s origin', (origin) => {
    const claim = 'The room accommodates 9 guests.';
    const claims = buildAtomicClaimEvidence({ replyText: claim,
      providedClaims: [{ claimId: 'model', claim, origin, evidenceIds: ['invented'], verdict: 'supported' }] });
    expect(verifyKnowledgeClaims({ claims, audience: 'customer', risk: 'low' }).mayDeliver).toBe(false);
  });

  it('verifies reference text against the authorized lane instead of trusting its verdict', () => {
    const input = { audience: 'customer' as const, risk: 'low' as const,
      claims: [{ claimId: 'c', claim: 'The room accommodates 2 guests.', origin: 'reference' as const,
        evidenceIds: ['authorized_reference'], verdict: 'supported' as const }] };
    expect(verifyKnowledgeClaims({ ...input, referenceEvidence: [{ source: 'other', excerpt: 'The room accommodates 2 guests.' }] }).mayDeliver).toBe(false);
    expect(verifyKnowledgeClaims({ ...input, referenceEvidence: [{ source: 'authorized_reference', excerpt: 'The room accommodates 9 guests.' }] }).mayDeliver).toBe(false);
    expect(verifyKnowledgeClaims({ ...input, referenceEvidence: [{ source: 'authorized_reference', excerpt: 'The room accommodates 2 guests.' }] }).mayDeliver).toBe(true);
  });

  it.each(['general', 'knowledge', 'reference'] as const)('requires a committed tool for completion claims labeled %s', (origin) => {
    expect(verifyKnowledgeClaims({ audience: 'customer', risk: 'low',
      claims: [{ claimId: 'c', claim: 'Your booking is confirmed.', origin, evidenceIds: ['authorized_reference'], verdict: 'supported' }],
      referenceEvidence: [{ source: 'authorized_reference', excerpt: 'Your booking is confirmed.' }],
    }).mayDeliver).toBe(false);
  });

  it.each(['insufficient', 'stale_only', 'unavailable', 'access_denied'] as const)('does not ground retained evidence from a %s retrieval', (status) => {
    const claim = 'The room accommodates 2 guests.';
    const retrieval: KnowledgeRetrievalResult = { status, indexVersion: 'test',
      diagnostics: { queryFingerprint: 'synthetic', candidateCount: 1, reranked: false, latencyMs: 0 },
      evidence: [{ evidenceId: 'KB-1', documentId: 1, versionId: 1, chunkId: '1', title: 'Room facts',
        excerpt: claim, authority: 'tenant_policy', scores: { fused: 1 } }] };
    expect(verifyKnowledgeClaims({ retrieval, audience: 'customer', risk: 'low',
      claims: [{ claimId: 'c', claim, origin: 'knowledge', evidenceIds: ['KB-1'], verdict: 'supported' }],
    }).mayDeliver).toBe(false);
  });

  it.each([
    ['Premium Club Room accommodates 9 guests.', 'Premium Club Room accommodates 2 guests.'],
    ['Premium Club Room accommodates nine guests.', 'Premium Club Room accommodates two guests.'],
    ['Sanctuary Villa has a private pool.', 'Sanctuary Villa does not have a private pool.'],
    ['Sanctuary Villa does not have a private pool.', 'Sanctuary Villa has a private pool.'],
    ['Premium Club Room measures 240 square feet.', 'Premium Club Room measures 1240 square feet.'],
    ['Premium Club Room accommodates 9 guests.', 'Premium Club Room accommodates 2 guests. The villa accommodates 9 guests.'],
  ])('rejects a contradictory claim: %s', (claim, excerpt) => {
    expect(evidenceSupportsClaim(claim, excerpt)).toBe(false);
    const retrieval: KnowledgeRetrievalResult = {
      status: 'sufficient', indexVersion: 'test',
      diagnostics: { queryFingerprint: 'synthetic', candidateCount: 1, reranked: false, latencyMs: 0 },
      evidence: [{ evidenceId: 'KB-1', documentId: 1, versionId: 1, chunkId: '1', title: 'Room facts',
        excerpt, authority: 'tenant_policy', scores: { fused: 1 } }],
    };
    expect(verifyKnowledgeClaims({ retrieval, audience: 'customer', risk: 'low',
      claims: [{ claimId: 'c1', claim, origin: 'knowledge', evidenceIds: ['KB-1'], verdict: 'supported' }],
    }).mayDeliver).toBe(false);
  });

  it.each([
    ['Premium Club Room accommodates 2 guests.', 'Premium Club Room accommodates two guests.'],
    ['Sanctuary Villa has a private pool.', 'Sanctuary Villa has a private pool. Breakfast is not included.'],
    ['Sanctuary Villa does not have a private pool.', 'Sanctuary Villa does not have a private pool.'],
    ['The property measures 1,13,870 square feet.', 'The property measures 113870 square feet.'],
    ['The property measures 240.5 square feet.', 'The property measures 240.5 square feet.'],
  ])('retains matching evidence: %s', (claim, excerpt) => {
    expect(evidenceSupportsClaim(claim, excerpt)).toBe(true);
  });

  it.each([
    ['Day-out hours are 10:00 AM to 6:00 PM unless a day use room is booked.', 'Day outing timings: 10:00 AM to 6:00 PM, unless a day use room is booked.'],
    ['GST is not included in the per-person price.', 'Prices are per person and exclusive of applicable GST.'],
    ['Spa services are chargeable separately.', 'Spa & Wellness services are chargeable separately, with the privilege discount applied.'],
  ])('verifies narrow S7 wording equivalence: %s', (claim, excerpt) => {
    expect(evidenceSupportsClaim(claim, excerpt)).toBe(true);
  });

  it.each([
    ['GST is included in the per-person price.', 'Prices are per person and exclusive of applicable GST.'],
    ['Spa services are included.', 'Spa & Wellness services are chargeable separately, with the privilege discount applied.'],
  ])('keeps S7 inclusion contradictions unsupported: %s', (claim, excerpt) => {
    expect(evidenceSupportsClaim(claim, excerpt)).toBe(false);
  });

  it.each([
    ['Premium Club Room costs INR 999 per night.', false],
    ['Premium Club Room costs INR 116992 per night.', false],
    ['Premium Club Room costs INR 33,984 per night.', false],
    ['Premium Club Room total is INR 16,992.', false],
    ['Premium Club Room costs INR 16,992 per night.', true],
    ['Premium Club Room total is INR 33,984.', true],
    ['Premium Club Room has a private pool.', false],
    ['Room: 9 rooms — Premium Club Room', false],
    ['Room: 1 room — Premium Club Room', true],
  ])('checks the live quote rather than only its room name: %s', (replyText, mayDeliver) => {
    const toolOutcomes = [{ name: 'check_room_availability',
      args: { guests: 2, rooms: 1, check_in: '2026-10-10', check_out: '2026-10-12' },
      result: { success: true, options: [{ name: 'Premium Club Room', price_per_night: 16992, total_price: 33984 }] },
      status: 'success' as const, success: true, confirmedSideEffect: false, reconciliationStatus: 'not_required' as const }];
    expect(verifyKnowledgeClaims({ claims: buildAtomicClaimEvidence({ replyText, toolOutcomes }),
      toolOutcomes, audience: 'customer', risk: 'transactional' }).mayDeliver).toBe(mayDeliver);
  });
});
