/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Webhooks Controller
 * Manages user-specific webhook URLs and generic user, lead, automation and SMS
 * webhooks. Platform handlers live in ./webhooks/ and are re-exported here so
 * routes and existing dynamic importers keep one entry point.
 */
import { authorizeBusinessManager } from '../middleware/businessPermissions.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { AuthenticatedRequest } from '../types/express.js';
import { Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../models/db';
import { eq, and } from 'drizzle-orm';
import { leadsTable } from '../models/leads/schema';
import { usersTable } from '../models/users/schema';
import { channelCredentialsTable } from '../models/channelCredentials/schema';
import { logger } from '../utils/logger.js';
import { logWebhookEvent } from '../utils/webhookLogger.js';
import { sanitizedWebhookPreview } from '../utils/webhookPayloadSanitizer.js';
import { webhookCapabilityConfig } from '../utils/userWebhookTokens.js';
import { InboundSMSProcessingError, processInboundSMS } from '../services/smsService.js';
import { MSG91DeliveryError, processMSG91DeliveryReports } from '../services/MSG91DeliveryService.js';
import { getAppUrl, findUserIdFromToken, verifyUserToken } from './webhooks/shared.js';

export { handleInstagramWebhook, handleFacebookWebhook } from './webhooks/meta.js';
export { handleWhatsAppWebhook, processWhatsAppStatus } from './webhooks/whatsapp.js';
export { saveWebhookToConversation, triggerAutoReply } from './webhooks/conversation.js';
export { sendInstagramCommentReply, sendFacebookCommentReply, type PublicCommentDeliveryResult } from './webhooks/socialReplies.js';
export { handleTwitterWebhook, handleLinkedInWebhook } from './webhooks/socialNetworks.js';

/**
 * Get user's webhook configuration
 */
export const getUserWebhooks = async (req: AuthenticatedRequest, res: Response) => {
  if (!authorizeBusinessManager(req, res)) return;
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const [owner] = await db.select({nonce:usersTable.webhookTokenNonce}).from(usersTable).where(eq(usersTable.id,userId)).limit(1);
    const nonce = owner?.nonce;
    const capabilities = Object.fromEntries((['user', 'whatsapp', 'sms', 'sms_delivery', 'twitter', 'linkedin', 'email', 'leads', 'automation'] as const)
      .map(purpose => [purpose, webhookCapabilityConfig(userId, nonce, purpose)]));
    const appUrl = getAppUrl(req);

    // Generate user-specific webhook URLs
    const webhooks = {
      // General purpose webhook URL
      general: {
        expiresAt: capabilities.user.expiresAt,
        url: `${appUrl}/api/webhooks/user/${capabilities.user.token}`,
        verifyToken: capabilities.user.verifyToken,
        description: "General purpose webhook for custom integrations",
      },
      // Instagram webhook
      instagram: {
        url: `${appUrl}/api/webhooks/instagram`,
        managed: true,
        description: "AskSales-managed Instagram messaging and events webhook",
        events: ["messages", "message_echoes", "messaging_postbacks", "message_deliveries", "message_reads", "comments", "follows"],
      },
      // Facebook/Meta webhook
      facebook: {
        url: `${appUrl}/api/webhooks/facebook`,
        managed: true,
        description: "AskSales-managed Facebook Messenger webhook",
        events: ["messages", "message_echoes", "messaging_postbacks", "messaging_optins", "comments", "feed"],
      },
      // WhatsApp webhook
      whatsapp: {
        expiresAt: capabilities.whatsapp.expiresAt,
        url: `${appUrl}/api/webhooks/whatsapp/${capabilities.whatsapp.token}`,
        verifyToken: capabilities.whatsapp.verifyToken,
        description: "WhatsApp Business API webhook",
        events: ["messages", "smb_message_echoes", "status", "contacts"],
      },
      // MSG91 inbound SMS/longcode callback. MSG91 callbacks can be configured
      // to emit this canonical JSON shape; the URL token binds it to one tenant.
      sms: {
        expiresAt: capabilities.sms.expiresAt,
        url: `${appUrl}/api/webhooks/sms/${capabilities.sms.token}`,
        deliveryUrl: `${appUrl}/api/webhooks/sms/${capabilities.sms_delivery.token}/delivery`,
        method: "POST",
        description: "MSG91 inbound SMS callback",
        requiredFields: ["sender", "message", "requestId"],
        optionalFields: ["receivedAt", "providerAccountId"],
      },
      // Twitter/X webhook
      twitter: {
        expiresAt: capabilities.twitter.expiresAt,
        url: `${appUrl}/api/webhooks/twitter/${capabilities.twitter.token}`,
        verifyToken: capabilities.twitter.verifyToken,
        description: "Twitter/X Account Activity API webhook",
        events: ["tweet_create_events", "direct_message_events", "follow_events", "favorite_events"],
      },
      // LinkedIn webhook
      linkedin: {
        expiresAt: capabilities.linkedin.expiresAt,
        url: `${appUrl}/api/webhooks/linkedin/${capabilities.linkedin.token}`,
        verifyToken: capabilities.linkedin.verifyToken,
        description: "LinkedIn events webhook",
        events: ["messages", "connections", "shares", "comments"],
      },
      // Email events webhook
      email: {
        expiresAt: capabilities.email.expiresAt,
        url: `${appUrl}/api/webhooks/email/${capabilities.email.token}`,
        verifyToken: capabilities.email.verifyToken,
        description: "Email delivery and engagement events webhook",
        events: ["delivery", "bounce", "complaint", "open", "click"],
      },
      // Lead capture webhook
      leads: {
        expiresAt: capabilities.leads.expiresAt,
        url: `${appUrl}/api/webhooks/leads/${capabilities.leads.token}`,
        verifyToken: capabilities.leads.verifyToken,
        description: "Webhook for capturing leads from external forms",
        events: ["lead_created", "lead_updated"],
      },
      // Zapier/Make integration webhook
      automation: {
        expiresAt: capabilities.automation.expiresAt,
        url: `${appUrl}/api/webhooks/automation/${capabilities.automation.token}`,
        verifyToken: capabilities.automation.verifyToken,
        description: "Integration webhook for Zapier, Make, and other automation tools",
        events: ["custom_events"],
      },
    };

    res.json({
      success: true,
      userId,
      webhooks,
    });

  } catch (error: any) {
    logger.error({ err: error }, '[WebhooksController] Error getting webhooks');
    res.status(500).json({ error: "Unable to retrieve webhooks. Please try again." });
  }
};

