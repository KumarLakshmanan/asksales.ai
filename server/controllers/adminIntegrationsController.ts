/**
 * Admin Integrations Controller
 * Handles system-wide integration management for admin panel
 */

import { Router, Request, Response } from 'express';
import { SystemIntegrationModel } from '../models/systemIntegrations/functions';
import { db } from '../models/db';
import { channelCredentialsTable } from '../models/channelCredentials/schema';
import { systemIntegrationsTable } from '../models/systemIntegrations/schema';
import { eq, count } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { getActiveAdminCredential } from '../models/adminApiCredentials/functions.js';

const router = Router();

/**
 * Get all system integrations
 * GET /api/admin/integrations
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const integrations = await SystemIntegrationModel.findAll();
    
    // If no integrations exist, seed defaults
    if (integrations.length === 0) {
      await SystemIntegrationModel.seedDefaults();
      const seededIntegrations = await SystemIntegrationModel.findAll();
      return res.json({ integrations: seededIntegrations });
    }

    res.json({ integrations });
  } catch (error) {
    logger.error({ err: error }, '[AdminIntegrations] Error fetching integrations');
    res.status(500).json({ message: 'Unable to retrieve integrations. Please try again.' });
  }
});

/**
 * Get integration stats
 * GET /api/admin/integrations/stats
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const stats = await SystemIntegrationModel.getStats();
    
    // Get user adoption stats (how many users have connected each integration)
    const userAdoptionQuery = await db
      .select({
        platform: channelCredentialsTable.platform,
        userCount: count(channelCredentialsTable.userId),
      })
      .from(channelCredentialsTable)
      .where(eq(channelCredentialsTable.isActive, true))
      .groupBy(channelCredentialsTable.platform);

    const userAdoption: Record<string, number> = {};
    for (const row of userAdoptionQuery) {
      userAdoption[row.platform] = Number(row.userCount);
    }

    res.json({
      ...stats,
      userAdoption,
    });
  } catch (error) {
    logger.error({ err: error }, '[AdminIntegrations] Error fetching stats');
    res.status(500).json({ message: 'Unable to retrieve integration statistics. Please try again.' });
  }
});

/**
 * Get single integration by ID
 * GET /api/admin/integrations/:id
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const integration = await SystemIntegrationModel.findById(parseInt(id));

    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    // Get user count for this integration
    const platformMap: Record<string, string> = {
      'instagram_official': 'instagram_api',
      'email_gmail': 'gmail',
      'email_smtp': 'smtp',
    };

    const platform = platformMap[integration.integrationId] || integration.integrationId;
    
    const [userCountResult] = await db
      .select({ count: count() })
      .from(channelCredentialsTable)
      .where(eq(channelCredentialsTable.platform, platform));

    res.json({
      integration,
      userCount: Number(userCountResult?.count || 0),
    });
  } catch (error) {
    logger.error({ err: error }, '[AdminIntegrations] Error fetching integration');
    res.status(500).json({ message: 'Unable to retrieve the integration details. Please try again.' });
  }
});

/**
 * Toggle integration enabled status
 * POST /api/admin/integrations/:id/toggle
 */
router.post('/:id/toggle', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const integration = await SystemIntegrationModel.toggleEnabled(parseInt(id));

    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    res.json({
      message: `Integration ${integration.isEnabled ? 'enabled' : 'disabled'} successfully`,
      integration,
    });
  } catch (error) {
    logger.error({ err: error }, '[AdminIntegrations] Error toggling integration');
    res.status(500).json({ message: 'Unable to toggle the integration status. Please try again.' });
  }
});

/**
 * Update integration status
 * PUT /api/admin/integrations/:id/status
 */
router.put('/:id/status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['available', 'beta', 'coming_soon', 'maintenance', 'disabled'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const integration = await SystemIntegrationModel.updateStatus(
      parseInt(id),
      status as 'available' | 'beta' | 'coming_soon' | 'maintenance' | 'disabled'
    );

    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    res.json({
      message: 'Integration status updated successfully',
      integration,
    });
  } catch (error) {
    logger.error({ err: error }, '[AdminIntegrations] Error updating status');
    res.status(500).json({ message: 'Unable to update the integration status. Please try again.' });
  }
});

