import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { requireBusinessScope } from "../../tenancy/businessContext.js";
import {
  captureJobBusiness,
  runBusinessJob,
  type JobBusinessPayload,
} from "../../tenancy/jobBusinessScope.js";
import { serializeUtcTimestamp } from "../../utils/supportTimestamp.js";
import {
  DashboardOperationError,
  ownedDashboardOperation,
  enqueueDashboardOperation,
  resumeDashboardOperation,
  type DashboardOperationRow,
} from "../operations/DashboardOperations.js";
import {
  canonicalOutreachCtes,
  executeReportQuery,
  reportPredicate,
  validateReportScope,
} from "./CampaignReportingService.js";
import { campaignReportFiltersSchema } from "./CampaignReportFilters.js";
import { LEGACY_WHATSAPP_APP_LIMIT_ERROR } from "./WhatsAppProviderRetry.js";
import {
  campaignReportUrl,
  type CampaignReportFilters,
} from "../../../shared/campaignReporting.js";
import type { OutreachRetryPreview } from "../../../shared/outreachRetries.js";
import {BillingOrganizationError} from '../billing/organizations.js';
import {BusinessLifecycleError} from '../../tenancy/businessLifecycle.js';
import { sha256Json as hash } from "../../utils/sha256.js";
type Candidate = {
  id: string;
  message_id: number | null;
  channel: string;
  state: string;
  status: string;
  provider_call_state: string | null;
  send_intent_id: string | null;
  confirmed_at: string | Date | null;
  confirmation_expires_at: string | Date | null;
  manual_review_required: boolean;
  external_message_id: string | null;
  provider_message_id: string | null;
  waba_message_id: string | null;
  rfc_message_id: string | null;
  delivered_at: string | Date | null;
  read_at: string | Date | null;
  sent_at: string | Date | null;
  error_message: string | null;
  updated_at: string | Date;
  metadata: Record<string, any>;
  conversation_id: number | null;
  lead_id: number;
  provider_account_id: string | null;
  marketing_failure: boolean;
};
const instant = (value: string | Date | null | undefined) =>
  value ? serializeUtcTimestamp(value) : null;
