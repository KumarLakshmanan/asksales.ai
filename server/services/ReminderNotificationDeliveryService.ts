import { sql } from "drizzle-orm";
import { db } from "../models/db.js";
import type { SendEmailResult } from './adminEmailService.js';

export class ReminderNotificationUncertainError extends Error {}
interface NotificationReminder {
  id: number;
  userId: number;
  businessProfileId: number;
  metadata?: Record<string, unknown> | null;
}
type NotificationResult = SendEmailResult;

/** One receipt per intentional schedule and destination. A crash after claim is
 * ambiguous and must never automatically repeat a provider request. */
export async function deliverReminderNotification(
  reminder: NotificationReminder,
  destination: "internal" | "contact",
  send: () => Promise<NotificationResult>,
): Promise<{ skipped: boolean }> {
  const generation = String(
    reminder.metadata?.notificationGeneration || "initial",
  );
  const path = sql`ARRAY['notificationDeliveries',${generation},${destination}]::text[]`;
  const statePath = sql`ARRAY['notificationDeliveries',${generation},${destination},'state']::text[]`;
  const started = { state: "sending", startedAt: new Date().toISOString() };
  const claimed = await db.execute(sql`UPDATE crm_activity_reminders
    SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{notificationDeliveries}',
      COALESCE(metadata->'notificationDeliveries','{}'::jsonb) || jsonb_build_object(${generation}::text,
        COALESCE(metadata->'notificationDeliveries'->${generation},'{}'::jsonb) || jsonb_build_object(${destination}::text,${JSON.stringify(started)}::jsonb))),updated_at=NOW()
    WHERE id=${reminder.id} AND user_id=${reminder.userId} AND business_profile_id=${reminder.businessProfileId}
      AND status IN ('pending','snoozed')
      AND COALESCE(metadata->>'notificationGeneration','initial')=${generation}
      AND COALESCE(metadata #>> ${statePath},'failed')='failed'
    RETURNING id`);
  if (!claimed.rows.length) {
    const current =
      await db.execute(sql`SELECT metadata #>> ${statePath} AS state
      FROM crm_activity_reminders WHERE id=${reminder.id} AND user_id=${reminder.userId}
      AND business_profile_id=${reminder.businessProfileId} AND COALESCE(metadata->>'notificationGeneration','initial')=${generation}`);
    if (current.rows[0]?.state === "sent") return { skipped: true };
    throw new ReminderNotificationUncertainError(
      "This notification is already in progress, uncertain, cancelled or rescheduled. Review delivery before retrying.",
    );
  }
  let result: NotificationResult;
  try {
    result = await send();
  } catch (error) {
    throw new ReminderNotificationUncertainError(
      `Notification delivery outcome is uncertain. Review it before retrying. ${error instanceof Error ? error.message : ""}`,
    );
  }
  const state = result.success
    ? "sent"
    : result.deliveryAttempted === false || result.outcomeUncertain === false
      ? "failed"
      : "unknown";
  const receipt = {
    state,
    messageId: result.messageId,
    finishedAt: new Date().toISOString(),
  };
  const saved = await db.execute(sql`UPDATE crm_activity_reminders
    SET metadata=jsonb_set(metadata,${path},${JSON.stringify(receipt)}::jsonb),updated_at=NOW()
    WHERE id=${reminder.id} AND user_id=${reminder.userId} AND business_profile_id=${reminder.businessProfileId}
      AND COALESCE(metadata->>'notificationGeneration','initial')=${generation}
      AND metadata #>> ${statePath}='sending' RETURNING id`);
  if (!saved.rows.length)
    throw new ReminderNotificationUncertainError(
      "The notification receipt could not be confirmed. Review delivery before retrying.",
    );
  if (!result.success) {
    if (state === "unknown")
      throw new ReminderNotificationUncertainError(
        result.error || "Notification delivery outcome is uncertain.",
      );
    throw new Error(result.error || "Notification delivery failed.");
  }
  return { skipped: false };
}
