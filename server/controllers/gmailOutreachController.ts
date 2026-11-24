import { businessOwnerUserId } from '../tenancy/businessContext.js';
/**
 * Gmail Outreach Controller
 * Handles Gmail API-based email outreach operations
 */

import { Request, Response } from 'express';
import { gmailApiService } from '../services/gmailApiService';
import { db } from '../models/db';
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { respondToGenerationFailure } from '../services/content/ContentTextGenerationError.js';
import { assertCustomerDeliveryRuntime, assertCustomerDeliveryReady, deliverySetupFailure, withCustomerDeliveryReceipt } from '../services/assistants/CustomerDeliveryGate.js';

async function gmailDeliveryAdmission(userId: number) {
  assertCustomerDeliveryRuntime('email');
  const accountId = await gmailApiService.getUserEmail(userId);
  return assertCustomerDeliveryReady({ userId, channel: 'email', accountId: accountId || '' });
}

/**
 * Get Gmail connection status
 * GET /api/gmail-outreach/status
 */
export async function getGmailStatus(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const isConnected = await gmailApiService.isConnected(userId);
    const email = isConnected ? await gmailApiService.getUserEmail(userId) : null;

    return res.json({
      success: true,
      connected: isConnected,
      email,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[GmailOutreachController] Error checking status');
    return res.status(500).json({ success: false, error: 'Unable to check the Gmail connection. Please try again.' });
  }
}

/**
 * Send an email to a specific lead via Gmail API
 * POST /api/gmail-outreach/send/:leadId
 */
export async function sendEmailToLead(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { leadId } = req.params;
    const { subject, body, campaignId, sequenceStep } = req.body;
    const assistant = await gmailDeliveryAdmission(userId);

    if (!subject || !body) {
      return res.status(400).json({ success: false, error: 'Subject and body are required' });
    }

    const result = await withCustomerDeliveryReceipt(assistant, () => gmailApiService.sendPersonalizedEmail(
      userId,
      parseInt(leadId),
      subject,
      body,
      campaignId ? parseInt(campaignId) : undefined,
      sequenceStep ? parseInt(sequenceStep) : undefined
    ));

    if (result.success) {
      return res.json({
        success: true,
        messageId: result.messageId,
        threadId: result.threadId,
        message: 'Email sent successfully via Gmail API',
      });
    } else {
      if (result.code === 'ASSISTANT_SETUP_REQUIRED') return res.status(409).json(result);
      return res.status(400).json({
        success: false,
        error: result.error || 'Unable to send the email. Please try again.',
      });
    }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[GmailOutreachController] Error sending email');
    const setup = deliverySetupFailure(error);
    if (setup) return res.status(409).json(setup);
    return res.status(500).json({ success: false, error: 'The email could not be confirmed as sent. Check the email history before sending again.' });
  }
}

/**
 * Send bulk emails to multiple leads via Gmail API
 * POST /api/gmail-outreach/send-bulk
 */
export async function sendBulkEmails(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { leadIds, subject, body, campaignId, delayMs = 2000 } = req.body;
    const assistant = await gmailDeliveryAdmission(userId);

    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ success: false, error: 'leadIds array is required' });
    }

    if (!subject || !body) {
      return res.status(400).json({ success: false, error: 'Subject and body are required' });
    }

    // Fetch lead data
    const leadsResult = await db.execute(sql`
      SELECT id, email, first_name, last_name, full_name, name, company, company_name, role, industry
      FROM leads
      WHERE id = ANY(${leadIds}::int[])
        AND email IS NOT NULL
        AND blacklisted = false
        AND (do_not_contact = false OR do_not_contact IS NULL)
    `);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const leads = leadsResult.rows.map((row: any) => ({
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      fullName: row.full_name || row.name,
      company: row.company || row.company_name,
      role: row.role,
      industry: row.industry,
    }));

    const results = await withCustomerDeliveryReceipt(assistant, () => gmailApiService.sendBulkEmails(
      userId,
      leads,
      { subject, body, isHtml: true, campaignId, delayBetweenEmails: delayMs }
    ));

    const sent = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    const setup = results.find(result => result.code === 'ASSISTANT_SETUP_REQUIRED');
    if (setup) return res.status(409).json({ ...setup, sent, failed, total: leads.length });

    return res.json({
      success: true,
      sent,
      failed,
      total: leads.length,
      message: `Sent ${sent} emails via Gmail API, ${failed} failed`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[GmailOutreachController] Error sending bulk emails');
    const setup = deliverySetupFailure(error);
    if (setup) return res.status(409).json(setup);
    return res.status(500).json({ success: false, error: 'Unable to send the emails. Check the email history before sending again.' });
  }
}

