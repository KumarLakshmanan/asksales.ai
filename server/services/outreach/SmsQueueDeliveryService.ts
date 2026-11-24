import { randomUUID } from "node:crypto";
import { sql, and, eq } from "drizzle-orm";
import { db } from "../../models/db.js";
import { requireBusinessScope } from "../../tenancy/businessContext.js";
import { currentBillingScope } from "../../tenancy/billingContext.js";
import { followUpSettingsRevision } from "../../utils/followUpSettingsRevision.js";
import { normalizeMSG91Phone } from "../../../shared/msg91.js";
import { sentMessagesTable } from "../../models/sentMessages/schema.js";
import { leadsTable } from "../../models/leads/schema.js";
export class SmsQueuePolicyError extends Error {}
export interface SmsQueueClaim {
  id: number;
  token: string;
  reservationReference?: string;
  reservationId?: number;
}
type Row = {
  id: number;
  state: string;
  payload_hash: string;
  claim_token: string;
  claimed_at: Date;
  reservation_reference?: string;
  reservation_id?: number;
  business_actor_user_id: number;
  billing_actor_user_id: number;
  billing_organization_id: number;
  provider_message_id?: string;
};
export async function claimQueuedSms(
  jobId: string,
  input: Record<string, unknown>,
  recoverStalled = false,
): Promise<{
  claim?: SmsQueueClaim;
  deliveryId?: number;
  success?: boolean;
  uncertain?: boolean;
  suppressed?: boolean;
  inProgress?: boolean;
  messageId?: string;
}> {
  const business = requireBusinessScope(),
    billing = currentBillingScope();
  if (
    !jobId ||
    input.userId !== business.userId ||
    !billing ||
    !business.actorUserId
  )
    throw new SmsQueuePolicyError(
      "Queued SMS requires its original business, actor, payer and stable job ID.",
    );
  const hash = followUpSettingsRevision({
    to: normalizeMSG91Phone(String(input.to || "")),
    message: input.message,
    leadId: input.leadId,
    campaignId: input.campaignId,
    providerAccountId: input.providerAccountId,
    isFollowUp: input.isFollowUp === true,
    useSavedFollowUpSettings: input.useSavedFollowUpSettings === true,
    followUpOriginMessageId: input.followUpOriginMessageId,
    followUpStep: input.followUpStep,
    followUpProvenance: input.followUpProvenance,
  });
  await db.execute(sql`INSERT INTO sms_queue_deliveries(user_id,business_profile_id,business_actor_user_id,billing_actor_user_id,billing_organization_id,job_id,payload_hash)
    VALUES(${business.userId},${business.businessProfileId},${business.actorUserId},${billing.actorUserId},${billing.organizationId},${jobId},${hash})
    ON CONFLICT(business_profile_id,user_id,job_id) DO NOTHING`);
  const saved = await db.execute(
    sql`SELECT * FROM sms_queue_deliveries WHERE user_id=${business.userId} AND business_profile_id=${business.businessProfileId} AND job_id=${jobId}`,
  );
  const row = saved.rows[0] as Row | undefined;
  if (
    !row ||
    row.payload_hash !== hash ||
    row.business_actor_user_id !== business.actorUserId ||
    row.billing_actor_user_id !== billing.actorUserId ||
    row.billing_organization_id !== billing.organizationId
  )
    throw new SmsQueuePolicyError(
      "Queued SMS content or originating authority changed. Review the intent.",
    );
  if (row.state === "confirmed")
    return {
      deliveryId: row.id,
      success: true,
      messageId: row.provider_message_id,
    };
  if (["started", "unknown"].includes(row.state)) {
    await db.execute(sql`UPDATE sms_queue_deliveries SET state='unknown',error='A previous provider start requires receipt review.',updated_at=NOW()
      WHERE id=${row.id} AND state='started'`);
    return { deliveryId: row.id, uncertain: true };
  }
  if (["stopped", "rejected"].includes(row.state))
    return { deliveryId: row.id, suppressed: true };
  const token = randomUUID();
  const claimed =
    await db.execute(sql`UPDATE sms_queue_deliveries SET state='preparing',claim_token=${token},claimed_at=NOW(),updated_at=NOW()
    WHERE id=${row.id} AND (state='pending' OR (state='preparing' AND claim_token=${row.claim_token} AND (${recoverStalled} OR claimed_at<NOW()-INTERVAL '15 minutes')))
    RETURNING id,reservation_reference,reservation_id`);
  if (!claimed.rows.length) return { inProgress: true };
  return {
    claim: {
      id: row.id,
      token,
      reservationReference: claimed.rows[0].reservation_reference as
        | string
        | undefined,
      reservationId: Number(claimed.rows[0].reservation_id) || undefined,
    },
  };
}
export function smsReservationReference(claim: SmsQueueClaim): string {
  return `sms-queue:${claim.id}:claim:${claim.token}`;
}
/** Called inside CreditService.reserveForResource so the reservation reference
 * and original wallet deduction commit together, including response-loss recovery. */
