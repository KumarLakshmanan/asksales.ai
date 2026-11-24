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

/** Credentials for the provider itself; no OpenRouter key, so the direct path is what's tested. */
function directOnly(credentials: ProviderCredential[]) {
  getAllActiveAdminCredentials.mockImplementation(async (platform) => (platform === 'openrouter' ? [] : credentials));
}

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

  it('uses a usable credential even when a higher-priority credential has an empty key', async () => {
    directOnly([{ id: 1, apiKey: '', config: {} }, credential({ model: 'ready-model' })]);
    expect(await service.getConfiguredModel('gemini')).toBe('ready-model');
  });

  it('exposes only the two grounded observation providers', () => {
    expect(AI_VISIBILITY_OBSERVATION_PROVIDERS).toEqual(['openai', 'gemini']);
  });

  it('returns an explicit failure without making a request when credentials are unavailable', async () => {
    directOnly([]);
    global.fetch = jest.fn() as typeof fetch;

    const result = await service.collect('openai', 'Which provider is best?', 'en-US', { userId: 4, auditId: 12 });

    expect(result).toEqual({
      provider: 'openai',
      model: 'unconfigured',
      fidelity: 'live_api',
      status: 'failed',
      citations: [],
      costCents: 0,
      error: 'openai API credential is not configured.',
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(createOpenAIUsage).not.toHaveBeenCalled();
  });

  it('rejects an unpriced observation before calling its provider', async () => {
    pricingGuardEnabled = true;
    llmPricingSnapshot.mockRejectedValue(new Error('Pricing is not configured.'));
    directOnly([credential({ model: 'unpriced-model' })]);
    global.fetch = jest.fn() as typeof fetch;
    const result = await service.collect('openai', 'Compare products', 'en-US', { userId: 4, auditId: 12 });
    expect(result.status).toBe('failed');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(llmPricingSnapshot).toHaveBeenCalledWith('unpriced-model','openai');
  });

  it('normalizes OpenAI answers, citations, token usage and configured cost', async () => {
    directOnly([credential({ model: 'gpt-test', inputCostPerMillion: 2, outputCostPerMillion: 4 })]);
    global.fetch = jest.fn(async () => jsonResponse({
      output_text: 'Orbit is one option.',
      output: [{ content: [{ annotations: [
        { url: 'https://example.com/source', title: 'Source' },
        { url: 'https://example.com/source', title: 'Duplicate' },
        { url: 'javascript:bad' },
      ] }] }],
      usage: { input_tokens: 100, output_tokens: 50 },
    })) as typeof fetch;

    const result = await service.collect('openai', 'Evaluate Orbit', 'en-CA', { userId: 4, auditId: 12 });

    expect(result).toEqual(expect.objectContaining({
      provider: 'openai', model: 'gpt-test', fidelity: 'live_api', status: 'completed',
      answer: 'Orbit is one option.', inputTokens: 100, outputTokens: 50, costCents: 0.04,
      citations: [{ url: 'https://example.com/source', title: 'Source' }],
    }));
    expect(global.fetch).toHaveBeenCalledWith('https://api.openai.com/v1/responses', expect.objectContaining({ method: 'POST' }));
    expect(updateAdminCredentialLastUsed).toHaveBeenCalledWith(9);
    expect(createOpenAIUsage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 4, provider: 'openai', purpose: 'ai_visibility_provider_observation',
      responseSuccess: 1, metadata: expect.objectContaining({ auditId: 12, fidelity: 'live_api', citationCount: 1 }),
    }));
  });

  it('normalizes Gemini grounded search responses', async () => {
    directOnly([credential({ model: 'gemini-test' })]);
    global.fetch = jest.fn(async () => jsonResponse({
      candidates: [{
        content: { parts: [{ text: 'Grounded answer' }, { text: 'Second paragraph' }] },
        groundingMetadata: { groundingChunks: [
          { web: { uri: 'https://google.example/a', title: 'A' } },
          { web: { uri: 'mailto:invalid' } },
        ] },
      }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 30 },
    })) as typeof fetch;

    const result = await service.collect('gemini', 'Compare providers', 'en-IN', { userId: 1, auditId: 2 });

    expect(result).toEqual(expect.objectContaining({
      provider: 'gemini', model: 'gemini-test', status: 'completed',
      answer: 'Grounded answer\nSecond paragraph', inputTokens: 20, outputTokens: 30,
      citations: [{ url: 'https://google.example/a', title: 'A' }],
    }));
    expect(String((global.fetch as jest.Mock).mock.calls[0][0])).toContain('gemini-test:generateContent');
  });

  it('records provider HTTP failures as failed live observations without synthetic answers', async () => {
    directOnly([credential({ model: 'gpt-test' })]);
    global.fetch = jest.fn(async () => jsonResponse({ error: { message: 'Rate limit exceeded' } }, 429)) as typeof fetch;

    const result = await service.collect('openai', 'Prompt', 'en-US', { userId: 7, auditId: 8 });

    expect(result).toEqual(expect.objectContaining({
      provider: 'openai', model: 'gpt-test', fidelity: 'live_api', status: 'failed',
      citations: [], costCents: 0, error: 'Rate limit exceeded',
    }));
    expect(result.answer).toBeUndefined();
    expect(createOpenAIUsage).toHaveBeenCalledWith(expect.objectContaining({ responseSuccess: 0, errorMessage: 'Rate limit exceeded' }));
  });

  it('uses provider defaults only when an active credential exists without a model override', async () => {
    directOnly([credential()]);
    await expect(service.getConfiguredModel('openai')).resolves.toBe('gpt-4.1-mini');
    await expect(service.getConfiguredModel('gemini')).resolves.toBe('gemini-2.5-flash');
    directOnly([]);
    await expect(service.getConfiguredModel('openai')).resolves.toBeNull();
  });

  it('tries the next active credential for the same provider before failing the observation', async () => {
    directOnly([
      { id: 10, apiKey: 'billing-denied', config: { model: 'gemini-first' } },
      { id: 11, apiKey: 'working-key', config: { model: 'gemini-second' } },
    ]);
    global.fetch = jest.fn(async (url: string | URL | Request) => String(url).includes('billing-denied')
      ? jsonResponse({ error: { message: 'Billing denied' } }, 403)
      : jsonResponse({ candidates: [{ content: { parts: [{ text: 'Verified answer' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://source.test', title: 'Source' } }] } }] })) as typeof fetch;

    const result = await service.collect('gemini', 'Prompt', 'en-US', { userId: 7, auditId: 8 });

    expect(result).toEqual(expect.objectContaining({ status: 'completed', model: 'gemini-second', answer: 'Verified answer' }));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(updateAdminCredentialLastUsed).toHaveBeenNthCalledWith(1, 10);
    expect(updateAdminCredentialLastUsed).toHaveBeenNthCalledWith(2, 11);
    expect(createOpenAIUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ responseSuccess: 0, errorMessage: 'Billing denied' }));
    expect(createOpenAIUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({ responseSuccess: 1 }));
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

  it('measures OpenAI and Gemini through OpenRouter with web search when they have no direct key', async () => {
    openRouterOnly();
    await expect(service.getConfiguredModel('openai')).resolves.toBe('openai/gpt-4.1-mini via openrouter');
    await expect(service.getConfiguredModel('gemini')).resolves.toBe('google/gemini-3.1-flash-lite via openrouter');
    global.fetch = jest.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      openRouterAnswer(JSON.parse(String(init?.body)).model)) as typeof fetch;

    for (const [provider, model] of [['openai', 'openai/gpt-4.1-mini'], ['gemini', 'google/gemini-3.1-flash-lite']] as const) {
      const result = await service.collect(provider, 'Compare Orbit', 'en-US', { userId: 4, auditId: 12 });
      expect(result).toEqual(expect.objectContaining({
        provider, model: `${model} via openrouter`, status: 'completed', answer: 'Orbit is a strong option.',
        citations: [{ url: 'https://source.test/a', title: 'A' }], inputTokens: 120, outputTokens: 80, costCents: 0.31,
      }));
    }
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(String(calls[0][0])).toBe('https://openrouter.ai/api/v1/chat/completions');
    const request = JSON.parse(String((calls[1][1] as RequestInit).body));
    expect(request).toEqual(expect.objectContaining({ model: 'google/gemini-3.1-flash-lite', plugins: [{ id: 'web', max_results: 5 }] }));
    expect(createOpenAIUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'gemini', responseSuccess: 1, metadata: expect.objectContaining({ transport: 'openrouter' }),
    }));
  });

  it('uses the models set on the OpenRouter credential', async () => {
    openRouterOnly({ aiVisibilityOpenAiModel: 'openai/gpt-5-mini', aiVisibilityGeminiModel: 'google/gemini-3.5-flash' });
    await expect(service.getConfiguredModel('openai')).resolves.toBe('openai/gpt-5-mini via openrouter');
    await expect(service.getConfiguredModel('gemini')).resolves.toBe('google/gemini-3.5-flash via openrouter');
  });

  it('falls back to OpenRouter when every direct key fails', async () => {
    getAllActiveAdminCredentials.mockImplementation(async (platform) => platform === 'openrouter'
      ? [{ id: 28, apiKey: 'openrouter-key', config: {} }]
      : [{ id: 10, apiKey: 'quota-exceeded', config: { model: 'gpt-direct' } }]);
    global.fetch = jest.fn(async (url: string | URL | Request) => String(url).includes('openrouter.ai')
      ? openRouterAnswer('openai/gpt-4.1-mini')
      : jsonResponse({ error: { message: 'Quota exceeded' } }, 429)) as typeof fetch;

    const result = await service.collect('openai', 'Compare Orbit', 'en-US', { userId: 4, auditId: 12 });

    expect(result).toEqual(expect.objectContaining({ status: 'completed', model: 'openai/gpt-4.1-mini via openrouter' }));
    expect(createOpenAIUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ responseSuccess: 0, errorMessage: 'Quota exceeded', metadata: expect.objectContaining({ transport: 'direct_api' }) }));
    expect(createOpenAIUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({ responseSuccess: 1, metadata: expect.objectContaining({ transport: 'openrouter' }) }));
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

  beforeEach(() => {
    jest.clearAllMocks();
    updateAdminCredentialLastUsed.mockResolvedValue(undefined);
    createOpenAIUsage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uses strict OpenAI structured output and validates every derived field', async () => {
    getAllActiveAdminCredentials.mockImplementation(async (platform) => platform === 'openai' ? [credential({ model: 'gpt-observation', extractionModel: 'gpt-extractor', inputCostPerMillion: 2, outputCostPerMillion: 4 })] : []);
    global.fetch = jest.fn(async () => jsonResponse({
      output_text: JSON.stringify({
        brandMentioned: true,
        brandRank: 1,
        sentiment: 'positive',
        competitors: ['Rival'],
        recommendationReason: 'Recommended for clear reporting.',
        exclusionReason: null,
      }),
      usage: { input_tokens: 100, output_tokens: 50 },
    })) as typeof fetch;

    const result = await service.extract(input, { userId: 4, auditId: 12, promptRunId: 31 });

    expect(result).toEqual(expect.objectContaining({
      status: 'completed', provider: 'openai', model: 'gpt-extractor', method: 'structured_llm_v1', fidelity: 'live_api',
      extraction: expect.objectContaining({ brandMentioned: true, brandRank: 1, sentiment: 'positive', competitors: ['Rival'] }),
      inputTokens: 100, outputTokens: 50, costCents: 0.04,
    }));
    const requestInit = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    const request = JSON.parse(String(requestInit.body));
    expect(request.text.format).toEqual(expect.objectContaining({ type: 'json_schema', name: 'ai_visibility_extraction', strict: true }));
    expect(request.text.format.schema).toEqual(expect.objectContaining({ additionalProperties: false }));
    expect(createOpenAIUsage).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'ai_visibility_answer_extraction', responseSuccess: 1,
      metadata: expect.objectContaining({ auditId: 12, promptRunId: 31, method: 'structured_llm_v1' }),
    }));
  });

  it('uses Gemini first and falls back to OpenAI when Gemini returns invalid structured data', async () => {
    getAllActiveAdminCredentials.mockImplementation(async (platform) => [credential({ model: platform === 'openai' ? 'gpt-test' : 'gemini-test' })]);
    global.fetch = jest.fn(async (url: string | URL | Request) => String(url).includes('googleapis.com')
      ? jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ brandMentioned: false, brandRank: 2, sentiment: 'neutral', competitors: [], recommendationReason: null, exclusionReason: null }) }] } }] })
      : jsonResponse({ output_text: JSON.stringify({ brandMentioned: true, brandRank: null, sentiment: 'neutral', competitors: ['Rival'], recommendationReason: null, exclusionReason: null }) })) as typeof fetch;

    const result = await service.extract(input, { userId: 4, auditId: 12, promptRunId: 31 });

    expect(result).toEqual(expect.objectContaining({ status: 'completed', provider: 'openai', model: 'gpt-test' }));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(createOpenAIUsage).toHaveBeenCalledTimes(2);
    expect(createOpenAIUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ provider: 'gemini', responseSuccess: 0 }));
    expect(createOpenAIUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({ provider: 'openai', responseSuccess: 1 }));
  });

  it('falls back to OpenRouter structured output when direct extraction providers are unavailable', async () => {
    getAllActiveAdminCredentials.mockImplementation(async (platform) => platform === 'openrouter'
      ? [{ id: 28, apiKey: 'openrouter-key', config: { aiVisibilityExtractionModel: 'openai/gpt-4.1-mini' } }]
      : []);
    global.fetch = jest.fn(async () => jsonResponse({
      model: 'openai/gpt-4.1-mini',
      choices: [{ message: { content: JSON.stringify({
        brandMentioned: true,
        brandRank: 1,
        sentiment: 'positive',
        competitors: ['Rival'],
        recommendationReason: 'Recommended for clear reporting.',
        exclusionReason: null,
      }) } }],
      usage: { prompt_tokens: 80, completion_tokens: 30, cost: 0.0025 },
    })) as typeof fetch;

    const result = await service.extract(input, { userId: 4, auditId: 12, promptRunId: 31 });

    expect(result).toEqual(expect.objectContaining({
      status: 'completed', provider: 'openrouter', model: 'openai/gpt-4.1-mini', costCents: 0.25,
      extraction: expect.objectContaining({ brandMentioned: true, brandRank: 1, competitors: ['Rival'] }),
    }));
    const requestInit = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    const request = JSON.parse(String(requestInit.body));
    expect(request.response_format).toEqual(expect.objectContaining({ type: 'json_schema' }));
    expect(updateAdminCredentialLastUsed).toHaveBeenCalledWith(28);
    expect(createOpenAIUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openrouter', responseSuccess: 1 }));
  });

  it('returns an explicit unavailable result when no structured-output credential exists', async () => {
    getAllActiveAdminCredentials.mockResolvedValue([]);
    global.fetch = jest.fn() as typeof fetch;

    const result = await service.extract(input, { userId: 4, auditId: 12, promptRunId: 31 });

    expect(result).toEqual(expect.objectContaining({
      status: 'failed', provider: 'unconfigured', model: 'unconfigured', costCents: 0,
      error: 'Gemini, OpenAI, and OpenRouter structured-output credentials are not configured.',
    }));
    expect(result.extraction).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(createOpenAIUsage).not.toHaveBeenCalled();
  });

  it('tries the next active extraction credential for the same provider', async () => {
    getAllActiveAdminCredentials.mockImplementation(async (platform) => platform === 'gemini' ? [
      { id: 10, apiKey: 'billing-denied', config: { model: 'gemini-first' } },
      { id: 11, apiKey: 'working-key', config: { model: 'gemini-second' } },
    ] : []);
    global.fetch = jest.fn(async (url: string | URL | Request) => String(url).includes('billing-denied')
      ? jsonResponse({ error: { message: 'Billing denied' } }, 403)
      : jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ brandMentioned: true, brandRank: 1, sentiment: 'positive', competitors: ['Rival'], recommendationReason: 'Best fit.', exclusionReason: null }) }] } }] })) as typeof fetch;

    const result = await service.extract(input, { userId: 4, auditId: 12, promptRunId: 31 });

    expect(result).toEqual(expect.objectContaining({ status: 'completed', provider: 'gemini', model: 'gemini-second' }));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(createOpenAIUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ responseSuccess: 0 }));
    expect(createOpenAIUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({ responseSuccess: 1 }));
  });
});
