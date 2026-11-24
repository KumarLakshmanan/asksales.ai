import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AdminApiPlatform } from '../models/adminApiCredentials/functions.js';

interface ProviderCredential {
  id: number;
  apiKey: string;
  config: Record<string, unknown>;
}

const getAllActiveAdminCredentials = jest.fn<(platform: AdminApiPlatform) => Promise<ProviderCredential[]>>();
const updateAdminCredentialLastUsed = jest.fn<(id: number) => Promise<void>>();
const createOpenAIUsage = jest.fn<(record: unknown) => Promise<void>>();
const llmPricingSnapshot = jest.fn<(model: string, provider: string) => Promise<unknown>>();
let pricingGuardEnabled = false;

jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({
  getAllActiveAdminCredentials,
  updateAdminCredentialLastUsed,
}));

jest.unstable_mockModule('../models/openaiUsages/functions.js', () => ({
  createOpenAIUsage,
}));
jest.unstable_mockModule('../services/insights/RuntimeService.js', () => ({
  getInsightsRuntime: async () => ({ enabled: pricingGuardEnabled, pricingGuardEnabled }),
}));
jest.unstable_mockModule('../services/insights/PricingService.js', () => ({ llmPricingSnapshot }));

const { AI_VISIBILITY_OBSERVATION_PROVIDERS, ProviderObservationService, resolveGroundingRedirects } = await import('../services/aiVisibility/ProviderObservationService.js');
const { StructuredAnswerExtractionService } = await import('../services/aiVisibility/StructuredAnswerExtractionService.js');

function credential(config: Record<string, unknown> = {}) {
  return { id: 9, apiKey: 'secret-key', config };
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => { pricingGuardEnabled = false; llmPricingSnapshot.mockResolvedValue(undefined); });

