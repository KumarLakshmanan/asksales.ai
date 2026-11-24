import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { Request, Response } from 'express';
import { emailService } from '../services/emailService';
import { logger } from '../utils/logger.js';
import { db } from '../models/db';
import { sql } from 'drizzle-orm';
import { NotificationService } from '../services/NotificationService.js';
import { admitCustomerDeliveryJob } from '../services/assistants/CustomerDeliveryJobs.js';
import { deliverySetupFailure, withCustomerDeliveryReceipt } from '../services/assistants/CustomerDeliveryGate.js';

function authenticatedUserId(req: Request, res: Response): number | undefined {
  const userId = businessOwnerUserId(req);
  if (!userId) res.status(401).json({ success: false, error: 'Unauthorized' });
  return userId;
}

/**
 * Send an email to a specific lead
 * POST /api/email-outreach/send/:leadId
 */
export async function sendEmailToLead(req: Request, res: Response) {
  try {
    const userId = authenticatedUserId(req, res);
    if (!userId) return;
    const { leadId } = req.params;
    const { subject, body, campaignId, sequenceStep } = req.body;
    const admitted = await admitCustomerDeliveryJob('send_email', { userId, channel: 'email' });

    if (!subject || !body) {
      return res.status(400).json({ success: false, error: 'Subject and body are required' });
    }

    const result = await withCustomerDeliveryReceipt(admitted.customerDeliveryAssistant!, () => emailService.sendPersonalizedEmail(
      parseInt(leadId),
      subject,
      body,
      campaignId ? parseInt(campaignId) : undefined,
      sequenceStep ? parseInt(sequenceStep) : undefined,
      userId
    ));

    if (result.success) {
      return res.json({
        success: true,
        messageId: result.messageId,
        message: 'Email sent successfully',
      });
    } else {
      if (result.code === 'ASSISTANT_SETUP_REQUIRED') return res.status(409).json(result);
      return res.status(400).json({
        success: false,
        error: result.error || 'Unable to send the email. Please try again.',
      });
    }
  } catch (error) {
    const setup = deliverySetupFailure(error);
    if (setup) return res.status(409).json(setup);
    logger.error({ err: error }, '[EmailOutreachController] Error sending email');
    return res.status(500).json({ success: false, error: 'Unable to send the email. Please try again.' });
  }
}

/**
 * Send bulk emails to multiple leads
 * POST /api/email-outreach/send-bulk
 */
export async function sendBulkEmails(req: Request, res: Response) {
  try {
    const userId = authenticatedUserId(req, res);
    if (!userId) return;
    const { leadIds, subject, body, campaignId, delayMs = 1000 } = req.body;
    const admitted = await admitCustomerDeliveryJob('send_email', { userId, channel: 'email' });

    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ success: false, error: 'leadIds array is required' });
    }

    if (!subject || !body) {
      return res.status(400).json({ success: false, error: 'Subject and body are required' });
    }

    const results = {
      sent: 0,
      failed: 0,
      errors: [] as { leadId: number; error: string }[],
    };

    for (let i = 0; i < leadIds.length; i++) {
      const leadId = leadIds[i];

      // Add delay between emails to avoid rate limiting
      if (i > 0 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const result = await withCustomerDeliveryReceipt(admitted.customerDeliveryAssistant!, () => emailService.sendPersonalizedEmail(
        leadId,
        subject,
        body,
        campaignId ? parseInt(campaignId) : undefined,
        undefined,
        userId
      ));
      if (result.code === 'ASSISTANT_SETUP_REQUIRED') return res.status(409).json({ ...result, sent: results.sent, failed: results.failed, total: leadIds.length });

      if (result.success) {
        results.sent++;
      } else {
        results.failed++;
        results.errors.push({ leadId, error: result.error || 'Unknown error' });
      }
    }

    // Save in-app notification
    if (userId && results.sent > 0) {
      NotificationService.bulkEmailsSent(userId, results.sent);
    }

    return res.json({
      success: true,
      ...results,
      message: `Sent ${results.sent} emails, ${results.failed} failed`,
    });
  } catch (error) {
    logger.error({ err: error }, '[EmailOutreachController] Error sending bulk emails');
    const setup = deliverySetupFailure(error);
    if (setup) return res.status(409).json(setup);
    return res.status(500).json({ success: false, error: 'Unable to send the emails. Please try again.' });
  }
}

/**
 * Check for and process email replies
 * POST /api/email-outreach/check-replies
 */
export async function checkReplies(req: Request, res: Response) {
  try {
    const userId = authenticatedUserId(req, res);
    if (!userId) return;

    const { requestGmailMailboxSync } = await import('../services/GmailMailboxSyncService.js');
    const queuedCount = await requestGmailMailboxSync(userId);

    return res.json({
      success: true,
      queuedCount,
      message: 'Email refresh queued. New replies use the verified mailbox processing pipeline.',
    });
  } catch (error) {
    logger.error({ err: error }, '[EmailOutreachController] Error checking replies');
    return res.status(500).json({ success: false, error: 'Unable to check replies. Please try again.' });
  }
}

