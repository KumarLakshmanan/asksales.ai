import { describe, expect, it, jest } from '@jest/globals';

const emitChatResponseChunk = jest.fn();
const loggerError = jest.fn();

class MockProviderResponseError extends Error {
  readonly isProviderResponseError = true;

  constructor(
    message: string,
    readonly provider: string,
    readonly model: string,
  ) {
    super(message);
    this.name = 'LLMProviderResponseError';
  }
}

jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({
  LLMProviderFactory: {
    createProviderForUser: jest.fn(),
  },
  isRateLimitError: () => false,
}));

jest.unstable_mockModule('../services/agents/LLMProviderErrors.js', () => ({
  LLMProviderResponseError: MockProviderResponseError,
  classifyLLMProviderFailure: () => ({ category: 'insufficient_credits', status: 402 }),
  safeLLMProviderFailureMessage: () => 'OpenRouter HTTP 402 reports insufficient provider credits. Check the configured provider balance or use another configured provider.',
}));

jest.unstable_mockModule('../mastra/utils/toolCallingLoop.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runToolCallingLoop: jest.fn<any>().mockRejectedValue(
    new MockProviderResponseError('HTTP 402 Payment required. Authorization: Bearer secret-provider-token', 'openrouter', 'openai/test'),
  ),
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: loggerError, debug: jest.fn() },
}));

jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({
  webSocketEmitter: {
    emitAgentStatus: jest.fn(),
    emitChatResponseChunk,
  },
}));

const { BaseAgent } = await import('../mastra/agents/BaseAgent.js');

class ProviderFailureAgent extends BaseAgent {
  readonly agentType = 'content_studio' as const;
  readonly thinkingMessage = 'Thinking';

  buildSystemPrompt(): string {
    return 'You are Alex.';
  }

  getTools(): Record<string, never> {
    return {};
  }
}

describe('BaseAgent provider error response', () => {
  it('emits actionable billing copy and never the raw upstream error or credential', async () => {
    const result = await new ProviderFailureAgent().run({
      userId: 7,
      threadId: 42,
      messages: [{ role: 'user', content: 'Create ad copy' }],
      currentAgent: 'content_studio',
    } as never);

    const message = result.messages?.[0]?.content || '';
    expect(message).toContain('insufficient provider credits');
    expect(message).toContain('use another configured provider');
    expect(message).not.toContain('Payment required');
    expect(message).not.toContain('secret-provider-token');
    expect(result.error).toBe(message);
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain('secret-provider-token');
    expect(emitChatResponseChunk).toHaveBeenCalledWith(
      7,
      42,
      expect.objectContaining({ chunk: message, done: false }),
    );
  });
});
