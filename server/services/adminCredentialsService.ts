/**
 * Admin Credentials Service
 * Provides admin API credentials for various services
 * Used by ApifyService, EmailValidationService, etc.
 */

import { 
  getActiveAdminCredential, 
  getNextActiveAdminCredential, 
  markAdminCredentialInactive,
  updateAdminCredentialLastUsed,
  AdminApiPlatform,
} from '../models/adminApiCredentials/functions';

export interface AdminCredential {
  id: number;
  apiKey: string;
  apiSecret?: string | null;
  config?: Record<string, unknown>;
}

/**
 * Get admin Apify API key
 */
export async function getAdminApifyKey(): Promise<AdminCredential | null> {
  const cred = await getActiveAdminCredential('apify');
  if (!cred) return null;
  
  return {
    id: cred.id,
    apiKey: cred.apiKey,
    config: cred.config || {},
  };
}

/**
 * Get admin Gemini API key
 */
export async function getAdminGeminiKey(): Promise<AdminCredential | null> {
  const cred = await getActiveAdminCredential('gemini');
  if (!cred) return null;
  
  return {
    id: cred.id,
    apiKey: cred.apiKey,
    apiSecret: cred.apiSecret || null,
    config: cred.config || {},
  };
}

/**
 * Get admin Gemini Image API key (falls back to generic gemini)
 */
export async function getAdminGeminiImageKey(): Promise<AdminCredential | null> {
  const cred = await getActiveAdminCredential('gemini_image');
  if (cred) {
    return { id: cred.id, apiKey: cred.apiKey, apiSecret: cred.apiSecret || null, config: cred.config || {} };
  }
  return getAdminGeminiKey();
}

/**
 * Get admin Gemini Video API key (falls back to generic gemini)
 */
export async function getAdminGeminiVideoKey(): Promise<AdminCredential | null> {
  const cred = await getActiveAdminCredential('gemini_video');
  if (cred) {
    return { id: cred.id, apiKey: cred.apiKey, apiSecret: cred.apiSecret || null, config: cred.config || {} };
  }
  return getAdminGeminiKey();
}

/**
 * Get admin ZeroBounce API key
 */
export async function getAdminZerobounceKey(): Promise<AdminCredential | null> {
  const cred = await getActiveAdminCredential('zerobounce');
  if (!cred) return null;
  
  return {
    id: cred.id,
    apiKey: cred.apiKey,
    config: cred.config || {},
  };
}

/**
 * Get admin OpenRouter API key
 */
export async function getAdminOpenRouterKey(): Promise<AdminCredential | null> {
  const cred = await getActiveAdminCredential('openrouter');
  if (!cred) return null;
  
  return {
    id: cred.id,
    apiKey: cred.apiKey,
    config: cred.config || {},
  };
}

/**
 * Get fallback admin credential for a platform
 */
export async function getNextAdminCredential(
  platform: AdminApiPlatform,
  excludeId: number
): Promise<AdminCredential | null> {
  const cred = await getNextActiveAdminCredential(platform, excludeId);
  if (!cred) return null;
  
  return {
    id: cred.id,
    apiKey: cred.apiKey,
    apiSecret: cred.apiSecret,
    config: cred.config || {},
  };
}

/**
 * Mark admin credential as inactive
 */
export async function markAdminCredentialAsInactive(id: number, reason: string): Promise<void> {
  await markAdminCredentialInactive(id, reason);
}

/**
 * Update admin credential last used timestamp
 */
export async function updateAdminCredentialUsage(id: number): Promise<void> {
  await updateAdminCredentialLastUsed(id);
}
