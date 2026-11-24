import OpenAI from 'openai';
import { BaseEmbeddingProvider, EMBEDDING_MODELS, validateEmbeddingVectors, type EmbeddingRequest, type EmbeddingResponse } from './BaseEmbeddingProvider';

/** Shared OpenAI-compatible embedding transport, also used by OpenRouter. */
export class OpenAIEmbeddingProvider extends BaseEmbeddingProvider {
  readonly providerName: 'openai' | 'openrouter';
  private client: OpenAI | null;

  constructor(apiKey: string, options: { provider?: 'openai' | 'openrouter'; baseURL?: string } = {}) {
    super();
    this.providerName = options.provider || 'openai';
    this.disabled = !apiKey;
    this.client = apiKey ? new OpenAI({ apiKey, ...(options.baseURL ? { baseURL: options.baseURL } : {}), timeout: 60_000, maxRetries: 1 }) : null;
  }

  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = request.model || Object.keys(EMBEDDING_MODELS[this.providerName])[0];
    const input = Array.isArray(request.text) ? request.text : [request.text];
    try {
      if (!this.client) throw new Error(`${this.providerName} embedding API key is not configured.`);
      if (!input.length || input.some(text => typeof text !== 'string' || !text.trim())) throw new Error('Embedding input must contain non-empty text.');
      const expectedDimensions = this.getDimensions(model);
      const response = await this.client.embeddings.create({
        model, input, encoding_format: 'float',
        ...(expectedDimensions ? { dimensions: expectedDimensions } : {}),
      });
      const ordered = [...response.data].sort((a, b) => a.index - b.index);
      if (ordered.some((item, index) => item.index !== index)) throw new Error('Embedding response contains invalid input indexes.');
      const embeddings = ordered.map(item => item.embedding);
      validateEmbeddingVectors(embeddings, input.length, expectedDimensions);
      return {
        success: true, embeddings, dimensions: embeddings[0].length, model,
        usage: response.usage ? { promptTokens: response.usage.prompt_tokens, totalTokens: response.usage.total_tokens } : undefined,
      };
    } catch (error) {
      return { success: false, embeddings: [], dimensions: 0, model, error: error instanceof Error ? error.message : 'Embedding request failed.' };
    }
  }

  async testConnection(): Promise<boolean> {
    return (await this.generateEmbeddings({ text: 'test', model: Object.keys(EMBEDDING_MODELS[this.providerName])[0] })).success;
  }
}
