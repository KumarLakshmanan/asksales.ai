import { describe, expect, it } from '@jest/globals';
import { buildAtomicClaimEvidence, verifyKnowledgeClaims } from '../services/knowledge/KnowledgeClaimVerifier.js';
import { contextualKnowledgeQuestion } from '../services/knowledge/KnowledgeFollowup.js';
import { presentPublishedQuote, splitPublishedQuote } from '../services/knowledge/KnowledgeQuoteFormatting.js';
import { buildPublishedQuoteCandidates } from '../services/knowledge/KnowledgeExtractiveAnswer.js';
import { formatMessageForChannel } from '../utils/messageFormatter.js';
import type { KnowledgeQuery, KnowledgeRetrievalResult, VerifiedKnowledgeAnswer } from '../services/knowledge/types.js';

const times = 'Check-In / Check-Out Timings\n• Check-In: 2:00 PM\n• Check-Out: 11:00 AM';
const retrieval: KnowledgeRetrievalResult = { status: 'sufficient', indexVersion: 'test',
  diagnostics: { queryFingerprint: 'test', candidateCount: 1, reranked: false, latencyMs: 0 },
  evidence: [{ evidenceId: 'KB-17', documentId: 17, versionId: 2, chunkId: '1',
    title: 'Approved timing policy', excerpt: times, authority: 'owner', scores: { fused: 1 } }] };
const verification: VerifiedKnowledgeAnswer = { reason: 'verbatim_published_evidence', mayDeliver: true,
  answerGrounding: 'grounded', unsupportedClaims: [], claims: [{ claimId: 'times', claim: times,
    origin: 'knowledge', evidenceIds: ['KB-17'], verdict: 'supported' }] };

