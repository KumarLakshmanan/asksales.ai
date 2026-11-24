import { currentBusinessScope } from '../tenancy/businessContext.js';
import { hasBusinessManagerAuthority } from '../middleware/businessPermissions.js';
import { getUserById as getWebhookOwner } from '../models/users/functions.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
/**
 * Twitter/X OAuth Controller
 * Handles status endpoint for Twitter/X API integration
 */

import { Router, type Request, type Response } from 'express';
import { readOfficialOAuthStatus } from '../services/OfficialOAuthStatusService.js';
import { logger } from '../utils/logger.js';
import { webhookCapabilityConfig } from '../utils/userWebhookTokens.js';
import { getRequestAppUrl as getAppUrl } from '../utils/requestAppUrl.js';

const router = Router();

/**
 * GET /api/twitter/oauth/status
 * Returns Twitter/X connection status and webhook configuration
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    const user = userId ? await getWebhookOwner(userId) : undefined;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const status = await readOfficialOAuthStatus(userId, 'twitter_api');

    const appUrl = getAppUrl(req);
    const webhook = hasBusinessManagerAuthority(req) && currentBusinessScope() ? webhookCapabilityConfig(userId, user?.webhookTokenNonce, 'twitter') : undefined;

    res.json({
      success: true,
      officialApi: {
        connected: status.connected,
        username: status.username,
        accountId: status.accountIdentifier,
        tokenExpired: status.tokenExpired,
        expiresAt: status.expiresAt,
      },
      ...(webhook ? { webhookUrl: `${appUrl}/api/webhooks/twitter/${webhook.token}`,
        webhookVerifyToken: webhook.verifyToken, webhookExpiresAt: webhook.expiresAt } : {}),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[TwitterOAuth] Status check error');
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

export default router;
