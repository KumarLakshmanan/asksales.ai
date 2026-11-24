import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
import { requireBusinessScope } from "../../tenancy/businessContext.js";
import { automationService } from "../AutomationService.js";
import { logger } from "../../utils/logger.js";

export type ContactHandoffStatus =
  | "pending"
  | "processing"
  | "completed"
  | "queued"
  | "review_required";
type Trigger = "status_change" | "pipeline_status_change";
export interface ContactAutomationHandoff {
  transitionId: number;
  status: ContactHandoffStatus;
  events: Array<{
    type: Trigger;
    status: ContactHandoffStatus;
    oldValue: string;
    newValue: string;
  }>;
}
function business(userId: number) {
  const scope = requireBusinessScope();
  if (scope.userId !== userId)
    throw new Error(
      "Contact automation account does not match business scope.",
    );
  return scope;
}
const aggregate = (
  events: ContactAutomationHandoff["events"],
): ContactHandoffStatus =>
  (["review_required", "processing", "pending", "queued"] as const).find(
    (status) => events.some((event) => event.status === status),
  ) || "completed";

/** A recovery checkpoint on an existing protected activity, not a second outbox.
 * Discovery can be retried. A claimed legacy evaluation is never automatically
 * replayed, including when an action's outcome or its completion write is lost.
 */
export async function contactAutomationHandoff(
  userId: number,
  contactId: number,
  transitionId: number,
  recover = false,
): Promise<ContactAutomationHandoff | null> {
  const scope = business(userId);
  const result =
    await db.execute(sql`SELECT activity.metadata FROM crm_activities activity
    JOIN crm_contacts contact ON contact.id=activity.contact_id AND contact.user_id=activity.user_id
      AND contact.business_profile_id=activity.business_profile_id AND contact.deleted_at IS NULL
    WHERE activity.id=${transitionId} AND activity.user_id=${userId} AND activity.business_profile_id=${scope.businessProfileId}
      AND activity.contact_id=${contactId} AND activity.type IN ('pipeline_change','contact_updated')`);
  const receipt = result.rows[0]?.metadata?.automationHandoff;
  if (receipt?.version !== 1 || !receipt.events) return null;
  const events: ContactAutomationHandoff["events"] = [];
  for (const type of ["status_change", "pipeline_status_change"] as const) {
    const event = receipt.events[type];
    if (!event) continue;
    const path = ["automationHandoff", "events", type, "status"];
    const current = async (): Promise<ContactHandoffStatus> => {
      const read =
        await db.execute(sql`SELECT metadata #>> ${sql.param(path)}::text[] AS status FROM crm_activities
        WHERE id=${transitionId} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND contact_id=${contactId}`);
      return read.rows[0]?.status || "review_required";
    };
    const mark = async (
      next: ContactHandoffStatus,
      expected: ContactHandoffStatus,
    ) =>
      db.execute(sql`UPDATE crm_activities
      SET metadata=jsonb_set(metadata,${sql.param(path)}::text[],to_jsonb(${next}::text)),updated_at=now()
      WHERE id=${transitionId} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId}
        AND contact_id=${contactId} AND metadata #>> ${sql.param(path)}::text[] = ${expected}`);
    let status: ContactHandoffStatus = event.status;
    try {
      // Existing 314 capture owns all enabled-engine effects. Refresh queued
      // outcomes from the actual event/runs; do not interpret event completion
      // alone as success when one of its runs failed or became uncertain.
      let captured = false;
      try {
        const source = `contact-${contactId}-${receipt.transactionId}-${type === "status_change" ? "status" : "stage"}-%`;
        const capture = await db.execute(sql`SELECT event.status,
          EXISTS(SELECT 1 FROM crm_automation_runs run WHERE run.event_id=event.id AND run.user_id=${userId}
            AND run.business_profile_id=${scope.businessProfileId} AND run.status IN ('failed','uncertain','manual_review','cancelled')) AS needs_review
          FROM crm_automation_events event WHERE event.user_id=${userId} AND event.business_profile_id=${scope.businessProfileId}
            AND event.contact_id=${contactId} AND event.event_type=${type} AND event.source_key LIKE ${source}
            AND event.context->'event'->>'oldValue'=${event.oldValue} AND event.context->'event'->>'newValue'=${event.newValue}
          LIMIT 1`);
        if (capture.rows.length) {
          captured = true;
          status =
            capture.rows[0].needs_review ||
            ["failed", "cancelled"].includes(capture.rows[0].status)
              ? "review_required"
              : capture.rows[0].status === "completed"
                ? "completed"
                : "queued";
          if (recover) await mark(status, event.status);
        }
      } catch (error) {
        const code =
          (error as { code?: string; cause?: { code?: string } }).code ||
          (error as { cause?: { code?: string } }).cause?.code;
        if (code !== "42P01") throw error; // Pre-migration installations stay legacy.
      }
      if (!captured && recover && status === "pending") {
        let started = false;
        try {
          const evaluated = await automationService.evaluateTriggers(
            userId,
            contactId,
            { type, oldValue: event.oldValue, newValue: event.newValue },
            {
              beforeActions: async () => {
                const field =
                  type === "status_change"
                    ? sql`contact.status`
                    : sql`contact.pipeline_status`;
                const claim =
                  await db.execute(sql`UPDATE crm_activities activity
                SET metadata=jsonb_set(metadata,${sql.param(path)}::text[],'"processing"'::jsonb),updated_at=now()
                WHERE activity.id=${transitionId} AND activity.user_id=${userId} AND activity.business_profile_id=${scope.businessProfileId}
                  AND activity.contact_id=${contactId} AND metadata #>> ${sql.param(path)}::text[] = 'pending'
                  AND EXISTS(SELECT 1 FROM crm_contacts contact WHERE contact.id=${contactId} AND contact.user_id=${userId}
                    AND contact.business_profile_id=${scope.businessProfileId} AND contact.deleted_at IS NULL AND ${field}=${event.newValue})
                  AND NOT EXISTS(SELECT 1 FROM crm_activities later WHERE later.contact_id=${contactId} AND later.user_id=${userId}
                    AND later.business_profile_id=${scope.businessProfileId} AND later.id>${transitionId}
                    AND (later.type='pipeline_change' OR (${type}='status_change' AND later.type='contact_updated'
                      AND later.metadata->'changedFields' ? 'status'))) RETURNING activity.id`);
                started = claim.rows.length > 0;
                return started;
              },
            },
          );
          if (evaluated?.mode === "legacy") {
            await mark(
              evaluated.failed ? "review_required" : "completed",
              "processing",
            );
          } else if (
            evaluated?.mode === "durable" ||
            (await current()) === "pending"
          ) {
            // Runtime changed after an uncaptured legacy commit or the contact
            // moved again. There is no captured event to delegate safely.
            await mark("review_required", "pending");
          }
          status = await current();
        } catch (error) {
          status = await current(); // Resolve a potentially committed claim/completion first.
          if (started && status === "processing") {
            await mark("review_required", "processing");
            status = "review_required";
          }
          logger.warn(
            { err: error, contactId, transitionId, type },
            "Contact saved; automation checkpoint requires recovery",
          );
        }
      }
    } catch (error) {
      // Discovery/read outages preserve the durable checkpoint. Never reset a
      // possibly committed claim or claim success from an unavailable read.
      status = await current().catch(() => "review_required" as const);
      logger.warn(
        { err: error, contactId, transitionId, type },
        "Automation recovery status unavailable",
      );
    }
    events.push({
      type,
      status,
      oldValue: event.oldValue,
      newValue: event.newValue,
    });
  }
  return { transitionId, status: aggregate(events), events };
}

