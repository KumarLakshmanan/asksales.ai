/**
 * Admin API Credentials Model Functions
 * CRUD operations for admin-managed API credentials
 */

import { db } from '../db';
import { adminApiCredentialsTable, adminCredentialAuditTable, AdminApiCredentialRecord, InsertAdminApiCredential } from './schema';
import { eq, and, desc, asc, sql, ne, count } from 'drizzle-orm';
import { adminsTable } from '../admins/schema.js';
import { decryptValue, encryptValue } from '../../services/SecretsManager.js';
import { decryptSensitiveIntegrationConfig, encryptSensitiveIntegrationConfig } from '../../utils/integrationSecrets.js';

export type AdminApiPlatform = 'openai' | 'openrouter' | 'apify' | 'gemini' | 'vertex_ai' | 'gemini_image' | 'gemini_video' | 'zerobounce' | 'smtp' | 'razorpay' | 'custom_ai' | 'resend' | 'gmail_oauth' | 'openai_embedding' | 'gemini_embedding' | 'openrouter_embedding' | 'meta_app' | 'instagram_app';
export const LLM_ADMIN_PLATFORMS = ['gemini', 'openai', 'vertex_ai', 'openrouter', 'custom_ai'] as const;
const CREDENTIAL_PRIORITY = { high: 0, normal: 1, low: 2, fallback: 3 } as const;

export function sortActiveCredentials<T extends Pick<AdminApiCredentialRecord, 'id' | 'platform' | 'priority' | 'isActive'>>(rows: T[]): T[] {
  return [...rows].filter(row => row.isActive).sort((a, b) =>
    (CREDENTIAL_PRIORITY[a.priority as keyof typeof CREDENTIAL_PRIORITY] ?? 4)
    - (CREDENTIAL_PRIORITY[b.priority as keyof typeof CREDENTIAL_PRIORITY] ?? 4)
    || LLM_ADMIN_PLATFORMS.indexOf(a.platform as typeof LLM_ADMIN_PLATFORMS[number])
    - LLM_ADMIN_PLATFORMS.indexOf(b.platform as typeof LLM_ADMIN_PLATFORMS[number])
    || a.id - b.id);
}

export async function getActiveLLMAdminCredentials(): Promise<AdminApiCredentialRecord[]> {
  const groups = await Promise.all(LLM_ADMIN_PLATFORMS.map(platform => getAllActiveAdminCredentials(platform)));
  return sortActiveCredentials(groups.flat());
}

const RETIRED_ADMIN_API_PLATFORMS = new Set(['perplexity']);

const SHARED_BUSINESS_DIRECTORY_ACTORS = new Set([
  'compass/crawler-google-places',
  'codingfrontend/justdial-business-lead-extractor',
  'memo23/justdial-business-scraper',
]);

export function usesSharedBusinessDirectoryApifyPool(actorId: string): boolean {
  return SHARED_BUSINESS_DIRECTORY_ACTORS.has(actorId.trim().toLowerCase());
}

function isUnscopedCredential(credential: AdminApiCredentialRecord): boolean {
  const assignedActors = (credential.config as Record<string, unknown> | null)?.assignedActors;
  return !Array.isArray(assignedActors) || assignedActors.length === 0;
}

export function selectSharedBusinessDirectoryCredential(
  actorId: string,
  credentials: AdminApiCredentialRecord[],
  excludeId?: number,
): AdminApiCredentialRecord | null {
  if (!usesSharedBusinessDirectoryApifyPool(actorId)) return null;
  const priorityRank: Record<string, number> = { high: 1, normal: 2, low: 3, fallback: 4 };
  return [...credentials]
    .filter(credential =>
      credential.id !== excludeId
      && credential.isActive
      && isUnscopedCredential(credential)
    )
    .sort((left, right) => {
      const rankDifference = (priorityRank[left.priority || ''] || 5) - (priorityRank[right.priority || ''] || 5);
      if (rankDifference !== 0) return rankDifference;
      return (right.lastUsedAt?.getTime() || 0) - (left.lastUsedAt?.getTime() || 0) || left.id - right.id;
    })[0] || null;
}

