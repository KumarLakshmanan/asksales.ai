import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { businessCacheKey } from '../tenancy/businessContext.js';
/**
 * Instagram Outreach Controller
 * Handles Instagram DM outreach operations
 */

import { Request, Response } from 'express';
import { db } from '../models/db';
import { sql, eq } from 'drizzle-orm';
import { channelCredentialsTable } from '../models/channelCredentials/schema';
import { logger } from '../utils/logger.js';
import { LeadModel } from '../models/leads/functions.js';
import { creditService } from '../services/CreditService.js';
import { idempotencyService } from '../services/IdempotencyService.js';
import { getInstagramApiForUser } from '../services/instagramGraphApiService.js';
import { resolveInstagramAccountContext } from '../services/instagramAccountSelectionService.js';

import crypto from 'crypto';

function normalizeInstagramHandle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .trim()
    .replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '')
    .split(/[/?#]/, 1)[0]
    .replace(/^@+/, '');
  return /^[A-Za-z0-9._]{1,30}$/.test(normalized) ? normalized : null;
}

function personalizeInstagramMessage(template: string, lead: Awaited<ReturnType<typeof LeadModel.findByIdForUser>>): string {
  if (!lead) return template;
  const fullName = lead.fullName || lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' ');
  return template
    .replace(/\{\{first_name\}\}/g, lead.firstName || fullName?.split(' ')[0] || 'there')
    .replace(/\{\{last_name\}\}/g, lead.lastName || fullName?.split(' ').slice(1).join(' ') || '')
    .replace(/\{\{full_name\}\}/g, fullName || 'there')
    .replace(/\{\{company\}\}/g, lead.company || lead.companyName || '')
    .replace(/\{\{role\}\}/g, lead.role || '');
}

/**
 * Initialize Instagram service with credentials
 * @deprecated Removed — Use Instagram OAuth (Graph API) connect button instead.
 */
export const initializeInstagram = async (req: Request, res: Response) => {
  return res.status(410).json({
    success: false,
    error: 'Manual Instagram credential setup has been removed. Please use the "Connect Instagram" button to connect via OAuth.',
  });
};

/**
 * Send direct message to a single user
 * Route through instagramMessageRouter so daily limits and official account routing
 * are enforced consistently with bulk and queued sends.
 */
