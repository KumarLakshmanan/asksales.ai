import type { Request, Response, NextFunction } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { parseWebhookCapability, verifyWebhookCapability, withVerifiedWebhookCapability, type WebhookPurpose } from '../utils/userWebhookTokens.js';
import { withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';

function requestPurpose(req: Request): WebhookPurpose | undefined {
  const route = req.originalUrl.split('?')[0].match(/^\/api\/webhooks\/(user|instagram|facebook|whatsapp|sms|twitter|linkedin|email|leads|automation)\/[^/]+(?:\/(delivery))?$/);
  if (!route || (route[2] && route[1] !== 'sms')) return undefined;
  return route[2] ? 'sms_delivery' : route[1] as WebhookPurpose;
}

export async function businessWebhookScope(req: Request, res: Response, next: NextFunction) {
  const token = req.params.userToken;
  const claims = typeof token === 'string' ? parseWebhookCapability(token) : null;
  const purpose = requestPurpose(req);
  if (!claims || !purpose || claims.purpose !== purpose) return res.status(403).json({ error: 'Invalid or expired webhook token' });
  try {
    const candidates = await withSystemScope('Resolve signed webhook capability owner', () => db.execute(sql`
      SELECT p.id,p.user_id,u.webhook_token_nonce FROM company_settings p JOIN users u ON u.id=p.user_id
      WHERE p.id=${claims.businessProfileId} AND p.user_id=${claims.userId} AND p.archived_at IS NULL AND u.deleted_at IS NULL LIMIT 1`));
    const owner = candidates.rows[0];
    const verified = owner && verifyWebhookCapability(token, owner.webhook_token_nonce, purpose);
    if (!verified || Number(owner.id) !== verified.businessProfileId || Number(owner.user_id) !== verified.userId) {
      return res.status(403).json({ error: 'Invalid or expired webhook token' });
    }
    return withBusinessScope({ userId: verified.userId, businessProfileId: verified.businessProfileId },
      () => withVerifiedWebhookCapability(token, verified, next));
  } catch (error) { return next(error); }
}
