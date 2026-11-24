import type { Request, Response, NextFunction } from 'express';
import { resolveBusinessScope } from '../tenancy/businessScopeResolver.js';
import { isAccountPrivacyPath } from '../tenancy/accountPrivacy.js';
import { withAccountScope, withBusinessScope } from '../tenancy/businessContext.js';

const accountPath = /^\/api\/(?:platform\/access(?:\/|$)|settings\/(?:profile|preferences)(?:\/|$)|auth(?:\/|$)|user(?:s)?(?:\/|$)|profile(?:\/|$)|setup(?:\/|$)|organizations(?:\/|$)|wallet(?:\/|$)|billing(?:\/|$)|subscriptions?(?:\/|$)|settings\/(?:business-profiles|business-categories|company)(?:\/|$))/;

export async function businessProfileScope(req: Request, res: Response, next: NextFunction) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Authentication required' });
  const path = req.originalUrl.split('?')[0];
  if (isAccountPrivacyPath(path)) return withAccountScope(next);
  // Profile management must work even after the tab's previous profile was
  // deleted. The account identity remains checked by every management handler.
  const accountOnly = accountPath.test(path);
  const managesIdentity = /^\/api\/(?:setup\/drafts(?:\/|$)|platform\/access(?:\/|$)|settings\/(?:profile|preferences)(?:\/|$)|auth(?:\/|$)|user(?:s)?(?:\/|$)|profile(?:\/|$)|settings\/(?:business-profiles|business-categories)(?:\/|$))/.test(path);
  // Browser redirects cannot send custom headers. Only OAuth initiation accepts
  // this non-secret selector in the query string; callbacks use durable state.
  const oauthInitiation = /\/oauth\/(?:authorize|auth|connect)$/.test(path);
  const value = req.headers['x-business-profile-id'] ?? (oauthInitiation ? req.query.businessProfileId : undefined);
  if (!managesIdentity && value !== undefined && (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
    return res.status(400).json({ code: 'INVALID_BUSINESS_PROFILE', message: 'Invalid business profile' });
  }
  const validValue = typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
  let scope = await resolveBusinessScope(userId, validValue ? Number(value) : undefined);
  if (!scope && validValue && !managesIdentity) return res.status(403).json({ code: 'BUSINESS_PROFILE_FORBIDDEN', message: 'This business profile is not available to your account.' });
  if (!scope && managesIdentity) scope = await resolveBusinessScope(userId);
  if (!scope) {
    if (accountOnly) return next();
    return res.status(409).json({ code: 'BUSINESS_PROFILE_REQUIRED', message: 'Select a business profile to continue' });
  }
  req.businessProfileId = scope.businessProfileId;
  if (!accountOnly) {
    for (const selected of [req.query.businessProfileId, req.body?.businessProfileId, req.body?.businessId]) {
      if (selected != null && selected !== '' && Number(selected) !== scope.businessProfileId) {
        return res.status(400).json({ code:'BUSINESS_PROFILE_MISMATCH', message:'Switch to this business profile before using its records' });
      }
    }
  }
  return withBusinessScope(scope, next);
}
