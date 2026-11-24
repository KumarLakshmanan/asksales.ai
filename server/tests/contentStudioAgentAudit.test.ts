import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// Production agent, mocked provider boundary. No credentials, DB, or network.
const complete = jest.fn<any>();
const fallback = jest.fn<any>();
const selectProvider = jest.fn<any>();
jest.unstable_mockModule('../services/agents/LLMProviderFactory', () => ({ LLMProviderFactory: {
  createProviderForUser: selectProvider,
  createChatCompletionWithFallback: fallback,
} }));
jest.unstable_mockModule('../models/db', () => ({ db: {} }));
jest.unstable_mockModule('../services/media/MediaGenerationWorkerFactory', () => ({
  createImageGenerationWorker: jest.fn(), createVideoGenerationWorker: jest.fn(),
}));
jest.unstable_mockModule('../events/EventBus.js', () => ({ eventBus: { publish: jest.fn<any>().mockResolvedValue(undefined) } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), error: jest.fn() } }));
const { ContentStudioAgent } = await import('../services/agents/ContentStudioAgent');
const agent = new ContentStudioAgent();
const icp: any = { id: 11, targetAudience: 'Synthetic teams', industry: 'Software' };
const prompt = { prompt: 'Synthetic visual', style_guide: 'Minimal', key_elements: ['shape'] };

beforeEach(() => {
  jest.clearAllMocks();
  selectProvider.mockResolvedValue({ defaultModel: 'fixture-first', createChatCompletion: complete });
  complete.mockResolvedValue({ success: true, content: JSON.stringify({ prompts: [prompt, prompt] }) });
  fallback.mockImplementation((...args: unknown[]) => complete(...args));
});

describe('Content Studio exact creative output contract', () => {
  it.each([
    ['array', [prompt, prompt]],
    ['prompts envelope', { prompts: [prompt, prompt] }],
    ['creatives envelope', { creatives: [prompt, prompt] }],
  ])('accepts the requested two outputs in a %s', async (_shape, output) => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(output) });
    expect(await agent.generateCreativePrompts(7, icp, 'image', 2)).toHaveLength(2);
  });
  it.each([
    ['short', { prompts: [prompt] }],
    ['excess', { prompts: [prompt, prompt, prompt] }],
    ['missing', {}],
    ['blank', { prompts: [prompt, { prompt: ' ' }] }],
    ['malformed', { prompts: 'not an array' }],
  ])('rejects %s provider output instead of a successful inaccurate receipt', async (_shape, output) => {
    complete.mockResolvedValue({ success: true, content: JSON.stringify(output) });
    await expect(agent.generateCreativePrompts(7, icp, 'image', 2)).rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it.each([0, -1, 1.5, 21, NaN])('rejects invalid count %s before the provider boundary', async count => {
    await expect(agent.generateCreativePrompts(7, icp, 'image', count)).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('legacy studio agent fallback contract', () => {
  it.each([
    ['generate_content_plan', () => agent.generateContentPlan(7, icp, 2)],
    ['generate_ad_copy', () => agent.generateAdCopy(7, icp, 'facebook', 1)],
    ['generate_content_piece', () => agent.generateContentPiece(7, icp, 'blog')],
    ['generate_creative_prompts', () => agent.generateCreativePrompts(7, icp, 'image', 2)],
    ['generate_outreach_copy', () => agent.generateOutreachCopy(7, icp, 'email')],
  ] as const)('preserves the %s request through fallback', async (action, invoke) => {
    fallback.mockResolvedValue({ success: true, content: JSON.stringify({ prompts: [prompt, prompt], content: 'Synthetic text', body: 'Synthetic body' }) });
    await invoke();
    expect(fallback).toHaveBeenCalledWith(7, expect.objectContaining({ model: '', messages: expect.any(Array), loggingContext: expect.objectContaining({ action }) }));
    expect(selectProvider).not.toHaveBeenCalled();
  });
  it('uses the configured fallback chain without first binding a single provider', async () => {
    complete.mockRejectedValue(new Error('Synthetic first-provider 429'));
    fallback.mockResolvedValue({ success: true, content: JSON.stringify({ prompts: [prompt, prompt] }) });
    expect(await agent.generateCreativePrompts(7, icp, 'image', 2)).toHaveLength(2);
    expect(selectProvider).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith(7, expect.objectContaining({ model: '', loggingContext: expect.objectContaining({ action: 'generate_creative_prompts' }) }));
    expect(complete).not.toHaveBeenCalled();
  });
  it('does not parse an unsuccessful fallback response as successful content', async () => {
    const failed = { success: false, error: 'Synthetic all-provider failure', content: JSON.stringify({ prompts: [prompt, prompt] }) };
    complete.mockResolvedValue(failed);
    fallback.mockResolvedValue(failed);
    await expect(agent.generateCreativePrompts(7, icp, 'image', 2)).rejects.toThrow('Synthetic all-provider failure');
  });
});
