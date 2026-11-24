import { captureJobBusiness, type JobBusinessPayload } from '../../tenancy/jobBusinessScope.js';
import { BillingOrganizationError } from '../billing/organizations.js';
import type { OrganicPublishOrigin, SocialPublishAttempt } from '../../models/socialPublishAttempts/schema.js';

/** Capture new reviewed work in its authenticated request, never in recovery. */
export async function captureOrganicPublishOrigin(userId: number): Promise<OrganicPublishOrigin> {
  const captured = await captureJobBusiness<JobBusinessPayload>({ userId });
  return { userId: captured.userId!, businessProfileId: captured.businessProfileId!,
    businessActorUserId: captured.businessActorUserId!, billingOrganizationId: captured.billingOrganizationId!,
    billingActorUserId: captured.billingActorUserId! };
}

/** Recovery retains the original actor/payer even in an owner's cron scope. */
export async function authorizeOrganicPublishOrigin(attempt: SocialPublishAttempt): Promise<OrganicPublishOrigin> {
  const origin = attempt.reviewedPayload.publicationOrigin;
  const captured = await captureJobBusiness<JobBusinessPayload>(origin || {}, { requireOriginatingIdentity: true });
  if (captured.userId !== attempt.userId || captured.businessProfileId !== attempt.businessProfileId
    || captured.businessActorUserId !== attempt.reviewedPayload.approvedBy) {
    throw new BillingOrganizationError('The publication origin does not match its durable approval.', 403, 'JOB_ACTOR_MISMATCH');
  }
  return captured as OrganicPublishOrigin;
}

export function assertOrganicJobOrigin(data: Record<string, unknown>, attempt: SocialPublishAttempt) {
  const origin = attempt.reviewedPayload.publicationOrigin;
  if (!origin) throw new BillingOrganizationError('This legacy publication has no originating authority. Review it before retrying.', 409, 'JOB_ORIGIN_REQUIRED');
  if ((Object.keys(origin) as Array<keyof OrganicPublishOrigin>).some(key => data[key] !== origin[key])) {
    throw new BillingOrganizationError('The queued actor or business conflicts with the publication origin.', 403, 'JOB_ACTOR_MISMATCH');
  }
}