describe('live owner chat regressions', () => {
  it('keeps quote presentation idempotent across recovery and owner-controller rendering', () => {
    const request = 'Draft an email with a bold heading and two numbered items.';
    const once = presentPublishedQuote(`24. Check-In / Check-Out Timings\n\n• Check-In: 2:00 PM\n\n• Check-Out: 11:00 AM`, request);
    expect(once).toBe('**Check-In / Check-Out Timings**\n\n1. Check-In: 2:00 PM\n\n2. Check-Out: 11:00 AM');
    expect(presentPublishedQuote(once, request)).toBe(once);
    expect(formatMessageForChannel(presentPublishedQuote(once, request), 'email')).toContain('<strong>Check-In / Check-Out Timings</strong>');
  });
  it.each(['1. Check-in: 2:00 PM\n2. Check-out: 11:00 AM',
    '<ol><li>Check-in: 2:00 PM</li><li>Check-out: 11:00 AM</li></ol>'])(
    'verifies facts rather than HTML or ordinal markers: %s', replyText => {
      const claims = buildAtomicClaimEvidence({ replyText, retrieval });
      expect(claims.map(c => c.claim)).toEqual(['Check-in: 2:00 PM', 'Check-out: 11:00 AM']);
      expect(verifyKnowledgeClaims({ claims, retrieval, audience: 'internal', risk: 'low' }).unsupportedClaims).toEqual([]);
    });
  it('does not let formatting hide a wrong time or invented policy', () => {
    const claims = buildAtomicClaimEvidence({ replyText: '<ol><li>Check-in: 9:00 PM</li><li>All refunds are guaranteed.</li></ol>', retrieval });
    expect(verifyKnowledgeClaims({ claims, retrieval, audience: 'customer', risk: 'low' }).mayDeliver).toBe(false);
  });
  it('decodes HTML entities before separating claims', () => {
    const claims = buildAtomicClaimEvidence({ replyText: '<p>Spa &amp; wellness services cost extra.</p>', retrieval });
    expect(claims.map(c => c.claim)).toEqual(['Spa & wellness services cost extra.']);
  });
  it('uses prior question only as retrieval context, not assistant assertions', () => {
    const query: KnowledgeQuery = { tenantId: 9, purpose: 'support_answer', audience: 'internal', channel: 'web', risk: 'low',
      redactedText: 'Turn those timings into a numbered list.', redactedHistory: [
        { role: 'user', content: 'What are the ORO check-in and check-out times?' },
        { role: 'assistant', content: 'Invented policy: free rooms.' }] };
    expect(contextualKnowledgeQuestion(query)).toContain('ORO check-in and check-out');
    expect(contextualKnowledgeQuestion(query)).not.toContain('free rooms');
    expect(contextualKnowledgeQuestion({ ...query, redactedHistory: [] })).toBe(query.redactedText);
    expect(contextualKnowledgeQuestion({ ...query, redactedText: 'What is the moon-shuttle timetable?' })).toBe('What is the moon-shuttle timetable?');
  });
  it('resolves a formatted email follow-up to the matching older topic across intervening pricing', () => {
    const timingQuestion = 'Chrome QA Sep 23: What are ORO The Estate published check-in and check-out times? Answer in two short lines using approved knowledge only.';
    const pricingQuestion = 'Different question: list every published ORO day-out package price and its GST qualification.';
    const query: KnowledgeQuery = { tenantId: 9, purpose: 'support_answer', audience: 'customer', channel: 'email', risk: 'low',
      redactedText: 'Draft a short customer email using the check-in and check-out times from earlier, with a bold heading and two numbered items.',
      redactedHistory: [
        { role: 'user', content: timingQuestion },
        { role: 'assistant', content: 'Check-In: 2 PM. Check-Out: 11 AM.' },
        { role: 'user', content: 'Please turn those two timings into a numbered list with a bold heading. Keep the same facts.' },
        { role: 'assistant', content: 'Invented unrelated assertion: free day-out packages.' },
        { role: 'user', content: pricingQuestion },
        { role: 'assistant', content: 'The packages cost Rs. 4,299, Rs. 3,499, and Rs. 5,499 plus GST.' },
      ] };
    const resolved = contextualKnowledgeQuestion(query);
    expect(resolved).toContain(timingQuestion);
    expect(resolved).not.toContain(pricingQuestion);
    expect(resolved).not.toContain('free day-out packages');
    expect(resolved).not.toContain('Rs. 4,299');
  });
  it('preserves every catalog paragraph and terms across bounded bubbles', () => {
    const paragraphs = ['Package A: 3499 + GST.', 'Package B: 4299 + GST.', 'Package C: 5499 + GST.', 'Terms & Conditions: prices may change.'];
    const verified = { ...verification, claims: paragraphs.map((claim, i) => ({ ...verification.claims[0], claimId: String(i), claim })) };
    const full = paragraphs.join('\n\n');
    const result = splitPublishedQuote(full, verified, 55)!;
    expect(result.split('|||').every(part => part.length <= 55)).toBe(true);
    for (const paragraph of paragraphs) expect(result).toContain(paragraph);
    expect(splitPublishedQuote(full.replace('3499', '[REDACTED]'), verified, 55)).toBeNull();
    expect(splitPublishedQuote(full, verified, 10)).toBeNull();
  });
  it('renders a verified quote as a heading and numbered list for every preview channel', () => {
    const markdown = presentPublishedQuote(`From the published knowledge base:\n\n${times}`, 'Use a bold heading and numbered list.');
    expect(markdown).toBe('**Check-In / Check-Out Timings**\n1. Check-In: 2:00 PM\n2. Check-Out: 11:00 AM');
    expect(formatMessageForChannel(markdown, 'email')).toContain('<strong>Check-In / Check-Out Timings</strong><br />1.');
    expect(formatMessageForChannel(markdown, 'whatsapp')).toContain('*Check-In / Check-Out Timings*\n1.');
    for (const channel of ['instagram', 'facebook']) {
      expect(formatMessageForChannel(markdown, channel)).not.toContain('*');
      expect(formatMessageForChannel(markdown, channel)).toContain('\n2. Check-Out: 11:00 AM');
    }
  });
  it('uses exact PDF lines for internal quote recovery instead of returning a whole extracted page', () => {
    const excerpt = [
      'ORO THE ESTATE | NANDI HILLS',
      'Oro The Estate • Day Out Packages • Page 2',
      'Terms & Conditions',
      '• Day outing timings: 10:00 AM to 6:00 PM.',
      '• Prices are exclusive of GST.',
    ].join('\n');
    const internal = buildPublishedQuoteCandidates({ evidenceId: 'KB-18', excerpt, audience: 'internal' });
    expect(internal.map(candidate => candidate.text)).toEqual(excerpt.split('\n'));
    expect(internal.filter(candidate => candidate.isTerms).map(candidate => candidate.text)).toEqual([
      'Terms & Conditions',
      '• Day outing timings: 10:00 AM to 6:00 PM.',
      '• Prices are exclusive of GST.',
    ]);
    const customer = buildPublishedQuoteCandidates({ evidenceId: 'KB-18', excerpt, audience: 'customer' });
    expect(customer).toHaveLength(1);
    expect(customer[0].text).toBe(excerpt);
  });
  it('removes fallback boilerplate and preserves requested bullet formatting', () => {
    expect(presentPublishedQuote(`From the published knowledge base:\n\n${times}`, 'Reply with two bullet points.'))
      .toBe(times);
    expect(presentPublishedQuote('From the published knowledge base:\n\nA verified sentence.', 'Reply concisely.'))
      .toBe('A verified sentence.');
    expect(presentPublishedQuote('From the published knowledge base:\n\n• A verified sentence.',
      'Reply as one concise sentence without markdown.'))
      .toBe('A verified sentence.');
    expect(presentPublishedQuote('From the published knowledge base:\n\n• Day outing timings: 10 AM to 6 PM.',
      'Reply with one bold heading and one concise bullet.'))
      .toBe('**Published details**\n• Day outing timings: 10 AM to 6 PM.');
  });
});
