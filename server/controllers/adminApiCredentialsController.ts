/**
 * Admin API Credentials Controller
 * Manages API keys/tokens for OpenAI, OpenRouter, Apify, Gemini, and ZeroBounce across all users
 */

import { Request, Response } from "express";
import { db } from "../models/db";
import { apiCredentialsTable } from "../models/apiCredentials/schema";
import { usersTable } from "../models/users/schema";
import { eq, and, asc, desc, sql } from "drizzle-orm";
import { logger } from '../utils/logger.js';
import { createAdminCredential, recordAdminCredentialAudit } from '../models/adminApiCredentials/functions.js';
import { parseIntegrationCredentialInput, validateIntegrationRequirements } from '../utils/integrationCredentialValidation.js';
import { maskSensitiveIntegrationConfig } from '../utils/integrationSecrets.js';

interface ApiCredentialWithUser {
  id: number;
  userId: number;
  serviceName: string;
  isActive: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  config: Record<string, unknown> | null;
  userName?: string | null;
  userEmail?: string | null;
}

/**
 * Get all API credentials across all users for a specific platform
 * GET /api/admin/api-credentials?platform=openai|openrouter|apify
 */
export async function getAllApiCredentials(req: Request, res: Response) {
  try {
    const { platform, page = 1, pageSize = 50 } = req.query;
    
    const parsedPage = Number(page);
    const parsedPageSize = Number(pageSize);
    if (!Number.isSafeInteger(parsedPage) || parsedPage < 1 || !Number.isSafeInteger(parsedPageSize) || parsedPageSize < 1 || parsedPageSize > 100) {
      return res.status(400).json({ error: 'page must be at least 1 and pageSize must be between 1 and 100' });
    }
    const offset = (parsedPage - 1) * parsedPageSize;
    const limit = parsedPageSize;
    
    // Build conditions
    const conditions: ReturnType<typeof eq>[] = [];
    if (platform) {
      conditions.push(eq(apiCredentialsTable.serviceName, platform as string));
    }
    
    // Get credentials with user info
    const credentials = await db.select({
      id: apiCredentialsTable.id,
      userId: apiCredentialsTable.userId,
      serviceName: apiCredentialsTable.serviceName,
      isActive: apiCredentialsTable.isActive,
      lastUsedAt: apiCredentialsTable.lastUsedAt,
      createdAt: apiCredentialsTable.createdAt,
      config: apiCredentialsTable.config,
      userName: usersTable.name,
      userEmail: usersTable.email,
    })
      .from(apiCredentialsTable)
      .leftJoin(usersTable, eq(apiCredentialsTable.userId, usersTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(apiCredentialsTable.id))
      .offset(offset)
      .limit(limit);
    
    // Get total count
    const [countResult] = await db.select({ count: sql<number>`count(*)` })
      .from(apiCredentialsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
    
    // Get stats by platform
    const stats = await db.select({
      serviceName: apiCredentialsTable.serviceName,
      total: sql<number>`count(*)`,
      active: sql<number>`sum(case when ${apiCredentialsTable.isActive} = true then 1 else 0 end)`,
    })
      .from(apiCredentialsTable)
      .groupBy(apiCredentialsTable.serviceName);
    
    const statsMap: Record<string, { total: number; active: number }> = {};
    for (const s of stats) {
      statsMap[s.serviceName] = { total: Number(s.total), active: Number(s.active) };
    }

    // Map to expected frontend format
    const mappedCredentials = credentials.map((c: ApiCredentialWithUser) => ({
      id: c.id,
      userId: c.userId,
      platform: c.serviceName, // Map serviceName to platform for frontend
      accountName: c.serviceName, // Use serviceName as account name
      accountIdentifier: null,
      isActive: c.isActive,
      lastUsedAt: c.lastUsedAt,
      createdAt: c.createdAt,
      metadata: maskSensitiveIntegrationConfig(c.config),
      userName: c.userName,
      userEmail: c.userEmail,
      hasKey: true, // We don't expose actual keys
    }));

    return res.json({
      success: true,
      credentials: mappedCredentials,
      pagination: {
        total: Number(countResult?.count) || 0,
        page: parsedPage,
        pageSize: parsedPageSize,
        totalPages: Math.ceil((Number(countResult?.count) || 0) / parsedPageSize),
      },
      stats: statsMap,
    });
  } catch (error) {
    logger.error({ err: error }, '[getAllApiCredentials] Error');
    return res.status(500).json({ error: "Unable to retrieve API credentials. Please try again." });
  }
}

/**
 * Get API credentials summary across all platforms
 * GET /api/admin/api-credentials/summary
 */
export async function getApiCredentialsSummary(req: Request, res: Response) {
  try {
    // Get stats by platform
    const byPlatform = await db.select({
      serviceName: apiCredentialsTable.serviceName,
      total: sql<number>`count(*)`,
      active: sql<number>`sum(case when ${apiCredentialsTable.isActive} = true then 1 else 0 end)`,
      usersWithCredentials: sql<number>`count(distinct ${apiCredentialsTable.userId})`,
    })
      .from(apiCredentialsTable)
      .groupBy(apiCredentialsTable.serviceName);
    
    const platformStats: Record<string, { total: number; active: number; usersWithCredentials: number }> = {};
    for (const p of byPlatform) {
      platformStats[p.serviceName] = {
        total: Number(p.total),
        active: Number(p.active),
        usersWithCredentials: Number(p.usersWithCredentials),
      };
    }
    
    // Ensure all platforms are represented
    const platforms = ['openai', 'openrouter', 'apify', 'gemini', 'zerobounce', 'smtp'];
    platforms.forEach(p => {
      if (!platformStats[p]) {
        platformStats[p] = { total: 0, active: 0, usersWithCredentials: 0 };
      }
    });
    
    return res.json({
      success: true,
      byPlatform: platformStats,
    });
  } catch (error) {
    logger.error({ err: error }, '[getApiCredentialsSummary] Error');
    return res.status(500).json({ error: "Unable to retrieve API credentials summary. Please try again." });
  }
}

/**
 * Toggle API credential active status
 * POST /api/admin/api-credentials/:id/toggle
 */
export async function toggleApiCredential(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const credentialId = Number(id);
    if (!Number.isSafeInteger(credentialId) || credentialId < 1) {
      return res.status(400).json({ error: 'Invalid credential ID' });
    }
    
    // Get current status
    const [credential] = await db.select()
      .from(apiCredentialsTable)
      .where(eq(apiCredentialsTable.id, credentialId));
    
    if (!credential) {
      return res.status(404).json({ error: "Credential not found" });
    }
    
    // Toggle status
    const newStatus = !credential.isActive;
    await db.update(apiCredentialsTable)
      .set({ isActive: newStatus, updatedAt: new Date() })
      .where(eq(apiCredentialsTable.id, credentialId));
    await recordAdminCredentialAudit({
      credentialId: null,
      platform: `user:${credential.serviceName}`,
      action: newStatus ? 'activate' : 'deactivate',
      adminId: Number(req.user?.id) || null,
      changedFields: ['isActive'],
      message: `User credential ${credentialId} ${newStatus ? 'activated' : 'deactivated'} by administrator`,
    });
    
    return res.json({
      success: true,
      message: `Credential ${newStatus ? 'activated' : 'deactivated'} successfully`,
      isActive: newStatus,
    });
  } catch (error) {
    logger.error({ err: error }, '[toggleApiCredential] Error');
    return res.status(500).json({ error: "Unable to toggle the credential status. Please try again." });
  }
}

/**
 * Delete API credential
 * DELETE /api/admin/api-credentials/:id
 */
export async function deleteApiCredential(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const credentialId = Number(id);
    if (!Number.isSafeInteger(credentialId) || credentialId < 1) {
      return res.status(400).json({ error: 'Invalid credential ID' });
    }
    
    // Check if exists
    const [credential] = await db.select()
      .from(apiCredentialsTable)
      .where(eq(apiCredentialsTable.id, credentialId));
    
    if (!credential) {
      return res.status(404).json({ error: "Credential not found" });
    }
    
    // Delete
    await recordAdminCredentialAudit({
      credentialId: null,
      platform: `user:${credential.serviceName}`,
      action: 'delete',
      adminId: Number(req.user?.id) || null,
      changedFields: ['credential'],
      message: `User credential ${credentialId} deleted by administrator`,
    });
    await db.delete(apiCredentialsTable)
      .where(eq(apiCredentialsTable.id, credentialId));
    
    return res.json({
      success: true,
      message: "Credential deleted successfully",
    });
  } catch (error) {
    logger.error({ err: error }, '[deleteApiCredential] Error');
    return res.status(500).json({ error: "Unable to delete the credential. Please try again." });
  }
}