export function decryptAdminCredential<T extends AdminApiCredentialRecord>(credential: T): T {
  try {
    return {
      ...credential,
      apiKey: credential.isEncrypted ? decryptValue(credential.apiKey) : credential.apiKey,
      apiSecret: credential.apiSecret && credential.isEncrypted ? decryptValue(credential.apiSecret) : credential.apiSecret,
      config: decryptSensitiveIntegrationConfig(credential.config) as T['config'],
    };
  } catch (error) {
    throw new Error(`Unable to decrypt admin credential ${credential.id}`, { cause: error });
  }
}

function encryptCredentialValues(apiKey: string, apiSecret?: string | null) {
  return {
    apiKey: encryptValue(apiKey),
    apiSecret: apiSecret ? encryptValue(apiSecret) : null,
    isEncrypted: true,
  };
}

async function reactivateTransientlyUnavailableCredentials(platform: AdminApiPlatform): Promise<void> {
  await db
    .update(adminApiCredentialsTable)
    .set({
      isActive: true,
      deactivationReason: null,
      deactivatedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(adminApiCredentialsTable.platform, platform),
        eq(adminApiCredentialsTable.isActive, false),
        sql`${adminApiCredentialsTable.deactivationReason} IN ('rate_limit', 'rate_limit_429', 'service_overloaded')`,
        sql`${adminApiCredentialsTable.deactivatedAt} < NOW() - INTERVAL '2 minutes'`
      )
    );
}

/**
 * Get all admin API credentials for a platform
 */
export async function getAdminCredentialsByPlatform(platform: AdminApiPlatform): Promise<AdminApiCredentialRecord[]> {
  const credentials = await db
    .select()
    .from(adminApiCredentialsTable)
    .where(eq(adminApiCredentialsTable.platform, platform))
    .orderBy(asc(adminApiCredentialsTable.id));
  return credentials.map(decryptAdminCredential);
}

/**
 * Get the first active admin API credential for a platform
 * Also auto-reactivates transiently unavailable credentials after 2 minutes.
 */
export async function getActiveAdminCredential(platform: AdminApiPlatform): Promise<AdminApiCredentialRecord | null> {
  await reactivateTransientlyUnavailableCredentials(platform);

  const [credential] = await db
    .select()
    .from(adminApiCredentialsTable)
    .where(
      and(
        eq(adminApiCredentialsTable.platform, platform),
        eq(adminApiCredentialsTable.isActive, true)
      )
    )
    .orderBy(
      asc(sql`CASE 
        WHEN ${adminApiCredentialsTable.priority} = 'high' THEN 1 
        WHEN ${adminApiCredentialsTable.priority} = 'normal' THEN 2 
        WHEN ${adminApiCredentialsTable.priority} = 'low' THEN 3 
        WHEN ${adminApiCredentialsTable.priority} = 'fallback' THEN 4 
        ELSE 5 
      END`),
      desc(adminApiCredentialsTable.lastUsedAt)
    )
    .limit(1);
  
  return credential ? decryptAdminCredential(credential) : null;
}

/**
 * Get next active admin API credential (for fallback)
 */
export async function getNextActiveAdminCredential(
  platform: AdminApiPlatform,
  excludeId: number
): Promise<AdminApiCredentialRecord | null> {
  const [credential] = await db
    .select()
    .from(adminApiCredentialsTable)
    .where(
      and(
        eq(adminApiCredentialsTable.platform, platform),
        eq(adminApiCredentialsTable.isActive, true),
        ne(adminApiCredentialsTable.id, excludeId)
      )
    )
    .orderBy(
      asc(sql`CASE 
        WHEN ${adminApiCredentialsTable.priority} = 'high' THEN 1 
        WHEN ${adminApiCredentialsTable.priority} = 'normal' THEN 2 
        WHEN ${adminApiCredentialsTable.priority} = 'low' THEN 3 
        WHEN ${adminApiCredentialsTable.priority} = 'fallback' THEN 4 
        ELSE 5 
      END`),
      desc(adminApiCredentialsTable.lastUsedAt)
    )
    .limit(1);
  
  return credential ? decryptAdminCredential(credential) : null;
}

