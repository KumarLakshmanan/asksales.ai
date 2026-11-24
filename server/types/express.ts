/**
 * Typed Express Request interfaces (Phase 4.16 / 4.17 / TYPE-002, TYPE-005)
 *
 * Augments Express's Request so `req.user` is strongly typed and `(req as any).user`
 * casts are no longer needed in middleware/controllers.
 */
import type { Request } from 'express';

/**
 * The fields controllers actually read on a regular user. Adding fields is
 * safe (drizzle's `User` type is assignable) but accidentally reading
 * non-existent ones becomes a compile error.
 */
export interface AuthenticatedUser {
  id: number;
  email: string;
  name?: string;
  role?: 'user' | 'admin' | 'support' | 'super_admin';
  // App-specific extension points (consumers must add to this union if used)
  companyProfileId?: number;
  isActive?: boolean;
  emailVerified?: boolean;
  setupCompleted?: boolean;
  webhookTokenNonce?: string | null;
}

export interface AdminUser {
  id: number;
  email: string;
  role: 'admin' | 'super_admin';
  name?: string;
  isActive?: boolean;
}

export interface SupportUser {
  id: number;
  email: string;
  role: 'support';
  name?: string;
  isActive?: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Attached by authenticateToken / authenticateAdminToken / authenticateSupportMember.
       * Optional because not every route is authenticated.
       */
      user?: AuthenticatedUser | AdminUser | SupportUser;
      /**
       * Per-request correlation id (also surfaces in logs).
       */
      id?: string;
      /** Validated business identity, fixed for this request. */
      businessProfileId?: number;
    }
  }
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Helpers retain backwards-compat with the untyped `(req as any).user` access
 * pattern so existing callers don't need to change immediately.
 */
export function getUserId(req: Request): number | undefined {
  return req.user?.id;
}

export {};