/**
 * Create system-level API credential (admin-only)
 * POST /api/admin/api-credentials/system
 */
export async function createSystemCredential(req: Request, res: Response) {
  try {
    const raw = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const input = parseIntegrationCredentialInput({
      ...raw,
      name: raw.name || (typeof raw.platform === 'string' ? `System ${raw.platform} Key` : undefined),
    });
    validateIntegrationRequirements(input);
    const newCredential = await createAdminCredential({
      platform: input.platform!,
      name: input.name!,
      apiKey: input.apiKey!,
      apiSecret: input.apiSecret || null,
      config: input.config || {},
      priority: input.priority || 'normal',
      isActive: true,
    });
    await recordAdminCredentialAudit({
      credentialId: newCredential.id,
      platform: newCredential.platform,
      action: 'create',
      adminId: Number(req.user?.id) || null,
      changedFields: ['name', 'apiKey', ...(newCredential.apiSecret ? ['apiSecret'] : []), 'config'],
    });
    
    return res.json({
      success: true,
      message: "System credential created successfully",
      credential: {
        id: newCredential.id,
        platform: newCredential.platform,
        accountName: newCredential.name,
        isActive: newCredential.isActive,
        createdAt: newCredential.createdAt,
      },
    });
  } catch (error) {
    if (error instanceof Error && /must|required|invalid|unsupported|between|smaller/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ err: error }, '[createSystemCredential] Error');
    return res.status(500).json({ error: "Unable to create the system credential. Please try again." });
  }
}

