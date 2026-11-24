import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
let settings: any = null;
let credentials: any[] = [];
const insert = jest.fn<any>().mockReturnValue({ values: jest.fn() });
jest.unstable_mockModule('../models/db.js', () => ({ db: { select: () => ({ from: () => ({ limit: async () => settings ? [settings] : [] }) }), insert } }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({ getAdminCredentialsByPlatform: async (platform: string) => credentials.filter(item => item.platform === platform) }));
jest.unstable_mockModule('../models/embeddingUsages/functions.js', () => ({ createEmbeddingUsage: jest.fn() }));
jest.unstable_mockModule('../models/apiPricing/functions.js', () => ({
  getEmbeddingModelCost: jest.fn(), getAllApiPricing: async () => [], getApiPricingByKey: async () => undefined,
}));
jest.unstable_mockModule('../services/CreditDeductionHooks.js', () => ({ deductCreditsForEmbeddingUsage: jest.fn() }));
const { embeddingService } = await import('../services/embeddings/EmbeddingService.js');
const { updateEmbeddingSettings, testEmbeddingProvider } = await import('../controllers/adminEmbeddingsController.js');
const add = (platform: string, model?: string, isActive = true) => credentials.push({ id: credentials.length + 1, platform, config: { model }, apiKey: 'test', isActive, priority: 'normal' });
beforeEach(() => { settings = null; credentials = []; jest.clearAllMocks(); });
afterEach(() => { jest.restoreAllMocks(); });

describe('enabled embedding provider selection', () => {
  it.each([['openai', 'text-embedding-3-large'], ['gemini', 'gemini-embedding-001'], ['openrouter', 'openai/text-embedding-3-large']] as const)('uses the active %s embedding credential and configured model', async (provider, model) => {
    add(`${provider}_embedding`, model);
    expect(await embeddingService.resolveProviderAndModel()).toEqual({ provider, model });
    expect((await embeddingService.createProvider(provider)).providerName).toBe(provider);
  });
  it('honors enabled providers and the saved default model', async () => {
    add('openai_embedding', 'text-embedding-3-small'); add('openrouter_embedding', 'openai/text-embedding-3-small');
    settings = { defaultProvider: 'openrouter', defaultModel: 'openai/text-embedding-3-large', enabledProviders: ['openrouter'] };
    expect(await embeddingService.resolveProviderAndModel()).toEqual({ provider: 'openrouter', model: 'openai/text-embedding-3-large' });
    await expect(embeddingService.resolveProviderAndModel('openai', 'text-embedding-3-small')).rejects.toThrow('disabled');
  });
  it('does not generate when all providers are disabled', async () => {
    add('openai_embedding'); settings = { enabledProviders: [] };
    await expect(embeddingService.resolveProviderAndModel()).rejects.toThrow('No enabled embedding');
  });
  it('does not bypass a disabled embedding key through an active chat key', async () => {
    add('openrouter_embedding', 'openai/text-embedding-3-small', false); add('openrouter', 'openai/gpt-chat');
    await expect(embeddingService.resolveProviderAndModel('openrouter')).rejects.toThrow('No enabled embedding');
    await expect(embeddingService.createProvider('openrouter')).rejects.toThrow('No active embedding');
  });
  it('reuses a chat key only if no dedicated key exists, without its chat model', async () => {
    add('openrouter', 'openai/gpt-chat');
    expect(await embeddingService.resolveProviderAndModel()).toEqual({ provider: 'openrouter', model: 'openai/text-embedding-3-small' });
  });
  it('does not change an explicitly requested provider or model', async () => {
    add('openai_embedding');
    await expect(embeddingService.resolveProviderAndModel('gemini', 'gemini-embedding-001')).rejects.toThrow('No enabled embedding');
    await expect(embeddingService.resolveProviderAndModel('openai', 'gemini-embedding-001')).rejects.toThrow('not supported');
  });
  it('honors priority and excludes inactive keys', async () => {
    add('openrouter_embedding', 'openai/text-embedding-3-small'); add('openrouter_embedding', 'openai/text-embedding-3-large'); credentials[1].priority = 'high';
    expect((await embeddingService.resolveProviderAndModel()).model).toBe('openai/text-embedding-3-large');
    credentials[1].isActive = false;
    expect((await embeddingService.resolveProviderAndModel()).model).toBe('openai/text-embedding-3-small');
  });
});
describe('embedding settings API', () => {
  const response = () => { const res: any = { status: jest.fn(), json: jest.fn() }; res.status.mockReturnValue(res); return res; };
  it.each([{ defaultProvider: 'invalid' }, { defaultProvider: 'openrouter', defaultModel: 'text-embedding-3-small' }, { enabledProviders: ['openai', 'invalid'] }, { defaultProvider: 'openai', enabledProviders: ['gemini'] }, { defaultModel: 'gemini-embedding-001' }])('rejects invalid merged settings %j', async body => {
    const res = response(); await updateEmbeddingSettings({ body } as any, res);
    expect(res.status).toHaveBeenCalledWith(400); expect(insert).not.toHaveBeenCalled();
  });
  it('accepts OpenRouter settings', async () => {
    const res = response(); await updateEmbeddingSettings({ body: { defaultProvider: 'openrouter', defaultModel: 'openai/text-embedding-3-small', enabledProviders: ['openrouter'] } } as any, res);
    expect(res.status).not.toHaveBeenCalled(); expect(insert).toHaveBeenCalled();
  });
  it('rejects unknown test providers before network access', async () => {
    const res = response(); await testEmbeddingProvider({ body: { provider: 'other' } } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
  it('tests the model saved on the credential when the test request omits it', async () => {
    add('openrouter_embedding', 'openai/text-embedding-3-large');
    const generateEmbeddings = jest.fn<any>().mockResolvedValue({ success: true, model: 'openai/text-embedding-3-large', dimensions: 3072 });
    jest.spyOn(embeddingService, 'createProvider').mockResolvedValue({ generateEmbeddings } as any);
    const res = response();
    await testEmbeddingProvider({ body: { provider: 'openrouter' } } as any, res);
    expect(generateEmbeddings).toHaveBeenCalledWith({ text: 'This is a test embedding.', model: 'openai/text-embedding-3-large' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
