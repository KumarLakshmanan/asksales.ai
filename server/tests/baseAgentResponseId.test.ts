import { describe, expect, it, jest } from '@jest/globals';

const emitChatResponseChunk = jest.fn();

jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({
  webSocketEmitter: {
    emitAgentStatus: jest.fn(),
    emitChatResponseChunk,
  },
}));

const { BaseAgent } = await import('../mastra/agents/BaseAgent.js');

class EarlyResponseAgent extends BaseAgent {
  readonly agentType = 'content_studio' as const;
  readonly thinkingMessage = 'Thinking';

  buildSystemPrompt(): string {
    return '';
  }

  getTools(): Record<string, never> {
    return {};
  }

  protected async preProcess() {
    return {
      earlyResponse: 'Choose a content type',
      earlyActionButtons: [],
    };
  }
}

describe('BaseAgent early responses', () => {
  it('reuses one response ID for streaming and durable-message reconciliation', async () => {
    emitChatResponseChunk.mockClear();
    const result = await new EarlyResponseAgent().run({
      userId: 7,
      threadId: 42,
      messages: [{ role: 'user', content: 'Create content' }],
      currentAgent: 'supervisor',
    } as never);

    expect(result.lastResponseId).toEqual(expect.stringMatching(/^content_studio-/));
    expect(emitChatResponseChunk).toHaveBeenCalledTimes(2);
    expect(emitChatResponseChunk.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      responseId: result.lastResponseId,
      done: false,
    }));
    expect(emitChatResponseChunk.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      responseId: result.lastResponseId,
      done: true,
    }));
  });
});
