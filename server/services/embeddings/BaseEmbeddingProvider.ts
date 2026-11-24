/**
 * Embedding Provider — Base Interface
 * Follows the same abstract-class pattern used by LLMProvider.
 */

export interface EmbeddingRequest {
  text: string | string[];
  model: string;
}

export interface EmbeddingResponse {
  success: boolean;
  embeddings: number[][];
  dimensions: number;
  model: string;
  usage?: { promptTokens: number; totalTokens: number };
  error?: string;
}

export const EMBEDDING_MODELS = {
  openai: {
    'text-embedding-3-small': { dimensions: 1536, description: 'OpenAI small (cost-effective)' },
    'text-embedding-3-large': { dimensions: 3072, description: 'OpenAI large (high fidelity)' },
  },
  gemini: {
    'gemini-embedding-001': { dimensions: 768, description: 'Gemini text embeddings (768 dimensions)' },
  },
  openrouter: {
    'openai/text-embedding-3-small': { dimensions: 1536, description: 'OpenAI small via OpenRouter' },
    'openai/text-embedding-3-large': { dimensions: 3072, description: 'OpenAI large via OpenRouter' },
    'google/gemini-embedding-001': { dimensions: 768, description: 'Gemini via OpenRouter (768 dimensions)' },
  },
} as const;

export type EmbeddingProvider = keyof typeof EMBEDDING_MODELS;

export const EMBEDDING_PROVIDERS = Object.keys(EMBEDDING_MODELS) as EmbeddingProvider[];

export function isEmbeddingProvider(value: unknown): value is EmbeddingProvider {
  return typeof value === 'string' && Object.hasOwn(EMBEDDING_MODELS, value);
}

export function isEmbeddingModel(provider: EmbeddingProvider, model: unknown): model is string {
  return typeof model === 'string' && (Object.hasOwn(EMBEDDING_MODELS[provider], model)
    || (provider === 'openrouter' && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:-]+$/.test(model)));
}

export function validateEmbeddingVectors(vectors: number[][], count: number, dimensions = 0): void {
  const size = dimensions || vectors[0]?.length;
  if (!size || vectors.length !== count || vectors.some(vector => !Array.isArray(vector)
    || vector.length !== size || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)))) {
    throw new Error('Embedding provider returned missing, invalid, or inconsistent vectors.');
  }
}

export abstract class BaseEmbeddingProvider {
  protected disabled = false;
  abstract readonly providerName: EmbeddingProvider;

  abstract generateEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  abstract testConnection(): Promise<boolean>;

  isDisabled(): boolean {
    return this.disabled;
  }

  getSupportedModels(): Record<string, { dimensions: number; description: string }> {
    return EMBEDDING_MODELS[this.providerName] ?? {};
  }

  getDimensions(model: string): number {
    const models = EMBEDDING_MODELS[this.providerName] as Record<string, { dimensions: number }> | undefined;
    return models?.[model]?.dimensions ?? 0;
  }
}