/**
 * Check for and process Gmail replies
 * POST /api/gmail-outreach/check-replies
 */
export async function checkReplies(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { requestGmailMailboxSync } = await import('../services/GmailMailboxSyncService.js');
    const queuedCount = await requestGmailMailboxSync(userId);

    return res.json({
      success: true,
      queuedCount,
      message: 'Gmail refresh queued. Replies use the verified mailbox processing pipeline.',
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[GmailOutreachController] Error checking replies');
    return res.status(500).json({ success: false, error: 'Unable to check for replies. Please try again.' });
  }
}

/**
 * Get email history for a lead
 * GET /api/gmail-outreach/history/:leadId
 */
export async function getEmailHistory(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { leadId } = req.params;

    const history = await db.execute(sql`
      SELECT id, channel, message, status, sent_at, message_id, is_reply, campaign_id, sequence_step
      FROM sent_messages
      WHERE lead_id = ${parseInt(leadId)} AND channel IN ('email', 'gmail') AND user_id = ${userId}
      ORDER BY sent_at DESC
      LIMIT 50
    `);

    return res.json({
      success: true,
      history: history.rows,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[GmailOutreachController] Error getting email history');
    return res.status(500).json({ success: false, error: 'Unable to load the email history. Please try again.' });
  }
}

/**
 * Generate AI-personalized email content
 * POST /api/gmail-outreach/generate
 */
export async function generateEmail(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { leadId, purpose = 'cold_outreach', campaignObjective, valueProposition, tone } = req.body;
    if (!['cold_outreach','follow_up','nurture'].includes(purpose)) {
      return res.status(400).json({ success: false, error: 'Generate replies from the original email conversation so its campaign context is preserved.' });
    }

    // Fetch lead data
    const leadResult = await db.execute(sql`
      SELECT id, email, first_name, last_name, full_name, name, company, company_name, role, industry, headline, location
      FROM leads
      WHERE id = ${leadId}
    `);

    if (leadResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = leadResult.rows[0] as any;
    const leadInfo = {
      id: lead.id,
      email: lead.email,
      firstName: lead.first_name,
      lastName: lead.last_name,
      fullName: lead.full_name || lead.name,
      company: lead.company || lead.company_name,
      role: lead.role,
      industry: lead.industry,
      headline: lead.headline,
      location: typeof lead.location === 'object' ? lead.location?.city : lead.location,
    };

    const result = await gmailApiService.generatePersonalizedEmail(
      leadInfo,
      purpose,
      { campaignObjective, valueProposition, tone },
      userId
    );

    return res.json({
      success: true,
      ...result,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToGenerationFailure(res, error, 'an email', logger, 'GmailOutreachController')) return;
    logger.error({ err: error }, '[GmailOutreachController] Error generating email');
    return res.status(500).json({ success: false, error: 'Unable to generate the email. Please try again.' });
  }
}

/**
 * Generate follow-up sequence for a lead
 * POST /api/gmail-outreach/generate-sequence
 */
export async function generateSequence(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { leadId, campaignObjective, valueProposition, tone, numberOfFollowUps = 3 } = req.body;

    // Fetch lead data
    const leadResult = await db.execute(sql`
      SELECT id, email, first_name, last_name, full_name, name, company, company_name, role, industry
      FROM leads
      WHERE id = ${leadId}
    `);

    if (leadResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = leadResult.rows[0] as any;
    const leadInfo = {
      id: lead.id,
      email: lead.email,
      firstName: lead.first_name,
      lastName: lead.last_name,
      fullName: lead.full_name || lead.name,
      company: lead.company || lead.company_name,
      role: lead.role,
      industry: lead.industry,
    };

    const sequence = await gmailApiService.generateFollowUpSequence(
      leadInfo,
      { campaignObjective, valueProposition, tone, numberOfFollowUps },
      userId
    );

    return res.json({
      success: true,
      sequence,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToGenerationFailure(res, error, 'an email sequence', logger, 'GmailOutreachController')) return;
    logger.error({ err: error }, '[GmailOutreachController] Error generating sequence');
    return res.status(500).json({ success: false, error: 'Unable to generate the email sequence. Please try again.' });
  }
}

/**
 * Get Gmail outreach statistics
 * GET /api/gmail-outreach/stats
 */
export async function getGmailStats(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    // Get overall stats
    const stats = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'sent' AND channel IN ('email', 'gmail')) as sent,
        COUNT(*) FILTER (WHERE status = 'delivered' AND channel IN ('email', 'gmail')) as delivered,
        COUNT(*) FILTER (WHERE status = 'opened' AND channel IN ('email', 'gmail')) as opened,
        COUNT(*) FILTER (WHERE status = 'clicked' AND channel IN ('email', 'gmail')) as clicked,
        COUNT(*) FILTER (WHERE is_reply = true AND channel IN ('email', 'gmail')) as replies,
        COUNT(*) FILTER (WHERE status = 'bounced' AND channel IN ('email', 'gmail')) as bounced
      FROM sent_messages
      WHERE user_id = ${userId}
    `);

    // Get recent activity
    const recentActivity = await db.execute(sql`
      SELECT DATE(sent_at) as date, COUNT(*) as count, status
      FROM sent_messages
      WHERE channel IN ('email', 'gmail') AND user_id = ${userId} AND sent_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(sent_at), status
      ORDER BY date DESC
    `);

    return res.json({
      success: true,
      stats: stats.rows[0],
      recentActivity: recentActivity.rows,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[GmailOutreachController] Error getting stats');
    return res.status(500).json({ success: false, error: 'Unable to load Gmail statistics. Please try again.' });
  }
}

// Follow-up delivery belongs to the canonical outreach/assistant schedulers.
// The unmounted legacy sequence CRUD/processor was retired with migration 318.

/**
 * Get pending replies (leads who have replied but not been responded to)
 * GET /api/gmail-outreach/pending-replies
 */
export async function getPendingReplies(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const pendingReplies = await db.execute(sql`
      SELECT DISTINCT ON (sm.lead_id)
        sm.id,
        sm.lead_id,
        sm.lead_name,
        sm.message as reply_content,
        sm.sent_at as replied_at,
        l.email as lead_email,
        l.full_name,
        l.company
      FROM sent_messages sm
      LEFT JOIN leads l ON l.id = sm.lead_id
      WHERE sm.user_id = ${userId}
        AND sm.channel IN ('email', 'gmail')
        AND sm.is_reply = true
        AND NOT EXISTS (
          SELECT 1 FROM sent_messages sm2
          WHERE sm2.lead_id = sm.lead_id
            AND sm2.user_id = ${userId}
        AND sm2.channel IN ('email', 'gmail')
            AND sm2.is_reply = false
            AND sm2.sent_at > sm.sent_at
        )
      ORDER BY sm.lead_id, sm.sent_at DESC
      LIMIT 50
    `);

    return res.json({
      success: true,
      pendingReplies: pendingReplies.rows,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[GmailOutreachController] Error getting pending replies');
    return res.status(500).json({ success: false, error: 'Unable to load pending replies. Please try again.' });
  }
}

/**
 * Generate smart reply for a lead's response
 * POST /api/gmail-outreach/smart-reply/:leadId
 */
export async function generateSmartReply(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { leadId } = req.params;
    const { replyContent, tone = 'professional' } = req.body;

    if (!replyContent) {
      return res.status(400).json({ success: false, error: 'replyContent is required' });
    }

    // Fetch lead data
    const leadResult = await db.execute(sql`
      SELECT id, email, first_name, last_name, full_name, name, company, company_name, role, industry
      FROM leads
      WHERE id = ${parseInt(leadId)} AND user_id = ${userId}
    `);

    if (leadResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = leadResult.rows[0] as any;
    const leadInfo = {
      id: lead.id,
      email: lead.email,
      firstName: lead.first_name,
      lastName: lead.last_name,
      fullName: lead.full_name || lead.name,
      company: lead.company || lead.company_name,
      role: lead.role,
      industry: lead.industry,
    };

    const { generateConfiguredReplyPreview } = await import('../services/agents/ConfiguredReplyPreviewService.js');
    const result = await generateConfiguredReplyPreview({
      userId,
      inboundText: replyContent,
      leadId: leadInfo.id,
      tone,
      sourceConversationId: req.body.conversationId ? Number(req.body.conversationId) : undefined,
    });

    return res.json({
      success: true,
      body: result.body,
      subject: result.subject,
      confidence: result.confidence,
      sourcesUsed: result.sourcesUsed,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (respondToGenerationFailure(res, error, 'a reply', logger, 'GmailOutreachController')) return;
    logger.error({ err: error }, '[GmailOutreachController] Error generating smart reply');
    return res.status(500).json({ success: false, error: 'Unable to generate a reply. Please try again.' });
  }
}
