import { currentBusinessScope, withBusinessScope } from '../tenancy/businessContext.js';
import { resolveBusinessScope } from '../tenancy/businessScopeResolver.js';
import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { logger } from '../utils/logger.js';
import { AUTH_COOKIES, clearAuthCookie, readAuthCookie, setAuthCookie } from '../utils/authCookies.js';
import { getUserByEmail, getUserByGoogleSub, createUser, updateUser, consumeUserPasswordReset, consumeUserVerification, recordFailedUserLogin, completeUserPasswordLogin } from "../models/users/functions";
import { generateToken, generateRandomToken, verifyToken, revokeToken } from "../utils/jwt";
import { sendVerificationEmail, sendResetPasswordEmail, sendApprovalPendingEmail, sendNewUserNotificationToAdmin } from "../utils/email";
import { db } from "../models/db";
import { usersTable } from "../models/users/schema";
import { companySettings } from "../models/companySettings/schema";
import { and, eq, sql } from "drizzle-orm";
import { adminsTable } from "../models/admins/schema";
import { verifyGoogleCredential } from "../services/googleSignIn.js";
import { accessibleBusinessProfiles } from '../services/businessProfileStaff.js';

// Register a new user
async function setupBrandToolkits(userId: number) {
  const scope = currentBusinessScope() || await resolveBusinessScope(userId);
  if (!scope || (scope.actorUserId ?? scope.userId) !== userId) return [];
  const { brandToolkitsTable } = await import('../models/brandToolkits/schema.js');
  return withBusinessScope(scope, () => db.select({ id:brandToolkitsTable.id }).from(brandToolkitsTable)
    .where(eq(brandToolkitsTable.userId,scope.userId)).limit(1));
}

export async function register(req: Request, res: Response) {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ message: "Email, password, and name are required" });
    }

    // Check if user already exists
    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ message: "User with this email already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate a short-lived six-digit verification OTP. Store only its bcrypt hash.
    const verificationOtp = generateRandomToken();
    const verificationOtpHash = await bcrypt.hash(verificationOtp, 10);
    const verificationOtpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Create user
    const user = await createUser({
      email,
      password: hashedPassword,
      name,
      isVerified: false,
      verificationToken: verificationOtpHash,
      verificationTokenExpiry: verificationOtpExpiry,
    });

    // Send verification email
    const delivery = await sendVerificationEmail(email, verificationOtp, name);

    res.status(201).json({
      message: "User registered successfully. Please check your email to verify your account.",
      userId: user.id,
      verificationEmailSent: delivery?.success !== false,
    });
  } catch (error) {
    logger.error({ err: error }, 'Registration error');
    res.status(500).json({ message: "Unable to complete registration. Please try again." });
  }
}

// Login
export async function login(req: Request, res: Response) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    // Find user
    const user = await getUserByEmail(email);
    if (!user || user.deletedAt) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return res.status(429).json({ message: "This account is temporarily locked after repeated failed attempts. Please try again later." });
    }

    // Verify password
    const isPasswordValid = user.password ? await bcrypt.compare(password, user.password) : false;
    if (!isPasswordValid) {
      await recordFailedUserLogin(user.id, user.password);
      return res.status(401).json({ message: "Sorry, we couldn't log you in. Please check your credentials and try again." });
    }

    if (!user.isVerified) {
      return res.status(403).json({ code: "EMAIL_NOT_VERIFIED", message: "Your email address has not been verified. Please check your inbox for the verification email." });
    }

    const loggedIn = await completeUserPasswordLogin(user.id, user.password!);
    if (!loggedIn) return res.status(401).json({ message: "Invalid email or password." });

    // Generate JWT token - issued regardless of approval status
    const token = generateToken({ userId: user.id, email: user.email });
    setAuthCookie(res, AUTH_COOKIES.user, token);

    // Check if user has business profile and brand toolkit
    // Phase 5.17 / CTRL-005: companySettings is now statically imported.

    const businessProfiles = await accessibleBusinessProfiles(user.id);
    const selectedProfile = businessProfiles.find(p => p.id === req.businessProfileId) ?? businessProfiles[0];
    const brandToolkits = await setupBrandToolkits(user.id);

    res.json({
      message: "Login successful",
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isSetupComplete: user.isSetupComplete || false,
        isApproved: user.isApproved || Boolean(selectedProfile && selectedProfile.role !== 'owner' && selectedProfile.ownerApproved && selectedProfile.isApproved),
        workspaceRole: selectedProfile?.role ?? null,
        businessProfileId: selectedProfile?.id ?? null,
        hasBusinessProfile: businessProfiles.length > 0,
        businessProfileCount: businessProfiles.length,
        hasBrandToolkit: brandToolkits.length > 0,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Login error');
    res.status(500).json({ message: "An unexpected error occurred. Please try again later." });
  }
}

