import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { logger } from '../../utils/logger.js';
import { countOrZero, deriveOutreachCampaignProgress, type OutreachCampaignProgress, type OutreachJobTotals } from './campaignProgress.js';

export interface OutreachQueueReceipt {
  queuedCount: number;
  failedBeforeEnqueueCount: number;
}

/**
 * Email/SMS jobs own their campaign totals. Serialize reconciliation against the
 * campaign row, then read committed jobs: an enqueue acknowledgement cannot
 * overwrite a fast worker's completion, and replay never increments a counter.
 * Social/BullMQ campaigns have a different ledger and must not enter this path.
 */
export async function reconcileOutreachJobCampaign(
  campaignId: number,
  userId: number,
  queueReceipt?: OutreachQueueReceipt,
): Promise<OutreachCampaignProgress | null> {
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0 || !Number.isSafeInteger(userId) || userId <= 0) return null;
  if (queueReceipt && Object.values(queueReceipt).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Invalid outreach queue receipt');
  }

  return db.transaction(async (tx: typeof db) => {
    const campaignResult = await tx.execute(sql`
      SELECT status, settings, start_date > NOW() AS "scheduledInFuture",
        created_at < NOW() - INTERVAL '10 minutes' AS "queueStalled"
      FROM outreach_campaigns
      WHERE id = ${campaignId} AND user_id = ${userId}
        AND campaign_type IN ('email', 'sms', 'mixed', 'both')
      FOR UPDATE
    `);
    const campaign = campaignResult.rows[0] as {
      status: string; settings: Record<string, unknown> | null; scheduledInFuture: boolean; queueStalled: boolean;
    } | undefined;
    if (!campaign) return null;

    const settings = { ...(campaign.settings || {}) };
    const contradictsFinalizedReceipt = Boolean(queueReceipt && settings.queueStatus && settings.queueStatus !== 'preparing'
      && (countOrZero(settings.queuedCount) !== queueReceipt.queuedCount
        || countOrZero(settings.failedBeforeEnqueueCount) !== queueReceipt.failedBeforeEnqueueCount));
    if (queueReceipt) {
      const selection = settings.selectionSnapshot as { leadIds?: unknown } | undefined;
      if (Array.isArray(selection?.leadIds)
        && queueReceipt.queuedCount + queueReceipt.failedBeforeEnqueueCount !== selection.leadIds.length) {
        throw new Error('The outreach queue receipt does not cover the reviewed recipient selection');
      }
    }

    const result = await tx.execute(sql`
      SELECT
        COUNT(*)::integer AS total,
        ARRAY_AGG(DISTINCT j.lead_id) FILTER (WHERE j.sequence_step_id = 1) AS "persistedLeadIds",
        COUNT(*) FILTER (WHERE j.status = 'pending')::integer AS pending,
        COUNT(*) FILTER (WHERE j.status = 'processing')::integer AS processing,
        COUNT(*) FILTER (WHERE j.status = 'sent' AND NULLIF(TRIM(j.external_message_id), '') IS NOT NULL)::integer AS sent,
        COUNT(*) FILTER (WHERE j.status = 'sent' AND receipt.delivered AND NOT receipt.failed)::integer AS delivered,
        COUNT(*) FILTER (WHERE (j.status = 'failed' AND COALESCE(j.metadata->>'manualReviewRequired', 'false') <> 'true')
          OR (j.status = 'sent' AND receipt.failed))::integer AS failed,
        COUNT(*) FILTER (WHERE j.status = 'sent' AND receipt.failed)::integer AS "deliveryFailed",
        COUNT(*) FILTER (WHERE j.status = 'cancelled')::integer AS cancelled,
        COUNT(*) FILTER (WHERE j.status = 'setup_required')::integer AS "setupRequired",
        COUNT(*) FILTER (WHERE (j.status = 'failed' AND j.metadata->>'manualReviewRequired' = 'true')
          OR (j.status = 'sent' AND NULLIF(TRIM(j.external_message_id), '') IS NULL)
          OR j.status NOT IN ('pending', 'processing', 'sent', 'failed', 'cancelled', 'setup_required'))::integer AS uncertain
      FROM outreach_jobs j
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(BOOL_OR(sm.delivered_at IS NOT NULL OR sm.delivery_status IN ('delivered', 'opened', 'clicked', 'replied')
            OR sm.status IN ('delivered', 'read')), false) AS delivered,
          COALESCE(BOOL_OR(sm.bounced_at IS NOT NULL OR sm.delivery_status IN ('bounced', 'complained', 'failed')
            OR sm.status IN ('bounced', 'complained', 'failed')), false) AS failed
        FROM sent_messages sm
        WHERE sm.user_id = ${userId} AND sm.campaign_id = ${campaignId}
          AND sm.lead_id = j.lead_id AND sm.message_id = j.external_message_id

      ) receipt ON true
      WHERE j.campaign_id = ${campaignId} AND j.user_id = ${userId}
    `);
    const { persistedLeadIds, ...raw } = result.rows[0] as unknown as OutreachJobTotals & { persistedLeadIds: number[] | null };
    const totals = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, countOrZero(value)])) as unknown as OutreachJobTotals;
    const selection = settings.selectionSnapshot as { leadIds?: unknown } | undefined;
    const selectedIds = Array.isArray(selection?.leadIds) ? selection.leadIds : [];
    const selected = new Set(selectedIds);
    const durableIds = persistedLeadIds || [];
    const hasExactSelection = selectedIds.length > 0 && selectedIds.every((id) => Number.isSafeInteger(id) && Number(id) > 0)
      && selected.size === selectedIds.length;
    const unexpectedJobs = hasExactSelection && (durableIds.some((id) => !selected.has(id)) || totals.total !== durableIds.length);
    const coversSelection = hasExactSelection && !unexpectedJobs && durableIds.length === selected.size;
    if (queueReceipt && (totals.total !== queueReceipt.queuedCount || unexpectedJobs || contradictsFinalizedReceipt)) {
      // A job INSERT may commit before its acknowledgement is lost. Never
      // classify that recipient as failed-before-side-effect or safe to resend.
      const knownPreEnqueueFailures = settings.queueStatus === 'preparing' ? 0 : countOrZero(settings.failedBeforeEnqueueCount);
      Object.assign(settings, {
        queueIssue: 'queue_receipt_conflict', queueStatus: 'needs_attention',
        queuedCount: totals.total, failedBeforeEnqueueCount: knownPreEnqueueFailures,
        conflictingQueueReceipt: queueReceipt,
      });
    } else if (queueReceipt) {
      Object.assign(settings, queueReceipt, {
        queueStatus: queueReceipt.queuedCount === 0 ? 'failed'
          : queueReceipt.failedBeforeEnqueueCount > 0 ? 'queued_partial' : 'queued',
      });
      delete settings.queueIssue;
    } else if (settings.queueStatus === 'preparing') {
      if (coversSelection && settings.queueIssue !== 'queue_receipt_conflict') {
        // All approved step-1 jobs exist. The producer's final acknowledgement
        // is dispensable; exact durable coverage is sufficient to close enqueue.
        Object.assign(settings, { queueStatus: 'queued', queuedCount: totals.total, failedBeforeEnqueueCount: 0 });
        delete settings.queueIssue;
      } else if (campaign.queueStalled) {
        // Missing IDs are not assumed failed and are never automatically resent.
        settings.queueIssue = 'enqueue_closure_stalled';
      }
    }
    const progress = deriveOutreachCampaignProgress({ ...campaign, settings }, totals);
    await tx.execute(sql`
      UPDATE outreach_campaigns
      SET status = ${progress.status}, is_active = ${progress.isActive},
          messages_sent = ${progress.sent}, messages_delivered = ${progress.delivered}, messages_failed = ${progress.failed},
          settings = ${JSON.stringify({ ...settings, deliveryProgress: progress })}::jsonb,
          launched_at = CASE WHEN ${totals.processing + totals.sent + totals.failed + totals.uncertain} > 0
            THEN COALESCE(launched_at, NOW()) ELSE launched_at END,
          completed_at = CASE WHEN ${progress.terminal} THEN COALESCE(completed_at, NOW()) ELSE NULL END,
          updated_at = NOW()
      WHERE id = ${campaignId} AND user_id = ${userId}
    `);
    return progress;
  });
}