export const sendDirectMessage = async (req: Request, res: Response) => {
  let claimedKey: string | null = null;
  try {
    const { message, leadId, idempotencyKey: bodyIdempotencyKey } = req.body || {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const parsedLeadId = Number(leadId);
    if (!Number.isInteger(parsedLeadId) || parsedLeadId <= 0) {
      return res.status(400).json({
        success: false,
        error: 'A valid leadId is required.',
      });
    }
    if (typeof message !== 'string' || !message.trim() || message.length > 10_000) {
      return res.status(400).json({ success: false, error: 'Message must be between 1 and 10,000 characters.' });
    }

    const lead = await LeadModel.findByIdForUser(parsedLeadId, userId);
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found.' });
    if (lead.blacklisted || lead.doNotContact) {
      return res.status(409).json({ success: false, error: 'This lead is blocked from outreach.' });
    }
    const username = normalizeInstagramHandle(lead.instagramHandle || lead.instagram);
    if (!username) {
      return res.status(400).json({ success: false, error: 'This lead does not have a valid Instagram handle.' });
    }

    const requestedKey = (typeof req.get === 'function' ? req.get('idempotency-key') : undefined) || bodyIdempotencyKey;
    if (requestedKey && (typeof requestedKey !== 'string' || requestedKey.length < 8 || requestedKey.length > 200)) {
      return res.status(400).json({ success: false, error: 'Idempotency key must be between 8 and 200 characters.' });
    }
    if (requestedKey) {
      const keyHash = crypto.createHash('sha256').update(`${userId}:${requestedKey}`).digest('hex');
      claimedKey = businessCacheKey(`instagram-direct:${userId}:${keyHash}`);
      const claim = await idempotencyService.checkAndStore(claimedKey);
      if (claim.status === 'duplicate') {
        if (claim.previousResponse) return res.json(JSON.parse(claim.previousResponse));
        return res.status(202).json({ success: true, inProgress: true, message: 'This send is already in progress.' });
      }
    }

    const referenceId = claimedKey || businessCacheKey(`instagram-direct:${userId}:${crypto.randomUUID()}`);
    const reservation = await creditService.reserveOutreachCredit({
      userId,
      channel: 'instagram',
      referenceId,
      service: 'InstagramController',
    });
    if (!reservation.success) {
      const body = { success: false, error: reservation.error || 'Insufficient credits.', code: 'INSUFFICIENT_CREDITS' };
      if (claimedKey) await idempotencyService.storeResponse(claimedKey, JSON.stringify(body));
      return res.status(402).json(body);
    }

    const { routeInstagramMessage } = await import('../services/instagramMessageRouter.js');
    const result = await routeInstagramMessage({
      userId,
      leadId: parsedLeadId,
      recipientUsername: username,
      providerAccountId: typeof req.body.providerAccountId === 'string' ? req.body.providerAccountId : undefined,
      message: message.trim(),
      skipCreditDeduction: true,
    });

    if (!result.success && reservation.transactionId) {
      await creditService.refundDeduction({
        userId,
        transactionId: reservation.transactionId,
        description: `Refund for failed Instagram message to lead ${parsedLeadId}`,
      });
    } else if (result.success) {
      try {
        await db.execute(sql`
          INSERT INTO sent_messages (lead_id, lead_name, channel, message, status, sent_at, user_id)
          VALUES (${parsedLeadId}, ${username}, 'instagram', ${message.trim()}, 'sent', NOW(), ${userId})
        `);

        await db.execute(sql`
          UPDATE leads SET
            last_contacted_at = NOW(),
            messages_sent = COALESCE(messages_sent, 0) + 1,
            updated_at = NOW()
          WHERE id = ${parsedLeadId} AND user_id = ${userId}
        `);
      } catch (dbError) {
        logger.error({ err: dbError }, '[InstagramController] Failed to log message');
      }
    }

    if (claimedKey) await idempotencyService.storeResponse(claimedKey, JSON.stringify(result));
    return res.status(result.success ? 200 : 422).json(result);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (claimedKey) await idempotencyService.forget(claimedKey);
    logger.error({ err: error }, '[InstagramController] Send DM error');
    return res.status(500).json({
      success: false,
      error: 'Unable to send the direct message. Please try again.',
    });
  }
};

/**
 * Send direct messages to multiple leads
 */
export const sendBulkDirectMessages = async (req: Request, res: Response) => {
  let claimedKey: string | null = null;
  try {
    const { leads, message, personalize = true, idempotencyKey: bodyIdempotencyKey } = req.body || {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    if (!Array.isArray(leads) || leads.length === 0 || leads.length > 50) {
      return res.status(400).json({
        success: false,
        error: 'Select between 1 and 50 leads.',
      });
    }

    if (typeof message !== 'string' || !message.trim() || message.length > 10_000) {
      return res.status(400).json({
        success: false,
        error: 'Message template must be between 1 and 10,000 characters.',
      });
    }

    const requestedKey = (typeof req.get === 'function' ? req.get('idempotency-key') : undefined) || bodyIdempotencyKey;
    if (requestedKey && (typeof requestedKey !== 'string' || requestedKey.length < 8 || requestedKey.length > 200)) {
      return res.status(400).json({ success: false, error: 'Idempotency key must be between 8 and 200 characters.' });
    }
    if (requestedKey) {
      const keyHash = crypto.createHash('sha256').update(`${userId}:${requestedKey}`).digest('hex');
      claimedKey = businessCacheKey(`instagram-bulk:${userId}:${keyHash}`);
      const claim = await idempotencyService.checkAndStore(claimedKey);
      if (claim.status === 'duplicate') {
        if (claim.previousResponse) return res.json(JSON.parse(claim.previousResponse));
        return res.status(202).json({ success: true, inProgress: true, message: 'This bulk send is already in progress.' });
      }
    }

    const leadIds = [...new Set(leads.map((item: unknown) => Number((item as { id?: unknown })?.id)))];
    if (leadIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      if (claimedKey) await idempotencyService.forget(claimedKey);
      return res.status(400).json({ success: false, error: 'Every selected lead must have a valid ID.' });
    }

    const { routeInstagramMessage } = await import('../services/instagramMessageRouter.js');
    const results: Array<{ username: string; success: boolean; error?: string; code?: string }> = [];
    for (const leadId of leadIds) {
      const lead = await LeadModel.findByIdForUser(leadId, userId);
      const username = normalizeInstagramHandle(lead?.instagramHandle || lead?.instagram) || `lead-${leadId}`;
      if (!lead) {
        results.push({ username, success: false, error: 'Lead not found or unavailable.' });
        continue;
      }
      if (lead.blacklisted || lead.doNotContact) {
        results.push({ username, success: false, error: 'Lead is blocked from outreach.' });
        continue;
      }
      const validUsername = normalizeInstagramHandle(lead.instagramHandle || lead.instagram);
      if (!validUsername) {
        results.push({ username, success: false, error: 'Lead does not have a valid Instagram handle.' });
        continue;
      }
      const personalizedMessage = personalize ? personalizeInstagramMessage(message.trim(), lead) : message.trim();
      const reservation = await creditService.reserveOutreachCredit({
        userId,
        channel: 'instagram',
        referenceId: `${claimedKey || crypto.randomUUID()}:${leadId}`,
        service: 'InstagramBulkController',
      });
      if (!reservation.success) {
        results.push({
          username: validUsername,
          success: false,
          error: reservation.error || 'Insufficient credits.',
          code: 'INSUFFICIENT_CREDITS',
        });
        continue;
      }

      const result = await routeInstagramMessage({
        userId,
        leadId,
        recipientUsername: validUsername,
        providerAccountId: typeof req.body.providerAccountId === 'string' ? req.body.providerAccountId : undefined,
        message: personalizedMessage,
        skipCreditDeduction: true,
      });
      if (!result.success && reservation.transactionId) {
        await creditService.refundDeduction({
          userId,
          transactionId: reservation.transactionId,
          description: `Refund for failed bulk Instagram message to lead ${leadId}`,
        });
      }
      results.push({ username: validUsername, success: result.success, error: result.error });

      if (result.success) {
        try {
          await db.execute(sql`
            INSERT INTO sent_messages (lead_id, lead_name, channel, message, status, sent_at, user_id)
            VALUES (${leadId}, ${validUsername}, 'instagram', ${personalizedMessage}, 'sent', NOW(), ${userId})
          `);
          await db.execute(sql`
            UPDATE leads SET
              last_contacted_at = NOW(),
              messages_sent = COALESCE(messages_sent, 0) + 1,
              updated_at = NOW()
            WHERE id = ${leadId} AND user_id = ${userId}
          `);
        } catch (dbError) {
          logger.error({ err: dbError, userId, leadId }, '[InstagramController] Failed to log bulk message');
        }
      }
    }

    const successCount = results.filter((result) => result.success).length;
    const responseBody = {
      success: true,
      results,
      summary: {
        total: results.length,
        sent: successCount,
        failed: results.length - successCount,
      },
    };
    if (claimedKey) await idempotencyService.storeResponse(claimedKey, JSON.stringify(responseBody));
    return res.json(responseBody);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (claimedKey) await idempotencyService.forget(claimedKey);
    logger.error({ err: error }, '[InstagramController] Bulk DM error');
    return res.status(500).json({
      success: false,
      error: 'Unable to send bulk messages. Please try again.',
    });
  }
};

/** Legacy browser-only read endpoints are unavailable. */
export const getUserInfo = async (_req: Request, res: Response) =>
  res.status(410).json({ success: false, error: 'Use the Instagram Graph API instead.' });

export const getDirectThreads = async (_req: Request, res: Response) =>
  res.status(410).json({ success: false, error: 'Use the Instagram Graph API conversations endpoint instead.' });

export const getFollowers = async (_req: Request, res: Response) =>
  res.status(410).json({ success: false, error: 'Instagram follower lists are unavailable through this integration.' });

/** Check only the official Instagram connection. */
export const checkCredentialsStatus = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const officialApi = await getInstagramApiForUser(userId);
    const officialAccount = officialApi?.getCredentialsInfo();
    return res.json({
      success: true,
      connected: Boolean(officialApi),
      configured: Boolean(officialApi),
      username: officialAccount?.username || null,
    });
  } catch (error) {
    logger.error({ err: error }, '[InstagramController] Status check error');
    return res.status(500).json({ success: false, error: 'Unable to check Instagram connection.' });
  }
};

