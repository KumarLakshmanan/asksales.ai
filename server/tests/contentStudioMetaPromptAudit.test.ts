import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const direct = jest.fn<any>();
const fallback = jest.fn<any>();
const select = jest.fn<any>();
jest.unstable_mockModule('../services/agents/LLMProviderFactory', () => ({ LLMProviderFactory: {
  createProviderForUser: select, createChatCompletionWithFallback: fallback,
} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn() } }));
const { MetaPromptEngine } = await import('../services/agents/MetaPromptEngine');
const engine = new MetaPromptEngine();
const context: any = { icp: { id: 11 }, contentType: 'email' };
const variation = { title: 'Synthetic variation', prompt: 'Useful synthetic prompt' };
beforeEach(() => {
  jest.clearAllMocks();
  select.mockResolvedValue({ defaultModel: 'synthetic-first', createChatCompletion: direct });
  direct.mockResolvedValue({ success: true, content: JSON.stringify({ variations: [variation, variation] }) });
  fallback.mockImplementation((...args: unknown[]) => direct(...args));
});

describe('exact meta-prompt variations', () => {
  it.each([{ result: [variation, variation] }, { result: { variations: [variation, variation] } }])('accepts exactly two usable variations: %j', async ({ result }) => {
    direct.mockResolvedValue({ success: true, content: JSON.stringify(result) });
    expect(await engine.generatePromptVariations(context, 'Synthetic brief', 2, 7)).toHaveLength(2);
  });
  it.each([
    {}, { variations: [variation] }, { variations: [variation, variation, variation] },
    { variations: [variation, {}] }, { variations: [variation, { prompt: ' ' }] },
  ])('rejects inaccurate or unusable provider variations: %j', async result => {
    direct.mockResolvedValue({ success: true, content: JSON.stringify(result) });
    await expect(engine.generatePromptVariations(context, 'Synthetic brief', 2, 7)).rejects.toThrow();
    expect(direct).toHaveBeenCalledTimes(1);
  });
  it.each([0, -1, 1.5, 21])('rejects invalid count %s before any provider work', async count => {
    await expect(engine.generatePromptVariations(context, 'Synthetic brief', count, 7)).rejects.toThrow();
    expect(direct).not.toHaveBeenCalled();
  });
});

describe('meta-prompt configured fallback', () => {
  it.each([
    ['tree', () => engine.generatePromptTree(context, 7)],
    ['single', () => engine.generateSinglePrompt(context, 'Synthetic task', 7)],
    ['variations', () => engine.generatePromptVariations(context, 'Synthetic brief', 2, 7)],
  ] as const)('uses fallback for %s instead of binding the first provider', async (_name, invoke) => {
    direct.mockRejectedValue(new Error('Synthetic first-provider 429'));
    fallback.mockResolvedValue({ success: true, content: JSON.stringify({ variations: [variation, variation] }) });
    await invoke();
    expect(select).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith(7, expect.objectContaining({ model: '', messages: expect.any(Array) }));
  });
});
