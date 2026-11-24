import { currentBillingScope, withBillingScope } from "./billingContext.js";
import { requireApprovedBusiness } from './businessLifecycle.js';
import {
  BillingOrganizationError,
  resolveBillingOrganization,
} from "../services/billing/organizations.js";
import { db } from "../models/db.js";
import { sql } from "drizzle-orm";
import {
  currentBusinessScope,
  withBusinessScope,
  withSystemScope,
} from "./businessContext.js";
import {
  forEachBusiness,
  resolveBusinessScope,
  scopeForRecord,
} from "./businessScopeResolver.js";

export type JobBusinessPayload = {
  userId?: number;
  businessProfileId?: number;
  businessActorUserId?: number;
  billingOrganizationId?: number;
  billingActorUserId?: number;
  systemJob?: boolean;
  type?: string;
};
type Payload = JobBusinessPayload;
export type JobBusinessCaptureOptions = {
  /** Recovery must provide the immutable originating snapshot, not ambient
   * inventory authority. Missing legacy identity needs review, never promotion. */
  requireOriginatingIdentity?: boolean;
};
const IDENTITY_FIELDS = [
  'userId', 'businessProfileId', 'businessActorUserId',
  'billingOrganizationId', 'billingActorUserId',
] as const;

function validateIdentity(data: Payload, required = false) {
  for (const field of IDENTITY_FIELDS) {
    const value = data[field];
    if ((required || value !== undefined) && (!Number.isSafeInteger(value) || Number(value) <= 0))
      throw new BillingOrganizationError(
        'This job has no complete originating authority. Review it before retrying.',
        409, 'JOB_ORIGIN_REQUIRED',
      );
  }
  if (data.businessActorUserId !== undefined && data.billingActorUserId !== undefined
    && data.businessActorUserId !== data.billingActorUserId)
    throw new BillingOrganizationError('Job business and billing actors conflict.', 403, 'JOB_ACTOR_MISMATCH');
}
const REFERENCES = [
  ["threadId", "chat_threads"],
  ["attemptId", "social_publish_attempts"],
  ["entryId", "knowledge_base"],
  ["assetId", "content_assets"],
  ["parentAssetId", "content_assets"],
  ["projectId", "ai_visibility_projects"],
  ["conversationId", "outreach_conversations"],
  ["leadId", "leads"],
  ["actionId", "ad_action_queue"],
] as const;

async function captureBusiness<T extends Payload>(data: T): Promise<T> {
  const current = currentBusinessScope();
  const actorUserId = data.businessActorUserId ?? data.billingActorUserId
    ?? current?.actorUserId ?? current?.userId;
  if (!actorUserId)
    throw new BillingOrganizationError('This job has no originating actor. Review it before retrying.', 409, 'JOB_ORIGIN_REQUIRED');
  if (current) {
    if (data.userId && data.userId !== current.userId)
      throw new Error("Job account does not match the business");
    if (
      data.businessProfileId &&
      data.businessProfileId !== current.businessProfileId
    )
      throw new Error("Job business does not match its origin");
    return {
      ...data,
      userId: current.userId,
      businessProfileId: current.businessProfileId,
      businessActorUserId: actorUserId,
      billingActorUserId: data.billingActorUserId ?? actorUserId,
      systemJob: false,
    };
  }
  if (data.businessProfileId && data.userId) {
    if (!(await resolveBusinessScope(data.userId, data.businessProfileId)))
      throw new Error("Job business is unavailable");
    return data;
  }
  // Persisted work created before the rollout can recover from an immutable
  // owning entity. Never resolve it from the account's current default.
  for (const [field, table] of REFERENCES) {
    const id = (data as Record<string, unknown>)[field];
    if (typeof id !== "number" && typeof id !== "string") continue;
    const scope = await scopeForRecord(table, id);
    if (scope && (!data.userId || scope.userId === data.userId))
      return { ...data, ...scope };
  }
  if (data.userId) {
    const result = await db.execute(
      sql`SELECT id FROM company_settings WHERE user_id=${data.userId} ORDER BY id LIMIT 2`,
    );
    if (result.rows.length === 1)
      return { ...data, businessProfileId: Number(result.rows[0].id) };
  }
  throw new Error(
    "This job has no unambiguous business owner; retry it from the correct business",
  );
}

