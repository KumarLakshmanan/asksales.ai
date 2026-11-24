import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const create = jest.fn<any>();
const constructorOptions: unknown[] = [];
const loggerInfo = jest.fn();
const loggerWarn = jest.fn();
const loggerError = jest.fn();
jest.unstable_mockModule('openai', () => ({
  default: class {
    chat = { completions: { create } };
    constructor(options: unknown) { constructorOptions.push(options); }
  },
}));
jest.unstable_mockModule('../models/llmUsages/functions', () => ({ createLLMUsage: jest.fn() }));
jest.unstable_mockModule('../models/apiPricing/functions', () => ({
  getApiPricingByKey: jest.fn<() => Promise<null>>().mockResolvedValue(null), getAllApiPricing: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]), getLLMModelCost: jest.fn(), getOriginalLLMModelCost: jest.fn(),
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: loggerInfo, warn: loggerWarn, error: loggerError },
}));
process.env.OPENROUTER_MAX_OUTPUT_TOKENS = '8192';
const { OpenRouterProvider } = await import('../services/agents/OpenRouterProvider.js');

// LLMProvider binds methods through a Proxy; spying on a property returns a
// bound function instead of Jest's mock. Install the isolated logger explicitly.
function stubUsage(provider: InstanceType<typeof OpenRouterProvider>) {
  const logger = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(provider, 'logUsage', { value: logger, configurable: true });
  return logger;
}

beforeEach(() => {
  create.mockReset();
  constructorOptions.length = 0;
  loggerInfo.mockReset();
  loggerWarn.mockReset();
  loggerError.mockReset();
});

