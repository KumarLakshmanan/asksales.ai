import { businessOwnerUserId } from '../tenancy/businessContext.js';
 
import type { AuthenticatedRequest } from '../types/express.js';
/**
 * API Credentials Controller
 * Manages API keys for various services (OpenAI, ZeroBounce, Gemini, OpenRouter, Apify)
 * Supports multiple keys per platform with active/inactive status and rate limit rotation
 * 
 * KEY BEHAVIOR:
 * - For admin-level integrations (OpenAI, OpenRouter, Apify, Gemini, ZeroBounce),
 *   the system first checks for admin credentials in admin_api_credentials table
 * - If found, uses admin credentials with usage tracking per user
 * - Falls back to user's personal credentials in channel_credentials
 */

 
import { Response } from "express";
import { db } from "../models/db";
import { channelCredentialsTable } from "../models/channelCredentials/schema";

import { getActiveAdminCredential } from "../models/adminApiCredentials/functions";
import { eq, and, asc, sql } from "drizzle-orm";
import { logger } from '../utils/logger.js';
import { encryptValue, decryptValue } from "../services/SecretsManager";
import { isEncryptedFormat } from "../utils/secretFormat.js";

// Extend Express Request to include user

// Supported credential types
export type CredentialPlatform = "openai" | "openrouter" | "zerobounce" | "gemini" | "apify";

// SEC-001: Use AES-256-GCM encryption from SecretsManager.
// Backward compat: try decryptValue first; if format invalid, fall back to legacy base64.

const encrypt = (text: string): string => {
  return encryptValue(text);
};

const decrypt = (encrypted: string): string => {
  if (isEncryptedFormat(encrypted)) {
    try {
      return decryptValue(encrypted);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, '[APICredentialsController] decryptValue failed, falling back to base64');
    }
  }
  // Legacy base64 fallback for not-yet-migrated rows
  return Buffer.from(encrypted, "base64").toString("utf8");
};

interface CredentialInfo {
  id: number;
  platform: string;
  accountName: string;
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  hasKey: boolean;
  apiKey?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
}

/**
 * Get user's API credentials for a specific platform
 * Returns all keys (not just the first one)
 */
export const getCredentials = (platform: CredentialPlatform) => {
  return async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = businessOwnerUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const credentials = await db
        .select({
          id: channelCredentialsTable.id,
          platform: channelCredentialsTable.platform,
          accountName: channelCredentialsTable.accountName,
          isActive: channelCredentialsTable.isActive,
          lastUsedAt: channelCredentialsTable.lastUsedAt,
          createdAt: channelCredentialsTable.createdAt,
          apiKey: channelCredentialsTable.apiKey,
          sessionData: channelCredentialsTable.sessionData,
        })
        .from(channelCredentialsTable)
        .where(
          and(
            eq(channelCredentialsTable.userId, userId),
            eq(channelCredentialsTable.platform, platform)
          )
        )
        .orderBy(asc(channelCredentialsTable.id));

      // Transform credentials with decrypted API key for editing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const transformedCredentials: CredentialInfo[] = credentials.map((c: any) => ({
        id: c.id,
        platform: c.platform,
        accountName: c.accountName || platform.toUpperCase() + " Key",
        isActive: c.isActive ?? false,
        lastUsedAt: c.lastUsedAt?.toISOString() || null,
        createdAt: c.createdAt?.toISOString() || "",
        hasKey: !!c.apiKey,
        apiKey: c.apiKey ? decrypt(c.apiKey) : undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: c.sessionData as Record<string, any> | undefined,
      }));

      res.json({ success: true, credentials: transformedCredentials });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error, platform }, '[APICredentialsController] Error getting credentials');
      res.status(500).json({ error: "Unable to retrieve your credentials. Please try again." });
    }
  };
};

/**
 * Add new API credential (supports multiple keys per platform)
 */
export const addCredential = (platform: CredentialPlatform) => {
  return async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = businessOwnerUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { apiKey, name, metadata } = req.body;
      if (!apiKey) {
        return res.status(400).json({ error: "API key is required" });
      }

      // Create new credential entry (allow multiple per platform)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const insertData: any = {
        userId,
        platform,
        credentialType: "api_key",
        apiKey: encrypt(apiKey),
        accountName: name || `${platform.toUpperCase()} API Key`,
        isActive: true,
      };
      if (metadata) {
        insertData.sessionData = metadata;
      }
      
      const [newCredential] = await db
        .insert(channelCredentialsTable)
        .values(insertData)
        .returning({
          id: channelCredentialsTable.id,
          accountName: channelCredentialsTable.accountName,
          createdAt: channelCredentialsTable.createdAt,
        });

      res.json({
        success: true,
        message: "API key added successfully",
        credential: {
          ...newCredential,
          platform,
          isActive: true,
        },
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error, platform }, '[APICredentialsController] Error adding credential');
      res.status(500).json({ error: "Unable to add the credential. Please try again." });
    }
  };
};