/** Only server-resolved payer context is written when enqueueing work. */
export async function captureJobBusiness<T extends Payload>(
  data: T,
  options: JobBusinessCaptureOptions = {},
): Promise<T> {
  validateIdentity(data, options.requireOriginatingIdentity);
  const scoped = await captureBusiness(data);
  const actorUserId = scoped.businessActorUserId ?? scoped.billingActorUserId
    ?? currentBusinessScope()?.actorUserId ?? currentBusinessScope()?.userId;
  if (!actorUserId) throw new BillingOrganizationError('This job has no originating actor.', 409, 'JOB_ORIGIN_REQUIRED');
  const billingActorUserId = scoped.billingActorUserId ?? actorUserId;
  const pinned = scoped.billingOrganizationId ?? currentBillingScope()?.organizationId;
  const organizationId = await withBusinessScope(
    {
      userId: scoped.userId!,
      businessProfileId: scoped.businessProfileId!,
      actorUserId,
    },
    () => pinned === undefined ? resolveBillingOrganization(scoped.userId!) : withBillingScope({
      organizationId: pinned, actorUserId: billingActorUserId,
      businessProfileId: scoped.businessProfileId, businessOwnerUserId: scoped.userId,
    }, () => resolveBillingOrganization(scoped.userId!)),
  );
  return {
    ...scoped,
    businessActorUserId: actorUserId,
    billingOrganizationId: organizationId,
    billingActorUserId,
  };
}

export async function runBusinessJob<T>(
  data: Payload,
  work: (scopedData: Payload) => Promise<T>,
  onBillingAuthorizationRejected?: (scopedData: Payload) => Promise<void>,
): Promise<T | T[]> {
  if (data.systemJob === true && !data.userId) {
    if (data.type === 'cron-storage-object-cleanup') {
      const { cleanupDeletedProfileAssets } = await import('../services/businessProfileAssetCleanup.js');
      await cleanupDeletedProfileAssets();
    }
    if (data.type === 'cron-instagram-automation-recovery')
      return withSystemScope('Instagram automation recovery', () => work(data));
    // One pass over every business's outreaches; each recount touches a single outreach.
    if (data.type === 'cron-outreach-batch-counts')
      return withSystemScope('Outreach tracking counts', () => work(data));
    // Reads and settles WhatsApp charges of every business in one pass.
    if (data.type === 'cron-whatsapp-billing-maintenance')
      return withSystemScope('WhatsApp billing maintenance', () => work(data));
    // Staged PII must expire even while a business is awaiting approval.
    // Recovery still revalidates each operation's original actor before enqueue.
    if(data.type==='cron-dashboard-operations-recovery') return withSystemScope('Dashboard operation maintenance inventory',()=>forEachBusiness(scope=>work({
      ...data,userId:scope.userId,businessProfileId:scope.businessProfileId,
    }),false));
    // Account subscription reconciliation is an explicitly global billing job.
    if (data.type === "cron-subscription-reconciliation" || data.type === "cron-crm-automation-dispatch")
      return withSystemScope(data.type === "cron-crm-automation-dispatch" ? "CRM automation dispatch" : "Subscription reconciliation", () => work(data));
    return forEachBusiness((scope) =>
      work({
        ...data,
        userId: scope.userId,
        businessProfileId: scope.businessProfileId,
      }),
      true,
    );
  }
  validateIdentity(data, true);
  const scoped = await captureBusiness(data);
  const actorUserId = data.businessActorUserId!;
  return withBusinessScope(
    {
      userId: scoped.userId!,
      businessProfileId: scoped.businessProfileId!,
      actorUserId,
    },
    async () => {
      const organizationId = data.billingOrganizationId!;
      return withBillingScope(
        {
          organizationId,
          actorUserId: data.billingActorUserId!,
          businessProfileId: scoped.businessProfileId,
          businessOwnerUserId: scoped.userId,
        },
        async () => {
          // Membership is rechecked when a queued operation begins.
          try {
            const authorized = await resolveBusinessScope(
              actorUserId,
              scoped.businessProfileId!,
            );
            if (!authorized || authorized.userId !== scoped.userId)
              throw new BillingOrganizationError(
                "Business staff access was removed.",
              );
            await resolveBillingOrganization(scoped.userId!);
          } catch (error) {
            // A known prepaid resource may release its original reservation after
            // membership is revoked. Keep its validated business and pinned payer
            // contexts; this callback cannot grant permission to execute the job.
            if (
              error instanceof BillingOrganizationError &&
              error.code === "ORGANIZATION_FORBIDDEN"
            ) {
              // Only the trusted cancellation callback runs as the durable owner.
              // It verifies the original reservation before releasing any credits.
              await withBusinessScope(
                {
                  userId: scoped.userId!,
                  businessProfileId: scoped.businessProfileId!,
                },
                () =>
                  onBillingAuthorizationRejected?.({
                    ...scoped,
                    billingOrganizationId: organizationId,
                  }),
              );
            }
            throw error;
          }
          await requireApprovedBusiness(scoped.userId!);
          return work({ ...scoped, billingOrganizationId: organizationId });
        },
      );
    },
  );
}