export async function attachSmsReservation(
  claim: SmsQueueClaim,
  tx: typeof db,
) {
  const referenceId = smsReservationReference(claim);
  const result =
    await tx.execute(sql`UPDATE sms_queue_deliveries SET reservation_reference=${referenceId},reservation_id=NULL,updated_at=NOW()
    WHERE id=${claim.id} AND state='preparing' AND claim_token=${claim.token} RETURNING id`);
  if (!result.rows.length)
    throw new SmsQueuePolicyError("SMS preparation claim was replaced.");
  return { resource: claim, referenceId };
}
export async function saveSmsReservation(
  claim: SmsQueueClaim,
  reservationId?: number,
) {
  const result =
    await db.execute(sql`UPDATE sms_queue_deliveries SET reservation_id=${reservationId || null},updated_at=NOW()
    WHERE id=${claim.id} AND state='preparing' AND claim_token=${claim.token} RETURNING id`);
  return result.rows.length === 1;
}
export async function findSmsReservation(
  claim: SmsQueueClaim,
): Promise<number | undefined> {
  if (claim.reservationId) return claim.reservationId;
  if (!claim.reservationReference) return undefined;
  const business = requireBusinessScope(),
    billing = currentBillingScope()!;
  const result =
    await db.execute(sql`SELECT id FROM wallet_transactions WHERE user_id=${business.userId} AND organization_id=${billing.organizationId}
    AND actor_user_id=${billing.actorUserId} AND billing_business_profile_id=${business.businessProfileId}
    AND type='deduction' AND reference_type='sms_queue_claim' AND reference_id=${claim.reservationReference} ORDER BY id LIMIT 1`);
  return Number(result.rows[0]?.id) || undefined;
}
export async function startQueuedSms(claim: SmsQueueClaim): Promise<boolean> {
  const result =
    await db.execute(sql`UPDATE sms_queue_deliveries SET state='started',updated_at=NOW()
    WHERE id=${claim.id} AND state='preparing' AND claim_token=${claim.token} AND claimed_at>NOW()-INTERVAL '15 minutes' RETURNING id`);
  return result.rows.length === 1;
}
export async function finishQueuedSms(
  claim: SmsQueueClaim,
  state: "pending" | "confirmed" | "unknown" | "stopped" | "rejected",
  error?: string,
  messageId?: string,
) {
  // A surviving original worker may reconcile its own unknown attempt. It can
  // never finish or reset a claim owned by a different preparation token.
  const result =
    await db.execute(sql`UPDATE sms_queue_deliveries SET state=${state},error=${error || null},provider_message_id=COALESCE(${messageId || null},provider_message_id),updated_at=NOW()
    WHERE id=${claim.id} AND claim_token=${claim.token} AND state IN ('preparing','started','unknown') RETURNING id`);
  return result.rows.length === 1;
}

