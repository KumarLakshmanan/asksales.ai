import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { businessCacheKey } from '../tenancy/businessContext.js';
import type { Request, Response } from "express";
import { logger } from '../utils/logger.js';
import { db } from "../models/db";
import { sql } from "drizzle-orm";
import { SentMessageModel } from "../models/sentMessages/functions";
import { emailService } from "../services/emailService";
import { sendSMS } from "../services/smsService";
import { OutreachAgent } from "../services/agents/OutreachAgent";
import { getOutreachSettingsByUserId } from "../models/outreachSettings/functions";
import { idempotencyService } from '../services/IdempotencyService.js';
import { createHash } from 'node:crypto';
import { emailBodyToHtml } from '../../shared/emailFormatting.js';
import {
  ContentBrandContextError,
  resolveContentBrandContext,
} from '../services/content/ContentBrandContextService.js';
import {
  ContentComplianceError,
  validateGeneratedContent,
} from '../services/content/ContentComplianceService.js';
import {
  findUnresolvedTemplateVariables,
  sanitizeEmailHtml,
} from '../utils/contentTemplateRendering.js';

const outreachAgent = new OutreachAgent();

/**
 * GET /api/outreach/progress/:campaignId
 * Get outreach campaign progress and status
 */
export async function getOutreachProgress(req: Request, res: Response) {
  try {
    const { campaignId } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    const parsedCampaignId = Number(campaignId);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (!Number.isInteger(parsedCampaignId) || parsedCampaignId <= 0) {
      return res.status(400).json({ error: 'A valid campaign ID is required' });
    }

    // Get campaign details
    const campaignResult = await db.execute(sql`
      SELECT
        id,
        status,
        total_leads AS "totalLeads",
        launched_at AS "launchedAt",
        start_date AS "startDate",
        completed_at AS "completedAt"
      FROM outreach_campaigns
      WHERE id = ${parsedCampaignId} AND user_id = ${userId}
    `);

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const campaign = campaignResult.rows[0] as any;

    // Progress is based on durable campaign jobs. A campaign can have several
    // sequence steps per lead, so sent_messages/lead count is not the correct
    // denominator for lifecycle progress.
    const messagesResult = await db.execute(sql`
      SELECT status, COUNT(*) as count
      FROM outreach_jobs
      WHERE campaign_id = ${parsedCampaignId} AND user_id = ${userId}
      GROUP BY status
    `);

    const statusCounts: Record<string, number> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of messagesResult.rows as any[]) {
      statusCounts[row.status] = parseInt(row.count);
    }

    // Calculate progress
    const totalJobs = Object.values(statusCounts).reduce((total, count) => total + count, 0);
    const sent = statusCounts['sent'] || 0;
    const pending = (statusCounts['pending'] || 0) + (statusCounts['processing'] || 0);
    const failed = statusCounts['failed'] || 0;
    const cancelled = statusCounts['cancelled'] || 0;
    const progress = totalJobs > 0
      ? Math.min(100, Math.round(((sent + failed + cancelled) / totalJobs) * 100))
      : 0;

    res.json({
      campaignId: parsedCampaignId,
      status: campaign.status,
      progress,
      stats: {
        total: totalJobs,
        sent,
        pending,
        failed,
        cancelled,
      },
      startedAt: campaign.launchedAt,
      scheduledAt: campaign.startDate,
      completedAt: campaign.completedAt,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[OutreachController] Error getting progress');
    res.status(500).json({ error: 'Unable to retrieve outreach progress. Please try again.' });
  }
}

export async function getOutreachMessages(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ message: "Authentication required" });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const messages = await SentMessageModel.findRecentByUser(userId, limit, offset);
    res.json(messages);
  } catch (error) {
    logger.error({ err: error }, 'Get outreach messages error');
    res.status(500).json({ message: "Unable to retrieve outreach messages. Please try again." });
  }
}

