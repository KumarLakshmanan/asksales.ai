import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getAllActiveAdminCredentials = jest.fn<any>();
const getActiveAdminCredential = jest.fn<any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const updateAdminCredentialLastUsed = jest.fn<any>().mockResolvedValue(undefined);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const markAdminCredentialInactive = jest.fn<any>();
const loggerWarn = jest.fn();
let openRouterResponseError: string | null = null;

jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({
  getActiveAdminCredential,
  getNextActiveAdminCredential: jest.fn(),
  markAdminCredentialInactive,
  getAllActiveAdminCredentials,
  getActiveLLMAdminCredentials: async () => (await Promise.all(['gemini', 'openai', 'vertex_ai', 'openrouter', 'custom_ai']
    .map(async platform => (await getAllActiveAdminCredentials(platform)).map((credential: any) => ({
      ...credential, platform, isActive: true, priority: 'normal',
    }))))).flat(),
  updateAdminCredentialLastUsed,
}));

class MockProvider {
  readonly defaultModel: string;

  constructor(
    readonly providerName: string,
    _apiKey: string,
    model?: string,
  ) {
    this.defaultModel = model || '';
  }

  getProviderName() {
    return this.providerName;
  }

  async createChatCompletion(options: { model: string }) {
    if (this.providerName === 'openrouter' && openRouterResponseError) {
      return { success: false, error: openRouterResponseError };
    }
    if (this.providerName === 'gemini') {
      return { success: false, error: 'Gemini credential rejected' };
    }
    return {
      success: true,
      content: `${this.providerName} response`,
      completion: { choices: [{ message: { content: `${this.providerName} response` } }], model: options.model },
    };
  }
}

jest.unstable_mockModule('../services/agents/OpenAIService.js', () => ({
  OpenAIService: class extends MockProvider {
    constructor(apiKey: string, model?: string) {
      super('openai', apiKey, model);
    }
  },
}));

jest.unstable_mockModule('../services/agents/GeminiProvider.js', () => ({
  GeminiProvider: class extends MockProvider {
    constructor(apiKey: string, model?: string) {
      super('gemini', apiKey, model);
    }
  },
}));

jest.unstable_mockModule('../services/agents/VertexAIProvider.js', () => ({
  VertexAIProvider: class extends MockProvider {
    constructor(apiKey: string, model?: string) {
      super('vertex_ai', apiKey, model);
    }
  },
}));

jest.unstable_mockModule('../services/agents/OpenRouterProvider.js', () => ({
  OpenRouterProvider: class extends MockProvider {
    constructor(apiKey: string, model?: string) {
      super('openrouter', apiKey, model);
    }
  },
}));

jest.unstable_mockModule('../services/agents/CustomAIProvider.js', () => ({
  CustomAIProvider: class extends MockProvider {
    constructor(apiKey: string, _baseURL: string, model?: string) {
      super('custom_ai', apiKey, model);
    }
  },
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: loggerWarn,
    error: jest.fn(),
  },
}));

const { LLMProviderFactory } = await import('../services/agents/LLMProviderFactory.js');
const { LLMProviderResponseError } = await import('../services/agents/LLMProviderErrors.js');
const { db } = await import('../models/db.js');

describe('isolated intent classifier provider', () => {
  it.each(['openrouter', 'openai', 'gemini', 'vertex_ai'])('uses the supplied %s classifier credential and model', async platform => {
    const result = LLMProviderFactory.createClassifierProvider(9, {
      id: 27, platform, apiKey: 'classifier-key', isActive: true, config: { model: 'classifier-model' },
    } as any);
    expect(result.defaultModel).toBe('classifier-model');
    expect(result.getProviderName()).toBe(platform);
    expect(getActiveAdminCredential).not.toHaveBeenCalled();
  });
});

