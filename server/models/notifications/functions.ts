import { eq, desc, and, count, sql, getTableColumns, type SQL } from "drizzle-orm";
import { db } from "../db";
import { notifications, type NewNotification, type Notification } from "./schema";
import { logger } from "../../utils/logger.js";

export type NotificationFilters = { type?: string; read?: boolean };

function notificationConditions(userId: number, filters: NotificationFilters = {}): SQL[] {
  const conditions: SQL[] = [eq(notifications.userId, userId)];
  if (filters.type) conditions.push(eq(notifications.type, filters.type));
  if (filters.read !== undefined) conditions.push(eq(notifications.read, filters.read));
  return conditions;
}

export async function getNotificationsByUserId(
  userId: number,
  limit = 100,
  offset = 0,
  filters: NotificationFilters = {},
  cursor?: { createdAt: string; id: number },
): Promise<Array<Notification & { cursorCreatedAt: string }>> {
  const conditions = notificationConditions(userId, filters);
  if (cursor) conditions.push(sql`(${notifications.createdAt}, ${notifications.id}) < (${cursor.createdAt}::timestamp, ${cursor.id})`);
  return await db
    .select({ ...getTableColumns(notifications), cursorCreatedAt: sql<string>`to_char(${notifications.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US')` })
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit)
    .offset(offset);
}

export async function getNotificationCountByUserId(userId: number, filters: NotificationFilters = {}) {
  const [result] = await db
    .select({ value: count() })
    .from(notifications)
    .where(and(...notificationConditions(userId, filters)));
  return result?.value ?? 0;
}

export async function getUnreadNotificationsByUserId(userId: number) {
  return await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(100);
}

export async function getUnreadCountByUserId(userId: number) {
  const [result] = await db
    .select({ value: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
  return result?.value ?? 0;
}

export async function createNotification(notification: NewNotification) {
  const [newNotification] = await db
    .insert(notifications)
    .values(notification)
    .returning();

  // Notifications are an inbox, not an audit log. Keep the working set
  // bounded per tenant while retaining recent unread items.
  try {
    await db.execute(sql`
      DELETE FROM notifications
      WHERE user_id = ${notification.userId}
        AND (
          created_at < NOW() - INTERVAL '90 days'
          OR id IN (
            SELECT id FROM notifications
            WHERE user_id = ${notification.userId}
            ORDER BY created_at DESC, id DESC
            OFFSET 1000
          )
        )
    `);
  } catch (error) {
    logger.warn({ err: error, userId: notification.userId }, '[Notifications] Retention cleanup failed');
  }
  return newNotification;
}

export async function markAsRead(notificationId: number, userId: number) {
  const [updated] = await db
    .update(notifications)
    .set({ read: true, updatedAt: new Date() })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    .returning();
  return updated;
}

export async function markAllAsRead(userId: number) {
  await db
    .update(notifications)
    .set({ read: true, updatedAt: new Date() })
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
}

export async function deleteNotification(notificationId: number, userId: number) {
  const [deleted] = await db.delete(notifications)
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    .returning({ id: notifications.id });
  return deleted;
}
