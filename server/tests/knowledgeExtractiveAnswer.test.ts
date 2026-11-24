import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { KnowledgeQuery, KnowledgeRetrievalResult, KnowledgeEvidence } from '../services/knowledge/types.js';

const chat = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const revalidate = jest.fn<(_query: KnowledgeQuery, evidence: KnowledgeEvidence[]) => Promise<KnowledgeEvidence[]>>();
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({ knowledgeGateway: { revalidateEvidence: revalidate } }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({
  LLMProviderFactory: { createChatCompletionWithFallback: chat },
}));
const { recoverExtractiveKnowledgeAnswer, isStandalonePublishedHeading } = await import('../services/knowledge/KnowledgeExtractiveAnswer.js');
const times = 'Check-In / Check-Out Timings\n• Check-In: 2:00 PM\n• Check-Out: 11:00 AM';
const retrieval: KnowledgeRetrievalResult = {
  status: 'sufficient', indexVersion: 'test',
  diagnostics: { queryFingerprint: 'test', candidateCount: 1, reranked: false, latencyMs: 1 },
  evidence: [{ evidenceId: 'KB-1', documentId: 1, versionId: 1, chunkId: '1',
    title: 'Approved guide', excerpt: times, authority: 'tenant_policy', scores: { fused: 1 } }],
};
const query: KnowledgeQuery = { tenantId: 9, redactedText: 'What are the check-in and check-out times?',
  risk: 'low', purpose: 'support_answer', audience: 'customer', channel: 'instagram' };
const input = { query, retrieval };
beforeEach(() => {
  chat.mockReset().mockResolvedValue({ success: true, content: '{"paragraphIds":["KB-1:published:0"]}' });
  revalidate.mockReset().mockImplementation(async (_query, evidence) => evidence);
});