/**
 * Update integration configuration
 * PUT /api/admin/integrations/:id
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const allowedFields = ['isEnabled', 'status', 'description', 'automationSettings', 'metadata', 'lastTestedAt'];
    const updateData: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    }

    const integration = await SystemIntegrationModel.update(parseInt(id), updateData);

    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    res.json({
      message: 'Integration updated successfully',
      integration,
    });
  } catch (error) {
    logger.error({ err: error }, '[AdminIntegrations] Error updating integration');
    res.status(500).json({ message: 'Unable to update the integration. Please try again.' });
  }
});

/**
 * Get users with specific integration connected
 * GET /api/admin/integrations/:integrationId/users
 */
router.get('/:integrationId/users', async (req: Request, res: Response) => {
  try {
    const { integrationId } = req.params;
    const { page = '1', limit = '10' } = req.query;

    // Map integration IDs to platform names in credentials table
    const platformMap: Record<string, string> = {
      'instagram_official': 'instagram_api',
      'email_gmail': 'gmail',
      'email_smtp': 'smtp',
    };

    const platform = platformMap[integrationId] || integrationId;
    const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

    // Get users with this integration
    const credentials = await db
      .select()
      .from(channelCredentialsTable)
      .where(eq(channelCredentialsTable.platform, platform))
      .limit(parseInt(limit as string))
      .offset(offset);

    // Get total count
    const [countResult] = await db
      .select({ count: count() })
      .from(channelCredentialsTable)
      .where(eq(channelCredentialsTable.platform, platform));

    res.json({
      credentials: credentials.map((c: typeof credentials[number]) => ({
        id: c.id,
        userId: c.userId,
        accountName: c.accountName,
        accountIdentifier: c.accountIdentifier,
        isActive: c.isActive,
        lastUsedAt: c.lastUsedAt,
        createdAt: c.createdAt,
      })),
      total: Number(countResult?.count || 0),
      page: parseInt(page as string),
      limit: parseInt(limit as string),
    });
  } catch (error) {
    logger.error({ err: error }, '[AdminIntegrations] Error fetching integration users');
    res.status(500).json({ message: 'Unable to retrieve users for this integration. Please try again.' });
  }
});

/**
 * Seed default integrations
 * POST /api/admin/integrations/seed
 */
router.post('/seed', async (req: Request, res: Response) => {
  try {
    // Force reseed by deleting all existing integrations
    const { force } = req.body;
    
    if (force) {
      // Delete all existing integrations
      await db.delete(systemIntegrationsTable);
    }

    await SystemIntegrationModel.seedDefaults();
    const integrations = await SystemIntegrationModel.findAll();

    res.json({
      message: 'Default integrations seeded successfully',
      integrations,
    });
  } catch (error) {
    logger.error({ err: error }, '[AdminIntegrations] Error seeding integrations');
    res.status(500).json({ message: 'Unable to seed default integrations. Please try again.' });
  }
});

/**
 * Test integration connection
 * POST /api/admin/integrations/:id/test
 */
router.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const integration = await SystemIntegrationModel.findById(parseInt(id));

    if (!integration) {
      return res.status(404).json({ message: 'Integration not found' });
    }

    let testResult = {
      success: false,
      message: 'An automated health check is not available for this integration.',
    };

    switch (integration.integrationId) {
      case 'instagram_official': {
        const metaCred = await getActiveAdminCredential('meta_app');
        if (!metaCred?.apiKey || !metaCred?.apiSecret) {
          testResult = { success: false, message: 'Meta App ID or Secret not configured. Please add them in Settings → Integrations → Meta' };
        } else {
          testResult = { success: true, message: 'The active Meta application credentials are configured.' };
        }
        break;
      }

      case 'email_gmail': {
        const gmailCred = await getActiveAdminCredential('gmail_oauth');
        if (!gmailCred?.apiKey || !gmailCred?.apiSecret) {
          testResult = { success: false, message: 'Gmail OAuth credentials not configured. Please add them in Settings → Integrations → Gmail' };
        } else {
          testResult = { success: true, message: 'The active Gmail OAuth credentials are configured.' };
        }
        break;
      }
    }

    // Update last tested timestamp
    await SystemIntegrationModel.update(parseInt(id), {
      lastTestedAt: new Date(),
    });

    res.json({
      integration: integration.integrationId,
      ...testResult,
      testedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ err: error }, '[AdminIntegrations] Error testing integration');
    res.status(500).json({ message: 'Unable to test the integration connection. Please try again.' });
  }
});

export default router;
