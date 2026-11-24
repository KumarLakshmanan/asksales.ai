import { asRecord as record } from '../../shared/records.js';
export { record };
/** Pure projection of durable review/job/provider receipts. No provider calls. */
export type OutreachReview = {
  id: number;
  userId?: number;
  threadId?: number;
  toolName: string;
  status: string;
  formValues?: Record<string, unknown> | null;
  submittedValues?: Record<string, unknown> | null;
  executionResult?: unknown;
};

export type RecipientState = 'queued' | 'sent' | 'delivered' | 'failed' | 'cancelled' | 'unavailable';
export type RecipientDelivery = { leadId: number; state: RecipientState; evidence: string };
export type ReviewDelivery = {
  reviewId: number;
  channel: string;
  recipients: RecipientDelivery[];
  counts: Record<RecipientState, number>;
  unavailableReason?: string;
};
export type OutreachDeliveryReport = {
  source: 'review_correlations';
  reviews: ReviewDelivery[];
  unavailableReason?: string;
};
export type DeliveryJob = {
  id: number; userId: number; leadId: number; campaignId: number | null;
  channel: string; sequenceStepId: number | null; status: string;
  externalMessageId: string | null; metadata?: unknown;
};
export type ProviderReceipt = {
  userId: number; leadId: number; channel: string; campaignId: number | null;
  messageId: string; status: string; deliveryStatus?: string | null;
  deliveredAt?: unknown; bouncedAt?: unknown;
  reviewId?: number; threadId?: number; internalMessageId?: number; providerCallState?: string;
};

