import type { Request, Response } from 'express';
import { isAccountPrivacyPath } from '../tenancy/accountPrivacy.js';
import { subscriptions } from '../services/subscriptions/service.js';

/** Personal privacy controls, recovery, onboarding and support remain reachable after subscription access ends. */
export function isSubscriptionExempt(path: string) {
  return isAccountPrivacyPath(path) || /^\/api\/(?:auth|organizations|subscriptions|legal|wallet|support|notifications)(?:\/|$)/.test(path)
    || /^\/api\/platform\/access\/?$/.test(path)
    || /^\/api\/settings\/(?:profile|preferences|business-profiles|business-categories)(?:\/|$)/.test(path)
    || /^\/api\/user\/(?:profile|change-password|notification-preferences)(?:\/|$)/.test(path)
    || /^\/api\/content\/brand-toolkits(?:\/|$)/.test(path)
    || /^\/api\/setup(?:\/|$)/.test(path);
}

export async function checkSubscriptionRequest(req: Request, res: Response) {
  const path = req.originalUrl.split('?')[0];
  if (isSubscriptionExempt(path)) return true;
  try {
    const access = await subscriptions.access(Number(req.user!.id));
    if (access.allowed) return true;
    if (access.reason === 'approval_required') {
      res.status(403).json({ success: false, error: 'This business is awaiting account approval. Contact its owner or support.', code: 'BUSINESS_APPROVAL_REQUIRED' });
      return false;
    }
    res.status(402).json({ success: false, error: 'Choose a subscription to continue. Your wallet credits are retained.', code: 'SUBSCRIPTION_REQUIRED', subscription: access });
  } catch {
    res.status(503).json({ success: false, error: 'Subscription access could not be verified. Please try again.', code: 'SUBSCRIPTION_UNAVAILABLE' });
  }
  return false;
}