/**
 * Get all active admin API credentials for a platform (for round-robin or random selection)
 */
export async function getAllActiveAdminCredentials(platform: AdminApiPlatform): Promise<AdminApiCredentialRecord[]> {
  await reactivateTransientlyUnavailableCredentials(platform);
  const credentials = await db
    .select()
    .from(adminApiCredentialsTable)
    .where(
      and(
        eq(adminApiCredentialsTable.platform, platform),
        eq(adminApiCredentialsTable.isActive, true)
      )
    )
    .orderBy(
      asc(sql`CASE 
        WHEN ${adminApiCredentialsTable.priority} = 'high' THEN 1 
        WHEN ${adminApiCredentialsTable.priority} = 'normal' THEN 2 
        WHEN ${adminApiCredentialsTable.priority} = 'low' THEN 3 
        WHEN ${adminApiCredentialsTable.priority} = 'fallback' THEN 4 
        ELSE 5 
      END`)
    );
  return credentials.map(decryptAdminCredential);
}

/**
 * Create a new admin API credential
 */
export async function createAdminCredential(data: InsertAdminApiCredential): Promise<AdminApiCredentialRecord> {
  const encrypted = encryptCredentialValues(data.apiKey, data.apiSecret);
  const encryptedConfig = encryptSensitiveIntegrationConfig(data.config || {}) as InsertAdminApiCredential['config'];
  const [credential] = await db
    .insert(adminApiCredentialsTable)
    .values({ ...data, ...encrypted, config: encryptedConfig })
    .returning();
  return decryptAdminCredential(credential);
}

/**
 * Update an admin API credential
 */
export async function updateAdminCredential(
  id: number,
  data: Partial<InsertAdminApiCredential>
): Promise<AdminApiCredentialRecord | null> {
  const [stored] = await db
    .select()
    .from(adminApiCredentialsTable)
    .where(eq(adminApiCredentialsTable.id, id))
    .limit(1);
  if (!stored) return null;

  let updateData: Partial<InsertAdminApiCredential> = data;
  if (data.apiKey !== undefined || data.apiSecret !== undefined) {
    const current = decryptAdminCredential(stored);
    const encrypted = encryptCredentialValues(
      data.apiKey ?? current.apiKey,
      data.apiSecret === undefined ? current.apiSecret : data.apiSecret,
    );
    updateData = { ...data, ...encrypted,
      // Preserve ciphertext for an unchanged identity. Re-encryption uses a new
      // IV and would look like a provider-account change to the durable guard.
      ...(stored.isEncrypted && (data.apiKey === undefined || data.apiKey === current.apiKey) ? {apiKey:stored.apiKey} : {}),
      ...(stored.isEncrypted && (data.apiSecret === undefined || data.apiSecret === current.apiSecret) ? {apiSecret:stored.apiSecret} : {}),
    };
  }
  if (data.config !== undefined) {
    updateData = {
      ...updateData,
      config: encryptSensitiveIntegrationConfig(data.config) as InsertAdminApiCredential['config'],
    };
  }
  const [updated] = await db
    .update(adminApiCredentialsTable)
    .set({ ...updateData, updatedAt: new Date() })
    .where(eq(adminApiCredentialsTable.id, id))
    .returning();
  return updated ? decryptAdminCredential(updated) : null;
}

/**
 * Delete an admin API credential
 */
export async function deleteAdminCredential(id: number): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const result = await db
    .delete(adminApiCredentialsTable)
    .where(eq(adminApiCredentialsTable.id, id));
  return true;
}

/**
 * Toggle admin API credential active status
 */