/**
 * Get API credentials for a specific user
 * GET /api/admin/users/:userId/api-credentials
 */
export async function getUserApiCredentials(req: Request, res: Response) {
  try {
    const { userId } = req.params;
    const parsedUserId = Number(userId);
    if (!Number.isSafeInteger(parsedUserId) || parsedUserId < 1) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    
    const credentials = await db.select({
      id: apiCredentialsTable.id,
      userId: apiCredentialsTable.userId,
      serviceName: apiCredentialsTable.serviceName,
      isActive: apiCredentialsTable.isActive,
      lastUsedAt: apiCredentialsTable.lastUsedAt,
      createdAt: apiCredentialsTable.createdAt,
      config: apiCredentialsTable.config,
    })
      .from(apiCredentialsTable)
      .where(eq(apiCredentialsTable.userId, parsedUserId))
      .orderBy(desc(apiCredentialsTable.createdAt));
    
    // Define credential type
    interface CredentialRow {
      id: number;
      userId: number;
      serviceName: string;
      isActive: boolean;
      lastUsedAt: Date | null;
      createdAt: Date;
      config: unknown;
    }
    
    // Map to expected format
    const mappedCredentials = (credentials as CredentialRow[]).map((c) => ({
      id: c.id,
      userId: c.userId,
      platform: c.serviceName,
      accountName: c.serviceName,
      accountIdentifier: null,
      isActive: c.isActive,
      lastUsedAt: c.lastUsedAt,
      createdAt: c.createdAt,
      metadata: maskSensitiveIntegrationConfig(c.config),
      hasKey: true,
    }));
    
    return res.json({
      success: true,
      credentials: mappedCredentials,
    });
  } catch (error) {
    logger.error({ err: error }, '[getUserApiCredentials] Error');
    return res.status(500).json({ error: "Unable to retrieve user API credentials. Please try again." });
  }
}