/** A receipt may outlive its worker. Serialize the history projection with the
 * intent so replay repairs it without another SMS or duplicate contact count. */
export async function projectQueuedSmsActivity(
  deliveryId: number,
  input: { leadId: number; leadName: string; message: string; step: number },
  failedPreparation = false,
): Promise<void> {
  const business = requireBusinessScope();
  const becameSent = await db.transaction(async (tx: typeof db) => {
    const result =
      await tx.execute(sql`SELECT state,provider_message_id,activity_message_id,activity_confirmed_at FROM sms_queue_deliveries
      WHERE id=${deliveryId} AND user_id=${business.userId} AND business_profile_id=${business.businessProfileId} FOR UPDATE`);
    const row = result.rows[0];
    if (!row) throw new Error("SMS history intent is unavailable.");
    const status =
      row.state === "confirmed"
        ? "sent"
        : row.state === "stopped"
          ? "cancelled"
          : "failed";
    const outcome = ["started", "unknown"].includes(String(row.state))
      ? "uncertain"
      : status;
    if (
      ["pending", "preparing"].includes(String(row.state)) &&
      !failedPreparation
    )
      return false;
    const current = row.activity_message_id
      ? (
          await tx
            .select()
            .from(sentMessagesTable)
            .where(
              and(
                eq(sentMessagesTable.id, Number(row.activity_message_id)),
                eq(sentMessagesTable.userId, business.userId),
                eq(
                  sentMessagesTable.businessProfileId,
                  business.businessProfileId,
                ),
              ),
            )
            .limit(1)
        )[0]
      : undefined;
    if (row.activity_message_id && !current)
      throw new Error("The saved SMS history record needs review.");
    // Once acceptance was projected, the callback-owned history may have
    // advanced to delivered/read/failed. Replay must neither downgrade it nor
    // consume the contact's sent counter again.
    if (row.activity_confirmed_at) return false;
    if (
      status !== "sent" &&
      current?.status === status &&
      current.deliveryStatus === outcome &&
      current.messageId === (row.provider_message_id || null)
    )
      return false;
    const projection = {
      status,
      deliveryStatus: outcome,
      messageId: row.provider_message_id as string | null,
      updatedAt: new Date(),
    };
    if (current)
      await tx
        .update(sentMessagesTable)
        .set(projection)
        .where(eq(sentMessagesTable.id, current.id));
    else {
      const [created] = await tx
        .insert(sentMessagesTable)
        .values({
          ...projection,
          businessProfileId: business.businessProfileId,
          userId: business.userId,
          leadId: input.leadId,
          leadName: input.leadName,
          channel: "sms",
          message: input.message,
          sentAt: new Date(),
          isReply: true,
          followUpStep: input.step,
        })
        .returning({ id: sentMessagesTable.id });
      await tx.execute(
        sql`UPDATE sms_queue_deliveries SET activity_message_id=${created.id} WHERE id=${deliveryId}`,
      );
    }
    const changedToSent = status === "sent";
    if (changedToSent)
      await tx.execute(
        sql`UPDATE sms_queue_deliveries SET activity_confirmed_at=NOW() WHERE id=${deliveryId}`,
      );
    if (changedToSent)
      await tx
        .update(leadsTable)
        .set({
          smsSent: sql`COALESCE(${leadsTable.smsSent},0)+1`,
          lastContactedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(leadsTable.id, input.leadId),
            eq(leadsTable.userId, business.userId),
          ),
        );
    return changedToSent;
  });
  // Preserve the existing SMS model's best-effort CRM reconciliation behavior.
  if (becameSent)
    void import("../CRMService.js")
      .then(({ crmService }) =>
        crmService.autoCreateContactOnOutreachSend(
          business.userId,
          input.leadId,
          { source: "sms" },
        ),
      )
      .catch(() => {});
}