/**
 * Verify email service connection
 * GET /api/email-outreach/verify
 */
export async function verifyEmailConnection(req: Request, res: Response) {
  try {
    const userId = authenticatedUserId(req, res);
    if (!userId) return;
    const configured = await db.execute(sql`SELECT id FROM email_senders WHERE user_id=${userId} AND is_verified LIMIT 1`);
    const verified = configured.rows.length === 1;

    return res.json({
      success: verified,
      message: verified ? 'Email service connected' : 'Email service not configured',
    });
  } catch (error) {
    logger.error({ err: error }, '[EmailOutreachController] Error verifying connection');
    return res.status(500).json({ success: false, error: 'Unable to verify the email connection.' });
  }
}

/**
 * Get email history for a lead
 * GET /api/email-outreach/history/:leadId
 */
export async function getEmailHistory(req: Request, res: Response) {
  try {
    const userId = authenticatedUserId(req, res);
    if (!userId) return;

    const { leadId } = req.params;
    const parsedLeadId = Number(leadId);
    if (!Number.isInteger(parsedLeadId) || parsedLeadId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid lead ID' });
    }

    const history = await db.execute(sql`
      SELECT id, channel, message, status, sent_at, message_id, is_reply, campaign_id, sequence_step
      FROM sent_messages
      WHERE lead_id = ${parsedLeadId}
        AND user_id = ${userId}
        AND channel IN ('email', 'gmail')
      ORDER BY sent_at DESC
      LIMIT 50
    `);

    return res.json({
      success: true,
      history: history.rows,
    });
  } catch (error) {
    logger.error({ err: error }, '[EmailOutreachController] Error getting email history');
    return res.status(500).json({ success: false, error: 'Unable to load email history.' });
  }
}

/**
 * Get email templates
 * GET /api/email-outreach/templates
 */
export async function getEmailTemplates(req: Request, res: Response) {
  try {
    const userId = authenticatedUserId(req, res);
    if (!userId) return;

    // Get templates from content_templates table
    const templates = await db.execute(sql`
      SELECT id, name, subject, content, category, created_at
      FROM content_templates
      WHERE (user_id = ${userId} OR is_predefined = true)
        AND (category = 'email' OR category IS NULL)
      ORDER BY created_at DESC
    `);

    return res.json({
      success: true,
      templates: templates.rows,
    });
  } catch (error) {
    logger.error({ err: error }, '[EmailOutreachController] Error getting templates');
    return res.status(500).json({ success: false, error: 'Unable to load email templates.' });
  }
}

/**
 * Save an email template
 * POST /api/email-outreach/templates
 */
export async function saveEmailTemplate(req: Request, res: Response) {
  try {
    const userId = authenticatedUserId(req, res);
    if (!userId) return;
    const { name, subject, content } = req.body;

    if (!name || !subject || !content) {
      return res.status(400).json({ success: false, error: 'Name, subject, and content are required' });
    }

    const result = await db.execute(sql`
      INSERT INTO content_templates (user_id, name, type, subject, content, category, created_at, updated_at)
      VALUES (${userId}, ${name}, 'email', ${subject}, ${content}, 'email', NOW(), NOW())
      RETURNING id, name, subject, content, category, created_at
    `);

    return res.json({
      success: true,
      template: result.rows[0],
    });
  } catch (error) {
    logger.error({ err: error }, '[EmailOutreachController] Error saving template');
    return res.status(500).json({ success: false, error: 'Unable to save the email template.' });
  }
}

/**
 * Get email outreach statistics
 * GET /api/email-outreach/stats
 */
export async function getEmailStats(req: Request, res: Response) {
  try {
    const userId = authenticatedUserId(req, res);
    if (!userId) return;

    // Get overall stats
    const stats = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'sent' AND channel = 'email') as sent,
        COUNT(*) FILTER (WHERE status = 'delivered' AND channel = 'email') as delivered,
        COUNT(*) FILTER (WHERE status = 'opened' AND channel = 'email') as opened,
        COUNT(*) FILTER (WHERE status = 'clicked' AND channel = 'email') as clicked,
        COUNT(*) FILTER (WHERE is_reply = true AND channel = 'email') as replies,
        COUNT(*) FILTER (WHERE status = 'bounced' AND channel = 'email') as bounced
      FROM sent_messages
      WHERE user_id = ${userId}
    `);

    // Get recent activity
    const recentActivity = await db.execute(sql`
      SELECT DATE(sent_at) as date, COUNT(*) as count, status
      FROM sent_messages
      WHERE user_id = ${userId}
        AND channel = 'email'
        AND sent_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(sent_at), status
      ORDER BY date DESC
    `);

    return res.json({
      success: true,
      stats: stats.rows[0],
      recentActivity: recentActivity.rows,
    });
  } catch (error) {
    logger.error({ err: error }, '[EmailOutreachController] Error getting stats');
    return res.status(500).json({ success: false, error: 'Unable to load email statistics.' });
  }
}
