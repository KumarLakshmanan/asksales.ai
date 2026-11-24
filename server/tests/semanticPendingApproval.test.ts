import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { intentWith } from './helpers/semanticIntent.js';
const completion = jest.fn<any>();
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: { createProviderForUser: async () => ({ defaultModel: 'test', createChatCompletion: completion }) } }));
jest.unstable_mockModule('../models/chatMessages/functions.js', () => ({ createChatMessage: jest.fn() }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const { MessageService } = await import('../services/agents/MessageService.js');
let nextThreadId = 9000;
const input = () => ({ userId: 1, threadId: ++nextThreadId, llmConfig: {} as any, message: 'Yes', pendingApproval: { executionId: 'review-1', toolName: 'execute_lead_workflow', args: { revision: 1 } }, currentAgent: 'lead_generation', recentMessages: [{ role: 'assistant', content: 'Prepare a different strategy?' }] });
beforeEach(() => { completion.mockReset(); });
describe('semantic exact recipient selection', () => {
  const request = { userId: 1, message: 'Select lead ID 1184 only; exclude lead ID 1185.', candidateIds: [1184, 1185], selectedLeadIds: [1185] };
  it('persists only positively selected IDs returned by the interpreter', async () => {
    completion.mockResolvedValue({ success: true, content: '{"action":"replace_selection","leadIds":[1184,1184]}' });
    expect(await MessageService.resolveExplicitLeadSelection(request)).toEqual([1184]);
    expect((completion.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content).toContain('never IDs mentioned as excluded');
  });
  it('does not turn an excluded-ID question into recipient selection', async () => {
    completion.mockResolvedValue({ success: true, content: '{"action":"not_selection","leadIds":[]}' });
    expect(await MessageService.resolveExplicitLeadSelection({ ...request, message: 'Why was lead ID 1185 excluded?' })).toBeNull();
  });
  it.each([
    '{"action":"replace_selection","leadIds":[9999]}',
    '{"action":"replace_selection","leadIds":["1184"]}',
    '{"action":"replace_selection","leadIds":[]}',
    '{"action":"approve","leadIds":[1184]}',
    'not JSON',
  ])('fails closed on unsupported or malformed selection %s', async (content) => {
    completion.mockResolvedValue({ success: true, content });
    expect(await MessageService.resolveExplicitLeadSelection(request)).toBeNull();
  });
  it('fails closed on a provider failure', async () => {
    completion.mockRejectedValue(new Error('provider offline'));
    expect(await MessageService.resolveExplicitLeadSelection(request)).toBeNull();
  });
  it('does not invoke a provider when no IDs were mentioned', async () => {
    expect(await MessageService.resolveExplicitLeadSelection({ ...request, candidateIds: [] })).toBeNull();
    expect(completion).not.toHaveBeenCalled();
  });
});
describe('semantic exact-review approval', () => {
  it.each(['question', 'revise', 'switch_agent', 'clarify'])('does not interpret a %s turn as rejecting a pending review', async action => {
    completion.mockResolvedValue({ success: true, content: '{"decision":"reject"}' });
    const request = { ...input(), message: 'Keep the search pending. Give advice in chat only; do not run anything.',
      turnIntent: intentWith({}, { action, hiredAgents: ['lead_generation'], nextAgent: 'lead_generation' }) };
    expect(await MessageService.resolvePendingApprovalDecision(request)).toBe('modify_or_unclear');
    expect(completion).not.toHaveBeenCalled();
  });
  it('preserves the pending lead review when a team advice request was classified as new work', async () => {
    completion.mockResolvedValue({ success: true, content: '{"decision":"reject"}' });
    const turnIntent = intentWith({}, { action: 'new_task',
      hiredAgents: ['content_studio', 'outreach', 'performance_marketing'], nextAgent: 'content_studio' });
    expect(await MessageService.resolvePendingApprovalDecision({ ...input(), turnIntent })).toBe('modify_or_unclear');
    expect(completion).not.toHaveBeenCalled();
  });
  it('still interprets an explicit continuation for the review owner against the exact pending action', async () => {
    completion.mockResolvedValue({ success: true, content: '{"decision":"approve"}' });
    const turnIntent = intentWith({}, { action: 'continue', hiredAgents: ['lead_generation'], nextAgent: 'lead_generation' });
    expect(await MessageService.resolvePendingApprovalDecision({ ...input(), turnIntent })).toBe('approve');
    expect(completion).toHaveBeenCalledTimes(1);
  });
  it('consults the model even for bare yes instead of keyword approval', async () => {
    completion.mockResolvedValue({ success: true, content: '{"decision":"modify_or_unclear"}' });
    expect(await MessageService.resolvePendingApprovalDecision(input())).toBe('modify_or_unclear');
    expect(completion).toHaveBeenCalledTimes(1);
    expect((completion.mock.calls[0][0] as { messages: Array<{ content: string }> }).messages[0].content).toContain('Prepare a different strategy?');
  });
  it('does not reuse an approval decision for another request, revision or prior question', async () => {
    completion.mockResolvedValue({ success: true, content: '{"decision":"approve"}' });
    const request = input();
    await MessageService.resolvePendingApprovalDecision(request);
    await MessageService.resolvePendingApprovalDecision(request);
    expect(completion).toHaveBeenCalledTimes(1);
    await MessageService.resolvePendingApprovalDecision({ ...request, pendingApproval: { ...request.pendingApproval, executionId: 'review-2' } });
    await MessageService.resolvePendingApprovalDecision({ ...request, pendingApproval: { ...request.pendingApproval, args: { revision: 2 } } });
    await MessageService.resolvePendingApprovalDecision({ ...request, recentMessages: [{ role: 'assistant', content: 'Which strategy?' }] });
    expect(completion).toHaveBeenCalledTimes(4);
  });
  it('fails closed for unavailable or malformed decisions', async () => {
    completion.mockResolvedValueOnce({ success: false, content: '{"decision":"approve"}' });
    expect(await MessageService.resolvePendingApprovalDecision(input())).toBeNull();
    completion.mockResolvedValueOnce({ success: true, content: 'Approve this {"decision":"approve"}' });
    expect(await MessageService.resolvePendingApprovalDecision(input())).toBeNull();
  });
});
