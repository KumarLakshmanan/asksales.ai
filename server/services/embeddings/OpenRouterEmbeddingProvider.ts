import { OpenAIEmbeddingProvider } from './OpenAIEmbeddingProvider';

export class OpenRouterEmbeddingProvider extends OpenAIEmbeddingProvider {
  constructor(apiKey: string) {
    super(apiKey, { provider: 'openrouter', baseURL: 'https://openrouter.ai/api/v1' });
  }
}
