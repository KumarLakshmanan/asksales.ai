import { describe, expect, it } from '@jest/globals';
import { buildAtomicClaimEvidence, isEvidenceFreeClarification, verifyKnowledgeClaims } from '../services/knowledge/KnowledgeClaimVerifier.js';

describe('question-ending replies cannot bypass grounding', () => {
  it.each([
    'The room accommodates 9 adults. Would you like to book?',
    'The room accommodates 9 adults, would you like to book?',
    'Your payment is confirmed. Which date would you like?',
    'Which of our available rooms would you like?',
    'Which complimentary services would you like?',
    'How many free nights would you like?',
    'Could you confirm our spa is complimentary?',
    'Please share your full name for your confirmed booking.',
    'Please share your full name for the booking enquiry. Your room is reserved.',
  ])('retains factual or presupposed claims in %s', (replyText) => {
    expect(isEvidenceFreeClarification(replyText)).toBe(false);
    const claims = buildAtomicClaimEvidence({ replyText });
    expect(claims.length).toBeGreaterThan(0);
    expect(verifyKnowledgeClaims({ claims, audience: 'customer', risk: 'low' }).mayDeliver).toBe(false);
  });

  it.each(['Which product version are you using?', 'Could you share more details?', 'What dates would you prefer?',
    'Please share your full name for the booking enquiry.', 'Please provide your full name?'])(
    'preserves a standalone information request: %s', (replyText) => {
      expect(isEvidenceFreeClarification(replyText)).toBe(true);
      expect(buildAtomicClaimEvidence({ replyText })).toEqual([]);
    },
  );

  it('does not drop short statements, heading-shaped assertions, or claims beyond position 24', () => {
    const replyText = ['9 guests', 'Payment confirmed:', ...Array.from({ length: 25 }, (_, index) => `The room includes feature ${index}.`)].join('\n');
    const claims = buildAtomicClaimEvidence({ replyText });
    expect(claims).toHaveLength(27);
    expect(claims[0].claim).toBe('9 guests');
    expect(claims[1].claim).toBe('Payment confirmed:');
    expect(claims.at(-1)?.claim).toBe('The room includes feature 24.');
    expect(verifyKnowledgeClaims({ claims, audience: 'customer', risk: 'low' }).mayDeliver).toBe(false);
  });
});
