import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { channelCredentialsTable } from '../../models/channelCredentials/schema.js';
import {
  providerCanaryRunsTable,
  type ProviderCanaryEvidence,
  type ProviderCanaryStatus,
} from '../../models/providerCanaryRuns/schema.js';
import type { ProviderVerificationPlatform } from '../../models/providerVerificationRuns/schema.js';
import { verifyProviderIntegration } from './ProviderVerificationService.js';
import { getMetaAdsCreds } from '../../models/metaPageConnections/functions.js';
import { getGoogleAdsCredentials } from '../../controllers/integrationsController.js';

export const PROVIDER_CANARY_CONFIRMATION = 'RUN_PROVIDER_CANARY';

export interface ProviderCanaryRequest {
  userId: number;
  platform: ProviderVerificationPlatform;
  credentialId?: number;
  accountIdentifier?: string;
  execute?: boolean;
  confirmation?: string;
}

export interface ProviderCanaryResult {
  id: number;
  platform: ProviderVerificationPlatform;
  status: ProviderCanaryStatus;
  mode: 'dry_run' | 'execute';
  credentialId: number | null;
  requestedAccountIdentifier: string | null;
  accountBindingMatches: boolean;
  executedAt: string | null;
}

type CredentialBinding = {
  id: number;
  accountIdentifier: string | null;
};

function storedPlatform(platform: ProviderVerificationPlatform): string {
  return platform === 'gmail' ? 'gmail_api'
    : platform === 'facebook' ? 'facebook_api'
      : platform === 'instagram' ? 'instagram_api'
        : platform;
}

async function resolveCredentialBinding(request: ProviderCanaryRequest): Promise<CredentialBinding | null> {
  // Resend uses a system provider credential plus a tenant-owned domain rather
  // than a channel credential. Its domain identity is checked on execute.
  if (request.platform === 'resend') return null;
  if (request.platform === 'meta_ads') {
    const credential = await getMetaAdsCreds(request.userId);
    return credential ? { id: 0, accountIdentifier: credential.adAccountId.replace(/^act_/, '') } : null;
  }
  if (request.platform === 'google_ads') {
    const credential = await getGoogleAdsCredentials(request.userId);
    return credential ? { id: 0, accountIdentifier: credential.customerId.replaceAll('-', '') } : null;
  }
  const predicates = [
    eq(channelCredentialsTable.userId, request.userId),
    eq(channelCredentialsTable.platform, storedPlatform(request.platform)),
    eq(channelCredentialsTable.isActive, true),
  ];
  if (request.credentialId) predicates.push(eq(channelCredentialsTable.id, request.credentialId));
  const [credential] = await db.select({
    id: channelCredentialsTable.id,
    accountIdentifier: channelCredentialsTable.accountIdentifier,
  }).from(channelCredentialsTable).where(and(...predicates)).orderBy(
    desc(channelCredentialsTable.isSelected),
    desc(channelCredentialsTable.updatedAt),
  ).limit(1);
  return credential || null;
}

function toResult(row: typeof providerCanaryRunsTable.$inferSelect): ProviderCanaryResult {
  const evidence = row.evidence;
  return {
    id: row.id,
    platform: row.platform,
    status: row.status,
    mode: evidence.mode,
    credentialId: row.credentialId,
    requestedAccountIdentifier: row.requestedAccountIdentifier,
    accountBindingMatches: evidence.accountBindingMatches,
    executedAt: row.executedAt?.toISOString() || null,
  };
}

/**
 * Runs a read-only provider canary. A dry run only checks tenant/account
 * binding in our database. An execute requires an explicit operator phrase
 * and performs the existing identity/scope/webhook verification probes; it
 * never posts content, sends a message, or uploads media.
 */
export async function runProviderCanary(request: ProviderCanaryRequest): Promise<ProviderCanaryResult> {
  const mode: 'dry_run' | 'execute' = request.execute ? 'execute' : 'dry_run';
  if (request.execute && request.confirmation !== PROVIDER_CANARY_CONFIRMATION) {
    throw new Error(`Execute requires confirmation exactly equal to ${PROVIDER_CANARY_CONFIRMATION}.`);
  }
  if (request.execute && process.env.PROVIDER_CANARY_ALLOW_EXECUTE !== 'true') {
    throw new Error('External provider probes are disabled. Set PROVIDER_CANARY_ALLOW_EXECUTE=true in the deployment environment.');
  }

  const binding = await resolveCredentialBinding(request);
  const requestedAccountIdentifier = request.accountIdentifier?.trim().replace(/^act_/, '').replaceAll('-', '') || null;
  const accountBindingMatches = request.platform === 'resend'
    ? !requestedAccountIdentifier
    : Boolean(binding && requestedAccountIdentifier && binding.accountIdentifier === requestedAccountIdentifier);
  let status: ProviderCanaryStatus = accountBindingMatches ? 'planned' : 'blocked';
  let evidence: ProviderCanaryEvidence = {
    mode,
    requestedAccountIdentifier,
    resolvedCredentialId: binding?.id || null,
    resolvedAccountIdentifier: binding?.accountIdentifier || null,
    accountBindingMatches,
  };
  let executedAt: Date | null = null;

  if (request.execute && accountBindingMatches) {
    const verification = await verifyProviderIntegration(request.userId, request.platform, binding?.id);
    status = verification.status === 'passing' ? 'passing'
      : verification.status === 'failing' ? 'failing' : 'blocked';
    evidence = {
      ...evidence,
      checks: verification.checks,
      providerRequestIds: verification.providerRequestIds,
      errorCode: verification.errorCode,
    };
    executedAt = new Date();
  }

  const [stored] = await db.insert(providerCanaryRunsTable).values({
    userId: request.userId,
    platform: request.platform,
    credentialId: binding?.id || null,
    requestedAccountIdentifier,
    status,
    evidence,
    executedAt,
  }).returning();
  return toResult(stored);
}