describe('AI Visibility live provider observations', () => {
  const service = new ProviderObservationService();
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    updateAdminCredentialLastUsed.mockResolvedValue(undefined);
    createOpenAIUsage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const openRouterOnly = (config: Record<string, unknown> = {}) =>
    getAllActiveAdminCredentials.mockImplementation(async (platform) =>
      platform === 'openrouter' ? [{ id: 28, apiKey: 'openrouter-key', config }] : []);
  const openRouterAnswer = (model: string) => jsonResponse({
    model,
    choices: [{ message: {
      content: 'Orbit is a strong option.',
      annotations: [
        { type: 'url_citation', url_citation: { url: 'https://source.test/a', title: 'A' } },
        { type: 'url_citation', url_citation: { url: 'https://source.test/a', title: 'Duplicate' } },
      ],
    } }],
    usage: { prompt_tokens: 120, completion_tokens: 80, cost: 0.0031 },
  });

  it('asks ChatGPT, Gemini, Perplexity and Claude', () => {
    expect(AI_VISIBILITY_OBSERVATION_PROVIDERS).toEqual(['openai', 'gemini', 'perplexity', 'claude']);
  });

  it('asks every engine through OpenRouter with web search, never a direct key', async () => {
    // A direct OpenAI or Gemini key is active (and out of quota); it must not be tried.
    getAllActiveAdminCredentials.mockImplementation(async (platform) => platform === 'openrouter'
      ? [{ id: 28, apiKey: 'openrouter-key', config: {} }]
      : [{ id: 10, apiKey: 'direct-key', config: { model: 'direct-model' } }]);
    global.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      openRouterAnswer(JSON.parse(String(init?.body)).model)) as typeof fetch;
    const expected = [
      ['openai', 'openai/gpt-6-luna'],
      ['gemini', 'google/gemini-3.1-flash-lite'],
      ['perplexity', 'perplexity/sonar'],
      ['claude', 'anthropic/claude-haiku-5.5'],
    ] as const;

    for (const [provider, model] of expected) {
      await expect(service.getConfiguredModel(provider)).resolves.toBe(`${model} via openrouter`);
      const result = await service.collect(provider, 'Compare Orbit', 'en-US', { userId: 4, auditId: 12 });
      expect(result).toEqual(expect.objectContaining({
        provider, model: `${model} via openrouter`, status: 'completed', answer: 'Orbit is a strong option.',
        citations: [{ url: 'https://source.test/a', title: 'A' }], inputTokens: 120, outputTokens: 80, costCents: 0.31,
      }));
    }
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls.map((call) => String(call[0]))).toEqual(Array(4).fill('https://openrouter.ai/api/v1/chat/completions'));
    const requests = calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    for (const request of requests)
      expect(request).toEqual(expect.objectContaining({ plugins: [{ id: 'web', max_results: 5 }], max_tokens: 6000 }));
    // GPT-6 and Claude think less, so their answers are not cut off.
    expect(requests.map((request) => request.reasoning?.effort ?? null)).toEqual(['low', null, null, 'low']);
    expect(updateAdminCredentialLastUsed).not.toHaveBeenCalledWith(10);
    expect(createOpenAIUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude', purpose: 'ai_visibility_provider_observation', responseSuccess: 1,
      metadata: expect.objectContaining({ auditId: 12, transport: 'openrouter', citationCount: 1 }),
    }));
  });

  it('uses the models set on the OpenRouter credential', async () => {
    openRouterOnly({
      aiVisibilityOpenAiModel: 'openai/gpt-6-sol',
      aiVisibilityGeminiModel: 'google/gemini-3.5-flash',
      aiVisibilityPerplexityModel: 'perplexity/sonar-pro',
      aiVisibilityClaudeModel: 'anthropic/claude-sonnet-5.5',
    });
    await expect(service.getConfiguredModel('openai')).resolves.toBe('openai/gpt-6-sol via openrouter');
    await expect(service.getConfiguredModel('gemini')).resolves.toBe('google/gemini-3.5-flash via openrouter');
    await expect(service.getConfiguredModel('perplexity')).resolves.toBe('perplexity/sonar-pro via openrouter');
    await expect(service.getConfiguredModel('claude')).resolves.toBe('anthropic/claude-sonnet-5.5 via openrouter');
  });

  it('skips an OpenRouter credential with an empty key', async () => {
    getAllActiveAdminCredentials.mockImplementation(async (platform) => platform === 'openrouter'
      ? [{ id: 1, apiKey: ' ', config: { aiVisibilityClaudeModel: 'empty' } }, { id: 2, apiKey: 'ready', config: {} }]
      : []);
    await expect(service.getConfiguredModel('claude')).resolves.toBe('anthropic/claude-haiku-5.5 via openrouter');
  });

  it('fails without a request when there is no OpenRouter key, even with direct keys', async () => {
    getAllActiveAdminCredentials.mockImplementation(async (platform) =>
      platform === 'openrouter' ? [] : [credential({ model: 'direct-model' })]);
    global.fetch = jest.fn() as typeof fetch;

    await expect(service.getConfiguredModel('openai')).resolves.toBeNull();
    const result = await service.collect('openai', 'Which provider is best?', 'en-US', { userId: 4, auditId: 12 });

    expect(result).toEqual({
      provider: 'openai',
      model: 'unconfigured',
      fidelity: 'live_api',
      status: 'failed',
      citations: [],
      costCents: 0,
      error: 'An AskSales administrator needs to add an OpenRouter API key before AI engines can be asked.',
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(createOpenAIUsage).not.toHaveBeenCalled();
    expect((await service.readiness()).map((item) => item.configured)).toEqual([false, false, false, false]);
  });

  it('rejects an unpriced observation before calling OpenRouter', async () => {
    pricingGuardEnabled = true;
    llmPricingSnapshot.mockRejectedValue(new Error('Pricing is not configured.'));
    openRouterOnly();
    global.fetch = jest.fn() as typeof fetch;
    const result = await service.collect('claude', 'Compare products', 'en-US', { userId: 4, auditId: 12 });
    expect(result.status).toBe('failed');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(llmPricingSnapshot).toHaveBeenCalledWith('anthropic/claude-haiku-5.5', 'openrouter');
  });

  it('records OpenRouter failures as failed observations without synthetic answers', async () => {
    openRouterOnly();
    global.fetch = jest.fn(async () => jsonResponse({ error: { message: 'Rate limit exceeded' } }, 429)) as typeof fetch;

    const result = await service.collect('perplexity', 'Prompt', 'en-US', { userId: 7, auditId: 8 });

    expect(result).toEqual(expect.objectContaining({
      provider: 'perplexity', model: 'perplexity/sonar via openrouter', fidelity: 'live_api', status: 'failed',
      citations: [], costCents: 0, error: 'Rate limit exceeded',
    }));
    expect(result.answer).toBeUndefined();
    expect(createOpenAIUsage).toHaveBeenCalledWith(expect.objectContaining({ responseSuccess: 0, errorMessage: 'Rate limit exceeded' }));
  });

  it('tries the next OpenRouter key before failing the observation', async () => {
    getAllActiveAdminCredentials.mockImplementation(async (platform) => platform === 'openrouter' ? [
      { id: 27, apiKey: 'out-of-credit', config: {} },
      { id: 28, apiKey: 'working-key', config: {} },
    ] : []);
    global.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      String((init?.headers as Record<string, string>).Authorization).includes('out-of-credit')
        ? jsonResponse({ error: { message: 'Insufficient credits' } }, 402)
        : openRouterAnswer('anthropic/claude-haiku-5.5')) as typeof fetch;

    const result = await service.collect('claude', 'Prompt', 'en-US', { userId: 7, auditId: 8 });

    expect(result).toEqual(expect.objectContaining({ status: 'completed', model: 'anthropic/claude-haiku-5.5 via openrouter' }));
    expect(updateAdminCredentialLastUsed).toHaveBeenNthCalledWith(1, 27);
    expect(updateAdminCredentialLastUsed).toHaveBeenNthCalledWith(2, 28);
    expect(createOpenAIUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ responseSuccess: 0, errorMessage: 'Insufficient credits' }));
    expect(createOpenAIUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({ responseSuccess: 1 }));
  });

  it('stores the real page behind Gemini grounding redirect links', async () => {
    const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc';
    const fetcher = jest.fn(async (url: string | URL | Request) => String(url) === redirect
      ? new Response(null, { status: 302, headers: { location: 'https://www.marriott.com/hotels/blrjw' } })
      : new Response(null, { status: 302, headers: {} })) as unknown as typeof fetch;
    const result = await resolveGroundingRedirects([
      { url: redirect, title: 'marriott.com' },
      { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/unresolvable', title: 'x.com' },
      { url: 'https://example.com/direct', title: 'Direct' },
    ], fetcher);
    expect(result).toEqual([
      { url: 'https://www.marriott.com/hotels/blrjw', title: 'marriott.com' },
      { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/unresolvable', title: 'x.com' },
      { url: 'https://example.com/direct', title: 'Direct' },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fails an OpenRouter observation that returns no answer instead of storing an empty one', async () => {
    openRouterOnly();
    global.fetch = jest.fn(async () => jsonResponse({ choices: [{ message: { content: '' } }] })) as typeof fetch;
    const result = await service.collect('gemini', 'Compare Orbit', 'en-US', { userId: 4, auditId: 12 });
    expect(result).toEqual(expect.objectContaining({
      status: 'failed', model: 'google/gemini-3.1-flash-lite via openrouter', error: 'OpenRouter returned no gemini answer.',
    }));
  });
});

describe('AI Visibility structured answer extraction', () => {
  const service = new StructuredAnswerExtractionService();
  const originalFetch = global.fetch;
  const input = {
    prompt: 'Which analytics platform is best?',
    answer: '1. Orbit is recommended for clear reporting. 2. Rival is another option.',
    brandName: 'Orbit',
    brandAliases: ['Orbit Analytics'],
    knownCompetitors: [{ name: 'Rival', aliases: [] }],
  };
  const extractionAnswer = (fields: Record<string, unknown> = {}) => jsonResponse({
    model: 'openai/gpt-4.1-mini',
    choices: [{ message: { content: JSON.stringify({
      brandMentioned: true,
      brandRank: 1,
      sentiment: 'positive',
      competitors: ['Rival'],
      recommendationReason: 'Recommended for clear reporting.',
      exclusionReason: null,
      ...fields,
    }) } }],
    usage: { prompt_tokens: 80, completion_tokens: 30, cost: 0.0025 },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    updateAdminCredentialLastUsed.mockResolvedValue(undefined);
    createOpenAIUsage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reads answers through OpenRouter strict structured output, never a direct key', async () => {
    // Overloaded direct Gemini keys held answer reading up for minutes; they must not be tried.
    getAllActiveAdminCredentials.mockImplementation(async (platform) => platform === 'openrouter'
      ? [{ id: 28, apiKey: 'openrouter-key', config: { aiVisibilityExtractionModel: 'openai/gpt-4.1-mini' } }]
      : [credential({ model: 'gemini-direct' })]);
    global.fetch = jest.fn(async () => extractionAnswer()) as typeof fetch;

    const result = await service.extract(input, { userId: 4, auditId: 12, promptRunId: 31 });

    expect(result).toEqual(expect.objectContaining({
      status: 'completed', provider: 'openrouter', model: 'openai/gpt-4.1-mini', costCents: 0.25,
      method: 'structured_llm_v1', fidelity: 'live_api',
      extraction: expect.objectContaining({ brandMentioned: true, brandRank: 1, sentiment: 'positive', competitors: ['Rival'] }),
    }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toBe('https://openrouter.ai/api/v1/chat/completions');
    const request = JSON.parse(String(((global.fetch as jest.Mock).mock.calls[0][1] as RequestInit).body));
    expect(request.response_format).toEqual(expect.objectContaining({ type: 'json_schema' }));
    expect(request.response_format.json_schema).toEqual(expect.objectContaining({ strict: true, name: 'ai_visibility_extraction' }));
    expect(updateAdminCredentialLastUsed).toHaveBeenCalledWith(28);
    expect(createOpenAIUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openrouter', purpose: 'ai_visibility_answer_extraction', responseSuccess: 1,
      metadata: expect.objectContaining({ auditId: 12, promptRunId: 31, method: 'structured_llm_v1' }),
    }));
  });

  it('rejects structured data that breaks the rules and tries the next OpenRouter key', async () => {
    getAllActiveAdminCredentials.mockImplementation(async (platform) => platform === 'openrouter' ? [
      { id: 27, apiKey: 'first', config: {} },
      { id: 28, apiKey: 'second', config: {} },
    ] : []);
    global.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      String((init?.headers as Record<string, string>).Authorization).includes('first')
        // A rank without a mention is invalid.
        ? extractionAnswer({ brandMentioned: false, brandRank: 2 })
        : extractionAnswer()) as typeof fetch;

    const result = await service.extract(input, { userId: 4, auditId: 12, promptRunId: 31 });

    expect(result).toEqual(expect.objectContaining({ status: 'completed', provider: 'openrouter' }));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(createOpenAIUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ responseSuccess: 0 }));
    expect(createOpenAIUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({ responseSuccess: 1 }));
  });

  it('returns an explicit unavailable result when there is no OpenRouter key', async () => {
    getAllActiveAdminCredentials.mockImplementation(async (platform) =>
      platform === 'openrouter' ? [] : [credential({ model: 'gemini-direct' })]);
    global.fetch = jest.fn() as typeof fetch;

    const result = await service.extract(input, { userId: 4, auditId: 12, promptRunId: 31 });

    expect(result).toEqual(expect.objectContaining({
      status: 'failed', provider: 'unconfigured', model: 'unconfigured', costCents: 0,
      error: 'An OpenRouter API key is needed to read AI engine answers.',
    }));
    expect(result.extraction).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(createOpenAIUsage).not.toHaveBeenCalled();
  });
});
