import type { Request, Response } from "express";
import { db } from "../models/db";
import { usersTable } from "../models/users/schema";
import { eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { logger } from '../utils/logger.js';
import { passwordSchema } from '../middleware/schemas.js';
import { upsertUserPreferences } from '../models/userPreferences/functions.js';

const defaultNotificationPreferences = {
  emailNotifications: true,
  leadAlerts: true,
  campaignUpdates: true,
  weeklyReports: false,
};

type NotificationPreferenceKey = keyof typeof defaultNotificationPreferences;

export async function getUserProfileHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user.id;
    
    const result = await db.select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      avatar: usersTable.avatar,
      bio: usersTable.bio,
      phone: usersTable.phone,
      timezone: usersTable.timezone,
      createdAt: usersTable.createdAt,
    }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    
    if (!result[0]) {
      return res.status(404).json({ error: "User not found" });
    }
    
    res.json(result[0]);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching user profile');
    res.status(500).json({ error: "Unable to retrieve your profile. Please try again." });
  }
}

export async function updateUserProfileHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user.id;
    const body = req.body ?? {};
    const updates: Partial<typeof usersTable.$inferInsert> = {};
    if ('name' in body) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 255) {
        return res.status(400).json({ error: 'Name must be between 1 and 255 characters' });
      }
      updates.name = body.name.trim();
    }
    if ('bio' in body) {
      if (body.bio !== null && (typeof body.bio !== 'string' || body.bio.length > 2000)) {
        return res.status(400).json({ error: 'Biography must be 2,000 characters or fewer' });
      }
      updates.bio = typeof body.bio === 'string' ? body.bio.trim() || null : null;
    }
    if ('phone' in body) {
      if (body.phone !== null && body.phone !== '' &&
          (typeof body.phone !== 'string' || !/^\+?[\d\s\-().]{7,20}$/.test(body.phone))) {
        return res.status(400).json({ error: 'Enter a valid phone number' });
      }
      updates.phone = typeof body.phone === 'string' ? body.phone.trim() || null : null;
    }
    if ('avatar' in body) {
      if (body.avatar === null || body.avatar === '') {
        updates.avatar = null;
      } else {
        try {
          if (typeof body.avatar !== 'string' || body.avatar.length > 2048) throw new Error();
          const avatarUrl = new URL(body.avatar);
          if (!['http:', 'https:'].includes(avatarUrl.protocol) || avatarUrl.username || avatarUrl.password) throw new Error();
          updates.avatar = avatarUrl.toString();
        } catch {
          return res.status(400).json({ error: 'Profile picture must be a valid HTTP or HTTPS URL' });
        }
      }
    }
    if ('timezone' in body) {
      if (typeof body.timezone !== 'string' || body.timezone.length > 100) {
        return res.status(400).json({ error: 'Timezone is invalid' });
      }
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }).format();
      } catch {
        return res.status(400).json({ error: 'Timezone must be a valid IANA timezone' });
      }
      updates.timezone = body.timezone;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Provide at least one profile field to update' });
    }
    
    const result = await db.transaction(async (tx: typeof db) => {
      const saved = await tx.update(usersTable)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, userId))
      .returning({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        avatar: usersTable.avatar,
        bio: usersTable.bio,
        phone: usersTable.phone,
        timezone: usersTable.timezone,
      });
      if (saved[0] && updates.timezone) {
        await upsertUserPreferences(userId, { timezone: updates.timezone }, tx);
      }
      return saved;
    });
    
    if (!result[0]) {
      return res.status(404).json({ error: "User not found" });
    }
    
    res.json(result[0]);
  } catch (error) {
    logger.error({ err: error }, 'Error updating user profile');
    res.status(500).json({ error: "Unable to update your profile. Please try again." });
  }
}

export async function changePasswordHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user.id;
    const { currentPassword, newPassword } = req.body;
    
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: "Current password and new password are required" });
    }
    const passwordResult = passwordSchema.safeParse(newPassword);
    if (!passwordResult.success) {
      return res.status(400).json({ error: passwordResult.error.issues[0]?.message || 'New password is invalid' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from the current password' });
    }
    
    // Get user
    const user = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user[0]) {
      return res.status(404).json({ error: "User not found" });
    }
    
    // Verify current password
    const isValid = await bcrypt.compare(currentPassword, user[0].password);
    if (!isValid) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    
    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    // Update password
    await db.update(usersTable)
      .set({
        password: hashedPassword,
        passwordChangedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, userId));
    
    res.json({ message: "Password changed successfully" });
  } catch (error) {
    logger.error({ err: error }, 'Error changing password');
    res.status(500).json({ error: "Unable to change your password. Please try again." });
  }
}

export async function getNotificationPreferencesHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user.id;
    const [user] = await db.select({
      notificationPreferences: usersTable.notificationPreferences,
    }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({
      ...defaultNotificationPreferences,
      ...(user.notificationPreferences ?? {}),
    });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching notification preferences');
    return res.status(500).json({ error: "Unable to retrieve notification preferences. Please try again." });
  }
}

export async function updateNotificationPreferencesHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user.id;
    const supplied = req.body ?? {};
    const allowedKeys = Object.keys(defaultNotificationPreferences) as NotificationPreferenceKey[];

    if (allowedKeys.some((key) => key in supplied && typeof supplied[key] !== "boolean")) {
      return res.status(400).json({ error: "Notification preferences must be boolean values" });
    }

    const updates = Object.fromEntries(
      allowedKeys
        .filter((key) => key in supplied)
        .map((key) => [key, supplied[key]])
    );
    // Merge with the row at UPDATE time so concurrent partial saves preserve
    // changes to other preferences after PostgreSQL serializes the row writes.
    const [user] = await db.update(usersTable)
      .set({
        notificationPreferences: sql`${JSON.stringify(defaultNotificationPreferences)}::jsonb || COALESCE(${usersTable.notificationPreferences}, '{}'::jsonb) || ${JSON.stringify(updates)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, userId))
      .returning({ notificationPreferences: usersTable.notificationPreferences });

    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json(user.notificationPreferences);
  } catch (error) {
    logger.error({ err: error }, 'Error updating notification preferences');
    return res.status(500).json({ error: "Unable to update notification preferences. Please try again." });
  }
}