// A Google ID token is verified server-side. The stable Google subject, not
// the email address, identifies a returning federated account.
export async function googleSignIn(req: Request, res: Response) {
  const clientId = process.env.GOOGLE_SIGN_IN_CLIENT_ID?.trim();
  if (!clientId) return res.status(503).json({ message: "Google sign-in is not configured yet." });

  let identity;
  try {
    identity = await verifyGoogleCredential(req.body.credential, clientId);
  } catch (error) {
    logger.warn({ err: error }, 'Invalid Google sign-in credential');
    return res.status(401).json({ message: "Google sign-in could not be verified. Please try again." });
  }

  try {
    let user = await getUserByGoogleSub(identity.sub);
    if (user?.deletedAt) return res.status(401).json({ message: "User account is unavailable" });
    if (!user) {
      // Do not silently attach a Google identity to a password account just
      // because the email matches. Google is not authoritative for every
      // third-party email address associated with a Google Account.
      const [existing] = await db.select({ id: usersTable.id })
        .from(usersTable)
        .where(sql`lower(${usersTable.email}) = ${identity.email}`)
        .limit(1);
      if (existing) {
        return res.status(409).json({
          message: "An account with this email already exists. Sign in with your password.",
        });
      }

      try {
        user = await createUser({
          googleSub: identity.sub,
          email: identity.email,
          name: identity.name,
          isVerified: true,
        });
      } catch (error) {
        // A second request may have created the same Google account first.
        user = await getUserByGoogleSub(identity.sub);
        if (!user) {
          logger.warn({ err: error }, 'Google sign-in email conflict');
          return res.status(409).json({ message: "An account with this email already exists. Sign in with your password." });
        }
      }
    }

    user = await updateUser(user.id, {
      isVerified: true,
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    }) || user;

    const token = generateToken({ userId: user.id, email: user.email });
    setAuthCookie(res, AUTH_COOKIES.user, token);

    const [businessProfiles, brandToolkits] = await Promise.all([
      accessibleBusinessProfiles(user.id),
      setupBrandToolkits(user.id),
    ]);
    const selectedProfile = businessProfiles.find(p => p.id === req.businessProfileId) ?? businessProfiles[0];

    return res.json({
      message: "Google sign-in successful",
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isVerified: true,
        isSetupComplete: user.isSetupComplete || false,
        isApproved: user.isApproved || Boolean(selectedProfile && selectedProfile.role !== 'owner' && selectedProfile.ownerApproved && selectedProfile.isApproved),
        workspaceRole: selectedProfile?.role ?? null,
        businessProfileId: selectedProfile?.id ?? null,
        hasBusinessProfile: businessProfiles.length > 0,
        businessProfileCount: businessProfiles.length,
        hasBrandToolkit: brandToolkits.length > 0,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Google sign-in error');
    return res.status(500).json({ message: "Unable to complete Google sign-in. Please try again." });
  }
}

// Verify email
export async function verifyEmail(req: Request, res: Response) {
  try {
    const { email, otp } = req.body;

    if (typeof email !== "string" || typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ message: "Email and a six-digit verification OTP are required" });
    }

    // OTPs are bcrypt-hashed, so resolve the account by email before comparing.
    const user = await getUserByEmail(email);
    if (!user || user.deletedAt) {
      return res.status(400).json({ message: "Invalid or expired verification OTP" });
    }

    // Every OTP is short-lived; a missing expiry is treated as invalid too.
    if (!user.verificationTokenExpiry || user.verificationTokenExpiry < new Date()) {
      return res.status(400).json({ message: "Verification OTP has expired" });
    }

    let otpMatches = false;
    if (user.verificationToken) {
      try {
        otpMatches = await bcrypt.compare(otp, user.verificationToken);
      } catch {
        // Malformed or legacy token values are treated as invalid credentials.
      }
    }
    if (!otpMatches) {
      return res.status(400).json({ message: "Invalid or expired verification OTP" });
    }

    // Update user
    const consumed = await consumeUserVerification(user.id, user.verificationToken!);
    if (!consumed) return res.status(400).json({ message: "Invalid or expired verification OTP" });

    // Generate JWT token for auto-login
    const jwtToken = generateToken({ userId: user.id, email: user.email });
    setAuthCookie(res, AUTH_COOKIES.user, jwtToken);

    const [businessProfiles, brandToolkits] = await Promise.all([
      accessibleBusinessProfiles(user.id),
      setupBrandToolkits(user.id),
    ]);
    const selectedProfile = businessProfiles.find(p => p.id === req.businessProfileId) ?? businessProfiles[0];

    res.json({
      message: "Email verified successfully",
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        isSetupComplete: user.isSetupComplete || false,
        isApproved: user.isApproved || Boolean(selectedProfile && selectedProfile.role !== 'owner' && selectedProfile.ownerApproved && selectedProfile.isApproved),
        workspaceRole: selectedProfile?.role ?? null,
        businessProfileId: selectedProfile?.id ?? null,
        hasBusinessProfile: businessProfiles.length > 0,
        businessProfileCount: businessProfiles.length,
        hasBrandToolkit: brandToolkits.length > 0,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Email verification error');
    res.status(500).json({ message: "Unable to verify your email. Please try again." });
  }
}

export async function logout(req: Request, res: Response) {
  const authHeader = req.headers.authorization;
  const tokens = new Set([readAuthCookie(req, AUTH_COOKIES.user),
    authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined]);
  for (const token of tokens) {
    if (!token) continue;
    const payload = verifyToken(token);
    if (!payload || !Number.isSafeInteger(payload.userId) || payload.userId! <= 0
      || payload.adminId || payload.supportMemberId) continue;
    if (!await revokeToken(token)) {
      return res.status(503).json({ message: "Sign out could not be confirmed. Please try again." });
    }
  }
  clearAuthCookie(res, AUTH_COOKIES.user);
  res.status(204).send();
}

// Forgot password
export async function forgotPassword(req: Request, res: Response) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Find user
    const user = await getUserByEmail(email);
    if (!user || user.deletedAt) {
      // Don't reveal if user exists or not
      return res.json({ message: "If the email exists, a password reset OTP has been sent" });
    }

    // Generate 6-digit OTP
    const otp = generateRandomToken();
    const hashedOtp = await bcrypt.hash(otp, 10);
    const resetPasswordTokenExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Update user with reset token
    await updateUser(user.id, {
      resetPasswordToken: hashedOtp,
      resetPasswordTokenExpiry,
    });

    // Send reset password email
    const delivery = await sendResetPasswordEmail(email, otp, user.name);
    if (delivery?.success === false) return res.status(503).json({ message: "Unable to send the recovery email right now. Please try again shortly." });

    res.json({ message: "If the email exists, a password reset OTP has been sent" });
  } catch (error) {
    logger.error({ err: error }, 'Forgot password error');
    res.status(500).json({ message: "Unable to process your password reset request. Please try again." });
  }
}

