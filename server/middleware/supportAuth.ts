import { withSystemScope, withBusinessScope } from '../tenancy/businessContext.js';
import type { Request, Response, NextFunction } from "express";
import { verifyToken, isTokenRevoked } from "../utils/jwt";
import { db } from '../models/db';
import { teamMembersTable } from '../models/teamMembers/schema';
import { supportTeamsTable } from '../models/supportTeams/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { AUTH_COOKIES, readAuthCookie, setAuthCookie } from '../utils/authCookies.js';
import { supportPresenceService } from '../services/SupportPresenceService.js';

export async function authenticateSupportMember(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    // AUTH-005: Require explicit "Bearer " prefix
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.split(" ")[1]
      : readAuthCookie(req, AUTH_COOKIES.support);

    if (!token) {
      return res.status(401).json({ message: "Access token is required" });
    }

    const payload = verifyToken(token) as (Awaited<ReturnType<typeof verifyToken>> & { jti?: string }) | null;
    if (!payload || !payload.supportMemberId || payload.userId || payload.adminId) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    if (authHeader?.startsWith('Bearer ') && !readAuthCookie(req, AUTH_COOKIES.support)) {
      setAuthCookie(res, AUTH_COOKIES.support, token);
    }

    // SEC-005: Check token revocation blocklist
    if (payload.jti && await isTokenRevoked(payload.jti)) {
      return res.status(401).json({ message: "Token has been revoked" });
    }

    const [member] = await withSystemScope('Authenticate support member', () => db.select().from(teamMembersTable)
      .where(and(
        eq(teamMembersTable.id, payload.supportMemberId!),
        eq(teamMembersTable.isActive, true)
      )));

    if (!member) {
      return res.status(403).json({ message: "Account not found or inactive" });
    }
    if (!member.businessProfileId) return res.status(403).json({ message: 'Support business is unavailable' });
    return await withBusinessScope({ userId: member.userId, businessProfileId: member.businessProfileId }, async () => {
    const [team] = await db.select({ id: supportTeamsTable.id }).from(supportTeamsTable)
      .where(and(eq(supportTeamsTable.id, member.teamId), eq(supportTeamsTable.userId, member.userId), eq(supportTeamsTable.isActive, true)));
    if (!team) return res.status(403).json({ message: "Support team not found or inactive" });
    if (member.passwordChangedAt && payload.iat && payload.iat * 1000 < member.passwordChangedAt.getTime()) {
      return res.status(401).json({ message: "Session expired after password change" });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).supportMember = member;
    // The JWT jti identifies a browser session without persisting the token.
    // Touching presence on authenticated actions complements the 60-second UI heartbeat.
    (req as any).supportSessionJti = payload.jti || '';
    if (payload.jti) await supportPresenceService.startOrTouch(member.userId, member.id, payload.jti);
    next();
    });
  } catch (error) {
    logger.error({ err: error }, 'Support member authentication error');
    // A lookup failure is not evidence of bad credentials: answer "try again"
    // (as the user and admin checks do), never a sign-out.
    if (!res.headersSent) res.status(503).json({ code: 'SESSION_VERIFICATION_UNAVAILABLE', message: 'Your session could not be verified. Please try again.' });
  }
}
