import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const create = jest.fn<any>();
const embedContent = jest.fn<any>();
const openaiOptions: unknown[] = [];
jest.unstable_mockModule('openai', () => ({ default: class { embeddings = { create }; constructor(options: unknown) { openaiOptions.push(options); } } }));
jest.unstable_mockModule('@google/genai', () => ({ GoogleGenAI: class { models = { embedContent }; } }));
const { OpenAIEmbeddingProvider } = await import('../services/embeddings/OpenAIEmbeddingProvider.js');
const { OpenRouterEmbeddingProvider } = await import('../services/embeddings/OpenRouterEmbeddingProvider.js');
const { GeminiEmbeddingProvider } = await import('../services/embeddings/GeminiEmbeddingProvider.js');
const { testEmbeddingCredential } = await import('../services/embeddings/testEmbeddingCredential.js');

beforeEach(() => {
  openaiOptions.length = 0;
  create.mockReset().mockImplementation(async ({ input, dimensions }: any) => ({ data: input.map((_: string, index: number) => ({ index, embedding: Array(dimensions).fill(index + 0.1) })).reverse(), usage: { prompt_tokens: 5, total_tokens: 5 } }));
  embedContent.mockReset().mockImplementation(async ({ contents, config }: any) => ({ embeddings: contents.map(() => ({ values: Array(config.outputDimensionality).fill(0.1) })) }));
});

describe('embedding transports', () => {
  it.each([
    ['openai', () => new OpenAIEmbeddingProvider('key'), 'text-embedding-3-small', 1536],
    ['openrouter', () => new OpenRouterEmbeddingProvider('key'), 'openai/text-embedding-3-small', 1536],
    ['gemini', () => new GeminiEmbeddingProvider('key'), 'gemini-embedding-001', 768],
  ] as const)('%s embeds single text and batches with the exact selected model', async (_name, factory, model, dimensions) => {
    const adapter = factory();
    for (const text of ['one', ['one', 'two']]) {
      const result = await adapter.generateEmbeddings({ text, model });
      expect(result).toMatchObject({ success: true, dimensions, model });
      expect(result.embeddings).toHaveLength(Array.isArray(text) ? 2 : 1);
    }
  });
  it('routes OpenRouter to its embeddings endpoint with namespaced model and float vectors', async () => {
    const result = await new OpenRouterEmbeddingProvider('router-key').generateEmbeddings({ text: ['one', 'two'], model: 'google/gemini-embedding-001' });
    expect(openaiOptions[0]).toMatchObject({ apiKey: 'router-key', baseURL: 'https://openrouter.ai/api/v1' });
    expect(create).toHaveBeenCalledWith({ model: 'google/gemini-embedding-001', input: ['one', 'two'], encoding_format: 'float', dimensions: 768 });
    expect(result.embeddings[0][0]).toBe(0.1);
    expect(result.embeddings[1][0]).toBe(1.1);
  });
  it.each([
    [], [{ index: 0, embedding: [] }], [{ index: 0, embedding: [NaN] }], [{ index: 1, embedding: Array(1536).fill(0) }],
  ])('rejects malformed or incomplete results: %j', async (...items) => {
    // it.each spreads array rows, so reassemble the provider data here.
    create.mockResolvedValue({ data: items });
    expect((await new OpenAIEmbeddingProvider('key').generateEmbeddings({ text: 'one', model: 'text-embedding-3-small' })).success).toBe(false);
  });
  it('does not substitute a different Gemini model when the selected model fails', async () => {
    embedContent.mockRejectedValue(new Error('model not found'));
    const result = await new GeminiEmbeddingProvider('key').generateEmbeddings({ text: 'one', model: 'gemini-embedding-001' });
    expect(result).toMatchObject({ success: false, model: 'gemini-embedding-001' });
    expect(embedContent).toHaveBeenCalledTimes(1);
  });
  it('rejects an empty Gemini success response', async () => {
    embedContent.mockResolvedValue({ embeddings: [] });
    expect((await new GeminiEmbeddingProvider('key').generateEmbeddings({ text: 'one', model: 'gemini-embedding-001' })).success).toBe(false);
  });
  it.each(['openai', 'gemini', 'openrouter'] as const)('admin credential test really embeds using %s', async provider => {
    expect((await testEmbeddingCredential(provider, 'key')).success).toBe(true);
    expect(provider === 'gemini' ? embedContent : create).toHaveBeenCalledTimes(1);
  });
  it('tests the configured model instead of a hard-coded default', async () => {
    expect((await testEmbeddingCredential('openrouter', 'key', { model: 'openai/text-embedding-3-large' })).details).toMatchObject({ dimensions: 3072, model: 'openai/text-embedding-3-large', vectors: 2 });
  });
});