// Reset password
export async function resetPassword(req: Request, res: Response) {
  try {
    const { email, otp, newPassword } = req.body;

    if (typeof email !== "string" || typeof otp !== "string" || !/^\d{6}$/.test(otp) || !newPassword) {
      return res.status(400).json({ message: "Email, OTP, and new password are required" });
    }

    // Find user by email
    const user = await getUserByEmail(email);
    if (!user || user.deletedAt) {
      return res.status(400).json({ message: "Invalid OTP or email" });
    }

    // Check if OTP matches
    const otpMatches = user.resetPasswordToken?.startsWith('$2')
      ? await bcrypt.compare(otp, user.resetPasswordToken)
      : false;
    if (!otpMatches) {
      return res.status(400).json({ message: "Invalid OTP or email" });
    }

    // Check if OTP is expired
    if (!user.resetPasswordTokenExpiry || user.resetPasswordTokenExpiry < new Date()) {
      return res.status(400).json({ message: "OTP has expired" });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update user
    const consumed = await consumeUserPasswordReset(user.id, user.resetPasswordToken!, hashedPassword);
    if (!consumed) return res.status(400).json({ message: "Invalid or expired OTP" });

    res.json({ message: "Password reset successfully" });
  } catch (error) {
    logger.error({ err: error }, 'Reset password error');
    res.status(500).json({ message: "Unable to reset your password. Please try again." });
  }
}

// Get current user (requires authentication)
export async function getCurrentUser(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = (req as any).user;

    // Check if user has business profile and brand toolkit
    // Phase 5.17 / CTRL-005: companySettings is now statically imported.

    const businessProfiles = await accessibleBusinessProfiles(user.id);
    const selectedProfile = businessProfiles.find(p => p.id === req.businessProfileId) ?? businessProfiles[0];
    const brandToolkits = await setupBrandToolkits(user.id);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isVerified: user.isVerified,
        isSetupComplete: user.isSetupComplete || false,
        isApproved: user.isApproved || Boolean(selectedProfile && selectedProfile.role !== 'owner' && selectedProfile.ownerApproved && selectedProfile.isApproved),
        workspaceRole: selectedProfile?.role ?? null,
        businessProfileId: selectedProfile?.id ?? null,
        hasBusinessProfile: businessProfiles.length > 0,
        businessProfileCount: businessProfiles.length,
        hasBrandToolkit: brandToolkits.length > 0,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Get current user error');
    res.status(500).json({ message: "Unable to retrieve your account information. Please try again." });
  }
}

