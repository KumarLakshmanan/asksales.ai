import { businessOwnerUserId, requireBusinessScope } from '../tenancy/businessContext.js';
/**
 * Outreach Controller
 * Handles outreach campaign operations
 */

import { Request, Response } from 'express';
import { OutreachAgent } from '../services/agents/OutreachAgent';
import { db } from '../models/db';
import { leadsTable } from '../models/leads/schema';
import { sql } from 'drizzle-orm';
import multer from 'multer';
import { logger } from '../utils/logger.js';
import { outreachSenderWorker } from '../tools/outreachSender.js';
import { CampaignDeliveryReviewError, prepareCampaignDelivery } from '../services/outreach/CampaignDeliveryService.js';
import { leadUploadLookup } from '../services/outreach/leadUploadLookup.js';

const outreachAgent = new OutreachAgent();

// Configure multer for file uploads (in-memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
    if (allowedTypes.includes(file.mimetype) || file.originalname.match(/\.(csv|xlsx|xls)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and Excel files are allowed'));
    }
  },
});

export const uploadLeadsFile = upload.single('leads_file');

/**
 * POST /api/outreach/upload-leads
 * Upload and process leads file
 */
export async function uploadLeads(req: Request, res: Response) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    // Process leads file
    const leads = await outreachAgent.processLeadsFile(fileBuffer, fileName);
    if (leads.length === 0) {
      return res.status(400).json({ error: 'No rows contained a usable email address or phone number' });
    }

    const uniqueRows = new Map<string, typeof leads[number]>();
    for (const lead of leads) {
      const email = String(lead.email || '').trim().toLowerCase();
      const phone = String(lead.phone || '').replace(/[^0-9+]/g, '');
      const key = email ? `email:${email}` : `phone:${phone}`;
      if (!uniqueRows.has(key)) uniqueRows.set(key, { ...lead, email, phone });
    }

    const emails = [...uniqueRows.values()].map((lead) => lead.email).filter(Boolean) as string[];
    const phones = [...uniqueRows.values()].map((lead) => lead.phone).filter(Boolean) as string[];
    const scope = requireBusinessScope();
    const existing = await db.execute(leadUploadLookup(userId, scope.businessProfileId, emails, phones));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingEmails = new Set((existing.rows as any[]).map((row) => row.email).filter(Boolean));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingPhones = new Set((existing.rows as any[]).map((row) => row.phone).filter(Boolean));
    const newRows = [...uniqueRows.values()].filter((lead) =>
      !(lead.email && existingEmails.has(lead.email))
      && !(lead.phone && existingPhones.has(lead.phone))
    );

    const inserted = newRows.length > 0
      ? await db.insert(leadsTable).values(newRows.map((lead) => ({
          userId,
          source: 'outreach_upload',
          email: lead.email || null,
          phone: lead.phone || null,
          firstName: String(lead.first_name || '').trim() || null,
          lastName: String(lead.last_name || '').trim() || null,
          fullName: String(lead.full_name || '').trim() || null,
          name: String(lead.full_name || lead.name || '').trim() || null,
          company: String(lead.company || '').trim() || null,
          role: String(lead.role || '').trim() || null,
        }))).returning()
      : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const persisted = [...(existing.rows as any[]), ...inserted];

    res.json({
      success: true,
      leads_count: persisted.length,
      imported_count: inserted.length,
      duplicate_count: uniqueRows.size - inserted.length,
      leads: persisted,
      message: `Imported ${inserted.length} new lead${inserted.length === 1 ? '' : 's'} from ${fileName}`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[OutreachController] Error uploading leads');
    if (String(error?.message).includes('5,000-row limit')) {
      return res.status(413).json({ error: error.message });
    }
    res.status(500).json({ error: 'Unable to upload leads. Please try again.' });
  }
}

/**
 * POST /api/outreach/generate-email-sequence
 * Generate email sequence for ICP and leads
 */
