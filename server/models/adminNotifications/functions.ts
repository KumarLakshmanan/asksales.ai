import { eq, desc, and, sql } from "drizzle-orm";
import { db } from "../db";
import { adminNotifications, type NewAdminNotification } from "./schema";

export async function getAdminNotifications(adminId: number, limit = 50) {
  return await db
    .select()
    .from(adminNotifications)
    .where(eq(adminNotifications.adminId, adminId))
    .orderBy(desc(adminNotifications.createdAt), desc(adminNotifications.id))
    .limit(limit);
}

export async function getUnreadAdminCount(adminId: number): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(adminNotifications)
    .where(and(eq(adminNotifications.adminId, adminId), eq(adminNotifications.read, false)));
  return result[0]?.count ?? 0;
}

export async function markAdminNotificationRead(notificationId: number, adminId: number) {
  const [updated] = await db
    .update(adminNotifications)
    .set({ read: true, updatedAt: new Date() })
    .where(and(eq(adminNotifications.id, notificationId), eq(adminNotifications.adminId, adminId)))
    .returning();
  return updated;
}

export async function markAllAdminNotificationsRead(adminId: number) {
  await db
    .update(adminNotifications)
    .set({ read: true, updatedAt: new Date() })
    .where(and(eq(adminNotifications.adminId, adminId), eq(adminNotifications.read, false)));
}

export async function deleteAdminNotification(notificationId: number, adminId: number) {
  const [deleted] = await db.delete(adminNotifications)
    .where(and(eq(adminNotifications.id, notificationId), eq(adminNotifications.adminId, adminId)))
    .returning({ id: adminNotifications.id });
  return deleted;
}

/**
 * Create a notification for ALL admins (e.g., system alerts like missing model pricing).
 * Deduplicates by title within the last 24 hours to avoid spam.
 */
export async function notifyAllAdmins(notification: Omit<NewAdminNotification, "adminId">) {
  const { getAllAdmins } = await import("../admins/functions");
  const admins = await getAllAdmins();

  for (const admin of admins) {
    // Deduplicate: skip if same title exists for this admin in last 24h
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const existing = await db
      .select({ id: adminNotifications.id })
      .from(adminNotifications)
      .where(
        and(
          eq(adminNotifications.adminId, admin.id),
          eq(adminNotifications.title, notification.title),
          sql`${adminNotifications.createdAt} > ${oneDayAgo}`
        )
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(adminNotifications).values({
        ...notification,
        adminId: admin.id,
      });
    }
  }
}