// Resend verification email
export async function resendVerificationEmail(req: Request, res: Response) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Find user by email
    const user = await getUserByEmail(email);
    if (!user || user.deletedAt) {
      // Don't reveal if user exists or not for security
      return res.json({ message: "If the email exists and is not verified, a verification email has been sent" });
    }

    // Check if user is already verified
    if (user.isVerified) {
      return res.json({ message: "If the email exists and is not verified, a verification email has been sent" });
    }

    // Generate a fresh six-digit OTP and replace the previous bcrypt hash.
    const verificationOtp = generateRandomToken();
    const verificationOtpHash = await bcrypt.hash(verificationOtp, 10);
    const verificationOtpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Update user with the new OTP hash and expiry.
    await updateUser(user.id, {
      verificationToken: verificationOtpHash,
      verificationTokenExpiry: verificationOtpExpiry,
    });

    // Send verification email
    const delivery = await sendVerificationEmail(email, verificationOtp, user.name);
    if (delivery?.success === false) return res.status(503).json({ message: "Unable to send the verification email right now. Please try again shortly." });

    res.json({ message: "If the email exists and is not verified, a verification email has been sent" });
  } catch (error) {
    logger.error({ err: error }, 'Resend verification email error');
    res.status(500).json({ message: "Unable to resend the verification email. Please try again." });
  }
}

// Mark user setup as complete
export async function markSetupComplete(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const setupScope=currentBusinessScope() || await resolveBusinessScope(Number(userId));
    if(!setupScope || setupScope.userId!==Number(userId)) return res.status(403).json({error:'Complete setup from a workspace you own.'});
    const clearCompletedDrafts=()=>db.execute(sql`UPDATE workspace_setup_drafts SET data=NULL,revision=revision+1,updated_at=now()
      WHERE user_id=${Number(userId)} AND data IS NOT NULL AND
        (draft_key=${`brand:${setupScope.businessProfileId}`} OR (draft_key='workspace:first' AND data->>'profileId'=${String(setupScope.businessProfileId)}))`);
    const [profiles, toolkits] = await Promise.all([
      db.select({ id: companySettings.id }).from(companySettings).where(eq(companySettings.userId, userId)).limit(1),
      setupBrandToolkits(userId),
    ]);
    if (!profiles.length || !toolkits.length) {
      return res.status(400).json({ error: "Save your business profile and brand toolkit before completing setup." });
    }

    const [completed] = await db.update(usersTable)
      .set({ isSetupComplete: true, updatedAt: new Date() })
      .where(and(eq(usersTable.id, userId), eq(usersTable.isSetupComplete, false)))
      .returning({ id: usersTable.id });

    if (!completed) {
      const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
      if (!existing) return res.status(404).json({ error: 'User account not found' });
      await clearCompletedDrafts();
      return res.json({ success: true, message: 'Setup was already complete' });
    }
    
    await clearCompletedDrafts();
    logger.info({userId,businessProfileId:setupScope.businessProfileId,event:'workspace_setup_completed'},'Workspace setup completed');
    // Get user details for emails
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = await getUserByEmail((req as any).user?.email);
    if (user) {
      // Send "under review" email to the user
      // Notifications are best-effort after the persisted onboarding state.
      // A mail-provider outage must not make the client retry a completed setup.
      const admins = await db.select({ email: adminsTable.email }).from(adminsTable);
      void Promise.allSettled([
        sendApprovalPendingEmail(user.email, user.name),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...admins.map((admin: any) => sendNewUserNotificationToAdmin(admin.email, user.name, user.email)),
      ]).then((results) => {
        const failures = results.filter((result) => result.status === 'rejected').length;
        if (failures > 0) logger.warn({ userId, failures }, 'Some setup-complete notifications could not be sent');
      });
    }
    
    res.json({ success: true, message: "Setup marked as complete" });
  } catch (error) {
    logger.error({ err: error }, 'Error marking setup complete');
    res.status(500).json({ error: "Unable to complete the onboarding setup. Please try again." });
  }
}