/** Shared postcommit contract for PUT, PATCH and bulk. Never turns a saved
 * contact into a failed mutation, even if the recovery store is unavailable. */
export async function completeContactAutomation(
  userId: number,
  contact: { id: number; automationTransitionId?: number },
) {
  if (!contact.automationTransitionId) return {};
  try {
    const handoff = await contactAutomationHandoff(
      userId,
      contact.id,
      contact.automationTransitionId,
      true,
    );
    return {
      automationTransitionId: contact.automationTransitionId,
      automationHandoff: handoff,
      automationReviewRequired:
        !handoff ||
        ["pending", "processing", "review_required"].includes(handoff.status),
    };
  } catch (error) {
    logger.warn(
      { err: error, contactId: contact.id },
      "Contact saved; automation recovery could not be read",
    );
    return {
      automationTransitionId: contact.automationTransitionId,
      automationReviewRequired: true,
    };
  }
}

export async function savedContactResponse(userId: number, contact: any) {
  const handoff = await completeContactAutomation(userId, contact);
  const { crmService } = await import("../CRMService.js");
  try {
    return {
      ...((await crmService.getContactById(userId, contact.id)) || contact),
      ...handoff,
    };
  } catch (error) {
    logger.warn(
      { err: error, contactId: contact.id },
      "Contact saved; final refresh unavailable",
    );
    return { ...contact, ...handoff, refreshRequired: true };
  }
}

export async function listContactAutomationHandoffs(
  userId: number,
  contactId: number,
  page: number,
  limit: number,
) {
  const scope = business(userId);
  const predicate = sql`user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND contact_id=${contactId}
    AND type IN ('pipeline_change','contact_updated') AND metadata->'automationHandoff'->>'version'='1'`;
  const result = await db.execute(
    sql`SELECT id FROM crm_activities WHERE ${predicate} ORDER BY id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
  );
  const count = await db.execute(
    sql`SELECT count(*)::int AS total FROM crm_activities WHERE ${predicate}`,
  );
  const data: ContactAutomationHandoff[] = [];
  for (const row of result.rows) {
    const handoff = await contactAutomationHandoff(
      userId,
      contactId,
      Number(row.id),
    );
    if (handoff) data.push(handoff);
  }
  return {
    data,
    pagination: {
      page,
      limit,
      total: Number(count.rows[0]?.total || 0),
      totalPages: Math.ceil(Number(count.rows[0]?.total || 0) / limit),
    },
  };
}
