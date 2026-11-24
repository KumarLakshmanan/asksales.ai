import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { normalizeLLMModelName } from '../../utils/llmConstants.js';
import { ASSISTANT_MODEL_PROVIDERS, assistantModelProviderLabels, type AdminAssistantModel, type AssistantModelConnection } from '../../../shared/assistantModelCatalog.js';
import type { AssistantModel } from '../../../shared/outreachAssistants.js';
import { assistantModelKey as key } from '../../../shared/outreachAssistants.js';

export interface ModelCredential {
  id: number; platform: string; name?: string; apiKey?: string; isActive?: boolean;
  config?: Record<string, unknown> | null;
}
export type ManagedAssistantModel = Omit<AdminAssistantModel, 'connected' | 'connectionName'>;
export function modelConnectionReady(credential: ModelCredential): boolean {
  return credential.isActive !== false && Boolean(credential.apiKey)
    && (credential.platform !== 'custom_ai' || Boolean(credential.config?.baseUrl || credential.config?.baseURL));
}

/** Existing configured models remain visible until explicitly managed here. A
 * managed disabled entry overrides legacy configuration, including other keys. */
export function mergeAssistantModelCatalog(credentials: ModelCredential[], managed: ManagedAssistantModel[]): AdminAssistantModel[] {
  const entries = new Map<string, AdminAssistantModel>();
  for (const credential of credentials) {
    const config = credential.config || {};
    const ids = [config.selectedModel, config.model, ...(Array.isArray(config.allowedModels) ? config.allowedModels : [])];
    for (const id of ids) {
      if (typeof id !== 'string' || !id.trim()) continue;
      const model = normalizeLLMModelName(credential.platform, id);
      const identity = key({ provider: credential.platform, model });
      const connected = modelConnectionReady(credential);
      if (entries.has(identity) && (!connected || entries.get(identity)!.connected)) continue;
      entries.set(identity, { id: null, provider: credential.platform, model, label: model, description: '',
        enabled: true, order: 0, credentialId: credential.id, connectionName: credential.name || credential.platform,
        connected, version: 0 });
    }
  }
  for (const entry of managed) {
    const credential = credentials.find(item => item.id === entry.credentialId && item.platform === entry.provider);
    entries.set(key(entry), { ...entry, connected: Boolean(credential && modelConnectionReady(credential)),
      connectionName: credential?.name || 'Connection unavailable' });
  }
  return [...entries.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label) || a.provider.localeCompare(b.provider));
}

export async function getManagedAssistantModels(executor: Pick<typeof db, 'execute'> = db): Promise<ManagedAssistantModel[]> {
  const result = await executor.execute(sql`SELECT id,provider,model,label,description,enabled,
    display_order AS "order",credential_id AS "credentialId",version FROM assistant_model_catalog ORDER BY display_order,id`);
  return result.rows as ManagedAssistantModel[];
}

export async function quotaBlockedAssistantProviders(unavailableModels: AssistantModel[]): Promise<string[]> {
  if (!unavailableModels.length) return [];

  const providers = [...new Set(unavailableModels.map(model => model.provider))];
  const { rows } = await db.execute(sql`SELECT id, platform, jsonb_build_object(
      'selectedModel', config->'selectedModel', 'model', config->'model', 'allowedModels', config->'allowedModels'
    ) AS config FROM admin_api_credentials
    WHERE NOT is_active AND deactivation_reason = 'quota_exceeded'
      AND platform IN (${sql.join(providers.map(provider => sql`${provider}`), sql`, `)})`);
  const credentials = rows as ModelCredential[];
  if (!credentials.length) return [];

  const quotaCredentialIds = new Set(credentials.map(credential => credential.id));
  const quotaModelKeys = new Set(mergeAssistantModelCatalog(credentials, await getManagedAssistantModels())
    .filter(entry => entry.enabled && entry.credentialId !== null && quotaCredentialIds.has(entry.credentialId))
    .map(key));

  return [...new Set(unavailableModels.filter(model => quotaModelKeys.has(key(model)))
    .map(model => assistantModelProviderLabels[model.provider] || 'The AI provider'))];
}

export async function quotaDisabledAIProviders(platforms: readonly string[] = ASSISTANT_MODEL_PROVIDERS): Promise<string[]> {
  const { rows } = await db.execute(sql`SELECT DISTINCT platform FROM admin_api_credentials
    WHERE NOT is_active AND deactivation_reason = 'quota_exceeded'
      AND platform IN (${sql.join(platforms.map(platform => sql`${platform}`), sql`, `)}) ORDER BY platform`);
  return (rows as { platform: string }[]).map(row => assistantModelProviderLabels[row.platform]);
}

export function assistantModelConnections(credentials: ModelCredential[]): AssistantModelConnection[] {
  return credentials.map(credential => ({ id: credential.id, provider: credential.platform,
    name: credential.name || credential.platform, connected: modelConnectionReady(credential) }));
}

export async function resolveAssistantModelCredential(selection: AssistantModel, credentials: ModelCredential[]): Promise<ModelCredential | undefined> {
  const entry = mergeAssistantModelCatalog(credentials, await getManagedAssistantModels())
    .find(item => key(item) === key(selection));
  if (!entry?.enabled || !entry.connected) return undefined;
  return credentials.find(item => item.id === entry.credentialId && item.platform === entry.provider);
}