const authorityFields = [
  "userId",
  "businessProfileId",
  "businessActorUserId",
  "billingOrganizationId",
  "billingActorUserId",
] as const;
function originOf(row: Candidate): JobBusinessPayload | null {
  const origin = row.metadata?.outreachQueueOrigin as
    | JobBusinessPayload
    | undefined;
  const scope = requireBusinessScope();
  return origin &&
    authorityFields.every(
      (key) => Number.isSafeInteger(origin[key]) && Number(origin[key]) > 0,
    ) &&
    origin.userId === scope.userId &&
    origin.businessProfileId === scope.businessProfileId &&
    origin.businessActorUserId === origin.billingActorUserId
    ? origin
    : null;
}
function version(row: Candidate) {
  return hash([
    row.message_id,
    row.status,
    row.provider_call_state,
    row.send_intent_id,
    instant(row.updated_at),
    row.metadata,
    row.external_message_id,
    row.provider_message_id,
    row.waba_message_id,
    row.rfc_message_id,
    instant(row.confirmation_expires_at),
    instant(row.delivered_at),
    instant(row.read_at),
  ]);
}
/** Deliberately conservative: a failure label alone is never evidence of rejection. */
export function retryDecision(
  row: Candidate,
  now = Date.now(),
): {
  eligible: boolean;
  reason: string;
  nextAttemptAt: string | null;
  marketing?: boolean;
} {
  const no = (reason: string, nextAttemptAt: string | null = null) => ({
    eligible: false,
    reason,
    nextAttemptAt,
  });
  const queue = row.metadata?.outreachQueue || {},
    creation = row.metadata?.outreachCreation;
  const deadlines = [queue.nextAttemptAt, row.metadata?.scheduledAt]
      .filter(Boolean)
      .map(instant),
    expires = instant(row.confirmation_expires_at);
  if (deadlines.some((value) => !value))
    return no("The saved retry deadline is invalid; review required");
  const due = deadlines.length
    ? new Date(
        Math.max(...deadlines.map((value) => Date.parse(value!))),
      ).toISOString()
    : null;
  if (row.delivered_at || row.read_at || row.state === "delivered")
    return no("Delivery confirmed");
  if (row.state === "accepted" || (row.sent_at && row.status !== "failed"))
    return no("Provider accepted; awaiting a receipt is not a retry");
  if (
    row.manual_review_required ||
    ["started", "unknown"].includes(row.provider_call_state || "")
  )
    return no("Provider outcome needs review");
  if (!row.message_id || !row.send_intent_id)
    return no("Historical record has no recoverable delivery intent");
  if (!["pending", "failed"].includes(row.status))
    return no(
      row.status === "sending"
        ? "An existing worker holds this message"
        : "This message requires a fresh review",
    );
  if (!row.confirmed_at || !expires || Date.parse(expires) <= now)
    return no("Original sending confirmation expired");
  if (
    !originOf(row) ||
    row.metadata?.outreachQueuePolicy?.version !== 1 ||
    creation?.version !== 1 ||
    !creation.delivery
  )
    return no("Original queue authority or reviewed delivery is unavailable");
  if (
    row.metadata?.dashboardRetry?.enqueueNeeded === true ||
    queue.enqueueNeeded === true
  )
    return no("Already registered for queue recovery", due);
  const marketing =
    row.channel === "whatsapp" &&
    row.status === "failed" &&
    ["confirmed", "rejected"].includes(row.provider_call_state || "") &&
    row.marketing_failure;
  if (marketing) {
    if (!creation.whatsappOptInConfirmed || !creation.delivery.templateName)
      return no("Approved template and original consent are required");
    // Recovery schedules another attempt; it does not shorten Meta's existing deadline.
    const next = new Date(
      Math.max(now + 4 * 60 * 60_000, due ? Date.parse(due) : 0),
    ).toISOString();
    if (Date.parse(expires) <= Date.parse(next))
      return no("Confirmation expires before the next provider retry", next);
    return {
      eligible: true,
      reason:
        "Recover a confirmed Meta marketing rejection; retain a four-hour cooldown",
      nextAttemptAt: next,
      marketing: true,
    };
  }
  if (
    row.external_message_id ||
    row.provider_message_id ||
    row.waba_message_id ||
    row.provider_call_state !== "not_started"
  )
    return no("Receipt or provider boundary requires review");
  const appFailure =
    row.channel === "whatsapp" &&
    row.error_message === LEGACY_WHATSAPP_APP_LIMIT_ERROR;
  if (
    row.status === "failed" &&
    !appFailure &&
    !["app_rate_limit", "provider_limit", "daily_allowance"].includes(
      queue.reason,
    )
  )
    return no("Failure has no recorded safe retry policy");
  if (due && Date.parse(due) > now)
    return no("Waiting for the saved schedule or provider cooldown", due);
  return {
    eligible: true,
    reason:
      row.status === "pending"
        ? "Due; reuse the existing queued intent"
        : "Known unstarted retry; reuse the existing intent",
    nextAttemptAt: due,
  };
}
async function candidates(
  userId: number,
  filters: CampaignReportFilters,
  ids?: number[],
  executor = db,
): Promise<Candidate[]> {
  const business = requireBusinessScope().businessProfileId;
  const result =
    await executeReportQuery(executor, sql`WITH ${canonicalOutreachCtes(userId)} SELECT i.id,i.message_id,i.channel,i.state,
    m.status,m.provider_call_state,m.send_intent_id,m.confirmed_at,m.confirmation_expires_at,m.manual_review_required,
    m.external_message_id,m.provider_message_id,m.waba_message_id,m.rfc_message_id,m.delivered_at,m.read_at,m.sent_at,m.error_message,m.updated_at,
    COALESCE(m.metadata,'{}'::jsonb) AS metadata,m.conversation_id,i.lead_id,m.provider_account_id,
    EXISTS(SELECT 1 FROM instagram_webhook_events event WHERE event.user_id=${userId}
      AND event.business_profile_id=${business} AND event.page_id=i.account_id AND event.event_type='whatsapp_failed'
      AND event.message_id=COALESCE(m.provider_message_id,m.external_message_id,m.waba_message_id)
      AND event.raw_data#>>'{status,errors,0,code}'='131049') AS marketing_failure
    FROM intents i LEFT JOIN outreach_messages m ON m.id=i.message_id AND m.user_id=${userId} AND m.business_profile_id=${business}
    WHERE ${reportPredicate(filters)} ${ids ? sql`AND m.id=ANY(${sql.param(ids)}::int[])` : sql``} ORDER BY i.id`);
  return result.rows as Candidate[];
}
function view(row: DashboardOperationRow): OutreachRetryPreview {
  if(Date.parse(instant(row.expires_at)!)<=Date.now() || !row.payload.filters || !row.result)
    throw new DashboardOperationError('This retry review expired. Create a fresh preview from the campaign report.',410);
  const data = row.result as unknown as Omit<
    OutreachRetryPreview,
    | "id"
    | "businessProfileId"
    | "status"
    | "filters"
    | "fingerprint"
    | "progress"
    | "card"
  >;
  return {
    ...data,
    id: row.id,
    businessProfileId: row.business_profile_id,
    error:row.error,
    status: row.status,
    fingerprint: row.fingerprint,
    filters: row.payload.filters as CampaignReportFilters,
    progress: { completed: row.processed, total: row.total },
    card: {
      title: "Review outreach retries",
      status: row.status,
      businessProfileId: row.business_profile_id,
      checkedAt: data.checkedAt,
      description:row.error ||
        "Retries retain the existing message, recipient and sending authority. Accepted and uncertain outcomes are excluded; saved cooldowns remain in force.",
      operation: { id: row.id, kind: "queue_retry" },
      progress: { completed: row.processed, total: row.total },
      metrics: [
        { label: "Eligible", value: data.counts.eligible },
        { label: "Waiting", value: data.counts.waiting },
        { label: "Excluded", value: data.counts.excluded },
        { label: "Registered", value: data.counts.registered },
      ],
      actions: [
        {
          label: "Review retries",
          href: `/dashboard/outreach/retries?operationId=${row.id}`,
        },
        {
          label: "View campaign report",
          href: campaignReportUrl(row.payload.filters as CampaignReportFilters),
        },
      ],
    },
  };
}
export async function getRetryPreview(id: string) {
  return view(await ownedDashboardOperation(id, ["queue_retry"]));
}
export async function resumeOutreachRetryPreview(id:string) {
  const row=await ownedDashboardOperation(id,['queue_retry']);view(row);
  if(row.status==='ready')throw new DashboardOperationError('Confirm a fresh retry preview before starting recovery.',409);
  await resumeDashboardOperation(id,['queue_retry']);return getRetryPreview(id);
}
export async function previewOutreachRetries(
  userId: number,
  input: unknown = {},
): Promise<OutreachRetryPreview> {
  const filters = campaignReportFiltersSchema.parse(input);
  await validateReportScope(userId, filters);
  const scope = requireBusinessScope(),
    checkedAt = new Date().toISOString(),
    reviewExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const rows = await candidates(userId, filters),
    eligible: Array<{ id: number; version: string }> = [],
    items: OutreachRetryPreview["items"] = [];
  const counts = {
      selected: rows.length,
      eligible: 0,
      waiting: 0,
      excluded: 0,
      registered: 0,
      changed: 0,
    },
    reasons = new Map<string, OutreachRetryPreview["reasons"][number]>();
  for (const row of rows) {
    const decision = retryDecision(row),
      waiting = !decision.eligible && !!decision.nextAttemptAt;
    counts[decision.eligible ? "eligible" : waiting ? "waiting" : "excluded"]++;
    if (decision.eligible)
      eligible.push({ id: row.message_id!, version: version(row) });
    const group = reasons.get(decision.reason) || {
      reason: decision.reason,
      count: 0,
      nextAttemptAt: decision.nextAttemptAt,
    };
    group.count++;
    if (
      decision.nextAttemptAt &&
      (!group.nextAttemptAt || decision.nextAttemptAt < group.nextAttemptAt)
    )
      group.nextAttemptAt = decision.nextAttemptAt;
    reasons.set(decision.reason, group);
    if (items.length < 100)
      items.push({
        id: row.id,
        channel: row.channel,
        state: row.state,
        ...decision,
      });
  }
  const payload = { filters, eligible },
    fingerprint = hash([payload, checkedAt]),
    origin = await captureJobBusiness({
      userId,
      businessProfileId: scope.businessProfileId,
    });
  const result = {
    checkedAt,
    reviewExpiresAt,
    counts,
    reasons: [...reasons.values()],
    items,
  };
  const saved =
    await db.execute(sql`INSERT INTO dashboard_operations(id,user_id,business_profile_id,kind,status,request_key,fingerprint,origin,payload,result,total)
    VALUES(${randomUUID()}::uuid,${userId},${scope.businessProfileId},'queue_retry','ready',${randomUUID()},${fingerprint},${JSON.stringify(origin)}::jsonb,
      ${JSON.stringify(payload)}::jsonb,${JSON.stringify(result)}::jsonb,${eligible.length}) RETURNING *`);
  return view(saved.rows[0] as DashboardOperationRow);
}
export async function applyOutreachRetryPreview(
  id: string,
  fingerprint: string,
) {
  const row = await ownedDashboardOperation(id, ["queue_retry"]);
  if (row.fingerprint !== fingerprint)
    throw new DashboardOperationError(
      "Refresh and confirm this retry preview again.",
      409,
    );
  if (row.status !== "ready") return view(row); // An identical confirmation is an idempotent status read.
  if (Date.parse(String(row.result?.reviewExpiresAt)) <= Date.now())
    throw new DashboardOperationError(
      "This retry preview expired. Create a fresh preview.",
      409,
    );
  const changed =
    await db.execute(sql`UPDATE dashboard_operations SET status='queued',updated_at=now() WHERE id=${id}::uuid
    AND user_id=${row.user_id} AND business_profile_id=${row.business_profile_id} AND status='ready' RETURNING *`);
  const saved = (changed.rows[0] || row) as DashboardOperationRow;
  // SQL remains the outbox if Redis is temporarily unavailable. The common cron recovers it.
  try {
    await enqueueDashboardOperation(saved);
  } catch {
    /* durable queued state is shown to the user */
  }
  return view(saved);
}
export async function processOutreachRetryPreview(
  row: DashboardOperationRow,
  token: string,
  checkpoint: (values: {
    cursor: number;
    processed: number;
    total: number;
    status?: DashboardOperationRow["status"];
    result?: unknown;
  }) => Promise<void>,
) {
  const entries = row.payload.eligible as Array<{
      id: number;
      version: string;
    }>,
    filters = row.payload.filters as CampaignReportFilters;
  const counts = { ...(row.result as any).counts },
    reasons = new Map<string, number>();
  for (let cursor = row.cursor; cursor < entries.length; cursor += 100) {
    const batch = entries.slice(cursor, cursor + 100);
    await db.transaction(async (tx: typeof db) => {
      // The operation lease fences both planning and its checkpoint in one transaction.
      const fence = await tx.execute(
        sql`SELECT id FROM dashboard_operations WHERE id=${row.id}::uuid AND lease_token=${token}::uuid AND status='running' FOR UPDATE`,
      );
      if (!fence.rows.length)
        throw new DashboardOperationError(
          "Retry operation ownership changed.",
          409,
        );
      await tx.execute(sql`SELECT id FROM outreach_messages WHERE id=ANY(${sql.param(batch.map((item) => item.id))}::int[])
        AND user_id=${row.user_id} AND business_profile_id=${row.business_profile_id} ORDER BY id FOR UPDATE`);
      const current = await candidates(
        row.user_id,
        filters,
        batch.map((item) => item.id),
        tx,
      );
      const byId = new Map(current.map((item) => [item.message_id, item]));
      for (const entry of batch) {
        const message = byId.get(entry.id);
        if (message?.metadata?.dashboardRetry?.previewId === row.id) continue;
        const decision = message ? retryDecision(message) : null;
        if (
          !message ||
          !decision?.eligible ||
          version(message) !== entry.version
        ) {
          counts.changed++;
          const reason =
            decision?.reason || "Message changed or is unavailable";
          reasons.set(reason, (reasons.get(reason) || 0) + 1);
          continue;
        }
        const due = decision.nextAttemptAt || new Date().toISOString();
        await tx.execute(sql`UPDATE outreach_messages SET status='pending',provider_call_state='not_started',send_claimed_at=NULL,
          external_message_id=NULL,provider_message_id=NULL,waba_message_id=NULL,
          metadata=COALESCE(metadata,'{}'::jsonb)||${JSON.stringify({
            dashboardRetry: {
              previewId: row.id,
              enqueueNeeded: true,
              requestedAt: new Date().toISOString(),
            },
            outreachQueue: {
              ...(message.metadata.outreachQueue || {}),
              nextAttemptAt: due,
              ...(decision.marketing
                ? {
                    lastFailureReceipt:
                      message.provider_message_id ||
                      message.external_message_id ||
                      message.waba_message_id,
                    reason: "provider_limit",
                    providerCode: 131049,
                    retryCount:
                      Number(message.metadata.outreachQueue?.retryCount || 0) +
                      1,
                  }
                : {}),
            },
          })}::jsonb,
          error_message='Retry registered. The existing delivery intent will be checked again before sending.',updated_at=now()
          WHERE id=${entry.id} AND user_id=${row.user_id} AND business_profile_id=${row.business_profile_id}`);
        counts.registered++;
      }
      await tx.execute(sql`UPDATE dashboard_operations SET cursor=${cursor + batch.length},processed=${cursor + batch.length},lease_until=now()+interval '5 minutes',
        result=jsonb_set(COALESCE(result,'{}'::jsonb),'{counts}',${JSON.stringify(counts)}::jsonb),updated_at=now()
        WHERE id=${row.id}::uuid AND lease_token=${token}::uuid AND status='running'`);
    });
  }
  await checkpoint({
    cursor: entries.length,
    processed: entries.length,
    total: entries.length,
    status: "completed",
    result: {
      ...row.result,
      counts,
      changedReasons: [...reasons].map(([reason, count]) => ({
        reason,
        count,
      })),
    },
  });
  await reconcileDashboardRetries();
}
/** Crash-safe handoff. Reuse the actual BullMQ job identity; do not manufacture
 * another provider send or replace the actor who approved the original intent. */
