import { businessPermissions } from './businessPermissions.js';
import type { Request, Response, NextFunction } from "express";
import { verifyToken, isTokenRevoked } from "../utils/jwt";
import { getUserById } from "../models/users/functions";
import { getAdminById } from "../models/admins/functions";
import { SmartThrottlingService } from "../services/SmartThrottlingService";
import { logger } from '../utils/logger.js';
import crypto from 'crypto';
import { checkSubscriptionRequest } from './subscriptionAccess.js';
import { AUTH_COOKIES, readAuthCookie, setAuthCookie } from '../utils/authCookies.js';
import { billingOrganizationScope } from './billingOrganizationScope.js';
import { businessProfileScope } from './businessProfileScope.js';
import { withSystemScope } from '../tenancy/businessContext.js';

const throttlingService = SmartThrottlingService.getInstance();

function sessionVerificationUnavailable(res: Response) {
  return res.status(503).json({
    code: 'SESSION_VERIFICATION_UNAVAILABLE',
    message: 'Your session could not be verified. Please try again.',
  });
}

export async function authenticateToken(req: Request, res: Response, next: NextFunction) {
  try {
    // Rate limiting based on IP - using userId 0 for IP-based limits
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
    // Use a proper hash that maps IP → a stable numeric bucket (avoids octet-sum aliasing)
    const ipHashHex = crypto.createHash('sha1').update(clientIP).digest('hex').slice(0, 8);
    const ipHash = parseInt(ipHashHex, 16);
    const rateLimitCheck = await throttlingService.isAllowed('api_general', ipHash);

    if (!rateLimitCheck.allowed) {
      return res.status(429).json({
        message: "Too many requests",
        retryAfter: rateLimitCheck.retryAfter || 60
      });
    }

    const authHeader = req.headers.authorization;
    // Accept token ONLY from Authorization header (never from URL query params —
    // query params are logged in access logs, proxy logs, and browser history).
    // AUTH-005: Require explicit "Bearer " prefix; reject Basic/Digest/etc.
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.split(" ")[1]
      : readAuthCookie(req, AUTH_COOKIES.user);

    if (!token) {
      // Record failed authentication attempt
      await throttlingService.recordRequest('api_auth', ipHash);
      return res.status(401).json({ message: "Access token is required" });
    }

    const payload = verifyToken(token) as (Awaited<ReturnType<typeof verifyToken>> & { jti?: string }) | null;
    if (!payload) {
      // Record failed authentication attempt
      await throttlingService.recordRequest('api_auth', ipHash);
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    // SEC-005: Check token revocation blocklist
    if (payload.jti && await isTokenRevoked(payload.jti)) {
      return res.status(401).json({ message: "Token has been revoked" });
    }

    if (!payload.userId || payload.adminId || payload.supportMemberId) {
      return res.status(403).json({ message: "User access token required" });
    }

    // Get user from database (for regular users)
    if (payload.userId) {
      try {
        const user = await getUserById(payload.userId);
        if (!user) {
          return res.status(401).json({ message: "User not found" });
        }
        if (user.deletedAt) {
          return res.status(401).json({ message: "User account is unavailable" });
        }
        if (user.passwordChangedAt && (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)
          || Math.round(payload.iat * 1000) < user.passwordChangedAt.getTime())) {
          return res.status(401).json({ message: "Session expired after password change" });
        }
        // Attach user to request
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        req.user = user as any;
      } catch (userError) {
        // Deny access when account verification is unavailable. A lookup error
        // is not evidence of invalid credentials and must not expire the session.
        logger.error({ userId: payload.userId, err: userError }, '[AUTH] Error fetching user');
        return sessionVerificationUnavailable(res);
      }

      // Record successful request for rate limiting per user
      await throttlingService.recordRequest('api_general', payload.userId);
    }

    await businessProfileScope(req, res, async (businessError?: unknown) => {
      if(businessError) return next(businessError);
      await businessPermissions(req,res,async () => billingOrganizationScope(req,res,async (billingError?: unknown) => {
        if(billingError) return next(billingError);
        if(await checkSubscriptionRequest(req,res)) {
          if (authHeader?.startsWith('Bearer ') && !readAuthCookie(req, AUTH_COOKIES.user)) {
            setAuthCookie(res, AUTH_COOKIES.user, token);
          }
          next();
        }
      }));
    });
  } catch (error) {
    logger.error({ err: error }, 'Authentication error');
    return sessionVerificationUnavailable(res);
  }
}

export async function authenticateAdminToken(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    
    // Tokens are accepted from the standard admin cookie or Authorization
    // header only. Never accept query parameters or page-specific token copies.
    const token = (authHeader && authHeader.startsWith('Bearer ') && authHeader.split(" ")[1])
      || readAuthCookie(req, AUTH_COOKIES.admin);

    if (!token) {
      return res.status(401).json({ message: "Access token is required" });
    }

    const payload = verifyToken(token) as (Awaited<ReturnType<typeof verifyToken>> & { jti?: string }) | null;
    if (!payload) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    if (!payload.jti) {
      return res.status(401).json({ message: 'Please sign in again' });
    }
    if (await isTokenRevoked(payload.jti, true)) {
      return res.status(401).json({ message: "Token has been revoked" });
    }

    if (
      !payload.adminId
      || payload.userId
      || payload.supportMemberId
      || !['admin', 'super_admin'].includes(payload.role || '')
    ) {
      return res.status(403).json({ message: "Admin access required" });
    }

    const admin = await getAdminById(payload.adminId);
    if (!admin) {
      return res.status(403).json({ message: "Admin not found" });
    }
    if (admin.passwordChangedAt && payload.iat && Math.round(payload.iat * 1000) < admin.passwordChangedAt.getTime()) {
      return res.status(401).json({ message: "Session expired after password change" });
    }

    // Strip sensitive fields from admin object
    const {
      password: _password,
      resetPasswordToken: _resetPasswordToken,
      resetPasswordTokenExpiry: _resetPasswordTokenExpiry,
      ...safeAdmin
    } = admin as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    req.user = safeAdmin as any;
    // Migrate bearer sessions only after principal, revocation and database checks.
    if (authHeader?.startsWith('Bearer ') && !readAuthCookie(req, AUTH_COOKIES.admin)) {
      setAuthCookie(res, AUTH_COOKIES.admin, token);
    }
    withSystemScope('Authenticated administrator', next);
  } catch (error) {
    logger.error({ err: error }, 'Admin authentication error');
    return sessionVerificationUnavailable(res);
  }
}

/**
 * Require super_admin role for sensitive operations.
 * Must be used after authenticateAdminToken.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = (req as any).user;
  if (!admin || admin.role !== 'super_admin') {
    return res.status(403).json({ message: "Super admin access required" });
  }
  next();
}
