export const PLATFORM_MODULES = [
  { key: 'campaigns', name: 'Campaigns', description: 'Campaign conversations, planning, and execution.', sortOrder: 10 },
  { key: 'lead_generation', name: 'Lead Generation', description: 'Lead discovery, imports, scoring, and enrichment.', sortOrder: 20 },
  { key: 'content', name: 'Content Creator', description: 'Content templates, assets, brand toolkits, and calendar.', sortOrder: 30 },
  { key: 'performance_marketing', name: 'Performance Marketing', description: 'Advertising campaigns, publishing, and analytics.', sortOrder: 40 },
  { key: 'ai_visibility', name: 'AI Visibility', description: 'SEO, answer-engine, generative-engine, competitor, and monitoring audits.', sortOrder: 45 },
  { key: 'outreach', name: 'Outreach', description: 'Email, social, SMS, and WhatsApp outreach.', sortOrder: 50 },
  { key: 'crm', name: 'CRM', description: 'Contacts, pipeline, reminders, alerts, and automations.', sortOrder: 60 },
  { key: 'support', name: 'Support', description: 'Support tickets, teams, analytics, and operations.', sortOrder: 70 },
  { key: 'support_ai', name: 'Support AI', description: 'AI support chat, knowledge retrieval, reports, and embeds.', sortOrder: 80 },
  { key: 'proposals', name: 'Proposals', description: 'Proposal creation, templates, delivery, and analytics.', sortOrder: 90 },
  { key: 'knowledge_base', name: 'Knowledge Base', description: 'Documents, crawling, embeddings, and semantic retrieval.', sortOrder: 100 },
  { key: 'integrations', name: 'Integrations', description: 'User provider connections and channel configuration.', sortOrder: 110 },
  { key: 'billing', name: 'Wallet & Billing', description: 'Wallet balance, recharges, history, and usage.', sortOrder: 120 },
  { key: 'storage', name: 'Storage', description: 'Tenant files, quotas, plans, and storage usage.', sortOrder: 130 },
] as const;

export type PlatformModuleKey = typeof PLATFORM_MODULES[number]['key'];
export type PlatformModuleStatus = 'available' | 'maintenance' | 'disabled';
export type UserModuleMode = 'inherit' | 'enabled' | 'disabled';

const MODULE_KEYS = new Set<string>(PLATFORM_MODULES.map((module) => module.key));

export function isPlatformModuleKey(value: unknown): value is PlatformModuleKey {
  return typeof value === 'string' && MODULE_KEYS.has(value);
}

export function isPlatformModuleStatus(value: unknown): value is PlatformModuleStatus {
  return value === 'available' || value === 'maintenance' || value === 'disabled';
}

export function isUserModuleMode(value: unknown): value is UserModuleMode {
  return value === 'inherit' || value === 'enabled' || value === 'disabled';
}

export function resolveModuleEnabled(status: PlatformModuleStatus, mode: UserModuleMode): boolean {
  // Account overrides may narrow an available module but never bypass a
  // global maintenance or disabled state.
  return status === 'available' && mode !== 'disabled';
}
