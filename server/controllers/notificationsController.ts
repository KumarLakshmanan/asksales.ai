 
import type { AuthenticatedRequest as AuthRequest } from '../types/express.js';
 
import type { Response } from "express";
import { 
  getNotificationsByUserId, 
  getNotificationCountByUserId,
  getUnreadNotificationsByUserId,
  getUnreadCountByUserId,
  markAsRead, 
  markAllAsRead,
  deleteNotification
} from "../models/notifications/functions";
import { logger } from '../utils/logger.js';
import { notificationInteger, decodeNotificationCursor, encodeNotificationCursor } from './notificationValidation.js';
import { currentBusinessScope } from '../tenancy/businessContext.js';

// Extend Request type to include user

// Get all notifications for user
export async function getNotifications(req: AuthRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  try {
    const userId = req.user.id;
    const parsedPage = notificationInteger(req.query.page, 1);
    const parsedLimit = notificationInteger(req.query.limit, 20, 100);
    if (parsedPage === null) return res.status(400).json({ error: "Invalid page" });
    if (parsedLimit === null) return res.status(400).json({ error: "Invalid limit" });
    if ((parsedPage - 1) * parsedLimit > 2_147_483_647) return res.status(400).json({ error: "Invalid page" });

    const type = req.query.type;
    if (type !== undefined && (typeof type !== 'string' || !['info', 'success', 'warning', 'error'].includes(type))) {
      return res.status(400).json({ error: "Invalid notification type" });
    }
    if (req.query.unread !== undefined && req.query.unread !== 'true' && req.query.unread !== 'false') {
      return res.status(400).json({ error: "Invalid unread filter" });
    }
    const unread = req.query.unread === undefined ? undefined : req.query.unread === 'true';

    const filters = { type, read: unread === undefined ? undefined : !unread };
    const businessProfileId = currentBusinessScope()?.businessProfileId ?? null;
    const cursor = req.query.cursor === undefined ? undefined : decodeNotificationCursor(req.query.cursor);
    if (cursor === null || (cursor && (cursor.userId !== userId || cursor.businessProfileId !== businessProfileId
      || cursor.type !== (filters.type ?? null) || cursor.read !== (filters.read ?? null)))) {
      return res.status(400).json({ error: "Invalid notification cursor" });
    }
    const offset = cursor ? 0 : (parsedPage - 1) * parsedLimit;
    const [rows, total, unreadCount, totalCount] = await Promise.all([
      getNotificationsByUserId(userId, parsedLimit + 1, offset, filters, cursor),
      getNotificationCountByUserId(userId, filters),
      getUnreadCountByUserId(userId),
      getNotificationCountByUserId(userId),
    ]);
    const hasMore = rows.length > parsedLimit;
    const items = rows.slice(0, parsedLimit);
    const last = items.at(-1);
    return res.json({
      items: items.map(({ cursorCreatedAt: _cursorCreatedAt, ...item }) => item),
      unreadCount,
      totalCount,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total,
        totalPages: Math.ceil(total / parsedLimit),
        hasMore,
        nextCursor: hasMore && last ? encodeNotificationCursor({
          createdAt: last.cursorCreatedAt, id: last.id, userId, businessProfileId,
          type: filters.type ?? null, read: filters.read ?? null,
        }) : null,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching notifications');
    res.status(500).json({ error: "Unable to retrieve notifications. Please try again." });
  }
}

// Get unread notifications for user
export async function getUnreadNotifications(req: AuthRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  try {
    const userId = req.user.id;
    const notifications = await getUnreadNotificationsByUserId(userId);
    res.json(notifications);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching unread notifications');
    res.status(500).json({ error: "Unable to retrieve unread notifications. Please try again." });
  }
}

// Get unread count
export async function getUnreadCount(req: AuthRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  try {
    const userId = req.user.id;
    const count = await getUnreadCountByUserId(userId);
    res.json({ count });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching unread count');
    res.status(500).json({ error: "Unable to retrieve the unread count. Please try again." });
  }
}

// Mark notification as read
export async function markNotificationAsRead(req: AuthRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  try {
    const notificationId = notificationInteger(req.params.id);
    if (notificationId === null) {
      return res.status(400).json({ error: "Invalid notification ID" });
    }
    const notification = await markAsRead(notificationId, req.user.id);
    if (!notification) return res.status(404).json({ error: "Notification not found" });
    return res.json(notification);
  } catch (error) {
    logger.error({ err: error }, 'Error marking notification as read');
    res.status(500).json({ error: "Unable to mark the notification as read. Please try again." });
  }
}

// Mark all notifications as read
export async function markAllNotificationsAsRead(req: AuthRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  try {
    const userId = req.user.id;
    await markAllAsRead(userId);
    res.json({ message: "All notifications marked as read" });
  } catch (error) {
    logger.error({ err: error }, 'Error marking all notifications as read');
    res.status(500).json({ error: "Unable to mark all notifications as read. Please try again." });
  }
}

// Delete notification
export async function deleteNotificationById(req: AuthRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  try {
    const notificationId = notificationInteger(req.params.id);
    if (notificationId === null) {
      return res.status(400).json({ error: "Invalid notification ID" });
    }
    const deleted = await deleteNotification(notificationId, req.user.id);
    if (!deleted) return res.status(404).json({ error: "Notification not found" });
    return res.json({ message: "Notification deleted" });
  } catch (error) {
    logger.error({ err: error }, 'Error deleting notification');
    res.status(500).json({ error: "Unable to delete the notification. Please try again." });
  }
}
