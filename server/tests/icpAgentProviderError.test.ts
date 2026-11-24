import { describe, expect, it, jest } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createCompletionWithProviderFallback = jest.fn<any>();
const emitChatResponseChunk = jest.fn();
const loggerError = jest.fn();
const webSocketEmitter = {
  emitAgentStatus: jest.fn(),
  emitChatResponseChunk,
  emitChatResponse: jest.fn(),
  emitToolExecution: jest.fn(),
  emit: jest.fn(),
};

jest.unstable_mockModule('../mastra/utils/providerCompletion.js', () => ({
  createCompletionWithProviderFallback,
}));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: loggerError, debug: jest.fn() },
}));
jest.unstable_mockModule('../mastra/utils/contextManager.js', () => ({
  buildAgentContext: () => '',
  prepareContextForAgent: (state: { messages: unknown[] }) => state.messages,
}));
jest.unstable_mockModule('../mastra/tools/toolRegistry.js', () => ({ getToolDescriptionsForAgent: () => '' }));
jest.unstable_mockModule('../mastra/tools/executors/icpExecutor.js', () => ({
  executeGenerateIcp: jest.fn(),
  executeCrawlWebsite: jest.fn(),
}));

const { LLMProviderResponseError } = await import('../services/agents/LLMProviderErrors.js');
const { runIcpAgent } = await import('../mastra/agents/icpAgent.js');

describe('ICP agent provider error response', () => {
  it('surfaces safe actionable billing guidance in response and state, not upstream details', async () => {
    const upstreamSecret = 'secret-provider-token';
    createCompletionWithProviderFallback.mockRejectedValue(new LLMProviderResponseError(
      `HTTP 402 Payment required. Authorization: Bearer ${upstreamSecret}`,
      'openrouter',
      'openai/test',
    ));

    const result = await runIcpAgent({
      userId: 7,
      threadId: 42,
      messages: [{ role: 'user', content: 'Create an ICP for my resort' }],
      currentAgent: 'icp_generation',
      icpProfile: null,
    } as never);

    const message = result.messages?.[0]?.content || '';
    expect(message).toContain('insufficient provider credits');
    expect(message).toContain('contact AskSales Support');
    expect(message).not.toContain('Payment required');
    expect(message).not.toContain(upstreamSecret);
    expect(result.error).toBe(message);
    expect(result.tasksCompleted).toBe(false);
    expect(result.workflowOutcome).toBe('failed');
    expect(emitChatResponseChunk).toHaveBeenCalledWith(
      7,
      42,
      expect.objectContaining({ chunk: message, done: false }),
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(upstreamSecret);
  });
});
