import { DelayedError, type Job } from 'bullmq';
import { deliveryOutcomeIsUncertain, type DeliveryOutcomeEvidence } from './deliveryOutcome.js';

export interface EmailRetryEvidence extends DeliveryOutcomeEvidence {
  success: boolean;
  retryable?: boolean;
  retryAt?: string;
}

export function emailRetryTime(attempt: number, retryAt?: string, now = Date.now()): number {
  const backoff = now + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(Math.max(attempt, 0), 10));
  const providerTime = retryAt ? Date.parse(retryAt) : NaN;
  return Number.isFinite(providerTime) ? Math.max(backoff, providerTime) : backoff;
}

/** Delay the same durable job without holding a worker or repeating an uncertain send. */
export async function delayRejectedEmail(
  job: Job,
  result: EmailRetryEvidence,
  releaseClaim: (retryAt: string) => Promise<void>,
  confirmationExpiresAt?: Date | string | null,
): Promise<'confirmation_expired' | undefined> {
  if (result.success || result.retryable !== true || deliveryOutcomeIsUncertain(result)) return;
  const retries = Number(job.data.emailRateLimitRetries || 0);
  if (!Number.isSafeInteger(retries) || retries < 0 || retries + job.attemptsMade + 1 >= Number(job.opts.attempts || 1)) return;
  const due = emailRetryTime(retries + job.attemptsMade, result.retryAt);
  if (confirmationExpiresAt && new Date(confirmationExpiresAt).getTime() <= due) return 'confirmation_expired';
  await job.updateData({ ...job.data, emailRateLimitRetries: retries + 1 });
  await releaseClaim(new Date(due).toISOString());
  await job.moveToDelayed(due, job.token);
  throw new DelayedError();
}