/** Recover missed worker/finalizer updates without contacting any provider. */
export async function reconcilePendingOutreachJobCampaigns(): Promise<void> {
  const result = await db.execute(sql`
    SELECT id, user_id AS "userId" FROM outreach_campaigns
    WHERE campaign_type IN ('email', 'sms', 'mixed', 'both')
      AND status NOT IN ('cancelled', 'paused')
      AND (status IN ('scheduled', 'queued', 'queued_partial', 'running') OR settings->>'queueStatus' = 'preparing')
    ORDER BY updated_at ASC
    LIMIT 100
  `);
  for (const campaign of result.rows as Array<{ id: number; userId: number }>) {
    try { await reconcileOutreachJobCampaign(campaign.id, campaign.userId); }
    catch (error) { logger.error({ err: error, campaignId: campaign.id }, '[Outreach] Campaign reconciliation will retry on the next pass'); }
  }
}

/** Called only after the existing email webhook/provider verification boundary. */
export async function recordOutreachEmailDelivery(externalMessageId: string, status: string, error?: string) {
  if (!externalMessageId.trim() || !['sent', 'delivered', 'read', 'bounced', 'complained'].includes(status)) return;
  const incomingFailure = status === 'bounced' || status === 'complained';
  const incomingDelivery = status === 'delivered' || status === 'read';
  const result = await db.execute(sql`
    UPDATE sent_messages
    SET status = CASE
          WHEN status IN ('bounced', 'complained') THEN status
          WHEN ${incomingFailure} THEN ${status}
          WHEN status IN ('delivered', 'read') AND ${status} = 'sent' THEN status
          ELSE ${status === 'read' ? 'delivered' : status}
        END,
        delivery_status = CASE
          WHEN delivery_status IN ('bounced', 'complained') THEN delivery_status
          WHEN ${incomingFailure} THEN ${status}
          WHEN delivery_status IN ('opened', 'clicked', 'replied') THEN delivery_status
          WHEN delivery_status = 'delivered' AND ${status} = 'sent' THEN delivery_status
          ELSE ${status === 'read' ? 'opened' : status}
        END,
        delivered_at = CASE WHEN ${incomingDelivery} THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
        opened_at = CASE WHEN ${status} = 'read' THEN COALESCE(opened_at, NOW()) ELSE opened_at END,
        bounced_at = CASE WHEN ${incomingFailure} THEN COALESCE(bounced_at, NOW()) ELSE bounced_at END,
        bounce_reason = CASE WHEN ${incomingFailure} THEN COALESCE(bounce_reason, ${error || status}) ELSE bounce_reason END,
        updated_at = NOW()
    WHERE message_id = ${externalMessageId} AND channel IN ('email', 'gmail', 'resend')

    RETURNING user_id AS "userId", campaign_id AS "campaignId"
  `);
  const seen = new Set<string>();
  for (const row of result.rows as Array<{ userId: number | null; campaignId: number | null }>) {
    const key = `${row.userId}:${row.campaignId}`;
    if (seen.has(key) || !row.userId || !row.campaignId) continue;
    seen.add(key);
    await reconcileOutreachJobCampaign(row.campaignId, row.userId);
  }
}