describe('LLMProviderFactory non-mutating provider fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    openRouterResponseError = null;
    getAllActiveAdminCredentials.mockImplementation((platform: string) => {
      if (platform === 'gemini') {
        return Promise.resolve([{ id: 11, apiKey: 'gemini-key', config: { model: 'credential-gemini' } }]);
      }
      if (platform === 'openai') {
        return Promise.resolve([{ id: 12, apiKey: 'openai-key', config: { model: 'gpt-fallback' } }]);
      }
      return Promise.resolve([]);
    });
  });

  it('explains a quota-disabled platform when no text providers are active', async () => {
    getAllActiveAdminCredentials.mockResolvedValue([]);
    const lookup = jest.spyOn(db, 'execute').mockResolvedValue({ rows: [{ platform: 'openrouter' }] });
    try {
      await expect(LLMProviderFactory.createProviderForUser(9)).rejects.toMatchObject({
        name: 'LLMProviderQuotaError',
        message: expect.stringMatching(/OpenRouter.*on the AskSales side.*contact AskSales Support/),
      });
      await expect(LLMProviderFactory.createChatCompletionWithFallback(9, { model: '', messages: [] })).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('contact AskSales Support'),
      });
      expect(markAdminCredentialInactive).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it('tries the next active provider without deactivating the rejected credential', async () => {
    const attempted: string[] = [];
    const result = await LLMProviderFactory.executeProviderCallWithFallback(
      7,
      async (provider) => {
        attempted.push(provider.getProviderName());
        if (provider.getProviderName() === 'gemini') {
          expect(provider.defaultModel).toBe('credential-gemini');
          throw new LLMProviderResponseError(
            '400 Provider returned error',
            provider.getProviderName(),
            provider.defaultModel,
          );
        }
        return 'fallback response';
      },
    );

    expect(result).toBe('fallback response');
    expect(attempted).toEqual(['gemini', 'openai']);
    expect(updateAdminCredentialLastUsed).toHaveBeenCalledWith(11);
    expect(updateAdminCredentialLastUsed).toHaveBeenCalledWith(12);
    expect(markAdminCredentialInactive).not.toHaveBeenCalled();
  });

  it('does not retry an application exception', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callback = jest.fn<any>().mockRejectedValue(new Error('Local validation failed'));

    await expect(
      LLMProviderFactory.executeProviderCallWithFallback(7, callback),
    ).rejects.toThrow('Local validation failed');
    expect(callback).toHaveBeenCalledTimes(1);
    expect(markAdminCredentialInactive).not.toHaveBeenCalled();
  });

  it('stops provider fallback after a response timeout', async () => {
    const attempted: string[] = [];
    await expect(LLMProviderFactory.executeProviderCallWithFallback(7, async (provider) => {
      attempted.push(provider.getProviderName());
      throw new LLMProviderResponseError('Request timed out after 120000ms', provider.getProviderName(), provider.defaultModel);
    })).rejects.toThrow('Request timed out');

    expect(attempted).toEqual(['gemini']);
    expect(updateAdminCredentialLastUsed).toHaveBeenCalledTimes(1);
    expect(markAdminCredentialInactive).not.toHaveBeenCalled();
  });

  it('quarantines a quota-exhausted credential before using the next provider', async () => {
    const result = await LLMProviderFactory.executeProviderCallWithFallback(
      7,
      async (provider) => {
        if (provider.getProviderName() === 'gemini') {
          throw new LLMProviderResponseError(
            '429 quota exceeded for this credential',
            provider.getProviderName(),
            provider.defaultModel,
          );
        }
        return 'fallback response';
      },
    );

    expect(result).toBe('fallback response');
    expect(markAdminCredentialInactive).toHaveBeenCalledWith(11, 'quota_exceeded');
  });

  it('does not quarantine a credential when OpenRouter credit verification times out', async () => {
    getAllActiveAdminCredentials.mockImplementation((platform: string) => Promise.resolve(
      platform === 'openrouter' ? [{ id: 28, apiKey: 'router-key', config: { model: 'openai/test' } }] : [],
    ));

    await expect(LLMProviderFactory.executeProviderCallWithFallback(7, async () => {
      throw new LLMProviderResponseError(
        '429 OpenRouter could not verify available credits for this request in time. Retry shortly.',
        'openrouter', 'openai/test',
      );
    })).rejects.toThrow('429');

    expect(markAdminCredentialInactive).not.toHaveBeenCalled();
  });

  it.each([
    ['31568', false],
    ['0', true],
  ])('only disables a 402 credential when its affordable budget is exhausted (%s)', async (affordable, disabled) => {
    getAllActiveAdminCredentials.mockImplementation((platform: string) => Promise.resolve(
      platform === 'openrouter' ? [{ id: 28, apiKey: 'router-key', config: { model: 'openai/test' } }] : [],
    ));
    await expect(LLMProviderFactory.executeProviderCallWithFallback(7, async () => {
      throw new LLMProviderResponseError(
        `402 This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford ${affordable}.`,
        'openrouter', 'openai/test',
      );
    })).rejects.toThrow('402');
    if (disabled) expect(markAdminCredentialInactive).toHaveBeenCalledWith(28, 'quota_exceeded');
    else expect(markAdminCredentialInactive).not.toHaveBeenCalled();
  });

  it('returns a safe OpenRouter affordability message and omits upstream text from fallback logs', async () => {
    const upstreamSecret = 'sk-or-sensitive-provider-token';
    openRouterResponseError = `OpenRouter HTTP 402 request requires fewer max_tokens; can only afford 3000 tokens. authorization=${upstreamSecret}`;
    getAllActiveAdminCredentials.mockImplementation((platform: string) => Promise.resolve(
      platform === 'openrouter' ? [{ id: 28, apiKey: 'router-key', config: { model: 'openai/test' } }] : [],
    ));

    const response = await LLMProviderFactory.createChatCompletionWithFallback(7, {
      model: 'openai/test', messages: [{ role: 'user', content: 'Test' }],
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain('Retry with a lower output limit');
    expect(response.error).not.toContain(upstreamSecret);
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain(upstreamSecret);
    expect(markAdminCredentialInactive).not.toHaveBeenCalled();
  });

  it('uses Vertex AI as a governed fallback after Gemini Developer API', async () => {
    getAllActiveAdminCredentials.mockImplementation((platform: string) => {
      if (platform === 'vertex_ai') {
        return Promise.resolve([{
          id: 21,
          apiKey: '{"type":"service_account"}',
          config: { model: 'gemini-2.5-flash', location: 'asia-south1' },
        }]);
      }
      if (platform === 'gemini') {
        return Promise.resolve([{ id: 22, apiKey: 'developer-api-key', config: { model: 'gemini-2.5-flash' } }]);
      }
      return Promise.resolve([]);
    });

    const attempted: string[] = [];
    const result = await LLMProviderFactory.executeProviderCallWithFallback(
      7,
      async (provider) => {
        attempted.push(provider.getProviderName());
        if (provider.getProviderName() === 'gemini') {
          throw new LLMProviderResponseError('Developer API unavailable', 'gemini', provider.defaultModel);
        }
        return 'vertex response';
      },
    );

    expect(result).toBe('vertex response');
    expect(attempted).toEqual(['gemini', 'vertex_ai']);
    expect(updateAdminCredentialLastUsed).toHaveBeenCalledWith(22);
    expect(updateAdminCredentialLastUsed).toHaveBeenCalledWith(21);
    expect(markAdminCredentialInactive).not.toHaveBeenCalled();
  });

  it('retries unsuccessful support completions and records the provider that answered', async () => {
    getAllActiveAdminCredentials.mockImplementation((platform: string) => {
      if (platform === 'gemini') {
        return Promise.resolve([{ id: 31, apiKey: 'broken-developer-key', config: { model: 'gemini-2.5-flash' } }]);
      }
      if (platform === 'vertex_ai') {
        return Promise.resolve([{ id: 32, apiKey: 'service-account', config: { model: 'gemini-2.5-flash' } }]);
      }
      return Promise.resolve([]);
    });

    const response = await LLMProviderFactory.createChatCompletionWithFallback(7, {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(response).toMatchObject({
      success: true,
      content: 'vertex_ai response',
      completion: { provider: 'vertex_ai', model: 'gemini-2.5-flash' },
    });
    expect(updateAdminCredentialLastUsed).toHaveBeenCalledWith(31);
    expect(updateAdminCredentialLastUsed).toHaveBeenCalledWith(32);
  });

  it('uses the pinned Claude model when the OpenRouter fallback credential has no configured model', async () => {
    getAllActiveAdminCredentials.mockImplementation((platform: string) => {
      if (platform === 'gemini') {
        return Promise.resolve([
          { id: 41, apiKey: 'denied-gemini-key', config: { model: 'gemini-3.1-flash-lite' } },
          { id: 42, apiKey: 'quota-limited-gemini-key', config: { model: 'gemini-3.1-flash-lite' } },
        ]);
      }
      if (platform === 'openrouter') {
        return Promise.resolve([{ id: 43, apiKey: 'openrouter-key', config: {} }]);
      }
      return Promise.resolve([]);
    });

    const response = await LLMProviderFactory.createChatCompletionWithFallback(7, {
      model: 'gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'Create compliant Meta and Google ad copy.' }],
    });

    expect(response).toMatchObject({
      success: true,
      content: 'openrouter response',
      completion: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' },
    });
    expect(updateAdminCredentialLastUsed).toHaveBeenCalledWith(41);
    expect(updateAdminCredentialLastUsed).toHaveBeenCalledWith(42);
    expect(updateAdminCredentialLastUsed).toHaveBeenCalledWith(43);
  });
});
