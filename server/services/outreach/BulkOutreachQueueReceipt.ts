import { sql } from "drizzle-orm";
import { db } from "../../models/db.js";
/** A rejected queue acknowledgement does not establish that enqueue failed. */
export async function reconcileBulkQueueReceipt(
  userId: number,
  messageId: number,
  jobId: string,
): Promise<"queued" | "uncertain"> {
  const result = await db.execute(
    sql`SELECT status,provider_call_state,manual_review_required FROM outreach_messages WHERE id=${messageId} AND user_id=${userId}`,
  );
  const message = result.rows[0];
  if (
    message &&
    (["sent", "delivered", "read"].includes(String(message.status)) ||
      message.provider_call_state === "confirmed")
  )
    return "queued";
  if (
    message &&
    (message.manual_review_required ||
      message.provider_call_state === "unknown")
  )
    return "uncertain";
  try {
    const { queueRegistry, QUEUE_NAMES } =
      await import("../../queues/index.js");
    if (await queueRegistry.getQueue(QUEUE_NAMES.OUTREACH).getJob(jobId))
      return "queued";
  } catch {
    /* Infrastructure failure leaves acknowledgement unconfirmed. */
  }
  // Only untouched intent may be held. A worker that already advanced the row
  // keeps its provider evidence and may finish normally.
  await db.execute(sql`UPDATE outreach_messages SET status='manual_review',manual_review_required=true,
    error_message='Queue confirmation is uncertain. Reconcile this saved intent before approving another send.',updated_at=NOW()
    WHERE id=${messageId} AND user_id=${userId} AND status='pending' AND provider_call_state='not_started'`);
  return "uncertain";
}
