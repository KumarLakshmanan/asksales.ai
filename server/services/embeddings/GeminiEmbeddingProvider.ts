import { BaseEmbeddingProvider, validateEmbeddingVectors, type EmbeddingRequest, type EmbeddingResponse } from './BaseEmbeddingProvider';
import { GoogleGenAI } from '@google/genai';

/** Uses the exact selected model: a fallback would change the vector space. */
export class GeminiEmbeddingProvider extends BaseEmbeddingProvider {
  readonly providerName = 'gemini' as const;
  private client?: GoogleGenAI;

  constructor(private readonly apiKey: string) {
    super();
    this.disabled = !apiKey;
  }

  async generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = request.model || 'gemini-embedding-001';
    const texts = Array.isArray(request.text) ? request.text : [request.text];
    try {
      if (this.disabled) throw new Error('Gemini embedding API key is not configured.');
      if (!texts.length || texts.some(text => typeof text !== 'string' || !text.trim())) throw new Error('Embedding input must contain non-empty text.');
      this.client ??= new GoogleGenAI({ apiKey: this.apiKey, httpOptions: { timeout: 60_000 } });
      const dimensions = this.getDimensions(model) || 768;
      const response = await this.client.models.embedContent({
        model,
        contents: texts.map(text => ({ parts: [{ text }] })),
        config: { outputDimensionality: dimensions },
      });
      const embeddings = response.embeddings?.map(item => item.values ?? []) ?? [];
      validateEmbeddingVectors(embeddings, texts.length, dimensions);
      return { success: true, embeddings, dimensions, model };
    } catch (error) {
      return { success: false, embeddings: [], dimensions: 0, model, error: error instanceof Error ? error.message : 'Gemini embedding request failed.' };
    }
  }

  async testConnection(): Promise<boolean> {
    return (await this.generateEmbeddings({ text: 'test', model: 'gemini-embedding-001' })).success;
  }
}