/**
 * Update API credential
 */
export const updateCredential = (platform: CredentialPlatform) => {
  return async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = businessOwnerUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { id } = req.params;
      const { name, apiKey, isActive, metadata } = req.body;

      // Verify ownership
      const existing = await db
        .select()
        .from(channelCredentialsTable)
        .where(
          and(
            eq(channelCredentialsTable.id, parseInt(id)),
            eq(channelCredentialsTable.userId, userId),
            eq(channelCredentialsTable.platform, platform)
          )
        );

      if (existing.length === 0) {
        return res.status(404).json({ error: "Credential not found" });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updates: any = { updatedAt: new Date() };
      if (name !== undefined) updates.accountName = name;
      if (apiKey !== undefined) updates.apiKey = encrypt(apiKey);
      if (isActive !== undefined) updates.isActive = isActive;
      if (metadata !== undefined) updates.sessionData = metadata;

      await db
        .update(channelCredentialsTable)
        .set(updates)
        .where(eq(channelCredentialsTable.id, parseInt(id)));

      res.json({ success: true, message: "Credential updated successfully" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error, platform }, '[APICredentialsController] Error updating credential');
      res.status(500).json({ error: "Unable to update the credential. Please try again." });
    }
  };
};

/**
 * Delete API credential
 */
export const deleteCredential = (platform: CredentialPlatform) => {
  return async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = businessOwnerUserId(req);
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { id } = req.params;

      // Verify ownership
      const existing = await db
        .select()
        .from(channelCredentialsTable)
        .where(
          and(
            eq(channelCredentialsTable.id, parseInt(id)),
            eq(channelCredentialsTable.userId, userId),
            eq(channelCredentialsTable.platform, platform)
          )
        );

      if (existing.length === 0) {
        return res.status(404).json({ error: "Credential not found" });
      }

      await db
        .delete(channelCredentialsTable)
        .where(eq(channelCredentialsTable.id, parseInt(id)));

      res.json({ success: true, message: "Credential deleted successfully" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error, platform }, '[APICredentialsController] Error deleting credential');
      res.status(500).json({ error: "Unable to delete the credential. Please try again." });
    }
  };
};

/**
 * Get active API key for a user (for internal use by other services)
 * Returns the first active key
 * 
 * PRIORITY ORDER:
 * 1. System/Admin credentials for admin-level platforms
 * 2. User's personal credentials
 */
export const getActiveApiKey = async (
  userId: number,
  platform: CredentialPlatform
): Promise<string | null> => {
  try {
    // For admin-level platforms, first check for system credentials
    if (ADMIN_LEVEL_PLATFORMS.includes(platform)) {
      const systemKey = await getActiveSystemApiKey(platform);
      if (systemKey) {
        logger.info({ userId, platform }, '[APICredentialsController] Using system key');
        return systemKey.apiKey;
      }
    }
    
    // Fall back to user's personal credentials
    const credentials = await db
      .select({
        apiKey: channelCredentialsTable.apiKey,
      })
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, platform),
          eq(channelCredentialsTable.isActive, true)
        )
      )
      .limit(1);

    if (credentials.length === 0 || !credentials[0].apiKey) {
      return null;
    }

    return decrypt(credentials[0].apiKey);
  } catch (error) {
    logger.error({ err: error, platform }, '[APICredentialsController] Error getting active key');
    return null;
  }
};

// Admin-level platforms that should check for system credentials first
const ADMIN_LEVEL_PLATFORMS: CredentialPlatform[] = ['openai', 'openrouter', 'apify', 'gemini', 'zerobounce'];

/**
 * Get active system/admin API key from admin_api_credentials table
 * These are credentials added by admin in the admin panel
 */
export const getActiveSystemApiKey = async (
  platform: CredentialPlatform
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ apiKey: string; metadata?: Record<string, any>; credentialId: number; isSystemKey: true } | null> => {
  try {
    // Look for admin credential in admin_api_credentials table
    const adminCredential = await getActiveAdminCredential(platform);
    if (!adminCredential?.apiKey) {
      return null;
    }

    logger.info({ platform, credentialId: adminCredential.id }, '[APICredentialsController] Found admin key');
    
    return {
      apiKey: adminCredential.apiKey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: adminCredential.config as Record<string, any> | undefined,
      credentialId: adminCredential.id,
      isSystemKey: true,
    };
  } catch (error) {
    logger.error({ err: error, platform }, '[APICredentialsController] Error getting admin key');
    return null;
  }
};