describe('verbatim published FAQ recovery', () => {
  it('rejects an English quote fallback for a Tamil request even when its facts are correct', async () => {
    chat.mockResolvedValueOnce({ success: true, content: '{"paragraphIds":["KB-1:published:0"],"restrictionsSatisfied":true}' })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true, content: '{"answersQuestion":true,"restrictionsSatisfied":true,"languageMatchesQuestion":false,"confidence":0.99}' });
    expect(await recoverExtractiveKnowledgeAnswer({ ...input, query: { ...query, redactedText: 'செக்-இன் நேரம் என்ன?' },
      answerRestrictions: ['Answer in the latest question language.'] })).toBeNull();
  });
  it('answers standalone FAQs with two verified model calls and revalidates publication after review', async () => {
    const excerpt = 'Check-in is at 2:00 PM.';
    chat.mockResolvedValueOnce({ success: true, content: JSON.stringify({ paragraphIds: ['KB-1:published:0'], restrictionsSatisfied: true, answer: excerpt, sourceAnswer: excerpt }) })
      .mockResolvedValueOnce({ success: true, content: '{"supported":true,"complete":true,"natural":true,"languageMatchesQuestion":true,"confidence":0.99}' });
    const result = await recoverExtractiveKnowledgeAnswer({ query: { ...query, redactedText: 'When is check-in?' },
      retrieval: { ...retrieval, evidence: [{ ...retrieval.evidence[0], excerpt }] },
      draftWithSelection: true, answerRestrictions: ['Do not promise early check-in.'] });
    expect(result?.replyText).toBe(excerpt);
    expect(result?.verification.reason).toBe('verified_natural_knowledge_answer');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(revalidate).toHaveBeenCalledTimes(2);
    for (const call of chat.mock.calls) expect(call[1]).toEqual(expect.objectContaining({ messages: expect.arrayContaining([
      expect.objectContaining({ role: 'system', content: expect.stringContaining('Do not promise early check-in.') }),
    ]) }));
  });
  it('rejects a fast FAQ answer when publication changes during generation', async () => {
    const excerpt = 'Check-in is at 2:00 PM.';
    chat.mockResolvedValueOnce({ success: true, content: JSON.stringify({ paragraphIds: ['KB-1:published:0'], restrictionsSatisfied: true, answer: excerpt }) })
      .mockResolvedValueOnce({ success: true, content: '{"supported":true,"complete":true,"natural":true,"languageMatchesQuestion":true,"confidence":0.99}' });
    revalidate.mockImplementationOnce(async (_query, evidence) => evidence).mockResolvedValueOnce([]);
    expect(await recoverExtractiveKnowledgeAnswer({ query: { ...query, redactedText: 'When is check-in?' },
      retrieval: { ...retrieval, evidence: [{ ...retrieval.evidence[0], excerpt }] }, draftWithSelection: true })).toBeNull();
  });
  it('never delivers an unsupported fast rewrite and does not generate it twice', async () => {
    chat.mockResolvedValueOnce({ success: true, content: '{"paragraphIds":["KB-1:published:0"],"restrictionsSatisfied":true,"answer":"Check-in is at 9:00 PM."}' })
      .mockResolvedValueOnce({ success: true, content: '{"answersQuestion":true,"restrictionsSatisfied":true,"languageMatchesQuestion":true,"confidence":0.99}' });
    const result = await recoverExtractiveKnowledgeAnswer({ ...input, draftWithSelection: true,
      answerRestrictions: ['Use only confirmed times.'] });
    expect(result?.replyText).toBe(times);
    expect(result?.replyText).not.toContain('9:00 PM');
    expect(chat).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, false, 'true'])('does not promote a quote without explicit restriction compliance: %s', async restrictionsSatisfied => {
    chat.mockResolvedValue({ success: true, content: JSON.stringify({ paragraphIds: ['KB-1:published:0'], restrictionsSatisfied }) });
    const result = await recoverExtractiveKnowledgeAnswer({ ...input,
      answerRestrictions: ['Breakfast hours are unconfirmed; do not quote them.'] });
    expect(result).toBeNull();
    expect(chat).toHaveBeenCalledWith(9, expect.objectContaining({ messages: expect.arrayContaining([
      expect.objectContaining({ role: 'system', content: expect.stringContaining('Breakfast hours are unconfirmed') }),
    ]) }));
  });
  it('does not bypass account restrictions during a provider outage', async () => {
    chat.mockResolvedValue({ success: false });
    expect(await recoverExtractiveKnowledgeAnswer({ ...input,
      answerRestrictions: ['Confirm service hours before answering.'] })).toBeNull();
    expect(revalidate).not.toHaveBeenCalled();
  });
  it('does not dump source paragraphs after a restricted natural-answer review fails', async () => {
    chat.mockResolvedValueOnce({ success: true, content: '{"paragraphIds":["KB-1:published:0"],"restrictionsSatisfied":true}' })
      .mockResolvedValue({ success: false });
    expect(await recoverExtractiveKnowledgeAnswer({ ...input,
      answerRestrictions: ['Answer only the actual timing question.'] })).toBeNull();
  });
  it('allows an exact focused quote only after separate question and restriction review', async () => {
    chat.mockResolvedValueOnce({ success: true, content: '{"paragraphIds":["KB-1:published:0"],"restrictionsSatisfied":true}' })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true, content: '{"answersQuestion":true,"restrictionsSatisfied":true,"languageMatchesQuestion":true,"confidence":0.99}' });
    const result = await recoverExtractiveKnowledgeAnswer({ ...input,
      answerRestrictions: ['Breakfast hours are unconfirmed; do not quote them.'] });
    expect(result?.replyText).toBe(times);
    expect(revalidate).toHaveBeenCalledTimes(3);
  });
  it.each([
    { answersQuestion: false, restrictionsSatisfied: true, confidence: 0.99 },
    { answersQuestion: true, restrictionsSatisfied: false, confidence: 0.99 },
    { answersQuestion: true, restrictionsSatisfied: true, confidence: 0.5 },
  ])('rejects an exact quote with failed final review: %j', async verdict => {
    chat.mockResolvedValueOnce({ success: true, content: '{"paragraphIds":["KB-1:published:0"],"restrictionsSatisfied":true}' })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true, content: JSON.stringify(verdict) });
    expect(await recoverExtractiveKnowledgeAnswer({ ...input,
      answerRestrictions: ['Answer only the timing question.'] })).toBeNull();
  });
  it('preserves verified natural answers with restrictions on every generation and review call', async () => {
    const excerpt = 'Check-in is at 2:00 PM.';
    chat.mockResolvedValueOnce({ success: true, content: '{"paragraphIds":["KB-1:published:0"],"restrictionsSatisfied":true}' })
      .mockResolvedValueOnce({ success: true, content: JSON.stringify({ answer: excerpt }) })
      .mockResolvedValueOnce({ success: true, content: '{"supported":true,"complete":true,"natural":true,"languageMatchesQuestion":true,"confidence":0.99}' });
    const result = await recoverExtractiveKnowledgeAnswer({ query: { ...query, redactedText: 'When is check-in?' },
      retrieval: { ...retrieval, evidence: [{ ...retrieval.evidence[0], excerpt }] },
      answerRestrictions: ['Breakfast hours are unconfirmed; do not quote them.'] });
    expect(result?.replyText).toBe(excerpt);
    expect(chat).toHaveBeenCalledTimes(3);
    for (const [, options] of chat.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ messages: expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: expect.stringContaining('Breakfast hours are unconfirmed') }),
      ]) }));
    }
  });
  it('allows a requested published property identity alongside facts, but never as the entire answer', async () => {
    const identity = 'Cedar Lodge – Property & Sales Information';
    const named = { ...retrieval, evidence: [{ ...retrieval.evidence[0], excerpt: `${identity}\n\n${times}` }] };
    chat.mockResolvedValue({ success: true, content: '{"paragraphIds":["KB-1:published:0","KB-1:published:1"]}' });
    const result = await recoverExtractiveKnowledgeAnswer({ query: { ...query, redactedText: 'Name the property and give its check-in and check-out times.' }, retrieval: named });
    expect(result?.replyText).toContain(identity);
    expect(result?.replyText).toContain(times);
    chat.mockResolvedValue({ success: true, content: '{"paragraphIds":["KB-1:published:0"]}' });
    expect(await recoverExtractiveKnowledgeAnswer({ query, retrieval: named })).toBeNull();
  });
  it('preserves block boundaries so compound owner advice can fit channel limits without losing terms', async () => {
    const lines = ['• Day-out hours: 10 AM to 6 PM unless a day-use room is booked.',
      '• Prices exclude applicable GST.', '• Spa is charged separately.'];
    chat.mockResolvedValue({ success: true, content: JSON.stringify({ paragraphIds: lines.map((_, i) => `KB-1:published:${i}`) }) });
    const result = await recoverExtractiveKnowledgeAnswer({ query: { ...query, audience: 'internal' },
      retrieval: { ...retrieval, evidence: [{ ...retrieval.evidence[0], excerpt: lines.join('\n') }] } });
    expect(result?.replyText).toContain(lines.join('\n\n'));
    expect(result?.verification.claims).toHaveLength(3);
  });
  it('formats verified internal email advice after a topic interruption without weakening evidence checks', async () => {
    chat.mockResolvedValue({ success: true, content: JSON.stringify({ paragraphIds: [0, 1, 2].map(i => `KB-1:published:${i}`) }) });
    const result = await recoverExtractiveKnowledgeAnswer({ query: { ...query, audience: 'internal', channel: 'email',
      redactedText: 'Return to the timings from earlier. Draft an email with a bold heading and numbered items; do not send.',
      redactedHistory: [{ role: 'user', content: 'What are check-in and check-out times?' },
        { role: 'assistant', content: times }, { role: 'user', content: 'Moon shuttle in 2035?' }] }, retrieval });
    expect(result?.replyText).toContain('1. Check-In: 2:00 PM');
    expect(result?.replyText).toContain('2. Check-Out: 11:00 AM');
    expect(result?.verification.unsupportedClaims).toEqual([]);
  });
  it('rewrites the screenshot location excerpt and revalidates after model review', async () => {
    const excerpt = 'Just 30 minutes from Kempegowda International Airport.';
    const reply = 'We’re about 30 minutes from Kempegowda International Airport.';
    chat.mockResolvedValueOnce({ success: true, content: '{"paragraphIds":["KB-1:published:0"]}' })
      .mockResolvedValueOnce({ success: true, content: JSON.stringify({ answer: reply }) })
      .mockResolvedValueOnce({ success: true, content: '{"supported":true,"complete":true,"natural":true,"languageMatchesQuestion":true,"confidence":0.99}' });
    const result = await recoverExtractiveKnowledgeAnswer({ query: { ...query, redactedText: 'where is this located ?' },
      retrieval: { ...retrieval, evidence: [{ ...retrieval.evidence[0], excerpt }] } });
    expect(result?.replyText).toBe(reply);
    expect(result?.verification.reason).toBe('verified_natural_knowledge_answer');
    expect(revalidate).toHaveBeenCalledTimes(2);
  });
  it('does not deliver facts withdrawn during natural generation', async () => {
    revalidate.mockImplementationOnce(async (_query, evidence) => evidence).mockResolvedValueOnce([]);
    expect(await recoverExtractiveKnowledgeAnswer(input)).toBeNull();
  });
  it.each(['ORO Resort – Property & Sales Information', '12. Available Activities & Facilities', '20. Unique Selling Points', 'Page 3'])('does not certify a heading-only answer: %s', async heading => {
    const result = await recoverExtractiveKnowledgeAnswer({ ...input,
      retrieval: { ...retrieval, evidence: [{ ...retrieval.evidence[0], excerpt: heading }] } });
    expect(result).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });
  it('rejects a model-selected heading ID but keeps the factual body eligible', async () => {
    const evidence = [{ ...retrieval.evidence[0], excerpt: '12. Available Activities & Facilities\n\nThe resort has a swimming pool and a badminton court.' }];
    expect(await recoverExtractiveKnowledgeAnswer({ ...input, retrieval: { ...retrieval, evidence } })).toBeNull();
    chat.mockResolvedValue({ success: true, content: '{"paragraphIds":["KB-1:published:1"]}' });
    expect((await recoverExtractiveKnowledgeAnswer({ ...input, retrieval: { ...retrieval, evidence } }))?.replyText).toContain('swimming pool');
  });
  it.each(['1. Press the blue reset button', '1. Swimming Pool', '2. Badminton Court', '1. No Refunds After Payment', '# No refunds after payment', '12. Rooms cost INR 5000', 'Check-In: 2:00 PM', times])('retains factual instructions and values: %s', text => {
    expect(isStandalonePublishedHeading(text)).toBe(false);
  });
  it.each(['1. No Refunds After Payment', '# No refunds after payment'])('retains a heading-shaped commercial restriction: %s', restriction => {
    return recoverExtractiveKnowledgeAnswer({ ...input, retrieval: { ...retrieval,
      evidence: [{ ...retrieval.evidence[0], excerpt: `Package price: INR 5000.\n\nTerms & Conditions\n\n${restriction}` }] },
    }).then(result => {
      expect(result?.replyText).toContain('INR 5000');
      expect(result?.replyText).toContain(restriction);
    });
  });
  it('uses exact server-owned text rather than a model-written paraphrase', async () => {
    chat.mockResolvedValue({ success: true, content: '{"paragraphIds":["KB-1:published:0"],"answer":"Check-in is 9 PM"}' });
    const result = await recoverExtractiveKnowledgeAnswer(input);
    expect(result?.replyText).toBe(times);
    expect(result?.verification).toMatchObject({ mayDeliver: true, reason: 'verbatim_published_evidence' });
    expect(result?.verification.claims[0]).toMatchObject({ claim: times, evidenceIds: ['KB-1'] });
    expect(chat).toHaveBeenCalledWith(9, expect.objectContaining({
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages: expect.arrayContaining([expect.objectContaining({ role: 'system', content: expect.stringContaining('JSON') })]),
    }));
  });
  it.each(['insufficient', 'unavailable', 'access_denied', 'stale_only', 'conflict_detected'] as const)('does not recover %s evidence', async status => {
    expect(await recoverExtractiveKnowledgeAnswer({ ...input, retrieval: { ...retrieval, status } })).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });
  it.each(['medium', 'high', 'transactional'] as const)('does not recover %s risk', async risk => {
    expect(await recoverExtractiveKnowledgeAnswer({ ...input, query: { ...query, risk } })).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });
  it.each(['{"paragraphIds":[]}', '{"paragraphIds":["invented"]}', 'not json'])('fails closed for invalid selection %s', async content => {
    chat.mockResolvedValue({ success: true, content });
    expect(await recoverExtractiveKnowledgeAnswer(input)).toBeNull();
  });
  it('preserves source terms even when they were not selected', async () => {
    const terms = 'Terms & Conditions\nPrices exclude GST and may vary on holidays.';
    const result = await recoverExtractiveKnowledgeAnswer({ ...input,
      retrieval: { ...retrieval, evidence: [{ ...retrieval.evidence[0], excerpt: `Package: Rs. 3,499 + GST\nLunch and activities\n\n${terms}` }] },
    });
    expect(result?.replyText).toContain(terms);
  });
  it('does not append every commercial term to a timing-only internal answer', async () => {
    const excerpt = ['Terms & Conditions', '• Day outing timings: 10:00 AM to 6:00 PM.',
      '• Prices are exclusive of GST.', '• Spa services are chargeable separately.'].join('\n');
    chat.mockResolvedValue({ success: true, content: '{"paragraphIds":["KB-1:published:1"]}' });
    const result = await recoverExtractiveKnowledgeAnswer({ ...input, query: { ...query, audience: 'internal' },
      retrieval: { ...retrieval, evidence: [{ ...retrieval.evidence[0], excerpt }] } });
    expect(result?.replyText).toContain('Day outing timings: 10:00 AM to 6:00 PM.');
    expect(result?.replyText).not.toContain('Prices are exclusive');
    expect(result?.replyText).not.toContain('Spa services');
  });
  it('recovers a unique complete published block when the selection provider fails', async () => {
    chat.mockResolvedValue({ success: false });
    expect((await recoverExtractiveKnowledgeAnswer(input))?.replyText).toContain(times);
    expect(revalidate).toHaveBeenCalledWith(query, retrieval.evidence);
  });
  it('recovers and verifies the formatted S4 facts across an intervening pricing topic during provider failure', async () => {
    chat.mockResolvedValue({ success: false, content: '{"paragraphIds":[]}' });
    const s4Query: KnowledgeQuery = { ...query,
      redactedText: 'Draft a short customer email using the check-in and check-out times from earlier, with a bold heading and two numbered items.',
      redactedHistory: [
        { role: 'user', content: 'What are ORO check-in and check-out times?' },
        { role: 'assistant', content: 'Check-in 2:00 PM; check-out 11:00 AM.' },
        { role: 'user', content: 'Different question: what are ORO day-out prices and GST terms?' },
        { role: 'assistant', content: 'The package prices are Rs. 3,499 and Rs. 4,299 plus GST.' },
      ] };
    const result = await recoverExtractiveKnowledgeAnswer({ query: s4Query,
      retrieval: { ...retrieval, evidence: [{ ...retrieval.evidence[0], title: 'ORO The Estate published guide' }] } });
    expect(result?.replyText).toBe('**Check-In / Check-Out Timings**\n1. Check-In: 2:00 PM\n2. Check-Out: 11:00 AM');
    expect(result?.verification).toMatchObject({ mayDeliver: true, answerGrounding: 'grounded',
      unsupportedClaims: [], reason: 'verbatim_published_evidence' });
    expect(revalidate).toHaveBeenCalledTimes(2);
  });
  it('recovers every supported S7 clause from published terms when the selector provider fails', async () => {
    chat.mockResolvedValue({ success: false });
    const excerpt = [
      'ORO The Estate • Day Out Packages • Page 2',
      'Terms & Conditions',
      '• Day outing timings: 10:00 AM to 6:00 PM, unless a day use room is booked.',
      '• Prices are per person and exclusive of applicable GST.',
      '• Spa & Wellness services are chargeable separately, with the privilege discount applied.',
    ].join('\n\n');
    const s7Query: KnowledgeQuery = { ...query,
      redactedText: 'What are ORO day-out hours, is GST included, and are spa services included? Keep the published qualifications.' };
    const result = await recoverExtractiveKnowledgeAnswer({ query: s7Query,
      retrieval: { ...retrieval, evidence: [{ ...retrieval.evidence[0], title: 'ORO The Estate published guide', excerpt }] } });
    expect(result?.replyText).toContain('Day outing timings: 10:00 AM to 6:00 PM, unless a day use room is booked.');
    expect(result?.replyText).toContain('Prices are per person and exclusive of applicable GST.');
    expect(result?.replyText).toContain('Spa & Wellness services are chargeable separately, with the privilege discount applied.');
    expect(result?.verification).toMatchObject({ mayDeliver: true, reason: 'verbatim_published_evidence' });
  });
  it('refuses an outage compound answer if even one S7 subquestion has no published match', async () => {
    chat.mockResolvedValue({ success: false, content: '{"paragraphIds":["KB-1:published:0"]}' });
    const excerpt = [
      'Terms & Conditions',
      '• Day outing timings: 10:00 AM to 6:00 PM, unless a day use room is booked.',
      '• Prices are per person and exclusive of applicable GST.',
    ].join('\n\n');
    const s7Query: KnowledgeQuery = { ...query,
      redactedText: 'What are ORO day-out hours, is GST included, and are spa services included? Keep the published qualifications.' };
    expect(await recoverExtractiveKnowledgeAnswer({ query: s7Query,
      retrieval: { ...retrieval, evidence: [{ ...retrieval.evidence[0], title: 'ORO published guide', excerpt }] } })).toBeNull();
    expect(revalidate).not.toHaveBeenCalled();
  });
  it('refuses contradictory equally complete timing passages during outage instead of choosing by size', async () => {
    chat.mockResolvedValue({ success: false, content: '{"paragraphIds":["KB-1:published:0"]}' });
    const conflicting: KnowledgeRetrievalResult = { ...retrieval, evidence: [
      { ...retrieval.evidence[0], evidenceId: 'KB-1', title: 'ORO published guide', excerpt: 'Check-In Timings: 2:00 PM.' },
      { ...retrieval.evidence[0], evidenceId: 'KB-2', title: 'ORO published guide', excerpt: 'Check-In Timings: 9:00 PM.' },
    ] };
    expect(await recoverExtractiveKnowledgeAnswer({ query: { ...query, redactedText: 'What are the ORO check-in times?' },
      retrieval: conflicting })).toBeNull();
    expect(revalidate).not.toHaveBeenCalled();
  });
  it.each(['Cedar', 'ORO'])('grounds the named business in source provenance, not a hardcoded stop-word (%s)', async (business) => {
    chat.mockResolvedValue({ success: false });
    const branded = { ...retrieval, evidence: [{ ...retrieval.evidence[0], title: `${business} published guide` }] };
    const request = { ...query, redactedText: `What are ${business} check-in and check-out times?` };
    expect((await recoverExtractiveKnowledgeAnswer({ query: request, retrieval: branded }))?.replyText).toContain(times);
    expect(await recoverExtractiveKnowledgeAnswer({ query: request, retrieval })).toBeNull();
  });
  it('does not guess a selection when outage evidence does not cover the question', async () => {
    chat.mockResolvedValue({ success: false });
    expect(await recoverExtractiveKnowledgeAnswer({ ...input, query: { ...query, redactedText: 'What are the airport transfer prices?' } })).toBeNull();
  });
  it('does not recover ambiguous or withdrawn blocks during an outage', async () => {
    chat.mockRejectedValue(new Error('provider offline'));
    expect(await recoverExtractiveKnowledgeAnswer({ ...input, retrieval: { ...retrieval, evidence: [retrieval.evidence[0], { ...retrieval.evidence[0], evidenceId: 'KB-2' }] } })).toBeNull();
    revalidate.mockResolvedValue([]);
    expect(await recoverExtractiveKnowledgeAnswer(input)).toBeNull();
  });
  it('fails closed when required commercial terms exceed the selection bound', async () => {
    const terms = `Terms & Conditions\n${'Conditions still apply. '.repeat(400).trim()}`;
    const result = await recoverExtractiveKnowledgeAnswer({ ...input,
      retrieval: { ...retrieval, evidence: [{ ...retrieval.evidence[0], excerpt: `Package price: Rs. 3,499 + GST.\n\n${terms}` }] },
    });
    expect(result).toBeNull();
  });
  it('rejects knowledge withdrawn or restricted while paragraph selection was running', async () => {
    revalidate.mockResolvedValue([]);
    expect(await recoverExtractiveKnowledgeAnswer(input)).toBeNull();
    expect(revalidate).toHaveBeenCalledWith(query, retrieval.evidence);
  });
  it('keeps later evidence available and selects all internal catalog options', async () => {
    const extra = Array.from({ length: 40 }, (_, i) => `Unrelated published section ${i}.`).join('\n\n');
    const catalog = ['Option one costs Rs. 3,499 + GST.', 'Option two costs Rs. 4,299 + GST.',
      'Option three costs Rs. 5,499 + GST.', 'Terms & Conditions\nPrices vary on holidays.'].join('\n\n');
    chat.mockResolvedValue({ success: true, content: JSON.stringify({ paragraphIds: [0, 1, 2, 3].map(i => `KB-2:published:${i}`) }) });
    const result = await recoverExtractiveKnowledgeAnswer({ query: { ...query, audience: 'internal' },
      retrieval: { ...retrieval, evidence: [{ ...retrieval.evidence[0], excerpt: extra },
        { ...retrieval.evidence[0], evidenceId: 'KB-2', documentId: 2, excerpt: catalog }] } });
    expect(result?.replyText).toContain('3,499');
    expect(result?.replyText).toContain('4,299');
    expect(result?.replyText).toContain('5,499');
    expect(result?.replyText).toContain('Prices vary on holidays');
    expect(JSON.stringify(chat.mock.calls)).toContain('KB-2:published:3');
  });
  it('passes the original factual topic for a presentation-only follow-up', async () => {
    await recoverExtractiveKnowledgeAnswer({ ...input, query: { ...query,
      redactedText: 'Please turn those two timings into a numbered list with a short bold heading.',
      redactedHistory: [{ role: 'user', content: 'What are the check-in and check-out times at ORO?' },
        { role: 'assistant', content: times }] } });
    expect(JSON.stringify(chat.mock.calls)).toContain('What are the check-in and check-out times at ORO?');
  });
});
