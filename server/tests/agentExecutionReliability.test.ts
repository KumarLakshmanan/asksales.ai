/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
const root = '..';
const providerCall = jest.fn<any>();
const saveMessage = jest.fn<any>();
const makeWidget = jest.fn<any>();
const hasWidget = jest.fn<any>();
const execute = jest.fn<any>();
const findWidgets = jest.fn<any>();
const replaceWidget = jest.fn<any>();
const widgetUpdate = jest.fn<any>();
jest.unstable_mockModule(root + '/services/agents/LLMProviderFactory.js', () => ({
  LLMProviderFactory: { executeProviderCallWithFallback: providerCall },
}));
jest.unstable_mockModule(root + '/services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: {
  emitToolExecution: jest.fn(), emitChatResponse: jest.fn(), emitWidgetCreated: jest.fn(), emitWidgetUpdate: widgetUpdate,
} }));
jest.unstable_mockModule(root + '/models/chatMessages/functions.js', () => ({ createChatMessage: saveMessage }));
jest.unstable_mockModule(root + '/models/widgetStates/functions.js', () => ({ WidgetStateModel: {
  findByThreadForUser: findWidgets, create: makeWidget, updateMessageId: jest.fn(), replacePendingReviewForUser: replaceWidget,
} }));
jest.unstable_mockModule(root + '/shared/toolWidgetMap.js', () => ({
  toolHasWidget: hasWidget, getWidgetTypeForTool: () => 'image_generation',
}));
const { runToolCallingLoop } = await import(root + '/mastra/utils/toolCallingLoop.js');
const options: any = {
  userId: 7, threadId: 42, agentType: 'content_studio', systemPrompt: 'Synthetic audit agent',
  messages: [{ role: 'user', content: 'Synthetic operation' }],
  toolContext: { userId: 7, threadId: 42 }, maxIterations: 1,
};
const call = (name: string, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: '{}' } });
function completion(calls: any[]) {
  return { success: true, completion: { choices: [{ message: { content: null, tool_calls: calls } }] } };
}
beforeEach(() => {
  jest.clearAllMocks();
  saveMessage.mockResolvedValue({});
  makeWidget.mockImplementation(async (input: any) => ({ ...input, id: 1 }));
  findWidgets.mockResolvedValue([]);
  replaceWidget.mockImplementation(async (_id: number, input: any) => ({ ...input, id: 2 }));
  hasWidget.mockReturnValue(false);
  execute.mockResolvedValue({ success: true, output: { synthetic: true } });
});
afterEach(() => { jest.restoreAllMocks(); });
describe('agent execution reliability acceptance', () => {
  it('counts calls across model iterations and preserves earlier receipts at the limit', async () => {
    providerCall.mockResolvedValueOnce(completion([call('mutation', 'first')]))
      .mockResolvedValueOnce(completion([call('mutation', 'second')]));
    const result = await runToolCallingLoop({ ...options, maxIterations: 3, maxToolCalls: 1, tools: { mutation: { execute } } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].success).toBe(true);
    expect(result.stopReason).toBe('call_limit');
  });
  it('stops after the same step fails the same way twice instead of retrying again', async () => {
    execute.mockResolvedValue({ success: false, error: 'Imported audience not found.' });
    providerCall.mockResolvedValueOnce(completion([call('mutation', 'first')]))
      .mockResolvedValueOnce(completion([call('mutation', 'second')]))
      .mockResolvedValueOnce(completion([call('mutation', 'third')]));
    const result = await runToolCallingLoop({ ...options, maxIterations: 5, tools: { mutation: { execute } } });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe('repeated_failure');
    expect(result.text).toContain('failed the same way both times: Imported audience not found.');
  });
  it('lets the model retry after a different error', async () => {
    execute.mockResolvedValueOnce({ success: false, error: 'Imported audience not found.' })
      .mockResolvedValueOnce({ success: false, error: 'Sending account unavailable.' });
    providerCall.mockResolvedValueOnce(completion([call('mutation', 'first')]))
      .mockResolvedValueOnce(completion([call('mutation', 'second')]))
      .mockResolvedValueOnce({ success: true, completion: { choices: [{ message: { content: 'Both attempts failed.' } }] } });
    const result = await runToolCallingLoop({ ...options, maxIterations: 5, tools: { mutation: { execute } } });
    expect(execute.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.stopReason).not.toBe('repeated_failure');
  });
  it('does not execute duplicate call identities in the same completion', async () => {
    providerCall.mockResolvedValue(completion([call('mutation'), call('mutation')]));
    const result = await runToolCallingLoop({ ...options, tools: { mutation: { execute } } });
    expect(execute).not.toHaveBeenCalled();
    expect(result.stopReason).toBe('invalid_tool_calls');
  });
  it('rechecks the deadline after a delayed policy check', async () => {
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    providerCall.mockResolvedValue(completion([call('mutation')]));
    const result = await runToolCallingLoop({ ...options, tools: { mutation: { execute } },
      onToolCall: async () => { now = 60_001; return true; } });
    expect(execute).not.toHaveBeenCalled();
    expect(result.outcome).toBe('timed_out');
  });
  it('returns promptly on Stop and ignores the late model completion', async () => {
    const controller = new AbortController();
    let finish!: (value: any) => void;
    providerCall.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = runToolCallingLoop({ ...options, signal: controller.signal, tools: { mutation: { execute } } });
    await Promise.resolve();
    controller.abort();
    const result = await pending;
    expect(result.outcome).toBe('cancelled');
    finish(completion([call('mutation')]));
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not start a mutation after the 60-second deadline', async () => {
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    providerCall.mockImplementation(async () => { now = 60_001; return completion([call('mutation')]); });
    const result = await runToolCallingLoop({ ...options, tools: { mutation: { execute } } });
    expect(execute).not.toHaveBeenCalled();
    expect(result.toolResults).toEqual([]);
    expect(result.outcome).toBe('timed_out');
  });
  it('rejects an excessive model batch before any policy or tool execution', async () => {
    providerCall.mockResolvedValue(completion(Array.from({ length: 32 }, (_, i) => call('mutation', `call-${i}`))));
    const policy = jest.fn<any>().mockReturnValue(true);
    const result = await runToolCallingLoop({ ...options, tools: { mutation: { execute } }, onToolCall: policy });
    expect(execute).not.toHaveBeenCalled();
    expect(policy).not.toHaveBeenCalled();
    expect(result.toolResults).toEqual([]);
    expect(result.stopReason).toBe('call_limit');
  });
  it('stops later mutations after a durable review card is created', async () => {
    providerCall.mockResolvedValue(completion([call('generate_image'), call('mutation', 'call-2')]));
    hasWidget.mockImplementation((name: string) => name === 'generate_image');
    const reviewExecutor = jest.fn<any>();
    const result = await runToolCallingLoop({ ...options, tools: {
      generate_image: { execute: reviewExecutor }, mutation: { execute },
    } });
    expect(makeWidget).toHaveBeenCalledTimes(1);
    expect(reviewExecutor).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.toolResults).toHaveLength(1);
    expect(result.text).toContain('Nothing has been generated yet');
  });
  it('replaces the unstarted outreach card for the same recipients and says so', async () => {
    const args = { channel: 'email', lead_ids: [8101, 8102], subject: 'Overnight enquiries', body: 'Hi,\n\nA short note.\n\nUnsubscribe: {{unsubscribe_link}}' };
    providerCall.mockResolvedValue(completion([{ id: 'call-1', type: 'function', function: { name: 'send_outreach_messages', arguments: JSON.stringify(args) } }]));
    hasWidget.mockImplementation((name: string) => name === 'send_outreach_messages');
    findWidgets.mockResolvedValue([{ id: 9, toolName: 'send_outreach_messages', userId: 7, threadId: 42, status: 'active',
      formValues: { channel: 'email', lead_ids: [8102, 8101], subject: 'Earlier draft', body: 'Hi' } }]);
    const sender = jest.fn<any>();
    const result = await runToolCallingLoop({ ...options, agentType: 'outreach', toolContext: { userId: 7, threadId: 42, companyProfile: { companyName: 'StayDesk' } },
      tools: { send_outreach_messages: { execute: sender } } });
    expect(sender).not.toHaveBeenCalled();
    expect(makeWidget).not.toHaveBeenCalled();
    expect(replaceWidget).toHaveBeenCalledWith(9, expect.objectContaining({ toolName: 'send_outreach_messages' }));
    const saved = (replaceWidget.mock.calls[0] as any)[1].formValues;
    expect(saved.body).not.toContain('{{unsubscribe_link}}');
    expect(saved.body).toMatch(/rather not hear from us[\s\S]*Best,\nStayDesk$/);
    expect(widgetUpdate).toHaveBeenCalledWith(7, 42, { id: 9, status: 'cancelled' });
    expect(result.toolResults[0].result.output.replacedWidgetId).toBe(9);
    expect(result.text).toContain('It replaces the earlier draft for the same recipients.');
    expect(result.text).toContain('Nothing has been sent yet.');
  });
  it('keeps a separate card for a different channel', async () => {
    providerCall.mockResolvedValue(completion([{ id: 'call-1', type: 'function', function: { name: 'send_outreach_messages',
      arguments: JSON.stringify({ channel: 'sms', lead_ids: [8101, 8102], body: 'Hi' }) } }]));
    hasWidget.mockImplementation((name: string) => name === 'send_outreach_messages');
    findWidgets.mockResolvedValue([{ id: 9, toolName: 'send_outreach_messages', userId: 7, threadId: 42, status: 'active', formValues: { channel: 'email', lead_ids: [8101, 8102] } }]);
    const result = await runToolCallingLoop({ ...options, agentType: 'outreach', tools: { send_outreach_messages: { execute: jest.fn<any>() } } });
    expect(replaceWidget).not.toHaveBeenCalled();
    expect(makeWidget).toHaveBeenCalledTimes(1);
    expect(result.text).not.toContain('replaces the earlier draft');
  });
  it.each([{}, [], { error: 'Synthetic adapter failure without success flag' }])(
    'rejects malformed tool output without a successful receipt: %j', async output => {
      providerCall.mockResolvedValue(completion([call('mutation')]));
      execute.mockResolvedValue(output);
      const result = await runToolCallingLoop({ ...options, tools: { mutation: { execute } } });
      expect(result.toolResults[0].success).toBe(false);
      expect(saveMessage.mock.calls.some(([m]: any[]) => m.content === '✅ mutation completed')).toBe(false);
    },
  );
  it('returns an explicit terminal outcome when iteration budget is exhausted', async () => {
    providerCall.mockResolvedValue(completion([call('mutation')]));
    const result = await runToolCallingLoop({ ...options, tools: { mutation: { execute } } });
    expect(result.text).toContain('reasoning limit');
    expect(result.outcome).toBe('failed');
    expect(result.stopReason).toBe('iteration_limit');
    expect(result.responseSource).toBe('server');
  });
  it('records a real Mastra output-validation error as failure', async () => {
    providerCall.mockResolvedValue(completion([call('mutation')]));
    const tool = createTool({ id: 'mutation', description: 'Synthetic validation fixture',
      inputSchema: z.object({}), outputSchema: z.object({ success: z.boolean(), toolName: z.string() }),
      execute: (async () => ({})) as any,
    });
    const result = await runToolCallingLoop({ ...options, tools: { mutation: tool } });
    expect(result.toolResults[0].result.code).toBe('invalid_tool_result');
    expect(result.toolResults[0].success).toBe(false);
    expect(saveMessage.mock.calls.some(([m]: any[]) => m.content === '✅ mutation completed')).toBe(false);
  });
});
