import { creatorSessionScope } from './creator-session';
import type { OrganicPublishPlatform } from './socialPublishing';

export type OrganicPublishRequest = {
  expectedVersion?: number;
  expectedReviewToken?: string;
  targets: Array<{ platform: OrganicPublishPlatform; credentialId: number; caption: string; postType: string; [key: string]: unknown }>;
  scheduledFor?: string;
  timezone: string;
};
export type PendingOrganicPublish = { schema: 1; scope: string; assetId: number; key: string; payload: OrganicPublishRequest };
export type RecoveryAttempt = { id: number; assetId: number; platform: OrganicPublishPlatform; status: string; idempotencyKey: string; providerPostUrl?: string; errorMessage?: string };
const storageKey = (assetId: number) => `organic-publish-intent:${creatorSessionScope()}:${assetId}`;

export function loadOrganicPublishIntent(assetId: number): PendingOrganicPublish | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(assetId)) || 'null') as PendingOrganicPublish | null;
    if (value?.schema !== 1 || value.scope !== creatorSessionScope() || value.assetId !== assetId || typeof value.key !== 'string' || !/^[a-zA-Z0-9_-]{8,96}$/.test(value.key)) return null;
    if (!value.payload || !Number.isSafeInteger(value.payload.expectedVersion) || Number(value.payload.expectedVersion) < 1 || typeof value.payload.expectedReviewToken !== 'string' || !value.payload.expectedReviewToken || !Array.isArray(value.payload.targets) || !value.payload.targets.length || value.payload.targets.length > 4) return null;
    if (value.payload.targets.some(target => !['facebook','instagram','youtube','linkedin'].includes(target.platform))) return null;
    return value;
  } catch { return null; }
}

export function retainOrganicPublishIntent(assetId: number, key: string, payload: OrganicPublishRequest): PendingOrganicPublish {
  const request: PendingOrganicPublish = { schema: 1, scope: creatorSessionScope(), assetId, key, payload };
  sessionStorage.setItem(storageKey(assetId), JSON.stringify(request));
  return request;
}

export function clearOrganicPublishIntent(request: PendingOrganicPublish) {
  if (request.scope !== creatorSessionScope()) return;
  if (loadOrganicPublishIntent(request.assetId)?.key === request.key) sessionStorage.removeItem(storageKey(request.assetId));
}

export function originalPublishContextMatches(request: PendingOrganicPublish) { return request.scope === creatorSessionScope(); }

/** Only exact key/destination receipts can acknowledge the saved review. */
export function recoveredPublishingResult(request: PendingOrganicPublish, attempts: RecoveryAttempt[]) {
  const matched = request.payload.targets.map(target => attempts.find(attempt => attempt.platform === target.platform && attempt.idempotencyKey === `${request.key}:${target.platform}`));
  if (matched.some(attempt => !attempt)) return null;
  const results = Object.fromEntries(matched.map(attempt => [attempt!.platform, {
    success: attempt!.status === 'succeeded', status: attempt!.status, attemptId: attempt!.id, assetId: attempt!.assetId,
    postUrl: attempt!.providerPostUrl, error: attempt!.errorMessage,
  }]));
  const entries = Object.values(results);
  const success = entries.every(entry => entry.success);
  const pending = entries.some(entry => ['pending','claimed','provider_succeeded','retryable_failed'].includes(entry.status));
  const scheduled = Boolean(request.payload.scheduledFor) && entries.every(entry => ['pending','claimed','retryable_failed'].includes(entry.status));
  return { success, partialSuccess: !success && entries.some(entry => entry.success), accepted: pending && !scheduled, scheduled, results };
}
