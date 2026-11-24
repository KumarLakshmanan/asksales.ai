import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { consumeAdminPasswordReset, getAdminByEmail, updateAdmin } from "../models/admins/functions";
import { generateRandomToken, generateToken } from "../utils/jwt";
import { sendResetPasswordEmail } from "../utils/email";
import { logger } from '../utils/logger.js';
import { AUTH_COOKIES, clearAuthCookie, readAuthCookie, setAuthCookie } from '../utils/authCookies.js';
import { db } from '../models/db.js';
import { adminsTable } from '../models/admins/schema.js';
import { sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';

// AUTH-002: Bootstrap admin (single-use, refuses once any admin exists).
// For first-time setup only. Use /api/admin/admins (auth required) to add subsequent admins.
export async function bootstrapAdmin(req: Request, res: Response) {
  // Explicit deployment opt-in, independently of whether an administrator exists.
  const secret = process.env.ADMIN_BOOTSTRAP_SECRET;
  const supplied = req.get('X-Admin-Bootstrap-Secret') || '';
  const expiresAt = Date.parse(process.env.ADMIN_BOOTSTRAP_EXPIRES_AT || '');
  const now = Date.now();
  if (!secret || secret.length < 32 || !Number.isFinite(expiresAt) || expiresAt <= now
    || expiresAt > now + 60 * 60 * 1000) {
    return res.status(404).json({ message: 'Not found' });
  }
  if (Buffer.byteLength(supplied) !== Buffer.byteLength(secret)
    || !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))) {
    return res.status(403).json({ message: 'Bootstrap authorization required' });
  }
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ message: "Email, password, and name are required" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const admin = await db.transaction(async (tx: typeof db) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('asksales-admin-bootstrap'))`);
      const existing = await tx.select({ id: adminsTable.id }).from(adminsTable).limit(1);
      if (existing.length > 0) return null;
      const [created] = await tx.insert(adminsTable).values({
        email: email.trim().toLowerCase(),
        password: hashedPassword,
        name: name.trim(),
        role: 'super_admin',
        isVerified: true,
      }).returning();
      return created;
    });
    if (!admin) {
      return res.status(409).json({ message: "Bootstrap not allowed: an admin already exists. Use authenticated /api/admin/admins to create additional admins." });
    }

    const token = generateToken({ adminId: admin.id, email: admin.email, role: admin.role });
    setAuthCookie(res, AUTH_COOKIES.admin, token);
    logger.warn({ adminId: admin.id, email }, '[AUTH] Bootstrap admin created');

    res.status(201).json({
      message: "Bootstrap admin created",
      user: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
    });
  } catch (error) {
    logger.error({ err: error }, 'Admin bootstrap error');
    res.status(500).json({ message: "Unable to bootstrap the admin account. Please try again." });
  }
}

// Login for admin
export async function loginAdmin(req: Request, res: Response) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    // Find admin from admins table
    const admin = await getAdminByEmail(email);
    if (!admin) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    // Check if admin is verified
    if (!admin.isVerified) {
      return res.status(403).json({ message: "Your account is not yet active. Please contact support." });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, admin.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Sorry, we couldn't log you in. Please check your credentials and try again." });
    }

    // Update last login
    await updateAdmin(admin.id, { updatedAt: new Date() });

    // Generate JWT token with adminId
    const token = generateToken({ adminId: admin.id, email: admin.email, role: admin.role });
    setAuthCookie(res, AUTH_COOKIES.admin, token);

    res.json({
      message: "Login successful",
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Admin login error');
    res.status(500).json({ message: "An unexpected error occurred. Please try again later." });
  }
}

export async function logoutAdmin(req: Request, res: Response) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : readAuthCookie(req, AUTH_COOKIES.admin);
  if (token) {
    const { revokeToken } = await import('../utils/jwt.js');
    if (!await revokeToken(token)) {
      return res.status(503).json({ code: 'SESSION_REVOCATION_UNAVAILABLE', message: 'Sign out could not be completed. Please retry.' });
    }
  }
  clearAuthCookie(res, AUTH_COOKIES.admin);
  res.status(204).send();
}

// Forgot password for admin
export async function forgotAdminPassword(req: Request, res: Response) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Find admin from admins table
    const admin = await getAdminByEmail(email);
    if (!admin) {
      // Don't reveal if admin exists or not
      return res.json({ message: "If the email exists, a password reset OTP has been sent" });
    }

    // Generate 6-digit OTP
    const otp = generateRandomToken();
    const hashedOtp = await bcrypt.hash(otp, 10);
    const resetPasswordTokenExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Update admin with reset token
    await updateAdmin(admin.id, {
      resetPasswordToken: hashedOtp,
      resetPasswordTokenExpiry,
    });

    // Send reset password email
    await sendResetPasswordEmail(email, otp, admin.name);

    res.json({ message: "If the email exists, a password reset OTP has been sent" });
  } catch (error) {
    logger.error({ err: error }, 'Admin forgot password error');
    res.status(500).json({ message: "Unable to process the password reset request. Please try again." });
  }
}

// Reset admin password
export async function resetAdminPassword(req: Request, res: Response) {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ message: "Email, OTP, and new password are required" });
    }

    // Find admin by email from admins table
    const admin = await getAdminByEmail(email);
    if (!admin) {
      return res.status(400).json({ message: "Invalid OTP or email" });
    }

    // Check if OTP matches
    const otpMatches = admin.resetPasswordToken?.startsWith('$2')
      ? await bcrypt.compare(otp, admin.resetPasswordToken)
      : false;
    if (!otpMatches) {
      return res.status(400).json({ message: "Invalid OTP or email" });
    }

    // Check if OTP is expired
    if (admin.resetPasswordTokenExpiry && admin.resetPasswordTokenExpiry < new Date()) {
      return res.status(400).json({ message: "OTP has expired" });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const consumed = await consumeAdminPasswordReset(admin.id, admin.resetPasswordToken!, hashedPassword);
    if (!consumed) return res.status(400).json({ message: "Invalid or expired OTP" });

    res.json({ message: "Password reset successfully" });
  } catch (error) {
    logger.error({ err: error }, 'Admin reset password error');
    res.status(500).json({ message: "Unable to reset the password. Please try again." });
  }
}

// Get current admin (requires authentication)
export async function getCurrentAdmin(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin = (req as any).user;
    if (!admin) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    res.json({
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        isVerified: admin.isVerified,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Get current admin error');
    res.status(500).json({ message: "Unable to retrieve admin information. Please try again." });
  }
}

// Update the authenticated admin's own non-sensitive profile fields.
// Email and role changes remain restricted to the super-admin CRUD endpoints.
export async function updateCurrentAdminProfile(req: Request, res: Response) {
  try {
    const admin = req.user;
    if (!admin || !('role' in admin) || typeof admin.role !== 'string' || !['admin', 'super_admin'].includes(admin.role)) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ message: "Name is required" });
    }
    if (name.length > 255) {
      return res.status(400).json({ message: "Name must be 255 characters or fewer" });
    }

    const updated = await updateAdmin(admin.id, { name });
    if (!updated) {
      return res.status(404).json({ message: "Admin account not found" });
    }

    return res.json({
      message: "Profile updated successfully",
      admin: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        role: updated.role,
        isVerified: updated.isVerified,
      },
    });
  } catch (error) {
    logger.error({ err: error, adminId: req.user?.id }, 'Update current admin profile error');
    return res.status(500).json({ message: "Unable to update the profile. Please try again." });
  }
}
