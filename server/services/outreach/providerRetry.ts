import { DelayedError, type Job } from "bullmq";
import {
  deliveryOutcomeIsUncertain,
  type DeliveryOutcomeEvidence,
} from "./deliveryOutcome.js";

export const WHATSAPP_APP_RATE_LIMIT = 'WHATSAPP_APP_RATE_LIMIT';
export const WHATSAPP_MARKETING_LIMIT = 131049;
export const WHATSAPP_MARKETING_RETRY_INTERVAL_MS = 4 * 60 * 60_000;

/** Only explicit provider rejections are safe to retry. Never infer this from error text. */
export function metaRetryable(code: unknown, status?: number): boolean {
  return (
    status === 429 ||
    [1, 2, 4, 17, 32, 613, 80007, 130429, 131000, 131056, 131049].includes(
      Number(code),
    )
  );
}

export function providerRetryAfter(
  value: string | null,
  now = Date.now(),
): string | undefined {
  if (!value?.trim()) return;
  const seconds = Number(value);
  const due =
    Number.isFinite(seconds) && seconds >= 0
      ? now + seconds * 1000
      : Date.parse(value);
  return Number.isFinite(due) && due > now
    ? new Date(due).toISOString()
    : undefined;
}

export function providerRetryTime(
  attempt: number,
  code?: unknown,
  retryAt?: string,
  now = Date.now(),
): number {
  const minimum =
    Number(code) === WHATSAPP_MARKETING_LIMIT
      ? WHATSAPP_MARKETING_RETRY_INTERVAL_MS
      : Math.min(15 * 60_000, 30_000 * 2 ** Math.min(Math.max(attempt, 0), 10));
  const providerTime = retryAt ? Date.parse(retryAt) : NaN;
  return Math.max(
    now + minimum,
    Number.isFinite(providerTime) ? providerTime : 0,
  );
}

export function nextDailyCapacityTime(now = Date.now()): number {
  const day = new Date(now);
  day.setUTCHours(24, 0, 0, 0);
  return day.getTime() + 1000;
}

export async function delayRejectedProvider(
  job: Job,
  result: DeliveryOutcomeEvidence & {
    success: boolean;
    retryable?: boolean;
    providerCode?: unknown;
    retryAt?: string;
  },
  releaseClaim: (retryAt: string, attempt: number) => Promise<void>,
  expiresAt?: Date | string | null,
): Promise<"confirmation_expired" | undefined> {
  if (
    result.success ||
    result.retryable !== true ||
    deliveryOutcomeIsUncertain(result)
  )
    return;
  const retries = Number(job.data.providerRateLimitRetries || 0);
  const appLimited = result.providerCode === WHATSAPP_APP_RATE_LIMIT
    && result.deliveryAttempted === false;
  const marketingLimited = Number(result.providerCode) === WHATSAPP_MARKETING_LIMIT;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries >= Number.MAX_SAFE_INTEGER
    || (!appLimited && !marketingLimited && retries + 1 >= 5)) return;
  // Capacity checks happen before the HTTP call. Waiting for the app's own
  // window must not consume the provider-rejection retry budget.
  const due = appLimited
    ? Math.max(Date.now() + 1000, Date.parse(result.retryAt || '') || Date.now() + 61_000)
    : providerRetryTime(retries, result.providerCode, result.retryAt);
  if (expiresAt && new Date(expiresAt).getTime() <= due)
    return "confirmation_expired";
  const nextRetry = appLimited ? retries : retries + 1;
  if (!appLimited) await job.updateData({ ...job.data, providerRateLimitRetries: nextRetry });
  await releaseClaim(new Date(due).toISOString(), nextRetry);
  await job.moveToDelayed(due, job.token);
  throw new DelayedError();
}
