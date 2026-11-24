import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const chat = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: { createChatCompletionWithFallback: chat } }));
const { presentSupportComposerReply } = await import('../services/agents/SupportComposerPresentation.js');
const { replyAudience } = await import('../services/agents/pipeline/ReplyAudience.js');
const input = { userId: 9, channel: 'instagram', question: 'When can I expect a reply from support?', governedReply: 'I do not have enough confirmed information to answer that accurately right now.' };
const reply = 'I’m sorry, I don’t have a confirmed response time from the support team yet.';
const accepted = { faithful: true, relevant: true, noNewClaims: true, confidence: 0.99 };
const response = (value: unknown) => ({ success: true, content: JSON.stringify(value) });
beforeEach(() => { chat.mockReset(); });
describe('Support AI composer presentation', () => {
  it('contextualizes a governed limitation only after independent semantic approval', async () => {
    chat.mockResolvedValueOnce(response({reply})).mockResolvedValueOnce(response(accepted));
    expect(await presentSupportComposerReply(input)).toBe(reply);
    expect(chat.mock.calls[0][0]).toBe(9);
    expect(chat.mock.calls[0][1].tools).toBeUndefined();
    expect(chat.mock.calls[1][1].messages[1].content).toContain(input.governedReply);
  });
  it.each([{...accepted, faithful:false}, {...accepted, relevant:false}, {...accepted, noNewClaims:false}, {...accepted,confidence:0.8}, {...accepted,confidence:2}, {}])('does not approve unsupported/promotional output: %j', async verdict => {
    chat.mockResolvedValueOnce(response({reply:'Our team will respond in five minutes.'})).mockResolvedValueOnce(response(verdict));
    expect(await presentSupportComposerReply(input)).toBe(input.governedReply);
  });
  it.each(['not json', '{}', '{"reply":4}'])('keeps the governed answer on malformed output %s', async content => {
    chat.mockResolvedValueOnce({success:true,content});
    expect(await presentSupportComposerReply(input)).toBe(input.governedReply);
  });
  it('allows independently approved removal of unrelated onboarding from an answered location question', async () => {
    const location = { ...input, question: 'Location plzz', governedReply: 'Oro The Estate is located in Nandi Hills, Bengaluru. How can I assist you today?\n1. Leisure stay\n2. Corporate offsite\nReply with a number.' };
    const concise = 'Oro The Estate is located in Nandi Hills, Bengaluru.';
    chat.mockResolvedValueOnce(response({ reply: concise })).mockResolvedValueOnce(response(accepted));
    expect(await presentSupportComposerReply(location)).toBe(concise);
    for (const call of chat.mock.calls) {
      expect(call[1].messages[0].content).toContain('Judge relevance semantically');
      expect(call[1].messages[0].content).toContain('requested list of services');
      expect(call[1].messages[0].content).toContain('commercial conditions');
    }
  });
  it('rejects removal of needed booking questions even when the shorter reply is relevant', async () => {
    const booking = { ...input, question: 'I would like a spa appointment', governedReply: 'What date and time would work best for your spa appointment?' };
    chat.mockResolvedValueOnce(response({ reply: 'Happy to help.' })).mockResolvedValueOnce(response({ ...accepted, faithful: false }));
    expect(await presentSupportComposerReply(booking)).toBe(booking.governedReply);
  });
  it('keeps the governed reply when generation or review is unavailable', async () => {
    chat.mockRejectedValueOnce(new Error('offline'));
    expect(await presentSupportComposerReply(input)).toBe(input.governedReply);
    chat.mockResolvedValueOnce(response({reply})).mockResolvedValueOnce({success:false,content:JSON.stringify(accepted)});
    expect(await presentSupportComposerReply(input)).toBe(input.governedReply);
  });
  it('uses customer authorization for composer knowledge, preserving internal staff scopes', () => {
    expect(replyAudience({ executionMode:'advisory', conversationKind:'outreach_draft' })).toBe('customer');
    expect(replyAudience({ executionMode:'advisory', conversationKind:'support_member' })).toBe('internal');
    expect(replyAudience({ executionMode:'preview', conversationKind:'owner_support' })).toBe('customer');
  });
});
