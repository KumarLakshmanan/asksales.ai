export const ASSISTANT_MODEL_PROVIDERS = ['openai', 'openrouter', 'gemini', 'vertex_ai', 'custom_ai'] as const;
export const assistantModelProviderLabels: Record<string, string> = {
  openai: 'OpenAI', openrouter: 'OpenRouter', gemini: 'Gemini Developer API', vertex_ai: 'Vertex AI', custom_ai: 'Custom AI',
};
export const platformAIQuotaMessage = (providers: readonly string[] = []) =>
  `${providers.length ? providers.join(' and ') : 'An AI provider'} reported insufficient provider credits or a quota limit on the AskSales side. Our team needs to restore the provider balance or quota. Please try again later or contact AskSales Support.`;
export interface AdminAssistantModel {
  id: number | null;
  provider: string;
  model: string;
  label: string;
  description: string;
  enabled: boolean;
  order: number;
  credentialId: number | null;
  connectionName: string;
  connected: boolean;
  version: number;
}
export interface AssistantModelConnection {
  id: number;
  provider: string;
  name: string;
  connected: boolean;
}
export interface AdminAssistantModelCatalog {
  models: AdminAssistantModel[];
  connections: AssistantModelConnection[];
  canManage: boolean;
}