export async function getOutreachStats(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ message: "Authentication required" });

    const { getCampaignReport, campaignReportStats } = await import('../services/outreach/CampaignReportingService.js');
    const range = req.query.range === undefined ? 'all' : (['7d','30d','90d'].includes(String(req.query.range)) ? String(req.query.range) : '30d');
    const since = new Date();
    since.setUTCHours(0,0,0,0);
    if (range !== 'all') since.setUTCDate(since.getUTCDate()-(Number.parseInt(range,10)-1));
    const report = await getCampaignReport(userId,{messageKind:'all',...(range === 'all' ? {} : {from:since.toISOString()})});
    // Activity's historic total includes every intent, while analytics labels sent as provider acceptance.
    return res.json(campaignReportStats(report,range));

  } catch (error) {
    logger.error({ err: error }, 'Get outreach stats error');
    res.status(500).json({ message: "Unable to retrieve outreach statistics. Please try again." });
  }
}

export async function sendOutreachMessage(req: Request, res: Response) {
  let claimedIdempotencyKey: string | null = null;
  let sideEffectStarted = false;
  let reservationTransactionId: number | undefined;

  try {
    const {
      leadId,
      leadName,
      channel,
      message,
      subject,
      imageUrl,
      videoUrl,
      businessProfileId,
      brandToolkitId,
      idempotencyKey: bodyIdempotencyKey,
    } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    if (!leadId) {
      return res.status(400).json({ message: 'leadId is required' });
    }
    if (!channel || !['email', 'sms'].includes(String(channel).toLowerCase())) {
      return res.status(400).json({ message: 'A valid channel (email or sms) is required' });
    }
    if (!message) {
      return res.status(400).json({ message: 'message content is required' });
    }

    const normalizedChannel = String(channel).toLowerCase() as 'email' | 'sms';
    const { admitCustomerDeliveryJob } = await import('../services/assistants/CustomerDeliveryJobs.js');
    await admitCustomerDeliveryJob(normalizedChannel === 'email' ? 'send_email' : 'send_sms', { userId, channel: normalizedChannel });
    const leadResult = await db.execute(sql`
      SELECT
        id,
        email,
        phone,
        full_name AS "fullName",
        first_name AS "firstName",
        last_name AS "lastName",
        name,
        do_not_contact AS "doNotContact",
        blacklisted,
        email_unsubscribed AS "emailUnsubscribed"
      FROM leads
      WHERE id = ${leadId}
        AND user_id = ${userId}
        AND deleted_at IS NULL
      LIMIT 1
    `);

    if (leadResult.rows.length === 0) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = leadResult.rows[0] as any;
    if (lead.doNotContact || lead.blacklisted || (normalizedChannel === 'email' && lead.emailUnsubscribed)) {
      return res.status(409).json({
        message: 'This lead has opted out of outreach or is blocked from contact.',
      });
    }

    const recipient = normalizedChannel === 'email' ? lead.email : lead.phone;
    if (!recipient) {
      return res.status(400).json({
        message: normalizedChannel === 'email'
          ? 'Lead does not have an email address'
          : 'Lead does not have a phone number',
      });
    }

    const actualLeadName = lead.fullName
      || lead.name
      || `${lead.firstName || ''} ${lead.lastName || ''}`.trim()
      || leadName
      || recipient;
    const unresolved = findUnresolvedTemplateVariables(`${subject || ''}\n${message}`);
    if (unresolved.length > 0) {
      return res.status(422).json({
        success: false,
        error: `Resolve template variables before sending: ${unresolved.join(', ')}.`,
        code: 'UNRESOLVED_TEMPLATE_VARIABLES',
      });
    }
    let validatedMessage = message;
    // The email is rendered with the same brand it was validated against.
    let sendBrandToolkitId: number | undefined;
    try {
      const brandContext = await resolveContentBrandContext(Number(userId), {
        businessProfileId,
        brandToolkitId,
      });
      sendBrandToolkitId = brandContext.brandToolkit.id;
      validatedMessage = normalizedChannel === 'email' ? sanitizeEmailHtml(emailBodyToHtml(message)) : message;
      validateGeneratedContent({
        type: normalizedChannel,
        output: normalizedChannel === 'email'
          ? {
              subject: subject?.trim() || `Message from ${brandContext.brandToolkit.name}`,
              body: validatedMessage,
            }
          : { message: validatedMessage },
        context: brandContext,
        platform: normalizedChannel,
      });
    } catch (error) {
      if (error instanceof ContentBrandContextError) {
        return res.status(error.status).json({ success: false, error: error.message, code: error.code });
      }
      if (error instanceof ContentComplianceError) {
        return res.status(422).json({
          success: false,
          error: 'Message failed brand or channel validation.',
          code: 'CONTENT_VALIDATION_FAILED',
          violations: error.violations,
        });
      }
      throw error;
    }
    const requestedKey = req.get('idempotency-key') || bodyIdempotencyKey;
    if (requestedKey && requestedKey.length > 200) {
      return res.status(400).json({ message: 'Idempotency key must be 200 characters or fewer' });
    }
    const requestFingerprint = createHash('sha256')
      .update(JSON.stringify({ userId, leadId, channel: normalizedChannel, subject: subject || '', message: validatedMessage }))
      .digest('hex');
    const keyFingerprint = requestedKey
      ? createHash('sha256').update(`${userId}:${requestedKey}`).digest('hex')
      : requestFingerprint;
    claimedIdempotencyKey = businessCacheKey(`outreach-send:${userId}:${keyFingerprint}`);
    const claim = await idempotencyService.checkAndStore(claimedIdempotencyKey, {
      ttlSeconds: requestedKey ? 24 * 60 * 60 : 2 * 60,
    });

    if (claim.status === 'duplicate') {
      if (claim.previousResponse) {
        try {
          const previous = JSON.parse(claim.previousResponse);
          return res.status(previous.statusCode || 200).json(previous.body || previous);
        } catch {
          logger.warn({ idempotencyKey: claimedIdempotencyKey }, '[OutreachController] Ignoring malformed cached send response');
        }
      }
      return res.status(202).json({
        success: true,
        message: 'This outreach message is already being processed.',
      });
    }

    const { creditService } = await import('../services/CreditService.js');
    const reservation = await creditService.reserveOutreachCredit({
      userId,
      channel: normalizedChannel,
      referenceId: requestFingerprint,
      service: 'OutreachController',
    });
    if (!reservation.success) {
      const responseBody = {
        success: false,
        error: reservation.error || 'Insufficient credits. Recharge your wallet before sending.',
        code: 'INSUFFICIENT_CREDITS',
      };
      await idempotencyService.storeResponse(claimedIdempotencyKey, JSON.stringify({
        statusCode: 402,
        body: responseBody,
      }));
      return res.status(402).json(responseBody);
    }
    reservationTransactionId = reservation.transactionId;

    sideEffectStarted = true;
    let providerResult: { success: boolean; messageId?: string; error?: string; code?: string; reason?: string; assistantId?: string };
    if (normalizedChannel === 'email') {
      providerResult = await emailService.sendEmailWithUserCredentials(userId, {
        to: recipient,
        toName: actualLeadName,
        subject: subject?.trim() || `Message from ${process.env.COMPANY_NAME || 'SalesMarketing'}`,
        html: validatedMessage,
        leadId,
        skipCreditDeduction: true,
        brandToolkitId: sendBrandToolkitId,
      });
    } else {
      providerResult = await sendSMS(userId, recipient, validatedMessage);
    }
    if (providerResult.code === 'ASSISTANT_SETUP_REQUIRED') {
      sideEffectStarted = false;
      const { throwIfCustomerDeliverySetupRequired } = await import('../services/assistants/CustomerDeliveryGate.js');
      throwIfCustomerDeliverySetupRequired(providerResult);
    }

    if (!providerResult.success && reservationTransactionId) {
      await creditService.refundDeduction({
        userId,
        transactionId: reservationTransactionId,
        description: `Refund for failed ${normalizedChannel} outreach to lead ${leadId}`,
      });
      reservationTransactionId = undefined;
    }

    let sentMessage = providerResult.messageId
      ? await SentMessageModel.findByProviderMessageId(userId, providerResult.messageId)
      : undefined;

    // Email providers persist successful sends in EmailService. SMS and failed
    // attempts are persisted here; a fallback record also covers provider sends
    // that succeeded even if their tracking write failed.
    if (!sentMessage) {
      sentMessage = await SentMessageModel.create({
        leadId,
        leadName: actualLeadName,
        channel: normalizedChannel,
        subject: subject?.trim() || null,
        message: validatedMessage,
        imageUrl: imageUrl || null,
        videoUrl: videoUrl || null,
        sentAt: new Date(),
        status: providerResult.success ? 'sent' : 'failed',
        deliveryStatus: providerResult.success ? 'sent' : 'failed',
        messageId: providerResult.messageId || null,
        userId,
      }, { skipCreditDeduction: true });
    }

    const statusCode = providerResult.success ? 201 : 502;
    const responseBody = providerResult.success
      ? { success: true, message: sentMessage }
      : {
          success: false,
          error: providerResult.error || `Unable to send ${normalizedChannel}. Please try again.`,
          message: sentMessage,
        };

    await idempotencyService.storeResponse(claimedIdempotencyKey, JSON.stringify({
      statusCode,
      body: responseBody,
    }));
    return res.status(statusCode).json(responseBody);
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { deliverySetupFailure } = await import('../services/assistants/CustomerDeliveryGate.js');
    const setup = deliverySetupFailure(error);
    if (!sideEffectStarted && reservationTransactionId && businessOwnerUserId(req)) {
      try {
        const { creditService } = await import('../services/CreditService.js');
        await creditService.refundDeduction({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          userId: businessOwnerUserId(req),
          transactionId: reservationTransactionId,
          description: 'Refund for outreach send that did not reach the provider',
        });
      } catch (_refundError) {
        // The reservation remains auditable for reconciliation.
      }
    }
    if (claimedIdempotencyKey) {
      try {
        if (sideEffectStarted) {
          await idempotencyService.storeResponse(claimedIdempotencyKey, JSON.stringify({
            statusCode: 500,
            body: { message: 'The send result could not be confirmed. Check message history before retrying.' },
          }));
        } else {
          await idempotencyService.forget(claimedIdempotencyKey);
        }
      } catch (idempotencyError) {
        logger.warn({ err: idempotencyError }, '[OutreachController] Unable to finalize send idempotency state');
      }
    }
    if (setup && !sideEffectStarted) return res.status(409).json(setup);
    logger.error({ err: error }, 'Send outreach message error');
    return res.status(500).json({
      message: sideEffectStarted
        ? 'The send result could not be confirmed. Check message history before retrying.'
        : 'Unable to send the outreach message. Please try again.',
    });
  }
}


