/**
 * One place that decides which Apify key a lead search actor would use.
 * The workflow executor runs with it, and the chat checks it before offering
 * a search, so both always agree on whether a search can run.
 */
import { getActiveApifyToken } from '../controllers/apifyController';
import { apifyApiKeys, type ApiKeyResult } from './apiKeyFallbackService';
import { getAdminCredentialForActor } from '../models/adminApiCredentials/functions';
import { logger } from '../utils/logger.js';

export interface ApifyCredentialResolution {
  apiKey: string;
  source: 'admin' | 'user' | 'legacy';
  keyInfo: ApiKeyResult | null;
}

/** Order: admin key for the actor, then the user's own key, then the legacy token. */
export async function resolveApifyCredential(userId?: number, actorId?: string): Promise<ApifyCredentialResolution | null> {
  if (actorId) {
    try {
      const actorCredential = await getAdminCredentialForActor(actorId);
      if (actorCredential && actorCredential.isActive) {
        return {
          apiKey: actorCredential.apiKey,
          source: 'admin',
          keyInfo: { apiKey: actorCredential.apiKey, credentialId: actorCredential.id, platform: 'apify' },
        };
      }
    } catch (err) {
      logger.warn({ err, actorId }, '[ApifyCredentialResolver] Could not read the admin key for an actor, falling back');
    }
  }

  if (userId) {
    const keyInfo = await apifyApiKeys.getWithTracking(userId);
    if (keyInfo) return { apiKey: keyInfo.apiKey, source: 'user', keyInfo };
    const legacyKey = await getActiveApifyToken(userId);
    if (legacyKey) return { apiKey: legacyKey, source: 'legacy', keyInfo: null };
  }

  return null;
}

export const LEAD_PROVIDER_UNAVAILABLE_MESSAGE =
  "Lead search isn't available right now because the lead data provider isn't connected. "
  + 'Nothing was run or charged. An admin needs to add credits or a new key for the data provider, then you can try again.';

export class LeadProviderUnavailableError extends Error {
  constructor() {
    super(LEAD_PROVIDER_UNAVAILABLE_MESSAGE);
    this.name = 'LeadProviderUnavailableError';
  }
}

/**
 * The actors that have no usable key. A failed check never blocks a search:
 * it returns an empty set and the search runs as it did before.
 */
export async function findLeadActorsWithoutKey(userId: number | undefined, actorIds: string[]): Promise<Set<string>> {
  const missing = new Set<string>();
  try {
    for (const actorId of new Set(actorIds.filter(Boolean))) {
      if (!(await resolveApifyCredential(userId, actorId))) missing.add(actorId);
    }
    return missing;
  } catch (err) {
    logger.warn({ err }, '[ApifyCredentialResolver] Lead search key check failed; allowing the search');
    return new Set();
  }
}
