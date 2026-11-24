import { EMBEDDING_MODELS, isEmbeddingModel, type EmbeddingProvider } from './BaseEmbeddingProvider';
import { OpenAIEmbeddingProvider } from './OpenAIEmbeddingProvider';
import { GeminiEmbeddingProvider } from './GeminiEmbeddingProvider';
import { OpenRouterEmbeddingProvider } from './OpenRouterEmbeddingProvider';

/** Tests the supplied key and selected embedding model, including unsaved keys. */
export async function testEmbeddingCredential(provider: EmbeddingProvider, apiKey: string, config?: Record<string, unknown> | null) {
  const model = config?.model || Object.keys(EMBEDDING_MODELS[provider])[0];
  if (!isEmbeddingModel(provider, model)) return { success: false, message: 'Choose a supported embedding model for this provider.' };
  const adapter = provider === 'openai' ? new OpenAIEmbeddingProvider(apiKey)
    : provider === 'gemini' ? new GeminiEmbeddingProvider(apiKey) : new OpenRouterEmbeddingProvider(apiKey);
  const result = await adapter.generateEmbeddings({ model, text: ['Embedding connection test.', 'Batch embedding connection test.'] });
  return {
    success: result.success,
    message: result.success ? `Embedding test passed: ${result.model}, ${result.dimensions} dimensions, ${result.embeddings.length} vectors.`
      : (result.error || 'Embedding generation failed.').split(apiKey || '\0').join('[REDACTED]').slice(0, 500),
    details: { provider, model: result.model, dimensions: result.dimensions, vectors: result.embeddings.length },
  };
}