export async function toggleAdminCredential(id: number): Promise<AdminApiCredentialRecord | null> {
  const [credential] = await db
    .select()
    .from(adminApiCredentialsTable)
    .where(eq(adminApiCredentialsTable.id, id))
    .limit(1);
  
  if (!credential) return null;
  
  const [updated] = await db
    .update(adminApiCredentialsTable)
    .set({ 
      isActive: !credential.isActive, 
      updatedAt: new Date(),
      deactivationReason: !credential.isActive ? null : 'manual',
      deactivatedAt: !credential.isActive ? null : new Date(),
    })
    .where(eq(adminApiCredentialsTable.id, id))
    .returning();
  
  return updated ? decryptAdminCredential(updated) : null;
}

/**
 * Mark an admin API credential as inactive with reason
 */
export async function markAdminCredentialInactive(
  id: number,
  reason: string,
  providerDetail?: string,
): Promise<AdminApiCredentialRecord | null> {
  const [previous] = await db
    .select({ isActive: adminApiCredentialsTable.isActive })
    .from(adminApiCredentialsTable)
    .where(eq(adminApiCredentialsTable.id, id))
    .limit(1);
  const [updated] = await db
    .update(adminApiCredentialsTable)
    .set({ 
      isActive: false, 
      deactivationReason: reason,
      deactivatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(adminApiCredentialsTable.id, id))
    .returning();

  if (updated && previous?.isActive) {
    await alertAdminsCredentialSwitchedOff(updated.platform, reason, { keyName: updated.name, providerDetail });
  }
  return updated ? decryptAdminCredential(updated) : null;
}

/**
 * Reasons worth an alert (credits, billing or a rejected key). Rate limits recover
 * on their own; AI keys off for credits are switched back on by
 * LLMCredentialRecoveryService once a test request succeeds.
 */
const LASTING_DEACTIVATION_REASONS = new Set(['quota_exceeded', 'billing_or_account_capacity', 'auth_failed', 'invalid_key']);
const PROVIDER_NAMES: Record<string, string> = {
  openrouter: 'OpenRouter', openai: 'OpenAI', gemini: 'Gemini', vertex_ai: 'Vertex AI', custom_ai: 'Custom AI',
  apify: 'Apify',
};
/** What stops working when no key of this kind is left. */
const NO_KEY_IMPACT: Record<string, string> = {
  apify: ' No Apify key is active now, so lead searches cannot run. Customers are told the lead data provider is not connected.',
};

/**
 * Tell every administrator once when a key is switched off for a lasting reason,
 * so an empty provider account is noticed before customers report failed replies.
 */
async function alertAdminsCredentialSwitchedOff(
  platform: string,
  reason: string,
  details: { keyName?: string; providerDetail?: string } = {},
): Promise<void> {
  if (!LASTING_DEACTIVATION_REASONS.has(reason)) return;
  try {
    const provider = PROVIDER_NAMES[platform] || platform.charAt(0).toUpperCase() + platform.slice(1);
    const cause = reason === 'quota_exceeded' || reason === 'billing_or_account_capacity'
      ? 'it ran out of credits or hit its billing limit' : 'the provider rejected the key';
    const isLlm = (LLM_ADMIN_PLATFORMS as readonly string[]).includes(platform);
    const remaining = isLlm
      ? (await getActiveLLMAdminCredentials()).length
      : (await getAllActiveAdminCredentials(platform as AdminApiPlatform)).length;
    const kind = isLlm ? 'AI provider' : provider;
    const impact = remaining === 0
      ? (isLlm
        ? ' No AI provider is active now, so AI replies, AI follow-ups and other AI features are paused. Approved WhatsApp templates still send.'
        : NO_KEY_IMPACT[platform] || ` No ${provider} key is active now.`)
      : ` ${remaining} other ${kind} key${remaining === 1 ? ' is' : 's are'} still active.`;
    const nextStep = isLlm && reason === 'quota_exceeded'
      ? ' Add credits to the provider account: AskSales checks every 5 minutes and switches the key back on by itself. Or add a new key under LLM Providers.'
      : isLlm
        ? ' Add credits or a new key under LLM Providers, then switch it back on.'
        : ` Fix the ${provider} account or add a new key under API Integrations, then switch it back on.`;
    const detail = details.providerDetail ? ` ${provider} said: ${details.providerDetail.slice(0, 300)}` : '';
    const keyLabel = details.keyName ? ` "${details.keyName}"` : '';
    const { notifyAllAdmins } = await import('../adminNotifications/functions.js');
    await notifyAllAdmins({
      // The key name keeps a second key switched off the same day from being
      // skipped as a repeat of the first alert.
      title: `${provider} key${keyLabel} switched off`,
      message: `AskSales switched off the ${provider} key${keyLabel} because ${cause}.${detail}${impact}${nextStep}`,
      type: 'error',
      category: 'system',
    });
  } catch (error) {
    console.error('[AdminApiCredentials] Could not alert administrators about a switched-off key', error);
  }
}

/**
 * Update last used timestamp
 */
export async function updateAdminCredentialLastUsed(id: number): Promise<void> {
  await db
    .update(adminApiCredentialsTable)
    .set({ 
      lastUsedAt: new Date(),
      usageCount: sql`COALESCE(${adminApiCredentialsTable.usageCount}::integer, 0) + 1`,
    })
    .where(eq(adminApiCredentialsTable.id, id));
}

export async function recordAdminCredentialAudit(input: {
  credentialId: number | null;
  platform: string;
  action: 'create' | 'update' | 'rotate' | 'activate' | 'deactivate' | 'validate' | 'delete';
  adminId?: number | null;
  changedFields?: string[];
  validationStatus?: 'valid' | 'invalid' | 'manual_required' | null;
  message?: string | null;
}) {
  await db.insert(adminCredentialAuditTable).values({
    credentialId: input.credentialId,
    platform: input.platform,
    action: input.action,
    adminId: input.adminId ?? null,
    changedFields: input.changedFields || [],
    validationStatus: input.validationStatus ?? null,
    message: input.message?.slice(0, 1000) || null,
  });
}

export async function updateAdminCredentialValidation(input: {
  id: number;
  platform: string;
  adminId?: number | null;
  status: 'valid' | 'invalid' | 'manual_required';
  message: string;
}) {
  await db.transaction(async (tx: typeof db) => {
    await tx.update(adminApiCredentialsTable).set({
      lastValidatedAt: new Date(),
      validationStatus: input.status,
      validationMessage: input.message.slice(0, 1000),
      updatedAt: new Date(),
    }).where(eq(adminApiCredentialsTable.id, input.id));
    await tx.insert(adminCredentialAuditTable).values({
      credentialId: input.id,
      platform: input.platform,
      action: 'validate',
      adminId: input.adminId ?? null,
      changedFields: [],
      validationStatus: input.status,
      message: input.message.slice(0, 1000),
    });
  });
}

export async function listAdminCredentialAudit(options: { platform?: string; limit: number; offset: number }) {
  const condition = options.platform ? eq(adminCredentialAuditTable.platform, options.platform) : undefined;
  const [entries, [totalRow]] = await Promise.all([
    db.select({
      id: adminCredentialAuditTable.id,
      credentialId: adminCredentialAuditTable.credentialId,
      platform: adminCredentialAuditTable.platform,
      action: adminCredentialAuditTable.action,
      adminId: adminCredentialAuditTable.adminId,
      adminName: adminsTable.name,
      changedFields: adminCredentialAuditTable.changedFields,
      validationStatus: adminCredentialAuditTable.validationStatus,
      message: adminCredentialAuditTable.message,
      createdAt: adminCredentialAuditTable.createdAt,
    }).from(adminCredentialAuditTable)
      .leftJoin(adminsTable, eq(adminCredentialAuditTable.adminId, adminsTable.id))
      .where(condition)
      .orderBy(desc(adminCredentialAuditTable.createdAt), desc(adminCredentialAuditTable.id))
      .limit(options.limit).offset(options.offset),
    db.select({ total: count() }).from(adminCredentialAuditTable).where(condition),
  ]);
  return { entries, total: Number(totalRow?.total ?? 0) };
}

/**
 * Get all admin API credentials with stats
 */
export async function getAllAdminCredentials(): Promise<AdminApiCredentialRecord[]> {
  const credentials = await db
    .select()
    .from(adminApiCredentialsTable)
    .orderBy(asc(adminApiCredentialsTable.id));
  return credentials.map(decryptAdminCredential);
}

/**
 * Get admin credential by ID
 */
export async function getAdminCredentialById(id: number): Promise<AdminApiCredentialRecord | null> {
  const [credential] = await db
    .select()
    .from(adminApiCredentialsTable)
    .where(eq(adminApiCredentialsTable.id, id))
    .limit(1);
  
  return credential ? decryptAdminCredential(credential) : null;
}

/**
 * Get the best admin credential for a specific Apify actor.
 * 1. First checks for active credentials that have this actor specifically assigned in config.assignedActors
 * 2. If the actor-specific key is inactive/expired, falls back to default
 * 3. Falls back to the default active credential (no assignedActors or empty)
 */
export async function getAdminCredentialForActor(actorId: string): Promise<AdminApiCredentialRecord | null> {
  const allApify = await getAdminCredentialsByPlatform('apify');

  // Google Maps and JustDial are interchangeable business-directory sources.
  // Keep both on the same unscoped pool so a provider-specific assignment can
  // never make their billing, retry, or capacity behavior diverge.
  if (usesSharedBusinessDirectoryApifyPool(actorId)) {
    return selectSharedBusinessDirectoryCredential(actorId, allApify);
  }
  
  // Find active credentials that have this actor in assignedActors
  const actorSpecific = allApify.find(cred => 
    cred.isActive && 
    cred.config && 
    Array.isArray((cred.config as Record<string, unknown>).assignedActors) && 
    ((cred.config as Record<string, unknown>).assignedActors as string[]).includes(actorId)
  );
  
  if (actorSpecific) return actorSpecific;
  
  // Fall back to default active credential that is NOT restricted to specific actors
  // (assignedActors is null, undefined, or empty array)
  const defaultCred = allApify.find(cred => {
    if (!cred.isActive) return false;
    const assigned = (cred.config as Record<string, unknown>)?.assignedActors;
    return !assigned || !Array.isArray(assigned) || assigned.length === 0;
  });
  
  if (defaultCred) return defaultCred;
  
  // Last resort: if no unscoped credentials exist, use the global fallback
  return getActiveAdminCredential('apify');
}

export async function getNextAdminCredentialForActor(
  actorId: string,
  excludeId: number,
): Promise<AdminApiCredentialRecord | null> {
  if (!usesSharedBusinessDirectoryApifyPool(actorId)) {
    return getNextActiveAdminCredential('apify', excludeId);
  }

  const allApify = await getAdminCredentialsByPlatform('apify');
  return selectSharedBusinessDirectoryCredential(actorId, allApify, excludeId);
}

/**
 * Get stats summary for all platforms
 */
export async function getAdminCredentialStats(): Promise<{
  byPlatform: Record<string, { total: number; active: number; inactive: number }>;
}> {
  const credentials = await getAllAdminCredentials();
  
  const byPlatform: Record<string, { total: number; active: number; inactive: number }> = {};
  const platforms: AdminApiPlatform[] = ['openai', 'openrouter', 'apify', 'gemini', 'vertex_ai', 'gemini_image', 'gemini_video', 'zerobounce', 'smtp', 'razorpay', 'resend', 'gmail_oauth'];
  
  // Initialize all platforms
  for (const platform of platforms) {
    byPlatform[platform] = { total: 0, active: 0, inactive: 0 };
  }
  
  // Count credentials
  for (const cred of credentials) {
    if (RETIRED_ADMIN_API_PLATFORMS.has(cred.platform)) continue;
    if (!byPlatform[cred.platform]) {
      byPlatform[cred.platform] = { total: 0, active: 0, inactive: 0 };
    }
    byPlatform[cred.platform].total++;
    if (cred.isActive) {
      byPlatform[cred.platform].active++;
    } else {
      byPlatform[cred.platform].inactive++;
    }
  }
  
  return { byPlatform };
}
