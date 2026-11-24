import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import {
  positiveId, projectReviewDelivery, providerTargets, reviewCorrelation, record,
  type DeliveryJob, type OutreachDeliveryReport, type OutreachReview, type ProviderReceipt,
} from './campaignActionDeliveryState.js';

export const MAX_STATUS_REVIEW_IDS = 100;

/** Read-only, bounded, tenant + conversation + review scoped. Never consults Redis
 * or providers, and never falls back to all messages for a lead. */
export async function storedOutreachStatusForReviews(
  userId: number,
  threadId: number,
  widgetIds: readonly number[],
): Promise<OutreachDeliveryReport> {
  const unavailable = (reason: string): OutreachDeliveryReport => ({
    source: 'review_correlations', reviews: [], unavailableReason: reason,
  });
  if (!positiveId(userId) || !positiveId(threadId) || widgetIds.length > MAX_STATUS_REVIEW_IDS
    || widgetIds.some(id => positiveId(id) === undefined)) {
    return unavailable(`Status requires valid account/conversation IDs and at most ${MAX_STATUS_REVIEW_IDS} exact review IDs`);
  }
  const ids = [...new Set(widgetIds)];
  if (!ids.length) return { source: 'review_correlations', reviews: [] };
  try {
    const selected = await db.execute(sql`
      SELECT id, user_id AS "userId", thread_id AS "threadId", tool_name AS "toolName", status,
        form_values AS "formValues", submitted_values AS "submittedValues", execution_result AS "executionResult"
      FROM widget_states
      WHERE user_id = ${userId} AND thread_id = ${threadId}
        AND id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
        AND tool_name = 'send_outreach_messages'
      ORDER BY id DESC LIMIT ${MAX_STATUS_REVIEW_IDS}
    `);
    const reviews = (selected.rows as OutreachReview[]).filter(review => review.userId === userId
      && review.threadId === threadId && ids.includes(review.id) && review.toolName === 'send_outreach_messages');
    const jobScopes = reviews.flatMap(review => {
      const scope = reviewCorrelation(review);
      if (scope.channel !== 'email' && scope.channel !== 'sms') return [];
      return scope.leadIds.map(leadId => ({
        leadId, channel: scope.channel, campaignId: scope.campaignId ?? null,
        jobIds: scope.results.filter(row => positiveId(row.leadId) === leadId)
          .map(row => positiveId(row.jobId)).filter(id => id !== undefined),
      })).filter(row => row.campaignId !== null || row.jobIds.length);
    });
    const jobs = jobScopes.length ? (await db.execute(sql`
      SELECT DISTINCT j.id, j.user_id AS "userId", j.lead_id AS "leadId", j.campaign_id AS "campaignId",
        j.channel, j.sequence_step_id AS "sequenceStepId", j.status,
        j.external_message_id AS "externalMessageId", j.metadata
      FROM outreach_jobs j
      JOIN jsonb_to_recordset(${JSON.stringify(jobScopes)}::jsonb)
        AS scope("leadId" integer, channel text, "campaignId" integer, "jobIds" jsonb)
        ON j.lead_id = scope."leadId" AND j.channel = scope.channel
        AND ((scope."campaignId" IS NOT NULL AND j.campaign_id = scope."campaignId" AND j.sequence_step_id = 1)
          OR (scope."campaignId" IS NULL AND scope."jobIds" @> to_jsonb(j.id)))
      LEFT JOIN outreach_campaigns c ON c.id = j.campaign_id AND c.user_id = ${userId}
      WHERE j.user_id = ${userId} AND (j.campaign_id IS NULL OR c.id IS NOT NULL)
    `)).rows as DeliveryJob[] : [];
    const targets = reviews.flatMap(review => providerTargets(review, jobs));
    const receipts = targets.length ? (await db.execute(sql`
      WITH targets AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(targets)}::jsonb)
          AS t("leadId" integer, channel text, "campaignId" integer, "messageId" text, "allowUnassignedCampaign" boolean)
      )
      SELECT sm.user_id AS "userId", sm.lead_id AS "leadId", sm.channel, sm.campaign_id AS "campaignId",
        sm.message_id AS "messageId", sm.status, sm.delivery_status AS "deliveryStatus",
        sm.delivered_at AS "deliveredAt", sm.bounced_at AS "bouncedAt"
      FROM sent_messages sm JOIN targets t ON sm.lead_id = t."leadId" AND sm.message_id = t."messageId"
        AND (sm.channel = t.channel OR (t.channel = 'email' AND sm.channel IN ('gmail', 'resend')))
        AND (sm.campaign_id IS NOT DISTINCT FROM t."campaignId" OR (t."allowUnassignedCampaign" AND sm.campaign_id IS NULL))
      WHERE sm.user_id = ${userId} AND COALESCE(sm.is_reply, false) = false
        AND COALESCE(sm.follow_up_step, 0) = 0
      UNION ALL
      SELECT om.user_id AS "userId", oc.lead_id AS "leadId", oc.channel, om.campaign_id AS "campaignId",
        t."messageId", om.status, NULL AS "deliveryStatus", om.delivered_at AS "deliveredAt", NULL AS "bouncedAt"
      FROM outreach_messages om
      JOIN outreach_conversations oc ON oc.id = om.conversation_id AND oc.user_id = ${userId}
      JOIN targets t ON oc.lead_id = t."leadId"
        AND (oc.channel = t.channel OR (t.channel = 'email' AND oc.channel IN ('gmail', 'resend')))
        AND (om.external_message_id = t."messageId" OR om.provider_message_id = t."messageId" OR om.waba_message_id = t."messageId")
        AND (om.campaign_id IS NOT DISTINCT FROM t."campaignId" OR (t."allowUnassignedCampaign" AND om.campaign_id IS NULL))
      WHERE om.user_id = ${userId} AND om.direction = 'outbound' AND om.message_kind = 'outreach'
    `)).rows as ProviderReceipt[] : [];
    const creationScopes = reviews.flatMap(review => {
      const values = review.submittedValues || review.formValues || {};
      if (record(values.outreach_review).creationVersion !== 1) return [];
      const scope = reviewCorrelation(review);
      return scope.results.flatMap(row => {
        const messageId = positiveId(row.messageId), leadId = positiveId(row.leadId);
        return messageId && leadId && scope.leadIds.includes(leadId)
          ? [{ reviewId: review.id, threadId, leadId, messageId, channel: scope.channel }] : [];
      });
    });
    const creationReceipts = creationScopes.length ? (await db.execute(sql`
      SELECT w.id AS "reviewId", w.thread_id AS "threadId", m.id AS "internalMessageId",
        m.user_id AS "userId", c.lead_id AS "leadId", c.channel,
        m.campaign_id AS "campaignId", COALESCE(m.provider_message_id,m.external_message_id,m.waba_message_id,'') AS "messageId",
        m.status, m.provider_call_state AS "providerCallState", m.delivered_at AS "deliveredAt"
      FROM jsonb_to_recordset(${JSON.stringify(creationScopes)}::jsonb)
        AS scope("reviewId" integer,"threadId" integer,"leadId" integer,"messageId" integer,channel text)
      JOIN widget_states w ON w.id=scope."reviewId" AND w.thread_id=scope."threadId" AND w.user_id=${userId}
      JOIN outreach_messages m ON m.id=scope."messageId" AND m.user_id=w.user_id AND m.business_profile_id=w.business_profile_id
        AND m.direction='outbound' AND m.message_kind='outreach'
        AND m.metadata#>>'{outreachCreation,delivery,widgetId}'=w.id::text
        AND m.metadata#>>'{outreachCreation,delivery,threadId}'=w.thread_id::text
      JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=w.user_id AND c.business_profile_id=w.business_profile_id
        AND c.lead_id=scope."leadId" AND c.channel=scope.channel
    `)).rows as ProviderReceipt[] : [];
    return { source: 'review_correlations', reviews: reviews.map(review => projectReviewDelivery(review, jobs, [...receipts, ...creationReceipts])),
      ...(!reviews.length ? { unavailableReason: 'No owned outreach reviews matched the requested conversation and IDs' } : {}) };
  } catch {
    // A failed ledger read must never become a zero-send claim or a leaked DB error.
    return unavailable('Persisted outreach status could not be read; delivery counts are unavailable');
  }
}

/** @deprecated Recipient IDs cannot establish campaign ownership. Kept fail-closed
 * while callers migrate to storedOutreachStatusForReviews(userId, threadId, widgetIds). */
export async function storedOutreachCountsForRecipients(_userId: number, _leadIds: number[]): Promise<OutreachDeliveryReport> {
  return { source: 'review_correlations', reviews: [], unavailableReason: 'Recipient IDs alone cannot correlate outreach to a review' };
}
