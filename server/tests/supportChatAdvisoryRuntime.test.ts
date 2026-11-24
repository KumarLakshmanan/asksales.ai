import { beforeEach, describe, expect, it, jest } from '@jest/globals';

let selected: any[][];
let inserted: any[];
const handle = jest.fn<(input: any) => Promise<any>>();
const requireSupportChatAssistant = jest.fn<(input: any) => Promise<void>>();
jest.unstable_mockModule('../services/SupportChatRouting.js', () => ({ requireSupportChatAssistant }));
function queryChain(result: any[]) {
  const chain: any = { then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject) };
  for (const method of ['from', 'innerJoin', 'where', 'limit', 'orderBy', 'offset']) chain[method] = () => chain;
  return chain;
}
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  select: () => queryChain(selected.shift() || []),
  insert: () => ({ values: (value: any) => { inserted.push(value); return { returning: async () => [{ id: inserted.length, ...value }] }; } }),
  update: () => ({ set: () => ({ where: async () => [] }) }),
} }));
jest.unstable_mockModule('../services/agents/AgentRouter.js', () => ({ agentRouter: { handle } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({
  redactPiiWithStableTokens: (text: string) => ({ redactedText: text.replace(/person@example.invalid/g, '[EMAIL_1]') }),
}));
const { sendMessage } = await import('../services/SupportChatService.js');

describe('member assistant advisory output', () => {
  beforeEach(() => {
    inserted = [];
    selected = [[{ id: 1, memberId: 5, ticketId: null }], [{ userId: 1 }], [], [{ count: 2 }]];
    handle.mockReset();
    requireSupportChatAssistant.mockReset().mockResolvedValue(undefined);
    handle.mockResolvedValue({ replyText: 'Check-in is 3:00 PM. ||| Check-out is 11:00 AM.', deliveryOutcome: 'auto_sent', confidence: 0.99, kbSourcesUsed: [] });
  });
  it('rejects unavailable routing before saving member messages or claiming a turn', async () => {
    const unavailable = new Error('Select an assistant');
    requireSupportChatAssistant.mockRejectedValue(unavailable);
    await expect(sendMessage(1, 5, 'What is the refund policy?')).rejects.toBe(unavailable);
    expect(inserted).toEqual([]);
    expect(handle).not.toHaveBeenCalled();
    expect(requireSupportChatAssistant).toHaveBeenCalledWith(expect.objectContaining({
      userId: 1, metadata: expect.objectContaining({ staffSupportSessionId: 1, conversationKind: 'support_member' }),
    }));
  });
  it('uses an internal no-intake contract and saves readable Markdown paragraphs', async () => {
    const result = await sendMessage(1, 5, 'What are the check-in times?');
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: -1000000001,
      metadata: expect.objectContaining({ executionMode: 'advisory', conversationKind: 'support_member', platformInstructions: expect.stringContaining('not a customer conversation') }),
    }));
    const instructions = handle.mock.calls[0][0].metadata.platformInstructions;
    expect(instructions).toContain('Do not ask the member for their name or contact information');
    expect(instructions).toContain('draft only when the member requests one');
    expect(result.assistantMsg.content).toBe('Check-in is 3:00 PM.\n\nCheck-out is 11:00 AM.');
    expect(result.response.deliveryAllowed).toBe(false);
  });
  it('does not accept client-provided ticket context and protects member input', async () => {
    await sendMessage(1, 5, 'Customer person@example.invalid asks for help', { ticketNumber: 'FORGED', subject: 'private', description: 'private', status: 'open', priority: 'high' });
    expect(handle.mock.calls[0][0].metadata.ticketContext).toBeNull();
    expect(handle.mock.calls[0][0].inboundText).toBe('Customer [EMAIL_1] asks for help');
    expect(inserted[0].content).not.toContain('person@example.invalid');
  });
  it('keeps review-required results advisory and does not show an unapproved draft', async () => {
    handle.mockResolvedValue({ replyText: 'Unapproved promise', deliveryOutcome: 'pending_approval' });
    expect((await sendMessage(1, 5, 'Please draft a reply')).response.answer).toBe('This draft requires human review before it can be used.');
  });
  it('never persists or displays an evidence-rejected advisory draft even when delivery is auto_sent', async () => {
    handle.mockResolvedValue({
      replyText: 'Harbour check-in is 3:00 PM according to the invented manual.',
      deliveryOutcome: 'auto_sent', confidence: 0.99,
      kbSourcesUsed: [{ sourceId: 23, citation: 'Invented manual' }],
      answerVerification: { mayDeliver: false, answerGrounding: 'blocked' },
    });
    const result = await sendMessage(1, 5, 'What are the lodge policies?');
    expect(result.assistantMsg.content).toBe('I do not have enough approved information to verify that. Please check an authorized source before advising the customer.');
    expect(result.response.sources).toEqual([]);
    expect(result.response.confidence).toBe(0);
    expect(JSON.stringify(inserted)).not.toContain('invented manual');
  });
});