export function positiveId(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
const messageId = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
export const canonicalChannel = (value: unknown): string =>
  value === 'gmail' || value === 'resend' ? 'email' : typeof value === 'string' ? value : '';

export function reviewCorrelation(review: OutreachReview) {
  const values = review.submittedValues || review.formValues || {};
  const result = record(review.executionResult);
  const output = Object.keys(record(result.output)).length ? record(result.output) : result;
  const rawIds = values.lead_ids;
  // Reject malformed selections rather than silently reporting a subset.
  const leadIds = Array.isArray(rawIds) && rawIds.every(id => positiveId(id) !== undefined)
    ? [...new Set(rawIds.map(id => positiveId(id)!))] : [];
  return {
    leadIds, channel: canonicalChannel(values.channel), campaignId: positiveId(output.campaignId),
    results: Array.isArray(output.results) ? output.results.map(record) : [],
    outcomes: record(result.reconciliationJobOutcomes), output,
  };
}

export function jobsForRecipient(review: OutreachReview, leadId: number, jobs: DeliveryJob[]): DeliveryJob[] {
  const scope = reviewCorrelation(review);
  const acknowledgedIds = scope.results.filter(row => positiveId(row.leadId) === leadId)
    .map(row => positiveId(row.jobId)).filter(id => id !== undefined);
  return jobs.filter(job => job.userId === review.userId && job.leadId === leadId
    && canonicalChannel(job.channel) === scope.channel
    && (scope.campaignId !== undefined
      ? job.campaignId === scope.campaignId && job.sequenceStepId === 1
      : acknowledgedIds.includes(job.id)));
}

/** Provider IDs come only from exact jobs or this widget's per-job outcome. */
export function providerTargets(review: OutreachReview, jobs: DeliveryJob[]) {
  const scope = reviewCorrelation(review);
  return scope.leadIds.flatMap(leadId => {
    const direct = jobsForRecipient(review, leadId, jobs);
    if (direct.length === 1 && messageId(direct[0].externalMessageId)) {
      return [{ leadId, channel: scope.channel, campaignId: direct[0].campaignId, messageId: direct[0].externalMessageId!, allowUnassignedCampaign: false }];
    }
    if (scope.channel === 'email' || scope.channel === 'sms') return [];
    return scope.results.filter(row => positiveId(row.leadId) === leadId && row.success === true).flatMap(row => {
      const outcome = record(scope.outcomes[String(row.jobId)]);
      const result = record(outcome.result);
      const id = messageId(result.externalMessageId) || messageId(result.messageId);
      return outcome.success === true && result.success === true && id
        ? [{ leadId, channel: scope.channel, campaignId: scope.campaignId ?? null, messageId: id, allowUnassignedCampaign: true }] : [];
    });
  });
}

export function projectReviewDelivery(review: OutreachReview, jobs: DeliveryJob[], receipts: ProviderReceipt[]): ReviewDelivery {
  const scope = reviewCorrelation(review);
  const targets = providerTargets(review, jobs);
  const recipients = scope.leadIds.map((leadId): RecipientDelivery => {
    const unavailable = (evidence: string): RecipientDelivery => ({ leadId, state: 'unavailable', evidence });
    const direct = jobsForRecipient(review, leadId, jobs);
    const results = scope.results.filter(row => positiveId(row.leadId) === leadId);
    if (direct.length > 1 || results.length > 1) return unavailable('Ambiguous recipient/job correlation');
    const values = review.submittedValues || review.formValues || {};
    const creation = record(values.outreach_review).creationVersion === 1;
    if (creation && results.length === 1 && positiveId(results[0].messageId)) {
      const matching = receipts.filter(row => row.reviewId === review.id && row.threadId === review.threadId
        && row.internalMessageId === positiveId(results[0].messageId) && row.userId === review.userId
        && row.leadId === leadId && canonicalChannel(row.channel) === scope.channel);
      if (matching.length !== 1) return unavailable('No unique owned initial-message receipt for this review');
      const row = matching[0];
      if (row.providerCallState === 'unknown' || row.status === 'manual_review') return unavailable('Provider outcome requires manual review');
      if (row.status === 'failed' || row.status === 'bounced') return { leadId, state: 'failed', evidence: 'Exact reviewed message records delivery failure' };
      if (row.status === 'cancelled') return { leadId, state: 'cancelled', evidence: 'Exact reviewed message was cancelled' };
      if (row.deliveredAt || ['delivered', 'read'].includes(row.status)) return { leadId, state: 'delivered', evidence: 'Exact reviewed message records delivery' };
      if (row.status === 'sent' && row.providerCallState === 'confirmed') return { leadId, state: 'sent', evidence: 'Exact reviewed message has provider acceptance' };
      if (['pending', 'sending'].includes(row.status)) return { leadId, state: 'queued', evidence: 'Exact reviewed message is awaiting provider confirmation' };
      return unavailable('Exact reviewed message is blocked or has no confirmed provider outcome');
    }
    let state: RecipientState = 'unavailable';
    let evidence = 'No exact durable job or provider correlation';
    if (direct.length === 1) {
      const job = direct[0];
      if (job.status === 'setup_required') {
        evidence = 'Assistant setup required. Review this account assignment and prepare a new delivery.';
      } else if (record(job.metadata).manualReviewRequired === true) {
        evidence = 'Provider outcome requires manual review';
      } else if (job.status === 'pending' || job.status === 'processing') {
        state = 'queued'; evidence = `outreach_jobs #${job.id}: ${job.status}`;
      } else if (job.status === 'failed' || job.status === 'cancelled') {
        state = job.status; evidence = `outreach_jobs #${job.id}: ${job.status}`;
      } else if (job.status === 'sent' && messageId(job.externalMessageId)) {
        state = 'sent'; evidence = `outreach_jobs #${job.id}: provider receipt persisted`;
      }
    } else if (scope.channel !== 'email' && scope.channel !== 'sms' && results.length === 1) {
      const queued = results[0];
      const outcome = record(scope.outcomes[String(queued.jobId)]);
      const result = record(outcome.result);
      if (queued.success === true && messageId(String(queued.jobId ?? ''))) {
        if (outcome.success === true && result.success === true && targets.some(target => target.leadId === leadId)) {
          state = 'sent'; evidence = 'Review job outcome includes a provider receipt';
        } else if (outcome.success === false && result.success === false && result.suppressed !== true) {
          state = 'failed'; evidence = 'Review job outcome records a rejected send';
        } else if (Object.keys(outcome).length === 0) {
          state = 'queued'; evidence = 'Persisted queue acknowledgement; current worker state unavailable';
        } else {
          evidence = 'Worker outcome has no confirmed provider receipt; retries or suppression may apply';
        }
      }
    }
    // An enqueue error can follow a committed INSERT. Only explicit safe failure
    // receipts authorize a failed-before-enqueue classification without a job.
    if (direct.length === 0 && results.length === 1 && results[0].success === false
      && scope.output.status === 'failed_before_side_effect' && scope.output.retrySafe === true) {
      state = 'failed'; evidence = 'Review records failure before side effects';
    }
    const matching = receipts.filter(receipt => receipt.userId === review.userId && receipt.leadId === leadId
      && canonicalChannel(receipt.channel) === scope.channel && targets.some(target => target.leadId === leadId
        && receipt.messageId === target.messageId && (receipt.campaignId === target.campaignId
          || (target.allowUnassignedCampaign && receipt.campaignId === null))));
    if (matching.some(row => row.bouncedAt || ['failed', 'bounced', 'complained'].includes(row.status)
      || ['failed', 'bounced', 'complained'].includes(row.deliveryStatus || ''))) {
      state = 'failed'; evidence = 'Exact provider receipt records delivery failure';
    } else if (matching.some(row => row.deliveredAt || ['delivered', 'read'].includes(row.status)
      || ['delivered', 'opened', 'clicked', 'replied'].includes(row.deliveryStatus || ''))) {
      state = 'delivered'; evidence = 'Exact provider receipt records delivery';
    }
    return { leadId, state, evidence };
  });
  const counts: ReviewDelivery['counts'] = { queued: 0, sent: 0, delivered: 0, failed: 0, cancelled: 0, unavailable: 0 };
  for (const recipient of recipients) counts[recipient.state] += 1;
  return { reviewId: review.id, channel: scope.channel, recipients, counts,
    ...(!scope.leadIds.length ? { unavailableReason: 'Exact reviewed recipients are missing or invalid' } : {}) };
}