export async function reconcileDashboardRetries() {
  const scope = requireBusinessScope();
  const rows =
    await db.execute(sql`SELECT id,metadata->'outreachQueueOrigin' AS origin FROM outreach_messages
    WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND metadata->'dashboardRetry'->>'enqueueNeeded'='true' ORDER BY id LIMIT 100`);
  const { queueRegistry, QUEUE_NAMES } = await import("../../queues/index.js");
  const { jobDispatcher } = await import("../../queues/JobDispatcher.js");
  for (const candidate of rows.rows) {
    try {
      await runBusinessJob(candidate.origin as JobBusinessPayload, () =>
        db.transaction(async (tx: typeof db) => {
          const selected =
            await tx.execute(sql`SELECT * FROM outreach_messages WHERE id=${candidate.id} AND user_id=${scope.userId}
          AND business_profile_id=${scope.businessProfileId} AND metadata->'dashboardRetry'->>'enqueueNeeded'='true' FOR UPDATE`);
          const message = selected.rows[0];
          if (!message) return;
          const clear = () =>
            tx.execute(
              sql`UPDATE outreach_messages SET metadata=metadata #- '{dashboardRetry,enqueueNeeded}' WHERE id=${message.id} AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}`,
            );
          if (
            message.status !== "pending" ||
            message.provider_call_state !== "not_started" ||
            message.provider_message_id ||
            message.external_message_id ||
            message.delivered_at ||
            message.read_at ||
            message.manual_review_required
          ) {
            await clear();
            return;
          }
          if (
            !message.confirmation_expires_at ||
            Date.parse(instant(message.confirmation_expires_at)!) <= Date.now()
          ) {
            await tx.execute(
              sql`UPDATE outreach_messages SET status='setup_required',error_message='The original sending confirmation expired. Review this outreach again.' WHERE id=${message.id}`,
            );
            await clear();
            return;
          }
          const queue = message.metadata.outreachQueue || {},
            jobId = queue.lastFailureReceipt
              ? `outreach-provider-retry-${message.send_intent_id}-${queue.retryCount || 0}`
              : queue.appRateLimitRecovery
                ? `outreach-app-rate-recovery-${message.send_intent_id}`
                : `outreach-send-${message.send_intent_id}`;
          await queueRegistry.initialize();
          const existing = await queueRegistry
            .getQueue(QUEUE_NAMES.OUTREACH)
            .getJob(jobId);
          if (existing) {
            if (
              existing.data.messageId !== Number(message.id) ||
              existing.data.userId !== scope.userId ||
              existing.data.businessProfileId !== scope.businessProfileId
            )
              throw new Error(
                "Saved queue identity does not match the original intent.",
              );
            const state = await existing.getState();
            if (state === "failed") await existing.retry("failed");
            else if (state === "completed") await existing.remove();
            else if (
              state === "delayed" &&
              Date.parse(queue.nextAttemptAt || "") <= Date.now()
            )
              await existing.promote();
            if (state !== "completed") {
              await clear();
              return;
            }
          }
          const due = Date.parse(queue.nextAttemptAt || "");
          await jobDispatcher.dispatch(
            "send_outreach_message",
            {
              ...message.metadata.outreachCreation.delivery,
              ...(candidate.origin as JobBusinessPayload),
              messageId: Number(message.id),
              providerRateLimitRetries: Number(queue.retryCount || 0),
            } as { userId: number },
            {
              jobId,
              priority: 10,
              delay: Number.isFinite(due) ? Math.max(0, due - Date.now()) : 0,
            },
          );
          await clear();
        }),
      );
    } catch (error) {
      if (
        error instanceof BillingOrganizationError || error instanceof BusinessLifecycleError || [
          "ORGANIZATION_FORBIDDEN",
          "JOB_ORIGIN_REQUIRED",
          "JOB_ACTOR_MISMATCH",
          "ASSISTANT_SETUP_REQUIRED",
        ].includes(String((error as any)?.code))
      )
        await db.execute(sql`UPDATE outreach_messages SET status='setup_required',error_message='Original sending authority or assistant setup needs review.',metadata=metadata #- '{dashboardRetry,enqueueNeeded}'
          WHERE id=${candidate.id} AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND status='pending'`);
      else await db.execute(sql`UPDATE outreach_messages SET error_message='Queue handoff is waiting for infrastructure recovery. The existing intent remains queued.'
        WHERE id=${candidate.id} AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND status='pending'
          AND metadata->'dashboardRetry'->>'enqueueNeeded'='true'`);
    }
  }
}
