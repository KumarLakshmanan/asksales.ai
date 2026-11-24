/**
 * API Key Fallback Service
 * Provides automatic fallback mechanism for API keys when rate limits or quota exceeded
 * Supports: Gemini, ZeroBounce, Apify platforms
 */

import { CredentialPlatform, getActiveApiKeyWithMetadata, markCredentialAsInactive, getNextActiveApiKey } from '../controllers/apiCredentialsController';
import { logger } from '../utils/logger.js';

// Rate limit error patterns — kept specific to avoid false positives
const RATE_LIMIT_ERROR_PATTERNS = [
  'rate limit',
  'rate_limit',
  'quota exceeded',
  'quota_exceeded',
  'too many requests',
  '429',
  'insufficient_quota',
  'exceeded your current quota',
  'resource_exhausted',
  'too_many_requests',
  'requests per minute',
  'requests per day',
  'requests per second',
  'daily limit',
  'per-minute',
  'per-minute quota',
  'per-day quota',
];

/**
 * Check if an error is a rate limit or quota error
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isRateLimitError(error: any): boolean {
  const errorMessage = (error?.message || error?.error?.message || String(error)).toLowerCase();
  const errorCode = error?.status || error?.code || error?.error?.code || error?.statusCode;
  
  // Check status code
  if (errorCode === 429 || errorCode === '429') {
    return true;
  }
  
  // Check error message patterns
  return RATE_LIMIT_ERROR_PATTERNS.some(pattern => errorMessage.includes(pattern));
}

/**
 * Apify can reject every actor start for an account-level billing condition
 * without returning HTTP 429. Treat those responses as credential-capacity
 * failures so an independently configured fallback account can be tried.
 */
export function isApifyCredentialCapacityError(error: any): boolean {
  if (isRateLimitError(error)) return true;
  const errorMessage = (error?.message || error?.error?.message || String(error || '')).toLowerCase();
  return [
    'too many outstanding invoices',
    'payment required',
    'billing account',
    'account is suspended',
    'actor plan limit',
    'free user call limit',
    'free user run limit',
  ].some(pattern => errorMessage.includes(pattern));
}

/** Shown to the person who ran the search; they cannot fix the platform's provider account. */
export const APIFY_ACCOUNTS_UNAVAILABLE_MESSAGE =
  'Lead search is unavailable right now because the lead data provider account needs attention from the AskSales team. No leads were saved. Please try again later.';

/** Saved on the admin credential so Admin Integrations shows the provider's own reason. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apifyCredentialRefusalNote(error: any): string {
  const raw = error instanceof Error ? error.message : error?.message || error?.error?.message || (typeof error === 'string' ? error : '');
  const providerMessage = String(raw || '')
    .replace(/^Actor execution failed:\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'no reason given';
  return `Apify refused a run: ${providerMessage}. Resolve this in the Apify account (billing or plan), then turn this credential back on.`;
}

/**
 * Account-wide failures make a credential unusable for every actor and may be
 * persisted as inactive. Actor-plan/free-user limits are scoped to one Actor,
 * so globally disabling the token would incorrectly break unrelated Actors.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isApifyAccountWideCapacityError(error: any): boolean {
  const errorMessage = (error?.message || error?.error?.message || String(error || '')).toLowerCase();
  return [
    'too many outstanding invoices',
    'payment required',
    'billing account',
    'account is suspended',
  ].some(pattern => errorMessage.includes(pattern));
}

/**
 * Result from getting an API key with fallback support
 */
export interface ApiKeyResult {
  apiKey: string;
  credentialId: number;
  platform: CredentialPlatform;
}

/**
 * Get an active API key for a platform with credential tracking
 * @param userId - User ID
 * @param platform - Platform type (gemini, zerobounce, apify)
 * @returns API key with credential info or null
 */
export async function getActiveApiKeyWithTracking(
  userId: number,
  platform: CredentialPlatform
): Promise<ApiKeyResult | null> {
  const keyData = await getActiveApiKeyWithMetadata(userId, platform);
  
  if (!keyData) {
    return null;
  }
  
  return {
    apiKey: keyData.apiKey,
    credentialId: keyData.credentialId,
    platform,
  };
}

/**
 * Handle rate limit error by marking current key as inactive and getting next key
 * @param userId - User ID
 * @param platform - Platform type
 * @param currentCredentialId - Current credential ID that hit rate limit
 * @returns Next available API key or null
 */
