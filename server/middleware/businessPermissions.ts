import type { Request, Response, NextFunction } from "express";
import {
  currentBusinessScope,
  isBusinessOwner,
} from "../tenancy/businessContext.js";

export function requireBusinessOwner(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!authorizeBusinessOwner(req, res)) return;
  return next();
}

export function authorizeBusinessOwner(req: Request, res: Response): boolean {
  if (!req.user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  const scope = currentBusinessScope();
  if (!isBusinessOwner(req) || (scope && req.user?.id !== (scope.actorUserId ?? scope.userId))) {
    res
      .status(403)
      .json({
        code: "BUSINESS_OWNER_REQUIRED",
        error: "Only the business owner can manage this setting.",
      });
    return false;
  }
  return true;
}

/** Explicit route capability for connection secrets and account management.
 * Keep this independent of the central URL classifier so new aliases can opt in. */
export function requireBusinessManager(req: Request, res: Response, next: NextFunction) {
  if (authorizeBusinessManager(req, res)) return next();
}

export function authorizeBusinessManager(req: Request, res: Response): boolean {
  if (!req.user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  if (hasBusinessManagerAuthority(req)) return true;
  res.status(403).json({
    code: 'BUSINESS_MANAGER_REQUIRED',
    error: 'Ask the business owner or billing admin to manage connections.',
  });
  return false;
}

export function hasBusinessManagerAuthority(req: Pick<Request, 'user'>): boolean {
  const scope = currentBusinessScope();
  const matchesActor = !scope || req.user?.id === (scope.actorUserId ?? scope.userId);
  return Boolean(req.user?.id && matchesActor && (isBusinessOwner(req) || scope?.role === 'billing_admin'));
}

/** Connection authority and support-login administration are separate from
 * permission to operate the business's CRM, content and conversations. */
export function businessPermissions(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const scope = currentBusinessScope();
  if (!scope) return next();
  if (req.user?.id !== (scope.actorUserId ?? scope.userId)) return res.status(403).json({code:'BUSINESS_ACTOR_MISMATCH',error:'Business authority does not match the authenticated account.'});
  if (scope.userId === req.user?.id) return next();
  const path = req.originalUrl.split("?")[0];
  const mutates = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  const connection =
    /^\/api\/webhooks\/(?:config|regenerate)$/.test(path) ||
    (mutates && /^\/api\/(?:whatsapp\/(?:config|toggle|test)|(?:instagram|facebook)\/settings|linkedin\/config)(?:\/|$)/.test(path)) ||
    (mutates && /^\/api\/(?:instagram|facebook|youtube|meta|google-ads|twitter|linkedin)\/oauth\/(?:selection|refresh|disconnect|manual|platforms)(?:\/|$)/.test(path)) ||
    /\/oauth\/(?:authorize|auth-url|auth|connect|url)$/.test(path) ||
    /^\/api\/(?:credentials\/|(?:facebook|instagram|whatsapp)\/manual-credentials|youtube\/credentials|apify\/tokens(?:\/|$))/.test(
      path,
    ) ||
    (mutates &&
      /^\/api\/(?:gmail\/oauth(?:\/|$)|integrations(?:\/|$)|channel-accounts(?:\/|$)|email-settings(?:\/|$)|email-senders(?:\/|$)|msg91(?:-settings)?(?:\/|$)|resend\/domains(?:\/|$))/.test(
        path,
      ));
  if (connection) return requireBusinessManager(req, res, next);
  const ownerSetting =
    mutates &&
    (/^\/api\/settings\/ai-agents(?:\/|$)/.test(path) ||
      /^\/api\/support\/ai\/playbooks(?:\/|$)/.test(path) ||
      /^\/api\/support\/(?:teams(?:\/|$)|notification)/.test(path) ||
      /^\/api\/support\/\d+\/messages\/[^/]+\/\d+\/reveal$/.test(path));
  if (ownerSetting) return requireBusinessOwner(req, res, next);
  return next();
}
