import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db.js';
import { decryptValue, encryptValue } from '../../services/SecretsManager.js';
import { decryptSensitiveIntegrationConfig, encryptSensitiveIntegrationConfig } from '../../utils/integrationSecrets.js';
import { intentClassifierCredentialsTable as credentials, intentClassifierCredentialAuditTable as audit,
  type IntentClassifierCredential, type InsertIntentClassifierCredential } from './schema.js';

export const CLASSIFIER_PLATFORMS = ['openrouter', 'openai', 'gemini', 'vertex_ai', 'custom_ai'] as const;
export const CLASSIFIER_PRIORITIES = ['high', 'normal', 'low', 'fallback'] as const;

function decrypted(row: IntentClassifierCredential): IntentClassifierCredential {
  return { ...row,
    apiKey: row.isEncrypted ? decryptValue(row.apiKey) : row.apiKey,
    apiSecret: row.apiSecret && row.isEncrypted ? decryptValue(row.apiSecret) : row.apiSecret,
    config: decryptSensitiveIntegrationConfig(row.config) as Record<string, unknown>,
  };
}

export function sortClassifierCredentials<T extends Pick<IntentClassifierCredential, 'id' | 'isActive' | 'priority'>>(rows: T[]): T[] {
  const rank = (value: string) => {
    const index = CLASSIFIER_PRIORITIES.indexOf(value as typeof CLASSIFIER_PRIORITIES[number]);
    return index < 0 ? CLASSIFIER_PRIORITIES.length : index;
  };
  return [...rows].filter(row => row.isActive).sort((a, b) => rank(a.priority) - rank(b.priority) || a.id - b.id);
}

export async function listClassifierCredentials(): Promise<IntentClassifierCredential[]> {
  return (await db.select().from(credentials).orderBy(asc(credentials.id))).map(decrypted);
}

export async function getActiveClassifierCredentials(): Promise<IntentClassifierCredential[]> {
  const rows = await db.select().from(credentials).where(eq(credentials.isActive, true));
  return sortClassifierCredentials<IntentClassifierCredential>(rows).map(decrypted);
}

export async function getClassifierCredential(id: number): Promise<IntentClassifierCredential | null> {
  const [row] = await db.select().from(credentials).where(eq(credentials.id, id)).limit(1);
  return row ? decrypted(row) : null;
}

export async function createClassifierCredential(input: InsertIntentClassifierCredential): Promise<IntentClassifierCredential> {
  const [row] = await db.insert(credentials).values({ ...input,
    apiKey: encryptValue(input.apiKey), apiSecret: input.apiSecret ? encryptValue(input.apiSecret) : null,
    isEncrypted: true,
    config: encryptSensitiveIntegrationConfig(input.config || {}) as Record<string, unknown>,
  }).returning();
  return decrypted(row);
}

export async function updateClassifierCredential(id: number, input: Partial<InsertIntentClassifierCredential>): Promise<IntentClassifierCredential | null> {
  const existing = await getClassifierCredential(id);
  if (!existing) return null;
  const changes = { ...input, updatedAt: new Date(),
    ...(input.apiKey !== undefined ? { apiKey: encryptValue(input.apiKey) } : {}),
    ...(input.apiSecret !== undefined ? { apiSecret: input.apiSecret ? encryptValue(input.apiSecret) : null } : {}),
    ...(input.config !== undefined ? { config: encryptSensitiveIntegrationConfig(input.config) as Record<string, unknown> } : {}),
  };
  const [row] = await db.update(credentials).set(changes).where(eq(credentials.id, id)).returning();
  return row ? decrypted(row) : null;
}

export async function deleteClassifierCredential(id: number): Promise<boolean> {
  return (await db.delete(credentials).where(eq(credentials.id, id)).returning({ id: credentials.id })).length > 0;
}

export async function markClassifierCredentialUsed(id: number): Promise<void> {
  await db.update(credentials).set({ lastUsedAt: new Date(), usageCount: sql`${credentials.usageCount} + 1` })
    .where(and(eq(credentials.id, id), eq(credentials.isActive, true)));
}

export async function recordClassifierAudit(input: {
  credentialId: number; platform: string; action: string; adminId?: number | null;
  changedFields?: string[]; validationStatus?: string | null; message?: string | null;
}): Promise<void> {
  await db.insert(audit).values({ credentialId: input.credentialId, platform: input.platform,
    action: input.action, adminId: input.adminId ?? null, changedFields: input.changedFields || [],
    validationStatus: input.validationStatus ?? null, message: input.message?.slice(0, 1000) || null });
}

export async function recordClassifierValidation(input: { id: number; platform: string; adminId?: number | null; success: boolean; message: string }): Promise<void> {
  const status = input.success ? 'valid' : 'invalid';
  await db.transaction(async (tx: typeof db) => {
    await tx.update(credentials).set({ lastValidatedAt: new Date(), validationStatus: status,
      validationMessage: input.message.slice(0, 1000), updatedAt: new Date() }).where(eq(credentials.id, input.id));
    await tx.insert(audit).values({ credentialId: input.id, platform: input.platform, action: 'validate',
      adminId: input.adminId ?? null, changedFields: [], validationStatus: status, message: input.message.slice(0, 1000) });
  });
}

export async function listClassifierAudit(limit = 50) {
  return db.select().from(audit).orderBy(desc(audit.createdAt), desc(audit.id)).limit(limit);
}
