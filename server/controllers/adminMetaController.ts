/**
 * Admin Meta Controller
 * Manages the global Meta App configuration and monitors user connections.
 * 
 * Admin stores Meta App ID, App Secret, and Webhook Verify Token.
 * Clients connect via OAuth using the admin's Meta App credentials.
 */

import { Request, Response } from 'express';
import {
  getActiveAdminCredential,
  getAdminCredentialsByPlatform,
  createAdminCredential,
  updateAdminCredential,
  recordAdminCredentialAudit,
} from '../models/adminApiCredentials/functions';
import {
  getAllActiveConnections,
  countActiveConnections,
} from '../models/metaPageConnections/functions';
import { db } from '../models/db';
import { sql, eq, and, or, gte, desc } from 'drizzle-orm';
import { channelCredentialsTable } from '../models/channelCredentials/schema';
import { webhookEventsTable } from '../models/webhookEvents/schema';
import { logger } from '../utils/logger.js';
import { MASKED_INTEGRATION_SECRET, maskSensitiveIntegrationConfig, mergeIntegrationCredentialConfig } from '../utils/integrationSecrets.js';
import { normalizeMetaAppReviewPermissions } from '../services/integrations/MetaCapabilityRegistry.js';

function optionalText(value: unknown, field: string, max = 500): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${field} must be between 1 and ${max} characters`);
  if (/^•{4,}/.test(normalized) || normalized === MASKED_INTEGRATION_SECRET) return undefined;
  return normalized;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

/**
 * GET /api/admin/meta/config
 * Get the current Meta App configuration
 */
export async function getMetaConfig(req: Request, res: Response) {
  try {
    const credential = await getActiveAdminCredential('meta_app');

    if (!credential) {
      return res.json({
        success: true,
        configured: false,
        config: null,
      });
    }

    const config = credential.config as Record<string, unknown> || {};

    return res.json({
      success: true,
      configured: true,
      config: {
        id: credential.id,
        appId: credential.apiKey,
        // Mask the secret for display
        appSecret: credential.apiSecret ? '••••••' + credential.apiSecret.slice(-4) : '',
        webhookVerifyToken: maskSensitiveIntegrationConfig(config.webhookVerifyToken, 'webhookVerifyToken') || '',
        webhookVerifyTokenConfigured: !!config.webhookVerifyToken,
        webhookUrl: config.webhookUrl || '',
        configId: config.configId || '',
        apiVersion: config.apiVersion || 'v25.0',
        appReviewPermissions: normalizeMetaAppReviewPermissions(config.appReviewPermissions),
        directInstagramLoginEnabled: config.directInstagramLoginEnabled === true,
        isActive: credential.isActive,
        lastUsedAt: credential.lastUsedAt,
        createdAt: credential.createdAt,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminMeta] Error getting config');
    return res.status(500).json({ error: 'Unable to retrieve Meta configuration.' });
  }
}

/**
 * GET /api/admin/meta/config/full
 * Get editable Meta App metadata. Secret values are never returned.
 */
export async function getMetaConfigFull(req: Request, res: Response) {
  try {
    const credential = await getActiveAdminCredential('meta_app');

    if (!credential) {
      return res.json({
        success: true,
        configured: false,
        config: null,
      });
    }

    const config = credential.config as Record<string, unknown> || {};

    const rawSecret = credential.apiSecret || '';
    const maskedSecret = rawSecret ? '••••••' + rawSecret.slice(-4) : '';

    return res.json({
      success: true,
      configured: true,
      config: {
        id: credential.id,
        appId: credential.apiKey,
        appSecret: maskedSecret,
        appSecretConfigured: !!rawSecret,
        webhookVerifyToken: maskSensitiveIntegrationConfig(config.webhookVerifyToken, 'webhookVerifyToken') || '',
        webhookVerifyTokenConfigured: !!config.webhookVerifyToken,
        webhookUrl: config.webhookUrl || '',
        configId: config.configId || '',
        apiVersion: config.apiVersion || 'v25.0',
        instagramAppId: config.instagramAppId || '',
        instagramAppSecret: maskSensitiveIntegrationConfig(config.instagramAppSecret, 'instagramAppSecret') || '',
        instagramAppSecretConfigured: !!config.instagramAppSecret,
        appReviewPermissions: normalizeMetaAppReviewPermissions(config.appReviewPermissions),
        directInstagramLoginEnabled: config.directInstagramLoginEnabled === true,
        isActive: credential.isActive,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminMeta] Error getting full config');
    return res.status(500).json({ error: 'Unable to retrieve Meta configuration.' });
  }
}

/**
 * POST /api/admin/meta/config
 * Create or update the Meta App configuration
 */
export async function saveMetaConfig(req: Request, res: Response) {
  try {
    const activeCredential = await getActiveAdminCredential('meta_app');
    const existing = activeCredential || (await getAdminCredentialsByPlatform('meta_app'))[0];
    const allowed = new Set(['appId', 'appSecret', 'webhookVerifyToken', 'webhookUrl', 'configId', 'apiVersion', 'instagramAppId', 'instagramAppSecret', 'appReviewPermissions', 'directInstagramLoginEnabled']);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some((key) => !allowed.has(key))) {
      return res.status(400).json({ error: 'Meta configuration contains unsupported fields.' });
    }
    const appId = optionalText(req.body.appId, 'App ID', 255);
    const appSecret = optionalText(req.body.appSecret, 'App Secret', 500);
    if (!appId) return res.status(400).json({ error: 'App ID is required.' });
    if (!existing && !appSecret) return res.status(400).json({ error: 'App Secret is required for initial setup.' });
    const apiVersion = optionalText(req.body.apiVersion, 'API version', 20) || 'v25.0';
    if (!/^v\d{1,3}\.\d{1,2}$/.test(apiVersion)) return res.status(400).json({ error: 'API version must use a value such as v25.0.' });
    const incomingConfig = Object.fromEntries(Object.entries({
      webhookVerifyToken: optionalText(req.body.webhookVerifyToken, 'Webhook verify token', 500),
      webhookUrl: optionalText(req.body.webhookUrl, 'Webhook URL', 2000),
      configId: optionalText(req.body.configId, 'Configuration ID', 255),
      apiVersion,
      instagramAppId: optionalText(req.body.instagramAppId, 'Instagram App ID', 255),
      instagramAppSecret: optionalText(req.body.instagramAppSecret, 'Instagram App Secret', 500),
      appReviewPermissions: req.body.appReviewPermissions === undefined
        ? undefined
        : normalizeMetaAppReviewPermissions(req.body.appReviewPermissions),
      directInstagramLoginEnabled: optionalBoolean(req.body.directInstagramLoginEnabled, 'Direct Instagram Login flag'),
    }).filter(([, value]) => value !== undefined));
    const config = mergeIntegrationCredentialConfig(existing?.config, incomingConfig);

    if (existing) {
      // Update existing
      const secretRotated = !!appSecret || !!incomingConfig.instagramAppSecret || !!incomingConfig.webhookVerifyToken;
      await updateAdminCredential(existing.id, {
        apiKey: appId,
        ...(appSecret ? { apiSecret: appSecret } : {}),
        config,
        ...(secretRotated ? {
          rotatedAt: new Date(),
          rotatedBy: Number(req.user?.id) || null,
          lastValidatedAt: null,
          validationStatus: null,
          validationMessage: null,
        } : {}),
      });
      await recordAdminCredentialAudit({
        credentialId: existing.id,
        platform: 'meta_app',
        action: secretRotated ? 'rotate' : 'update',
        adminId: Number(req.user?.id) || null,
        changedFields: ['apiKey', 'config', ...(appSecret ? ['apiSecret'] : [])],
      });
    } else {
      // Create new
      const created = await createAdminCredential({
        platform: 'meta_app',
        name: 'Meta Apps (Facebook + Instagram)',
        apiKey: appId,
        apiSecret: appSecret,
        priority: 'normal',
        config,
      });
      await recordAdminCredentialAudit({
        credentialId: created.id,
        platform: 'meta_app',
        action: 'create',
        adminId: Number(req.user?.id) || null,
        changedFields: ['apiKey', 'apiSecret', 'config'],
      });
    }

    logger.info('[AdminMeta] Meta App configuration saved');
    return res.json({ success: true, message: 'Meta configuration saved successfully.' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error instanceof Error && /must|required|between|unsupported/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ err: error }, '[AdminMeta] Error saving config');
    return res.status(500).json({ error: 'Unable to save Meta configuration.' });
  }
}

/**
 * GET /api/admin/meta/connections
 * Get all users who have connected their Facebook/Instagram via OAuth
 */
export async function getMetaConnections(req: Request, res: Response) {
  try {
    const connections = await getAllActiveConnections();

    return res.json({
      success: true,
      connections: connections.map(c => ({
        id: c.id,
        userId: c.userId,
        pageId: c.pageId,
        pageName: c.pageName,
        instagramUsername: c.instagramUsername,
        instagramAccountId: c.instagramAccountId,
        instagramFollowersCount: c.instagramFollowersCount,
        adAccountId: c.adAccountId,
        adAccountName: c.adAccountName,
        isActive: c.isActive,
        webhookSubscribed: c.webhookSubscribed,
        lastUsedAt: c.lastUsedAt,
        createdAt: c.createdAt,
      })),
      total: connections.length,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminMeta] Error getting connections');
    return res.status(500).json({ error: 'Unable to retrieve Meta connections.' });
  }
}

/**
 * GET /api/admin/meta/stats
 * Get Meta integration statistics
 */
export async function getMetaStats(req: Request, res: Response) {
  try {
    const totalConnections = await countActiveConnections();
    const connections = await getAllActiveConnections();

    const withInstagram = connections.filter(c => c.instagramAccountId).length;
    const withAds = connections.filter(c => c.adAccountId).length;
    const withWebhook = connections.filter(c => c.webhookSubscribed).length;

    return res.json({
      success: true,
      stats: {
        totalConnections,
        withInstagram,
        withAds,
        withWebhook,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminMeta] Error getting stats');
    return res.status(500).json({ error: 'Unable to retrieve Meta statistics.' });
  }
}

/**
 * GET /api/admin/meta/health
 * Returns integration health: token statuses, recent webhook activity, errors
 */
export async function getMetaHealth(req: Request, res: Response) {
  try {
    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Token health across channel_credentials for Meta platforms
    const metaPlatforms = ['instagram_api', 'instagram', 'facebook', 'facebook_api', 'whatsapp'];
    const credentials = await db
      .select({
        id: channelCredentialsTable.id,
        userId: channelCredentialsTable.userId,
        platform: channelCredentialsTable.platform,
        accountIdentifier: channelCredentialsTable.accountIdentifier,
        tokenExpiry: channelCredentialsTable.tokenExpiry,
        isActive: channelCredentialsTable.isActive,
        updatedAt: channelCredentialsTable.updatedAt,
      })
      .from(channelCredentialsTable)
      .where(
        and(
          or(...metaPlatforms.map(p => eq(channelCredentialsTable.platform, p))),
          eq(channelCredentialsTable.isActive, true)
        )
      );

    const tokenStatuses = credentials.map((cred: { tokenExpiry: string | Date | null, id: string, userId: string, platform: string, accountIdentifier: string | null, updatedAt: Date }) => {
      let status: 'valid' | 'expiring' | 'expired' | 'unknown' = 'unknown';
      if (!cred.tokenExpiry) {
        status = 'unknown';
      } else if (new Date(cred.tokenExpiry) < now) {
        status = 'expired';
      } else if (new Date(cred.tokenExpiry) < sevenDaysFromNow) {
        status = 'expiring';
      } else {
        status = 'valid';
      }
      return {
        id: cred.id,
        userId: cred.userId,
        platform: cred.platform,
        account: cred.accountIdentifier,
        status,
        expiresAt: cred.tokenExpiry,
        lastUpdated: cred.updatedAt,
      };
    });

    // Recent webhook activity (last 24 hours)
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const recentWebhooks = await db
      .select({
        platform: webhookEventsTable.platform,
        total: sql<number>`count(*)::int`,
        processed: sql<number>`count(*) filter (where ${webhookEventsTable.processed} = true)::int`,
        errors: sql<number>`count(*) filter (where ${webhookEventsTable.error} is not null)::int`,
        signatureRejected: sql<number>`count(*) filter (where ${webhookEventsTable.signatureValid} = false)::int`,
        lastEvent: sql<string>`max(${webhookEventsTable.createdAt})`,
      })
      .from(webhookEventsTable)
      .where(gte(webhookEventsTable.createdAt, oneDayAgo))
      .groupBy(webhookEventsTable.platform);

    // Recent errors (last 10)
    const recentErrors = await db
      .select({
        id: webhookEventsTable.id,
        platform: webhookEventsTable.platform,
        eventType: webhookEventsTable.eventType,
        error: webhookEventsTable.error,
        createdAt: webhookEventsTable.createdAt,
      })
      .from(webhookEventsTable)
      .where(sql`${webhookEventsTable.error} is not null`)
      .orderBy(desc(webhookEventsTable.createdAt))
      .limit(10);

    // Page connections health
    const connections = await getAllActiveConnections();
    const pageStatuses = connections.map(conn => ({
      pageId: conn.pageId,
      pageName: conn.pageName,
      userId: conn.userId,
      hasInstagram: !!conn.instagramAccountId,
      hasAds: !!conn.adAccountId,
      webhookSubscribed: conn.webhookSubscribed,
    }));

    // Overall health assessment
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const expiredCount = tokenStatuses.filter((t: any) => t.status === 'expired').length;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const expiringCount = tokenStatuses.filter((t: any) => t.status === 'expiring').length;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalErrors24h = recentWebhooks.reduce((sum: number, w: any) => sum + (w.errors || 0), 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalWebhooks24h = recentWebhooks.reduce((sum: number, w: any) => sum + (w.total || 0), 0);

    let overallStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (expiredCount > 0 || totalErrors24h > 10) overallStatus = 'critical';
    else if (expiringCount > 0 || totalErrors24h > 0) overallStatus = 'warning';

    return res.json({
      success: true,
      health: {
        overallStatus,
        tokens: {
          total: tokenStatuses.length,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          valid: tokenStatuses.filter((t: any) => t.status === 'valid').length,
          expiring: expiringCount,
          expired: expiredCount,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          unknown: tokenStatuses.filter((t: any) => t.status === 'unknown').length,
          details: tokenStatuses,
        },
        webhooks: {
          last24h: recentWebhooks,
          totalEvents: totalWebhooks24h,
          totalErrors: totalErrors24h,
        },
        recentErrors,
        pages: pageStatuses,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminMeta] Error getting health status');
    return res.status(500).json({ error: 'Unable to retrieve health status.' });
  }
}

/**
 * GET /api/admin/meta/webhook-logs
 * Returns paginated webhook event logs with optional filtering
 * Query params: platform, page, limit, eventType, status (processed|error|all)
 */
export async function getWebhookLogs(req: Request, res: Response) {
  try {
    const platform = req.query.platform as string | undefined;
    const eventType = req.query.eventType as string | undefined;
    const status = req.query.status as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = (page - 1) * limit;

    const conditions = [];
    if (platform) conditions.push(eq(webhookEventsTable.platform, platform));
    if (eventType) conditions.push(eq(webhookEventsTable.eventType, eventType));
    if (status === 'processed') conditions.push(eq(webhookEventsTable.processed, true));
    if (status === 'error') conditions.push(sql`${webhookEventsTable.error} is not null`);

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [events, countResult] = await Promise.all([
      db
        .select({
          id: webhookEventsTable.id,
          platform: webhookEventsTable.platform,
          eventType: webhookEventsTable.eventType,
          pageId: webhookEventsTable.pageId,
          userId: webhookEventsTable.userId,
          payload: webhookEventsTable.payload,
          signatureValid: webhookEventsTable.signatureValid,
          processed: webhookEventsTable.processed,
          error: webhookEventsTable.error,
          createdAt: webhookEventsTable.createdAt,
        })
        .from(webhookEventsTable)
        .where(whereClause)
        .orderBy(desc(webhookEventsTable.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(webhookEventsTable)
        .where(whereClause),
    ]);

    const total = countResult[0]?.count || 0;

    // Get distinct platforms for filter dropdown
    const platforms = await db
      .selectDistinct({ platform: webhookEventsTable.platform })
      .from(webhookEventsTable)
      .orderBy(webhookEventsTable.platform);

    // Get distinct event types for filter dropdown
    const eventTypes = await db
      .selectDistinct({ eventType: webhookEventsTable.eventType })
      .from(webhookEventsTable)
      .where(sql`${webhookEventsTable.eventType} is not null`)
      .orderBy(webhookEventsTable.eventType);

    return res.json({
      success: true,
      events,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      filters: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        platforms: platforms.map((p: any) => p.platform),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        eventTypes: eventTypes.map((e: any) => e.eventType),
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[AdminMeta] Error getting webhook logs');
    return res.status(500).json({ error: 'Unable to retrieve webhook logs.' });
  }
}