export async function generateEmailSequence(req: Request, res: Response) {
  try {
    const { icp_id, leads, total_emails = 5 } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!icp_id || !leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'icp_id and leads array are required' });
    }

    // Fetch ICP from database
    const icpResult = await db.execute(sql`
      SELECT * FROM icp_profiles WHERE id = ${icp_id} AND user_id = ${userId}
    `);

    if (icpResult.rows.length === 0) {
      return res.status(404).json({ error: 'ICP not found' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const icp = icpResult.rows[0] as any;

    // Generate email sequence
    const emailSequence = await outreachAgent.generateEmailSequence(userId, icp, leads, total_emails);

    // Save to database
    const sequenceId = await outreachAgent.saveEmailSequence(userId, emailSequence);

    res.json({
      success: true,
      sequence_id: sequenceId,
      email_sequence: emailSequence,
      message: `Generated ${emailSequence.emails.length}-email sequence`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[OutreachController] Error generating email sequence');
    res.status(500).json({ error: 'Unable to generate the email sequence. Please try again.' });
  }
}

/**
 * POST /api/outreach/generate-sms-sequence
 * Generate SMS sequence for ICP and leads
 */
export async function generateSMSSequence(req: Request, res: Response) {
  try {
    const { icp_id, leads, total_messages = 3 } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!icp_id || !leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'icp_id and leads array are required' });
    }

    // Fetch ICP from database
    const icpResult = await db.execute(sql`
      SELECT * FROM icp_profiles WHERE id = ${icp_id} AND user_id = ${userId}
    `);

    if (icpResult.rows.length === 0) {
      return res.status(404).json({ error: 'ICP not found' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const icp = icpResult.rows[0] as any;

    // Generate SMS sequence
    const smsSequence = await outreachAgent.generateSMSSequence(userId, icp, leads, total_messages);

    // Save to database
    const sequenceId = await outreachAgent.saveSMSSequence(userId, smsSequence);

    res.json({
      success: true,
      sequence_id: sequenceId,
      sms_sequence: smsSequence,
      message: `Generated ${smsSequence.messages.length}-message SMS sequence`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[OutreachController] Error generating SMS sequence');
    res.status(500).json({ error: 'Unable to generate the SMS sequence. Please try again.' });
  }
}

/**
 * POST /api/outreach/create-campaign
 * Create outreach campaign
 */
export async function createCampaign(req: Request, res: Response) {
  try {
    const { icp_id, campaign_name, campaign_type, leads, sequence_id, sequence_ids, auto_reply } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    if (!icp_id || !campaign_name || !campaign_type || !leads || !Array.isArray(leads)) {
      return res.status(400).json({
        error: 'icp_id, campaign_name, campaign_type, and leads array are required',
      });
    }

    const validCampaignTypes = ['email', 'sms', 'both'];
    if (!validCampaignTypes.includes(campaign_type)) {
      return res.status(400).json({
        error: `Invalid campaign_type. Must be one of: ${validCampaignTypes.join(', ')}`,
      });
    }
    if (auto_reply !== undefined && typeof auto_reply !== 'boolean') {
      return res.status(400).json({ error: 'Auto reply must be true or false' });
    }

    const normalizedName = String(campaign_name).trim();
    if (!normalizedName || normalizedName.length > 255) {
      return res.status(400).json({ error: 'Campaign name must be between 1 and 255 characters' });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const leadIds = [...new Set(leads.map((lead: any) => Number(lead?.id)).filter((id) => Number.isInteger(id) && id > 0))];
    if (leadIds.length === 0 || leadIds.length > 5_000) {
      return res.status(400).json({ error: 'Select between 1 and 5,000 persisted leads' });
    }

    const requestedSequenceIds = [...new Set([
      sequence_id,
      ...(sequence_ids && typeof sequence_ids === 'object' ? Object.values(sequence_ids) : []),
    ].map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (requestedSequenceIds.length === 0 || requestedSequenceIds.length > 2) {
      return res.status(400).json({ error: 'Select the generated outreach sequence for this campaign' });
    }

    const scope = requireBusinessScope();
    const [icpResult, ownedLeadsResult, sequenceResult] = await Promise.all([
      db.execute(sql`SELECT id FROM icp_profiles WHERE id = ${Number(icp_id)} AND user_id = ${userId}
        AND business_profile_id = ${scope.businessProfileId} LIMIT 1`),
      db.execute(sql`
        SELECT * FROM leads
        WHERE id IN (${sql.join(leadIds.map(id => sql`${id}`), sql`, `)})
          AND user_id = ${userId}
          AND business_profile_id = ${scope.businessProfileId}
          AND deleted_at IS NULL
      `),
      db.execute(sql`
        SELECT id, sequence_type FROM outreach_sequences
        WHERE id IN (${sql.join(requestedSequenceIds.map(id => sql`${id}`), sql`, `)}) AND user_id = ${userId}
          AND business_profile_id = ${scope.businessProfileId}
      `),
    ]);
    if (icpResult.rows.length === 0) {
      return res.status(404).json({ error: 'ICP not found' });
    }
    if (ownedLeadsResult.rows.length !== leadIds.length) {
      return res.status(400).json({ error: 'One or more selected leads are unavailable' });
    }
    if (sequenceResult.rows.length !== requestedSequenceIds.length) {
      return res.status(404).json({ error: 'One or more outreach sequences were not found' });
    }
    const sequenceTypes = new Set(sequenceResult.rows.map((row: Record<string, unknown>) => String(row.sequence_type)));
    const expectedTypes = campaign_type === 'both' ? ['email', 'sms'] : [campaign_type];
    if (expectedTypes.some((type) => !sequenceTypes.has(type)) || sequenceTypes.size !== expectedTypes.length) {
      return res.status(400).json({ error: `The selected sequences do not match the ${campaign_type} campaign type` });
    }

    // Create campaign
    const campaignId = await outreachAgent.createCampaign(
      userId,
      Number(icp_id),
      normalizedName,
      campaign_type,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ownedLeadsResult.rows as any[],
      requestedSequenceIds,
      campaign_type !== 'sms' && auto_reply === true,
      { brandToolkitId: req.body.brandToolkitId, threadId: req.body.threadId },
    );
    const campaign = await outreachAgent.getCampaign(campaignId, userId);

    res.json({
      success: true,
      campaign_id: campaignId,
      campaign,
      message: `Created ${campaign_type} campaign with ${leads.length} leads`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (error?.name === 'WorkflowBrandError') return res.status(404).json({ error: error.message, code: error.code });
    logger.error({ err: error }, '[OutreachController] Error creating campaign');
    res.status(500).json({ error: 'Unable to create the campaign. Please try again.' });
  }
}

/**
  * POST /api/outreach/schedule-campaign/:id
  * Schedule campaign to start and begin sending messages
  */
export async function previewCampaign(req: Request, res: Response) {
  try {
    const plan=await prepareCampaignDelivery(businessOwnerUserId(req),Number(req.params.id),req.body.accounts,req.body.start_date);
    return res.json({campaign:plan.campaign,reviewHash:plan.reviewHash,summaries:plan.summaries,skipped:plan.skipped,
      messages:plan.jobs.map(job=>({leadId:job.leadId,channel:job.messageType,stepNumber:job.stepNumber,
        recipient:job.deliveryReview!.recipient,subject:job.subject,content:job.content,scheduledFor:job.scheduledFor}))});
  } catch(error) {
    logger.warn({err:error},'[OutreachController] Campaign review failed');
    const { deliverySetupFailure } = await import('../services/assistants/CustomerDeliveryGate.js');
    const setup = deliverySetupFailure(error);
    if (setup) return res.status(409).json(setup);
    return res.status(error instanceof CampaignDeliveryReviewError ? 409 : 500).json({error:error instanceof CampaignDeliveryReviewError ? error.message : 'Unable to review campaign. Please try again.'});
  }
}

export async function scheduleCampaign(req: Request, res: Response) {
  try {
    const userId=businessOwnerUserId(req),campaignId=Number(req.params.id);
    if (!await outreachAgent.getCampaign(campaignId,userId)) return res.status(404).json({error:'Campaign not found'});
    const scheduled=await outreachAgent.scheduleCampaign(campaignId,new Date(req.body.start_date || Date.now()),{
      accounts:req.body.accounts,reviewHash:req.body.review_hash,startAt:req.body.start_date,
    });
    if (!scheduled) return res.status(409).json({error:'This campaign has already changed. Review its current status.'});
    return res.json({success:true,campaign:await outreachAgent.getCampaign(campaignId,userId),message:'Reviewed campaign queued.'});
  } catch(error) {
    logger.warn({err:error},'[OutreachController] Campaign schedule rejected');
    const { deliverySetupFailure } = await import('../services/assistants/CustomerDeliveryGate.js');
    const setup = deliverySetupFailure(error);
    if (setup) return res.status(409).json(setup);
    return res.status(error instanceof CampaignDeliveryReviewError ? 409 : 500).json({error:error instanceof CampaignDeliveryReviewError ? error.message : 'Unable to schedule campaign. Please try again.'});
  }
}

/**
 * GET /api/outreach/campaigns
 * Get all campaigns for user
 */
export async function getCampaigns(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { icp_id, status } = req.query;

    let query = sql`
      SELECT
        oc.*,
        oc.name AS campaign_name,
        oc.total_leads AS lead_count,
        oc.lead_list_ids AS leads,
        ip.campaign_name as icp_campaign_name,
        ip.target_audience,
        COALESCE(job_stats.total_jobs, 0)::integer AS job_count,
        COALESCE(job_stats.sent_jobs, 0)::integer AS sent_count,
        COALESCE(oc.messages_delivered, 0)::integer AS delivered_count,
        oc.settings->>'queueIssue' AS queue_issue,
        COALESCE(job_stats.pending_jobs, 0)::integer AS pending_count,
        COALESCE(job_stats.failed_jobs, 0)::integer AS failed_count,
        CASE WHEN oc.settings->'deliveryProgress'->>'deliveryFailed' ~ '^[0-9]{1,9}$'
          THEN (oc.settings->'deliveryProgress'->>'deliveryFailed')::integer ELSE 0 END AS delivery_failed_count,
        CASE WHEN oc.settings->>'failedBeforeEnqueueCount' ~ '^[0-9]{1,9}$'
          THEN (oc.settings->>'failedBeforeEnqueueCount')::integer ELSE 0 END AS failed_before_enqueue_count,
        COALESCE(job_stats.cancelled_jobs, 0)::integer AS cancelled_count,
        COALESCE(job_stats.manual_review_jobs, 0)::integer AS manual_review_count,
        job_stats.last_error
      FROM outreach_campaigns oc
      LEFT JOIN icp_profiles ip
        ON ip.id = CASE
          WHEN (oc.settings->>'icpId') ~ '^[0-9]+$' THEN (oc.settings->>'icpId')::integer
          ELSE NULL
        END
        AND ip.user_id = ${userId}
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS total_jobs,
          COUNT(*) FILTER (WHERE status = 'sent') AS sent_jobs,
          COUNT(*) FILTER (WHERE status IN ('pending', 'processing')) AS pending_jobs,
          COUNT(*) FILTER (WHERE status = 'failed') AS failed_jobs,
          COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_jobs,
          COUNT(*) FILTER (
            WHERE metadata->>'manualReviewRequired' = 'true'
          ) AS manual_review_jobs,
          (ARRAY_AGG(error ORDER BY updated_at DESC) FILTER (WHERE error IS NOT NULL))[1] AS last_error
        FROM outreach_jobs
        WHERE campaign_id = oc.id AND user_id = ${userId}
      ) job_stats ON true
      WHERE oc.user_id = ${userId}
    `;

    if (icp_id) {
      query = sql`${query} AND oc.settings->>'icpId' = ${String(icp_id)}`;
    }

    if (status) {
      query = sql`${query} AND oc.status = ${status}`;
    }

    query = sql`${query} ORDER BY oc.created_at DESC LIMIT 50`;

    const result = await db.execute(query);

    res.json({
      success: true,
      campaigns: result.rows,
      count: result.rows.length,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[OutreachController] Error fetching campaigns');
    res.status(500).json({ error: 'Unable to retrieve campaigns. Please try again.' });
  }
}

/**
 * GET /api/outreach/campaigns/:id
 * Get campaign by ID
 */
export async function getCampaignById(req: Request, res: Response) {
  try {
    const { id } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    const campaignId = parseInt(id);
    const campaign = await outreachAgent.getCampaign(campaignId, userId);

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const jobs = await db.execute(sql`
      SELECT
        id,
        lead_id AS "leadId",
        CASE WHEN metadata->'deliveryReview'->>'stepNumber' ~ '^[1-9][0-9]{0,2}$'
          THEN (metadata->'deliveryReview'->>'stepNumber')::integer ELSE sequence_step_id END AS "stepNumber",
        channel,
        status,
        attempts,
        max_attempts AS "maxAttempts",
        scheduled_for AS "scheduledFor",
        sent_at AS "sentAt",
        error,
        (metadata->>'manualReviewRequired' = 'true') AS "manualReviewRequired"
      FROM outreach_jobs
      WHERE campaign_id = ${campaignId} AND user_id = ${userId}
      ORDER BY scheduled_for ASC, id ASC
      LIMIT 500
    `);

    res.json({
      success: true,
      campaign,
      jobs: jobs.rows,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[OutreachController] Error fetching campaign');
    res.status(500).json({ error: 'Unable to retrieve the campaign. Please try again.' });
  }
}

/** Cancel all not-yet-started jobs for an owned campaign. */
export async function cancelCampaign(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const campaignId = Number(req.params.id);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: 'A valid campaign ID is required' });
    }
    const campaign = await outreachAgent.getCampaign(campaignId, userId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (['completed'].includes(String(campaign.status))) {
      return res.status(409).json({ error: `Campaign is already ${campaign.status}` });
    }

    const cancelledJobs = await outreachSenderWorker.cancelCampaignJobs(campaignId, userId);
    const remaining=await db.execute(sql`SELECT COUNT(*)::int AS count FROM outreach_jobs WHERE campaign_id=${campaignId} AND user_id=${userId}
      AND status='processing' AND metadata->>'providerCallStarted'='true'`);
    const inFlightJobs=Number(remaining.rows[0]?.count)||0;
    return res.json({ success: true, cancelledJobs, inFlightJobs, message: inFlightJobs ? 'Campaign cancelled; already started deliveries may still finish.' : 'Campaign cancelled' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[OutreachController] Error cancelling campaign');
    return res.status(500).json({ error: 'Unable to cancel the campaign. Please try again.' });
  }
}

/** Retry only failures for which the provider explicitly rejected the send. */
export async function retryFailedCampaign(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const campaignId = Number(req.params.id);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: 'A valid campaign ID is required' });
    }
    const campaign = await outreachAgent.getCampaign(campaignId, userId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const retriedJobs = await outreachSenderWorker.retryFailedCampaignJobs(campaignId, userId);
    if (retriedJobs === 0) {
      return res.status(409).json({
        error: 'No safely retryable jobs were found. Messages with uncertain provider outcomes require manual review.',
      });
    }
    return res.json({ success: true, retriedJobs, message: `${retriedJobs} failed job${retriedJobs === 1 ? '' : 's'} queued for retry` });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[OutreachController] Error retrying campaign');
    return res.status(500).json({ error: 'Unable to retry failed campaign jobs. Please try again.' });
  }
}

/**
 * GET /api/outreach/sequences
 * Get all sequences for user
 */
export async function getSequences(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { icp_id, sequence_type } = req.query;

    let query = sql`
      SELECT os.*, ip.campaign_name as icp_campaign_name
      FROM outreach_sequences os
      LEFT JOIN icp_profiles ip ON os.icp_id = ip.id AND ip.user_id = ${userId}
      WHERE os.user_id = ${userId}
    `;

    if (icp_id) {
      query = sql`${query} AND os.icp_id = ${icp_id}`;
    }

    if (sequence_type) {
      query = sql`${query} AND os.sequence_type = ${sequence_type}`;
    }

    query = sql`${query} ORDER BY os.created_at DESC LIMIT 50`;

    const result = await db.execute(query);

    res.json({
      success: true,
      sequences: result.rows,
      count: result.rows.length,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[OutreachController] Error fetching sequences');
    res.status(500).json({ error: 'Unable to retrieve sequences. Please try again.' });
  }
}

export const getCampaignsHandler = getCampaigns;