/**
 * Handle a tenant-bound MSG91 inbound SMS callback.
 *
 * The provider callback is acknowledged only after the durable message and CRM
 * receipt are committed. A repeated callback returns the same message binding
 * and cannot increment conversation or reply counters twice.
 */
export const handleSMSWebhook = async (req: Request, res: Response) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const userId = await findUserIdFromToken(req.params.userToken, req.params.callbackType === 'delivery' ? 'sms_delivery' : 'sms');
    if (!userId) {
      return res.status(404).json({ error: 'Invalid webhook token' });
    }
    if (req.params.callbackType === 'delivery') {
      const result = await processMSG91DeliveryReports(userId, req.body);
      // A report can beat the sender's receipt commit. Ask MSG91 to retry it.
      return res.status(result.unmatched ? 503 : 200).json({ received: result.unmatched === 0, ...result });
    }
    const result = await processInboundSMS(userId, req.body);
    if (!result.duplicate) {
      await logWebhookEvent({ platform: 'msg91', eventType: 'sms_message', userId, payload: req.body, signatureValid: true, processed: true });
    }
    return res.status(200).json({
      received: true,
      duplicate: result.duplicate,
    });
  } catch (error) {
    if (error instanceof InboundSMSProcessingError || error instanceof MSG91DeliveryError) {
      await logWebhookEvent({
        platform: 'msg91', eventType: req.params.callbackType === 'delivery' ? 'sms_delivery_rejected' : 'sms_message_rejected',
        payload: req.body, processed: false, error: error.message,
      });
      logger.warn(
        { code: error.code, status: error.status },
        '[WebhooksController] MSG91 callback rejected',
      );
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    logger.error({ err: error }, '[WebhooksController] MSG91 callback failed');
    return res.status(500).json({ error: 'Unable to process the SMS webhook. Please try again.' });
  }
};

/**
 * Handle general user webhook (for custom integrations)
 */