export async function handleRateLimitAndGetNextKey(
  userId: number,
  platform: CredentialPlatform,
  currentCredentialId: number
): Promise<ApiKeyResult | null> {
  logger.warn({ platform, credentialId: currentCredentialId }, '[ApiKeyFallbackService] Rate limit hit for credential, marking as inactive');
  
  // Mark current credential as inactive
  await markCredentialAsInactive(currentCredentialId);
  
  // Try to get next available key
  const nextKey = await getNextActiveApiKey(userId, platform, currentCredentialId);
  
  if (nextKey) {
    logger.info({ platform: platform, id: nextKey.id }, '[ApiKeyFallbackService] Falling back to next key (credential ID: )');
    return {
      apiKey: nextKey.apiKey,
      credentialId: nextKey.id,
      platform,
    };
  }
  
  logger.warn({ platform: platform }, '[ApiKeyFallbackService] No more active keys available');
  return null;
}

/**
 * Execute an API call with automatic fallback on rate limit errors
 * @param userId - User ID
 * @param platform - Platform type (gemini, zerobounce, apify)
 * @param callFn - Function that takes apiKey and executes the API call
 * @param maxRetries - Maximum number of fallback attempts (default: 3)
 * @returns Result from the API call
 * @throws Error if all keys exhausted or non-rate-limit error
 */
export async function executeWithFallback<T>(
  userId: number,
  platform: CredentialPlatform,
  callFn: (apiKey: string) => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let currentKey = await getActiveApiKeyWithTracking(userId, platform);
  
  if (!currentKey) {
    throw new Error(`No active ${platform} API keys found. Please add an API key in Settings > Integrations.`);
  }
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastError: any;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callFn(currentKey.apiKey);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      lastError = error;
      
      if (isRateLimitError(error)) {
        logger.warn({ platform, attempt: attempt + 1 }, '[ApiKeyFallbackService] Rate limit on attempt, trying fallback');
        
        const nextKey = await handleRateLimitAndGetNextKey(
          userId,
          platform,
          currentKey.credentialId
        );
        
        if (nextKey) {
          currentKey = nextKey;
          continue; // Retry with new key
        }
        
        // No more keys available
        throw new Error(`All ${platform} API keys have hit rate limits or quota exceeded. Please add more API keys or wait for rate limits to reset in Settings > Integrations.`);
      }
      
      // Not a rate limit error, throw immediately
      throw error;
    }
  }
  
  // Max retries reached
  throw lastError || new Error(`Max retries reached for ${platform} API call`);
}

/**
 * Wrapper class for platform-specific API key management with fallback
 */
export class PlatformApiKeyManager {
  private platform: CredentialPlatform;
  private userId: number;
  private currentCredentialId?: number;
  
  constructor(userId: number, platform: CredentialPlatform) {
    this.userId = userId;
    this.platform = platform;
  }
  
  /**
   * Get an active API key
   */
  async getActiveKey(): Promise<string | null> {
    const keyData = await getActiveApiKeyWithTracking(this.userId, this.platform);
    if (keyData) {
      this.currentCredentialId = keyData.credentialId;
      return keyData.apiKey;
    }
    return null;
  }
  
  /**
   * Report that the current key hit a rate limit and get next key
   */
  async reportRateLimitAndGetNext(): Promise<string | null> {
    if (!this.currentCredentialId) {
      logger.warn({ platform: this.platform }, '[PlatformApiKeyManager] No current credential ID to report rate limit for');
      return null;
    }
    
    const nextKey = await handleRateLimitAndGetNextKey(
      this.userId,
      this.platform,
      this.currentCredentialId
    );
    
    if (nextKey) {
      this.currentCredentialId = nextKey.credentialId;
      return nextKey.apiKey;
    }
    
    return null;
  }
  
  /**
   * Execute an API call with automatic fallback
   */
  async executeWithFallback<T>(
    callFn: (apiKey: string) => Promise<T>,
    maxRetries: number = 3
  ): Promise<T> {
    return executeWithFallback(this.userId, this.platform, callFn, maxRetries);
  }
}

/**
 * Create a platform-specific API key manager
 */
export function createApiKeyManager(userId: number, platform: CredentialPlatform): PlatformApiKeyManager {
  return new PlatformApiKeyManager(userId, platform);
}

export const apifyApiKeys = {
  getWithTracking: (userId: number) => getActiveApiKeyWithTracking(userId, 'apify'),
  executeWithFallback: <T>(userId: number, callFn: (apiKey: string) => Promise<T>, maxRetries?: number) => 
    executeWithFallback(userId, 'apify', callFn, maxRetries),
  createManager: (userId: number) => createApiKeyManager(userId, 'apify'),
};