/**
 * Get active API key with metadata for a user (includes model selection)
 * 
 * PRIORITY ORDER:
 * 1. System/Admin credentials (api_credentials with isSystemKey=true) for admin-level platforms
 * 2. User's personal credentials (channel_credentials)
 */
export const getActiveApiKeyWithMetadata = async (
  userId: number,
  platform: CredentialPlatform
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ apiKey: string; metadata?: Record<string, any>; credentialId: number; isSystemKey?: boolean } | null> => {
  try {
    // For admin-level platforms, first check for system credentials
    if (ADMIN_LEVEL_PLATFORMS.includes(platform)) {
      const systemKey = await getActiveSystemApiKey(platform);
      if (systemKey) {
        logger.info({ userId, platform }, '[APICredentialsController] Using system key');
        return systemKey;
      }
    }
    
    // Fall back to user's personal credentials
    const credentials = await db
      .select({
        id: channelCredentialsTable.id,
        apiKey: channelCredentialsTable.apiKey,
        sessionData: channelCredentialsTable.sessionData,
      })
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, platform),
          eq(channelCredentialsTable.isActive, true)
        )
      )
      .limit(1);

    if (credentials.length === 0 || !credentials[0].apiKey) {
      return null;
    }

    return {
      apiKey: decrypt(credentials[0].apiKey),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: credentials[0].sessionData as Record<string, any> | undefined,
      credentialId: credentials[0].id,
      isSystemKey: false,
    };
  } catch (error) {
    logger.error({ err: error, platform }, '[APICredentialsController] Error getting active key with metadata');
    return null;
  }
};

/**
 * Mark credential as inactive (for rate limit rotation)
 * @param credentialId - The credential ID to mark as inactive
 * @param reason - Optional reason for deactivation (e.g., 'quota_exceeded', 'rate_limit')
 */
export const markCredentialAsInactive = async (
  credentialId: number,
  reason?: string
): Promise<void> => {
  try {
    await db
      .update(channelCredentialsTable)
      .set({ 
        isActive: false, 
        deactivationReason: reason || 'rate_limit_or_quota_exceeded',
        deactivatedAt: new Date(),
        updatedAt: new Date() 
      })
      .where(eq(channelCredentialsTable.id, credentialId));
    logger.info({ credentialId, reason }, '[APICredentialsController] Marked credential as inactive');
  } catch (error) {
    logger.error({ err: error }, '[APICredentialsController] Error marking credential as inactive');
  }
};

/**
 * Get next available API key (for rate limit rotation)
 * Skips the current key and returns the next active one
 */
export const getNextActiveApiKey = async (
  userId: number,
  platform: CredentialPlatform,
  currentKeyId: number
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ id: number; apiKey: string; metadata?: Record<string, any> } | null> => {
  try {
    const credentials = await db
      .select({
        id: channelCredentialsTable.id,
        apiKey: channelCredentialsTable.apiKey,
        sessionData: channelCredentialsTable.sessionData,
      })
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, platform),
          eq(channelCredentialsTable.isActive, true),
          sql`${channelCredentialsTable.id} != ${currentKeyId}`
        )
      )
      .limit(1);

    if (credentials.length === 0 || !credentials[0].apiKey) {
      return null;
    }

    return {
      id: credentials[0].id,
      apiKey: decrypt(credentials[0].apiKey),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: credentials[0].sessionData as Record<string, any> | undefined,
    };
  } catch (error) {
    logger.error({ err: error, platform }, '[APICredentialsController] Error getting next key');
    return null;
  }
};

// Export specific handlers for each platform
export const openai = {
  get: getCredentials("openai"),
  add: addCredential("openai"),
  update: updateCredential("openai"),
  delete: deleteCredential("openai"),
  getActiveKey: (userId: number) => getActiveApiKey(userId, "openai"),
};

export const zerobounce = {
  get: getCredentials("zerobounce"),
  add: addCredential("zerobounce"),
  update: updateCredential("zerobounce"),
  delete: deleteCredential("zerobounce"),
  getActiveKey: (userId: number) => getActiveApiKey(userId, "zerobounce"),
};

export const gemini = {
  get: getCredentials("gemini"),
  add: addCredential("gemini"),
  update: updateCredential("gemini"),
  delete: deleteCredential("gemini"),
  getActiveKey: (userId: number) => getActiveApiKey(userId, "gemini"),
};

export const openrouter = {
  get: getCredentials("openrouter"),
  add: addCredential("openrouter"),
  update: updateCredential("openrouter"),
  delete: deleteCredential("openrouter"),
  getActiveKey: (userId: number) => getActiveApiKey(userId, "openrouter"),
};

export const apify = {
  get: getCredentials("apify"),
  add: addCredential("apify"),
  update: updateCredential("apify"),
  delete: deleteCredential("apify"),
  getActiveKey: (userId: number) => getActiveApiKey(userId, "apify"),
};