export const handleUserWebhook = async (req: Request, res: Response) => {
  try {
    const { userToken } = req.params;

    // Handle verification challenge (for Meta webhooks)
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe" && token) {
        const userId = await verifyUserToken(userToken, token as string, ['user', 'email']);
        if (userId) {
          logger.info({ userId }, '[WebhooksController] User webhook verified');
          return res.status(200).send(challenge);
        }
      }
      return res.sendStatus(403);
    }

    // Handle webhook payload
    const userId = await findUserIdFromToken(userToken, ['user', 'email']);
    if (!userId) {
      logger.info('[WebhooksController] No user found for webhook token');
      return res.status(404).json({ error: "Invalid webhook token" });
    }

    const payload = req.body;
    logger.info({ userId, payloadPreview: sanitizedWebhookPreview(payload) }, '[WebhooksController] Received webhook');

    res.status(200).json({ received: true });

  } catch (error: any) {
    logger.error({ err: error }, '[WebhooksController] Error handling webhook');
    res.status(500).json({ error: "Unable to process the webhook. Please try again." });
  }
};

/**
 * Handle lead capture webhook
 */
export const handleLeadWebhook = async (req: Request, res: Response) => {
  try {
    const { userToken } = req.params;
    const leadData = req.body;

    const userId = await findUserIdFromToken(userToken, 'leads');
    if (!userId) {
      return res.status(404).json({ error: "Invalid webhook token" });
    }

    logger.info({ userId, leadPreview: sanitizedWebhookPreview(leadData) }, '[WebhooksController] Lead webhook received');

    // Create lead in database
    if (leadData.email || leadData.name || leadData.phone) {
      await db.insert(leadsTable).values({
        userId,
        name: leadData.name || 'Unknown',
        firstName: leadData.firstName || leadData.name?.split(' ')[0],
        lastName: leadData.lastName || leadData.name?.split(' ').slice(1).join(' '),
        email: leadData.email,
        phone: leadData.phone,
        company: leadData.company,
        title: leadData.title,
        status: 'new',
        source: leadData.source || 'webhook',
        notes: leadData.notes,
      });
    }

    res.status(200).json({
      received: true,
      message: "Lead data received successfully"
    });

  } catch (error: any) {
    logger.error({ err: error }, '[WebhooksController] Error handling lead webhook');
    res.status(500).json({ error: "Unable to process the lead webhook. Please try again." });
  }
};

/**
 * Handle automation webhook (Zapier/Make)
 */
export const handleAutomationWebhook = async (req: Request, res: Response) => {
  try {
    const { userToken } = req.params;
    const payload = req.body;

    const userId = await findUserIdFromToken(userToken, 'automation');
    if (!userId) {
      return res.status(404).json({ error: "Invalid webhook token" });
    }

    logger.info({ userId, payloadPreview: sanitizedWebhookPreview(payload) }, '[WebhooksController] Automation webhook received');

    res.status(200).json({
      received: true,
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    logger.error({ err: error }, '[WebhooksController] Error handling automation webhook');
    res.status(500).json({ error: "Unable to process the automation webhook. Please try again." });
  }
};

/**
 * Regenerate user webhook tokens (for security purposes)
 */
export const regenerateWebhookTokens = async (req: AuthenticatedRequest, res: Response) => {
  if (!authorizeBusinessManager(req, res)) return;
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (req.user?.id !== userId) return res.status(403).json({code:'BUSINESS_OWNER_REQUIRED',error:'Only the account owner can rotate webhook credentials.'});
    const webhookTokenNonce = crypto.randomBytes(32).toString('hex');
    await db
      .update(usersTable)
      .set({ webhookTokenNonce, updatedAt: new Date() })
      .where(eq(usersTable.id, userId));
    await db.update(channelCredentialsTable)
      .set({ legacyWebhookTokenHash: null, updatedAt: new Date() })
      .where(and(
        eq(channelCredentialsTable.userId, userId),
        eq(channelCredentialsTable.platform, 'whatsapp'),
      ));

    res.json({
      success: true,
      message: "Webhook credentials rotated. Existing webhook URLs and verify tokens are no longer valid.",
    });

  } catch (error: any) {
    logger.error({ err: error }, '[WebhooksController] Error regenerating tokens');
    res.status(500).json({ error: "Unable to regenerate tokens. Please try again." });
  }
};