describe('OpenRouter output reservations', () => {
  it('bounds provider requests to the shared widget-safe timeout without SDK retries', () => {
    new OpenRouterProvider('test-key', 'openai/test');
    expect(constructorOptions).toEqual([
      expect.objectContaining({ timeout: 120_000, maxRetries: 0 }),
    ]);
  });

  it.each([
    [undefined, 8192], [65536, 8192], [2048, 2048], [0, 8192],
    [-1, 8192], [NaN, 8192], [Infinity, 8192], [12.9, 12],
  ])('bounds chat output %s to %s without changing the caller', async (requested, expected) => {
    create.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    const options = { model: 'openai/test', messages: [{ role: 'user', content: 'Test' }], max_tokens: requested };
    const result = await new OpenRouterProvider('test-key', options.model).createChatCompletion(options);
    expect(result.success).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: expected }));
    expect(options.max_tokens).toBe(requested);
  });

  it.each([undefined, 65536])('also bounds streaming output %s', async requested => {
    create.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: 'ok' } }] };
    })());
    const result = await new OpenRouterProvider('test-key', 'openai/test').createChatCompletionStream({
      model: 'openai/test', messages: [{ role: 'user', content: 'Test' }],
      max_tokens: requested, onChunk: jest.fn(), onComplete: jest.fn(),
    });
    expect(result.success).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 8192 }));
  });

  it('reserves visible JSON headroom for paragraph selection without affecting other calls', async () => {
    create.mockResolvedValue({ choices: [{ message: { content: '{"paragraphIds":[]}' } }] });
    const provider = new OpenRouterProvider('test-key', 'openai/test');
    stubUsage(provider);
    const options = {
      model: 'openai/test', messages: [{ role: 'user', content: 'Select paragraph IDs as JSON' }],
      max_tokens: 2048,
      loggingContext: { purpose: 'knowledge_extractive_repair', service: 'KnowledgeExtractiveAnswer' },
    };
    await provider.createChatCompletion(options);
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ max_tokens: 2048, reasoning: { effort: 'low' } }));
    expect(options).not.toHaveProperty('reasoning');
    await provider.createChatCompletion({ ...options, loggingContext: { purpose: 'other', service: 'Other' } });
    expect(create.mock.calls.at(-1)?.[0]).not.toHaveProperty('reasoning');
  });

  it('reserves visible JSON headroom for action-claim grounding', async () => {
    create.mockResolvedValue({ choices: [{ message: { content: '{"unsupportedClaims":false,"claims":[]}' } }] });
    const provider = new OpenRouterProvider('test-key', 'openai/test');
    stubUsage(provider);
    await provider.createChatCompletion({
      model: 'openai/test', messages: [{ role: 'user', content: 'Audit action claims as JSON' }],
      max_tokens: 2000,
      loggingContext: { purpose: 'response_grounding', service: 'ResponseGrounding' },
    });
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ max_tokens: 2000, reasoning: { effort: 'low' } }));
  });

  it('bounds reasoning for campaign reply verification', async () => {
    create.mockResolvedValue({ choices: [{ message: { content: '{"valid":true}' } }] });
    const provider = new OpenRouterProvider('test-key', 'openai/test');
    stubUsage(provider);
    await provider.createChatCompletion({
      model: 'openai/test', messages: [{ role: 'user', content: 'Verify this reply as JSON' }],
      max_tokens: 800, loggingContext: { purpose: 'campaign_email_reply_verification', service: 'CampaignEmailReplyService' },
    });
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ max_tokens: 800, reasoning: { effort: 'low' } }));
  });

  it('fails closed for an empty reasoning-only completion', async () => {
    create.mockResolvedValue({ choices: [{ finish_reason: 'length', message: { content: '' } }],
      usage: { completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 500 } } });
    const result = await new OpenRouterProvider('test-key', 'openai/test').createChatCompletion({
      model: 'openai/test', messages: [{ role: 'user', content: 'Test' }], max_tokens: 500,
    });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('no visible completion content') });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('retries once with a conservative cap only for a precisely matched affordable output limit', async () => {
    create.mockRejectedValueOnce({
      status: 402,
      message: 'This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 4000 tokens.',
    });
    create.mockResolvedValueOnce({ choices: [{ message: { content: 'Recovered response' } }] });
    const options = {
      model: 'openai/test', messages: [{ role: 'user', content: 'Test' }], max_tokens: 8192,
    };

    const result = await new OpenRouterProvider('test-key', options.model).createChatCompletion(options);

    expect(result).toMatchObject({ success: true, content: 'Recovered response' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 8192 });
    expect(create.mock.calls[1]?.[0]).toMatchObject({ max_tokens: 3600 });
    expect(options.max_tokens).toBe(8192);
  });

  it.each([
    [{ status: 402, message: 'Payment required. Authorization: Bearer secret-provider-token' }, 8192],
    [{ status: 402, message: 'This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 1000 tokens.' }, 8192],
    [{ status: 402, message: 'This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 0 tokens.' }, 8192],
    [{ status: 429, message: 'Rate limited. Authorization: Bearer secret-provider-token' }, 8192],
  ])('does not retry non-recoverable or ambiguous failure %#', async (error, requested) => {
    create.mockRejectedValue(error);
    const provider = new OpenRouterProvider('test-key', 'openai/test');
    const usageLogger = stubUsage(provider);
    const result = await provider.createChatCompletion({
      model: 'openai/test', messages: [{ role: 'user', content: 'Test' }], max_tokens: requested,
      loggingContext: { purpose: 'test', service: 'OpenRouterProvider', userId: 1 },
    });

    expect(result.success).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.error).not.toContain('secret-provider-token');
    expect(JSON.stringify(usageLogger.mock.calls)).not.toContain('secret-provider-token');
  });

  it('treats an empty stream as failure instead of completing successfully', async () => {
    create.mockResolvedValue((async function* () {
      yield { choices: [{ delta: { content: '   ' } }] };
    })());
    const onChunk = jest.fn();
    const onComplete = jest.fn();
    const onError = jest.fn();

    const result = await new OpenRouterProvider('test-key', 'openai/test').createChatCompletionStream({
      model: 'openai/test', messages: [{ role: 'user', content: 'Test' }],
      onChunk, onComplete, onError,
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('no visible completion content') });
    expect(onError).toHaveBeenCalledWith(result.error);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('maps upstream failures without exposing provider bodies or credentials', async () => {
    create.mockRejectedValue({
      status: 402,
      message: 'Payment required; authorization=sk-or-secret-key customer=private-customer-id',
    });
    const provider = new OpenRouterProvider('test-key', 'openai/test');
    const logUsage = stubUsage(provider);
    const result = await provider.createChatCompletion({
      model: 'openai/test', messages: [{ role: 'user', content: 'Test' }], max_tokens: 8192,
      loggingContext: { purpose: 'test', service: 'OpenRouterProvider', userId: 1 },
    });

    expect(result.error).toContain('insufficient provider credits');
    expect(result.error).not.toContain('sk-or-secret-key');
    expect(result.error).not.toContain('private-customer-id');
    expect(JSON.stringify(logUsage.mock.calls)).not.toContain('sk-or-secret-key');
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain('sk-or-secret-key');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