/**
 * POST /api/outreach/start
 * Start outreach based on workflowId: generate or reuse sequence, create campaign, schedule & start sending
 */
export async function startOutreachHandler(req: Request, res: Response) {
  let idempotencyKey: string | null = null;
  let launchCreated = false;

  try {
    const { workflowId, followUpDelayHours } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!workflowId) {
      return res.status(400).json({ error: 'workflowId is required' });
    }

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Fetch only executions belonging to the authenticated user's workflow.
    const execsResult = await db.execute(sql`
      SELECT ae.id, ae.output
      FROM agent_executions ae
      INNER JOIN workflow_sessions ws ON ws.id = ae.workflow_id
      WHERE ae.workflow_id = ${workflowId}
        AND ws.user_id = ${userId}
        AND ae.agent_type = 'lead_generation'
      ORDER BY ae.created_at DESC
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const execRows = execsResult.rows as any[];

    if (!execRows || execRows.length === 0) {
      return res.status(404).json({ error: 'No lead generation results found for this workflow' });
    }

    // Collect lead ids from executions (if they returned leads in output) OR query leads table based on execution ids
    const execIds = execRows.map(r => r.id);

    const leadsQuery = await db.execute(sql`
      SELECT *
      FROM leads
      WHERE execution_id IN (${sql.join(execIds.map(id=>sql`${id}::uuid`),sql`,`)})
        AND user_id = ${userId}
        AND deleted_at IS NULL
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawLeads = leadsQuery.rows as any[];

    if (!rawLeads || rawLeads.length === 0) {
      return res.status(404).json({ error: 'No leads found linked to last lead_generation execution' });
    }

    // Deduplicate leads by email address to prevent multiple emails to the same recipient
    // (the same lead may appear in several lead_generation executions for the same workflow)
    const seenEmails = new Set<string>();
    const leads = rawLeads.filter((lead) => {
      const email = (lead.email || '').toLowerCase().trim();
      if (!email) return true; // keep leads without email; they'll be skipped later
      if (seenEmails.has(email)) return false;
      seenEmails.add(email);
      return true;
    });

    // Claim one launch per user/workflow for a short retry window. This is
    // atomic in Redis, so duplicate requests from React, network retries, or
    // another API instance cannot create and send a second campaign.
    idempotencyKey = businessCacheKey(`outreach-start:${userId}:${workflowId}`);
    const idempotency = await idempotencyService.checkAndStore(idempotencyKey, {
      ttlSeconds: 5 * 60,
    });
    if (idempotency.status === 'duplicate') {
      if (idempotency.previousResponse) {
        try {
          const previous = JSON.parse(idempotency.previousResponse);
          if (previous.statusCode && previous.body) {
            return res.status(previous.statusCode).json(previous.body);
          }
          return res.json(previous);
        } catch {
          logger.warn({ idempotencyKey }, '[OutreachController] Ignoring malformed cached launch response');
        }
      }
      return res.status(202).json({
        success: true,
        message: 'Outreach campaign launch is already in progress',
      });
    }

    // Fetch outreach settings
    const userOutreachSettings = await getOutreachSettingsByUserId(userId);

    // Determine total emails and delay
    const totalEmails = Math.min(Math.max(userOutreachSettings?.maxFollowUps || 3, 1), 10);
    // If followUpDelayHours is provided in request, override settings; default to settings.followUpDelay days -> convert to hours
    const followDelayHours = typeof followUpDelayHours === 'number' ? followUpDelayHours : ((userOutreachSettings?.followUpDelay || 3) * 24);

    // Fetch ICP from one of the leads' promptId (if present)
    const icpId = (leads[0] && (leads[0].prompt_id ?? leads[0].promptId)) || null;
    let icp = null;
    if (icpId) {
      const icpRes = await db.execute(sql`
        SELECT * FROM icp_profiles WHERE id = ${icpId} AND user_id = ${userId}
      `);
      if (icpRes.rows.length > 0) icp = icpRes.rows[0];
    }

    // Fall back to basic ICP object if not found
    const icpProfile = icp || { id: icpId || null, campaignName: `Outreach from workflow ${workflowId}` };

    // Generate email sequence
    const emailSequence = await outreachAgent.generateEmailSequence(userId, icpProfile, leads, totalEmails);

    // Sequence generation owns all steps. The legacy Content Studio toggle no
    // longer runs a second generation path that overwrote the reviewed sequence.

    // Adjust days_between using followDelayHours (convert to decimals days)
    // Overwrite the `day` field on each email step using follow delays (hours converted to fractional days)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emailSequence.emails = (emailSequence.emails || []).map((step: any, idx: number) => ({
      ...step,
      day: idx === 0 ? 0 : (followDelayHours * idx) / 24,
    }));

    // Save sequence
    const sequenceId = await outreachAgent.saveEmailSequence(userId, emailSequence);

    // Create campaign
    const campaignId = await outreachAgent.createCampaign(userId, icpProfile.id || 0, `${emailSequence.campaign_name}`, 'email', leads, [sequenceId]);
    launchCreated = true;

    // Workflow generation creates a draft. Exact account, recipient, content,
    // consent and launch-time review happen through the canonical campaign UI.
    const response = {
      success: true,
      status: 'needs_review',
      campaign_id: campaignId,
      sequence_id: sequenceId,
      review_url: `/dashboard/outreach/campaigns/${campaignId}/review`,
      message: 'Campaign draft created. Review its sending account, recipients and messages before launch.',
    };
    await idempotencyService.storeResponse(idempotencyKey, JSON.stringify(response));
    return res.json(response);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (idempotencyKey) {
      if (launchCreated) {
        await idempotencyService.storeResponse(idempotencyKey, JSON.stringify({
          statusCode: 500,
          body: {
            error: 'The campaign was created but launch completion could not be confirmed. Check campaign history before retrying.',
          },
        }));
      } else {
        await idempotencyService.forget(idempotencyKey);
      }
    }
    logger.error({ err: error }, '[OutreachController] Error starting outreach');
    return res.status(500).json({
      error: launchCreated
        ? 'The campaign was created but launch completion could not be confirmed. Check campaign history before retrying.'
        : 'Unable to start outreach. Please try again.',
    });
  }
}
