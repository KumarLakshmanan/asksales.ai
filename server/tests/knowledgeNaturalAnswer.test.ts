import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { KnowledgeQuery, KnowledgeRetrievalResult } from '../services/knowledge/types.js';
const chat = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: {
  createChatCompletionWithFallback: chat,
} }));
const { renderNaturalKnowledgeAnswer } = await import('../services/knowledge/KnowledgeNaturalAnswer.js');
const query: KnowledgeQuery = { tenantId: 9, redactedText: 'where is this located ?', channel: 'whatsapp',
  risk: 'low', audience: 'customer', purpose: 'support_answer' };
const retrieval: KnowledgeRetrievalResult = { status: 'sufficient', indexVersion: 'test',
  diagnostics: { queryFingerprint: 'test', candidateCount: 1, reranked: false, latencyMs: 1 },
  evidence: [{ evidenceId: 'KB-1', documentId: 1, versionId: 1, chunkId: '1', title: 'Location',
    excerpt: 'Just 30 minutes from Kempegowda International Airport.', authority: 'tenant_policy', scores: { fused: 1 } }],
};
const reply = 'We’re about 30 minutes from Kempegowda International Airport.';
const accepted = { supported: true, complete: true, natural: true, languageMatchesQuestion: true, confidence: 0.98 };
const response = (value: unknown) => ({ success: true, content: JSON.stringify(value) });
beforeEach(() => { chat.mockReset(); });
describe('verified conversational FAQ rendering', () => {
  it.each([false, undefined, 'true'])('requires explicit independent language approval: %s', async languageMatchesQuestion => {
    const english = 'Check-in is at 2:00 PM.';
    const facts = { ...retrieval, evidence: [{ ...retrieval.evidence[0], excerpt: english }] };
    chat.mockResolvedValueOnce(response({ ...accepted, languageMatchesQuestion }));
    expect(await renderNaturalKnowledgeAnswer({ query: { ...query, redactedText: 'What is check-in time?' },
      retrieval: facts, draft: { answer: 'L’arrivée est à 14 h.', sourceAnswer: english } })).toBeNull();
    const reviewData = JSON.parse(chat.mock.calls[0][1].messages.at(-1).content);
    expect(reviewData.latestQuestion).toBe('What is check-in time?');
  });
  it('reviews a supplied draft independently without another generation call', async () => {
    chat.mockResolvedValueOnce(response(accepted));
    const result = await renderNaturalKnowledgeAnswer({ query, retrieval,
      draft: { answer: reply, sourceAnswer: reply } });
    expect(result?.replyText).toBe(reply);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][1].loggingContext.purpose).toBe('knowledge_natural_answer_review');
  });
  it('removes an overbroad bare verdict while verifying every remaining conditional claim', async () => {
    const conditional = 'Individual bookings are 100% non-refundable.';
    const facts = { ...retrieval, evidence: [{ ...retrieval.evidence[0], excerpt: conditional }] };
    chat.mockResolvedValueOnce(response(accepted));
    const result = await renderNaturalKnowledgeAnswer({ query: { ...query, redactedText: 'Will I get a refund?' },
      retrieval: facts, draft: { answer: 'No. ' + conditional, sourceAnswer: conditional } });
    expect(result?.replyText).toBe(conditional);
    expect(JSON.parse(chat.mock.calls[0][1].messages.at(-1).content).reply).toBe(conditional);
  });
  it.each(['whatsapp', 'instagram', 'facebook', 'web', 'email'])('generates a natural location answer for %s without inventing an address', async channel => {
    chat.mockResolvedValueOnce(response({ answer: reply })).mockResolvedValueOnce(response(accepted));
    const result = await renderNaturalKnowledgeAnswer({ query: { ...query, channel }, retrieval });
    expect(result?.replyText).toBe(reply);
    expect(result?.verification).toMatchObject({ reason: 'verified_natural_knowledge_answer', mayDeliver: true,
      answerGrounding: 'grounded', unsupportedClaims: [] });
    expect(result?.verification.claims[0].evidenceIds).toEqual(['KB-1']);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[0][1].messages[0].content).toContain('untrusted data');
    expect(chat.mock.calls[1][1].messages[0].content).toContain('conditions/exclusions/uncertainty');
  });
  it.each(['We are 10 minutes from Kempegowda International Airport.',
    'Your spa booking is confirmed.', 'Free airport transfers are included.',
    'From the published knowledge base: Just 30 minutes away.', 'Hello ||| Airport details', '<p>Location</p>'])('rejects unsupported or internal output: %s', async answer => {
    chat.mockResolvedValueOnce(response({ answer }));
    expect(await renderNaturalKnowledgeAnswer({ query, retrieval })).toBeNull();
    expect(chat).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...accepted, supported: false }, { ...accepted, complete: false }, { ...accepted, natural: false },
    { ...accepted, confidence: 0.7 }, { ...accepted, confidence: 2 }, {}])('requires independent semantic approval: %j', async verdict => {
    chat.mockResolvedValueOnce(response({ answer: reply })).mockResolvedValueOnce(response(verdict));
    expect(await renderNaturalKnowledgeAnswer({ query, retrieval })).toBeNull();
  });
  it('rejects an omission even if lexical overlap would pass', async () => {
    const facts = { ...retrieval, evidence: [{ ...retrieval.evidence[0], excerpt: 'Spa services cost INR 2000 excluding tax.' }] };
    chat.mockResolvedValueOnce(response({ answer: 'Spa services cost INR 2000.' }))
      .mockResolvedValueOnce(response({ ...accepted, complete: false }));
    expect(await renderNaturalKnowledgeAnswer({ query: { ...query, redactedText: 'What does spa cost?' }, retrieval: facts })).toBeNull();
  });
  it.each(['not json', '{}', '{"answer":3}'])('rejects malformed generation: %s', async content => {
    chat.mockResolvedValueOnce({ success: true, content });
    expect(await renderNaturalKnowledgeAnswer({ query, retrieval })).toBeNull();
  });
  it('fails safely on provider/review outage', async () => {
    chat.mockRejectedValueOnce(new Error('offline'));
    expect(await renderNaturalKnowledgeAnswer({ query, retrieval })).toBeNull();
    chat.mockResolvedValueOnce(response({ answer: reply })).mockRejectedValueOnce(new Error('offline'));
    expect(await renderNaturalKnowledgeAnswer({ query, retrieval })).toBeNull();
  });
  it('does not waive existing verification when a translated answer cannot be checked', async () => {
    chat.mockResolvedValueOnce(response({ answer: 'கெம்பேகவுடா சர்வதேச விமான நிலையத்திலிருந்து சுமார் 30 நிமிடங்கள்.' }));
    expect(await renderNaturalKnowledgeAnswer({ query, retrieval })).toBeNull();
  });
  it.each(['access_denied', 'insufficient', 'unavailable', 'conflict_detected'] as const)('never rewrites %s evidence', async status => {
    expect(await renderNaturalKnowledgeAnswer({ query, retrieval: { ...retrieval, status } })).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });
  it.each(['medium', 'high', 'transactional'] as const)('does not rewrite %s operations', async risk => {
    expect(await renderNaturalKnowledgeAnswer({ query: { ...query, risk }, retrieval })).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });
});

describe('translated facts',()=>{
  it('requires supported source text and independent translation review for Tamil',async()=>{
    const tamil='செக்-இன் நேரம் பிற்பகல் 2:00 PM.';
    const facts={...retrieval,evidence:[{...retrieval.evidence[0],excerpt:'Check-in: 2:00 PM.'}]};
    chat.mockResolvedValueOnce(response({answer:tamil,sourceAnswer:'Check-in: 2:00 PM.'})).mockResolvedValueOnce(response(accepted));
    expect((await renderNaturalKnowledgeAnswer({query:{...query,redactedText:'செக்-இன் நேரம் என்ன?'},retrieval:facts}))?.replyText).toBe(tamil);
    chat.mockResolvedValueOnce(response({answer:'செக்-இன் 1:00 PM.',sourceAnswer:'Check-in: 2:00 PM.'})).mockResolvedValueOnce(response({...accepted,supported:false}));
    expect(await renderNaturalKnowledgeAnswer({query,retrieval:facts})).toBeNull();
  });
});
