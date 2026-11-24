/** Durable delivery totals. Acceptance and delivery are different milestones. */
export interface OutreachJobTotals {
  total: number;
  pending: number;
  processing: number;
  sent: number;
  delivered: number;
  failed: number;
  deliveryFailed: number;
  cancelled: number;
  uncertain: number;
  setupRequired?: number;
}

export interface OutreachCampaignProgress extends OutreachJobTotals {
  version: 1;
  enqueueComplete: boolean;
  failedBeforeEnqueue: number;
  missingJobs: number;
  queueIssue: string | null;
  status: string;
  isActive: boolean;
  terminal: boolean;
}

export function countOrZero(value: unknown): number {
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function deriveOutreachCampaignProgress(
  campaign: { status: string; settings: Record<string, unknown>; scheduledInFuture: boolean },
  totals: OutreachJobTotals,
): OutreachCampaignProgress {
  const failedBeforeEnqueue = countOrZero(campaign.settings.failedBeforeEnqueueCount);
  const enqueueComplete = campaign.settings.queueStatus !== 'preparing';
  const expectedJobs = countOrZero(campaign.settings.queuedCount);
  const missingJobs = enqueueComplete ? Math.max(0, expectedJobs - totals.total) : 0;
  const failed = totals.failed + failedBeforeEnqueue;
  const outstanding = totals.pending + totals.processing;
  const acceptedWithoutFailure = Math.max(0, totals.sent - totals.deliveryFailed);
  const queueIssue = typeof campaign.settings.queueIssue === 'string' ? campaign.settings.queueIssue : null;
  let status = campaign.status;
  let terminal = false;

  // Cancellation/pause is owned by the client, not undone by a late receipt.
  if (status === 'cancelled') {
    terminal = true;
  } else if (status !== 'paused') {
    if (countOrZero(totals.setupRequired) > 0) {
      status = 'needs_attention';
      terminal = true;
    } else if (queueIssue) {
      status = 'needs_attention';
      terminal = true;
    } else if (!enqueueComplete) {
      status = totals.sent + totals.failed + totals.processing + totals.uncertain > 0 ? 'running' : 'scheduled';
    } else if (outstanding > 0) {
      status = totals.processing + totals.sent + totals.failed + totals.uncertain > 0 || status === 'running'
        ? 'running'
        : campaign.scheduledInFuture ? 'scheduled' : failedBeforeEnqueue > 0 ? 'queued_partial' : 'queued';
    } else if (missingJobs > 0 || totals.uncertain > 0) {
      status = 'needs_attention';
      terminal = true;
    } else if (failed > 0) {
      status = acceptedWithoutFailure > 0 ? 'partial_success' : 'failed';
      terminal = true;
    } else if (totals.cancelled > 0) {
      status = totals.sent > 0 ? 'partial_success' : 'cancelled';
      terminal = true;
    } else if (totals.sent > 0) {
      status = 'completed';
      terminal = true;
    }
    // Zero durable jobs without a completed enqueue receipt is not completion.
  }

  return {
    ...totals, version: 1, failed, failedBeforeEnqueue, enqueueComplete, missingJobs, queueIssue,
    status, terminal, isActive: !terminal && status !== 'paused' && status !== 'draft',
  };
}
