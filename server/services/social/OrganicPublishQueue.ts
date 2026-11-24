import type { SocialPublishAttempt } from '../../models/socialPublishAttempts/schema.js';
import { SocialPublishAttemptModel } from '../../models/socialPublishAttempts/functions.js';
import { queueRegistry, QUEUE_NAMES } from '../../queues/index.js';
import { authorizeOrganicPublishOrigin, assertOrganicJobOrigin } from './OrganicPublishAuthority.js';
import type { JobBusinessPayload } from '../../tenancy/jobBusinessScope.js';

export async function enqueueOrganicPublishAttempt(attempt: SocialPublishAttempt) {
  const origin = await authorizeOrganicPublishOrigin(attempt);
  return queueRegistry.addJob(QUEUE_NAMES.ORGANIC_PUBLISHING, 'publish-attempt', {
    ...origin, attemptId: attempt.id, createdAt: new Date().toISOString(),
  }, {
    jobId: `organic-${attempt.id}-${attempt.status}-${attempt.nextAttemptAt.getTime()}`,
    // The durable attempt owns history and retry eligibility. A failed Redis
    // job must not retain this key and suppress later cron recovery after an
    // infrastructure outage exhausts BullMQ's immediate retries.
    removeOnFail: true,
  });
}

/** The database claim is authoritative even when Redis redelivers a job. */
export async function processOrganicPublishJob(data: JobBusinessPayload & { userId: number; attemptId: number }, workerId: string) {
  const attempt = await SocialPublishAttemptModel.findByIdForUser(data.attemptId, data.userId);
  if (!attempt || attempt.nextAttemptAt.getTime() > Date.now()) return { skipped: true };
  if (['cancelled', 'succeeded', 'failed', 'claimed', 'remote_deleted'].includes(attempt.status)) return { skipped: true };
  assertOrganicJobOrigin(data, attempt);
  await authorizeOrganicPublishOrigin(attempt);
  const { executeOrganicPublishAttempt, reconcileAmbiguousOrganicAttempt } = await import('./OrganicPublishingService.js');
  if (attempt.status === 'provider_succeeded') return executeOrganicPublishAttempt(attempt.id, attempt.userId, workerId);
  if (attempt.status === 'ambiguous') {
    if (!await SocialPublishAttemptModel.claimReconciliation(attempt.id, attempt.userId, workerId)) return { skipped: true };
    try {
      return await reconcileAmbiguousOrganicAttempt(attempt, attempt.userId);
    } finally {
      await SocialPublishAttemptModel.releaseReconciliation(attempt.id, attempt.userId, workerId);
    }
  }
  if (!['pending', 'retryable_failed'].includes(attempt.status)) return { skipped: true };
  return executeOrganicPublishAttempt(attempt.id, attempt.userId, workerId);
}