/**
 * Get Instagram Integration Settings
 */
export const getInstagramSettings = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const apiContext = await resolveInstagramAccountContext(userId);
    const result = apiContext ? [apiContext.credential] : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionData = result[0]?.sessionData as any || {};

    res.json({
      success: true,
      settings: {
        welcomeMessagesEnabled: sessionData.welcomeMessagesEnabled || false,
        dailyOutreachLimit: sessionData.dailyOutreachLimit || 20,
      }
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[InstagramController] Get settings error');
    res.status(500).json({ success: false, error: 'Unable to load Instagram settings. Please try again.' });
  }
};

/**
 * Update Instagram Integration Settings
 */
export const updateInstagramSettings = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { welcomeMessagesEnabled, dailyOutreachLimit } = req.body;
    if (welcomeMessagesEnabled !== undefined && typeof welcomeMessagesEnabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'welcomeMessagesEnabled must be a boolean' });
    }
    if (dailyOutreachLimit !== undefined && (!Number.isInteger(dailyOutreachLimit) || dailyOutreachLimit < 0 || dailyOutreachLimit > 50)) {
      return res.status(400).json({ success: false, error: 'dailyOutreachLimit must be an integer from 0 to 50' });
    }

    const apiContext = await resolveInstagramAccountContext(userId);
    const existing = apiContext ? [apiContext.credential] : [];

    if (existing.length === 0) {
      // Must have credentials first
      return res.status(400).json({
        success: false,
        error: 'Connect Instagram through Meta OAuth before changing settings.'
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentSessionData = existing[0].sessionData as any || {};
    const updatedSessionData = {
      ...currentSessionData,
      welcomeMessagesEnabled: typeof welcomeMessagesEnabled === 'boolean' ? welcomeMessagesEnabled : currentSessionData.welcomeMessagesEnabled,
      dailyOutreachLimit: Number.isInteger(dailyOutreachLimit) ? dailyOutreachLimit : currentSessionData.dailyOutreachLimit,
    };

    await db.update(channelCredentialsTable)
      .set({
        sessionData: updatedSessionData,
        updatedAt: new Date()
      })
      .where(eq(channelCredentialsTable.id, existing[0].id));

    res.json({
      success: true,
      settings: {
        welcomeMessagesEnabled: updatedSessionData.welcomeMessagesEnabled,
        dailyOutreachLimit: updatedSessionData.dailyOutreachLimit,
      }
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[InstagramController] Update settings error');
    res.status(500).json({ success: false, error: 'Unable to save Instagram settings. Please try again.' });
  }
};
