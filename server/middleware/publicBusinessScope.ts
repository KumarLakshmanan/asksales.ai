import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../models/db.js';
import { withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';

/** A narrow capability lookup, followed by normal business-scoped processing.
 * Existing handlers still validate expiry, signatures and operation permissions. */
function tokenScope(lookup: (req: Request) => SQL | null) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = lookup(req);
      if (!query) return res.status(404).json({ error: 'Invalid or expired link' });
      const result = await withSystemScope('Resolve public capability owner', () => db.execute(query));
      const row = result.rows[0];
      if (!row?.business_profile_id || !row?.user_id) return res.status(404).json({ error: 'Invalid or expired link' });
      return withBusinessScope({ userId: Number(row.user_id), businessProfileId: Number(row.business_profile_id) }, next);
    } catch (error) { return next(error); }
  };
}
function token(value: unknown): string | null {
  return typeof value === 'string' && value.length >= 16 && value.length <= 512 ? value : null;
}
export const widgetBusinessScope = tokenScope(req => {
  const value = token(req.body?.token ?? req.query.token);
  return value ? sql`SELECT t.user_id,t.business_profile_id FROM support_teams t WHERE t.widget_token=${value} AND t.is_active=TRUE LIMIT 1` : null;
});
export const widgetEmailBusinessScope = tokenScope(req => {
  const value = token(req.query.token);
  return value ? sql`SELECT user_id,business_profile_id FROM leads WHERE confirmation_token=${value} LIMIT 1` : null;
});
export const proposalBusinessScope = tokenScope(req => {
  const value = token(req.params.token);
  return value ? sql`SELECT user_id,business_profile_id FROM proposals
    WHERE public_token_hash=${createHash('sha256').update(value).digest('hex')}
    AND public_token_expires_at>NOW() LIMIT 1` : null;
});
export const reviewBusinessScope = tokenScope(req => {
  const value = token(req.params.token);
  return value ? sql`SELECT user_id,business_profile_id FROM support_tickets WHERE review_token=${value} AND review_token_expires_at>NOW() LIMIT 1` : null;
});
export const reportBusinessScope = tokenScope(req => {
  const value = token(req.params.token);
  return value ? sql`SELECT user_id,business_profile_id FROM ai_visibility_report_shares
    WHERE token_hash=${createHash('sha256').update(value).digest('hex')} LIMIT 1` : null;
});
