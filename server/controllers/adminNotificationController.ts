import type { Request, Response } from "express";
import {
  getAdminNotifications,
  getUnreadAdminCount,
  markAdminNotificationRead,
  markAllAdminNotificationsRead,
  deleteAdminNotification,
} from "../models/adminNotifications/functions";
import { logger } from "../utils/logger.js";
import { notificationInteger } from "./notificationValidation.js";

function getAdminId(req: Request): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = (req as any).user;
  return admin?.id ?? null;
}

/** GET /api/admin/notifications */
export async function getAdminNotificationsHandler(req: Request, res: Response) {
  try {
    const adminId = getAdminId(req);
    if (!adminId) return res.status(401).json({ success: false, error: "Admin not found" });

    const limit = notificationInteger(req.query.limit, 50, 100);
    if (limit === null) return res.status(400).json({ success: false, error: "Invalid limit" });
    const notifications = await getAdminNotifications(adminId, limit);
    const unreadCount = await getUnreadAdminCount(adminId);

    return res.json({ success: true, data: { notifications, unreadCount } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[AdminNotifications] Error fetching notifications");
    return res.status(500).json({ success: false, error: "Failed to fetch notifications" });
  }
}

/** GET /api/admin/notifications/unread-count */
export async function getUnreadCountHandler(req: Request, res: Response) {
  try {
    const adminId = getAdminId(req);
    if (!adminId) return res.status(401).json({ success: false, error: "Admin not found" });

    const unreadCount = await getUnreadAdminCount(adminId);
    return res.json({ success: true, data: { unreadCount } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[AdminNotifications] Error fetching unread count");
    return res.status(500).json({ success: false, error: "Failed to fetch unread count" });
  }
}

/** PATCH /api/admin/notifications/:id/read */
export async function markReadHandler(req: Request, res: Response) {
  try {
    const adminId = getAdminId(req);
    if (!adminId) return res.status(401).json({ success: false, error: "Admin not found" });
    const notificationId = notificationInteger(req.params.id);
    if (notificationId === null) return res.status(400).json({ success: false, error: "Invalid notification ID" });

    const updated = await markAdminNotificationRead(notificationId, adminId);
    if (!updated) return res.status(404).json({ success: false, error: "Notification not found" });

    return res.json({ success: true, data: updated });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[AdminNotifications] Error marking notification read");
    return res.status(500).json({ success: false, error: "Failed to update notification" });
  }
}

/** PATCH /api/admin/notifications/read-all */
export async function markAllReadHandler(req: Request, res: Response) {
  try {
    const adminId = getAdminId(req);
    if (!adminId) return res.status(401).json({ success: false, error: "Admin not found" });

    await markAllAdminNotificationsRead(adminId);
    return res.json({ success: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[AdminNotifications] Error marking all read");
    return res.status(500).json({ success: false, error: "Failed to mark all read" });
  }
}

/** DELETE /api/admin/notifications/:id */
export async function deleteNotificationHandler(req: Request, res: Response) {
  try {
    const adminId = getAdminId(req);
    if (!adminId) return res.status(401).json({ success: false, error: "Admin not found" });
    const notificationId = notificationInteger(req.params.id);
    if (notificationId === null) return res.status(400).json({ success: false, error: "Invalid notification ID" });

    const deleted = await deleteAdminNotification(notificationId, adminId);
    if (!deleted) return res.status(404).json({ success: false, error: "Notification not found" });
    return res.json({ success: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, "[AdminNotifications] Error deleting notification");
    return res.status(500).json({ success: false, error: "Failed to delete notification" });
  }
}
