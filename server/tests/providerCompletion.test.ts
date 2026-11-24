import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const primaryCompletion = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fallbackCompletion = jest.fn<any>();
const executeProviderCallWithFallback = jest.fn(async (
  _userId: number,
  call: (provider: any) => Promise<unknown>,
) => {
  let lastError: unknown;
  for (const provider of [
    {
      defaultModel: 'primary-model',
      getProviderName: () => 'primary',
      createChatCompletion: primaryCompletion,
    },
    {
      defaultModel: 'fallback-model',
      getProviderName: () => 'fallback',
      createChatCompletion: fallbackCompletion,
    },
  ]) {
    try {
      return await call(provider);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
});

jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({
  LLMProviderFactory: {
    executeProviderCallWithFallback,
  },
}));

const { createCompletionWithProviderFallback } = await import('../mastra/utils/providerCompletion.js');

describe('content provider completion fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('retries a failed configured provider and returns the fallback response', async () => {
    primaryCompletion.mockResolvedValueOnce({ success: false, error: 'provider unavailable' });
    fallbackCompletion.mockResolvedValueOnce({ success: true, content: '{"subject":"Ready"}' });

    await expect(createCompletionWithProviderFallback(7, {
      messages: [{ role: 'user', content: 'Generate copy' }],
      response_format: { type: 'json_object' },
    })).resolves.toMatchObject({ success: true, content: '{"subject":"Ready"}' });

    expect(primaryCompletion).toHaveBeenCalledWith(expect.objectContaining({ model: 'primary-model' }));
    expect(fallbackCompletion).toHaveBeenCalledWith(expect.objectContaining({ model: 'fallback-model' }));
  });

  it('does not convert an all-provider failure into a successful result', async () => {
    primaryCompletion.mockResolvedValueOnce({ success: false, error: 'primary failed' });
    fallbackCompletion.mockResolvedValueOnce({ success: false, error: 'fallback failed' });

    await expect(createCompletionWithProviderFallback(7, {
      messages: [{ role: 'user', content: 'Generate copy' }],
    })).rejects.toThrow('fallback failed');
  });
});
