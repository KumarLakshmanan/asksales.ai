import { businessOwnerUserId } from '../tenancy/businessContext.js';
 
import type { AuthenticatedRequest } from '../types/express.js';
/**
 * Apify Integration Controller
 * Manages Apify API tokens for users
 * 
 * PRIORITY FOR API KEY:
 * 1. System/Admin credentials (api_credentials with isSystemKey=true)
 * 2. User's personal credentials (channel_credentials)
 */

 
import { Response } from "express";
import { logger } from '../utils/logger.js';
import { db } from "../models/db";
import { channelCredentialsTable } from "../models/channelCredentials/schema";
import { apiCredentialsTable } from "../models/apiCredentials/schema";
import { eq, and, sql } from "drizzle-orm";
import { ApifyClient } from "apify-client";
import { encryptValue, decryptValue } from "../services/SecretsManager";
import { isEncryptedFormat } from "../utils/secretFormat.js";

// Extend Express Request to include user

// SEC-001: Use AES-256-GCM encryption. Backward-compat with legacy base64 rows.

const encrypt = (text: string): string => encryptValue(text);

const decrypt = (encrypted: string): string => {
  if (isEncryptedFormat(encrypted)) {
    try {
      return decryptValue(encrypted);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, '[ApifyController] decryptValue failed, falling back to base64');
    }
  }
  return Buffer.from(encrypted, "base64").toString("utf8");
};

/**
 * Get user's Apify tokens
 */
export const getApifyTokens = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const tokens = await db
      .select({
        id: channelCredentialsTable.id,
        accountName: channelCredentialsTable.accountName,
        accountIdentifier: channelCredentialsTable.accountIdentifier,
        isActive: channelCredentialsTable.isActive,
        lastUsedAt: channelCredentialsTable.lastUsedAt,
        createdAt: channelCredentialsTable.createdAt,
      })
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, "apify")
        )
      );

    res.json({ success: true, tokens });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ApifyController] Error getting tokens');
    res.status(500).json({ error: "Unable to retrieve tokens. Please try again." });
  }
};

/**
 * Verify and add new Apify token
 */
export const addApifyToken = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { apiToken, name } = req.body;
    if (!apiToken) {
      return res.status(400).json({ error: "API token is required" });
    }

    // Verify token with Apify API
    let accountInfo: { username: string; id: string } | null = null;
    try {
      const client = new ApifyClient({ token: apiToken });
      const user = await client.user().get();
      accountInfo = {
        username: user?.username || "Unknown",
        id: user?.id || "",
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (verifyError: any) {
      logger.error({ err: verifyError }, '[ApifyController] Token verification failed');
      return res.status(400).json({
        error: "Invalid API token. Please check your token and try again.",
        details: verifyError.message,
      });
    }

    // Check if token already exists
    const existingTokens = await db
      .select()
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, "apify"),
          eq(channelCredentialsTable.accountIdentifier, accountInfo.id)
        )
      );

    if (existingTokens.length > 0) {
      // Update existing token
      await db
        .update(channelCredentialsTable)
        .set({
          apiKey: encrypt(apiToken),
          accountName: name || accountInfo.username,
          isActive: true,
          updatedAt: new Date(),
        })
        .where(eq(channelCredentialsTable.id, existingTokens[0].id));

      return res.json({
        success: true,
        message: "Token updated successfully",
        token: {
          id: existingTokens[0].id,
          accountName: name || accountInfo.username,
          accountIdentifier: accountInfo.id,
          username: accountInfo.username,
        },
      });
    }

    // Create new token entry
    const [newToken] = await db
      .insert(channelCredentialsTable)
      .values({
        userId,
        platform: "apify",
        credentialType: "api_key",
        apiKey: encrypt(apiToken),
        accountIdentifier: accountInfo.id,
        accountName: name || accountInfo.username,
        isActive: true,
      })
      .returning({
        id: channelCredentialsTable.id,
        accountName: channelCredentialsTable.accountName,
        accountIdentifier: channelCredentialsTable.accountIdentifier,
        createdAt: channelCredentialsTable.createdAt,
      });

    res.json({
      success: true,
      message: "Token added successfully",
      token: {
        ...newToken,
        username: accountInfo.username,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ApifyController] Error adding token');
    res.status(500).json({ error: "Unable to add the token. Please try again." });
  }
};

/**
 * Update Apify token name or status
 */
export const updateApifyToken = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { id } = req.params;
    const { name, isActive } = req.body;

    // Verify ownership
    const existing = await db
      .select()
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.id, parseInt(id)),
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, "apify")
        )
      );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Token not found" });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: any = { updatedAt: new Date() };
    if (name !== undefined) updates.accountName = name;
    if (isActive !== undefined) updates.isActive = isActive;

    await db
      .update(channelCredentialsTable)
      .set(updates)
      .where(eq(channelCredentialsTable.id, parseInt(id)));

    res.json({ success: true, message: "Token updated successfully" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ApifyController] Error updating token');
    res.status(500).json({ error: "Unable to update the token. Please try again." });
  }
};

/**
 * Delete Apify token
 */
export const deleteApifyToken = async (req: AuthenticatedRequest, res: Response) => {
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
          eq(channelCredentialsTable.platform, "apify")
        )
      );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Token not found" });
    }

    await db
      .delete(channelCredentialsTable)
      .where(eq(channelCredentialsTable.id, parseInt(id)));

    res.json({ success: true, message: "Token deleted successfully" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ApifyController] Error deleting token');
    res.status(500).json({ error: "Unable to delete the token. Please try again." });
  }
};

/**
 * Get active Apify token for the user (for internal use by other services)
 * 
 * PRIORITY:
 * 1. System/Admin credentials (api_credentials with isSystemKey=true)
 * 2. User's personal credentials (channel_credentials)
 */
export const getActiveApifyToken = async (userId: number): Promise<string | null> => {
  try {
    // First, check for system/admin credentials
    const systemCredentials = await db
      .select({
        apiKey: apiCredentialsTable.apiKey,
      })
      .from(apiCredentialsTable)
      .where(
        and(
          eq(apiCredentialsTable.serviceName, "apify"),
          eq(apiCredentialsTable.isActive, true),
          sql`(${apiCredentialsTable.config}->>'isSystemKey')::boolean = true`
        )
      )
      .limit(1);

    if (systemCredentials.length > 0 && systemCredentials[0].apiKey) {
      logger.info({ userId }, '[ApifyController] Using system Apify key');
      return systemCredentials[0].apiKey; // System credentials may not be encrypted
    }

    // Fall back to user's personal credentials
    const tokens = await db
      .select({
        apiKey: channelCredentialsTable.apiKey,
      })
      .from(channelCredentialsTable)
      .where(
        and(
          eq(channelCredentialsTable.userId, userId),
          eq(channelCredentialsTable.platform, "apify"),
          eq(channelCredentialsTable.isActive, true)
        )
      )
      .limit(1);

    if (tokens.length === 0 || !tokens[0].apiKey) {
      return null;
    }

    return decrypt(tokens[0].apiKey);
  } catch (error) {
    logger.error({ err: error }, '[ApifyController] Error getting active token');
    return null;
  }
};

