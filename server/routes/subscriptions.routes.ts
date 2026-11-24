import { listOrganizationWallets, adjustOrganizationCredits } from '../services/billing/adminWallets.js';
import { adminPlanOverview, assignAdminPlan, revokeAdminPlan } from '../services/subscriptions/adminPlans.js';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authenticateToken, authenticateAdminToken, requireSuperAdmin } from '../middleware/auth.js';
import { apiRateLimiter } from '../middleware/rateLimiter.js';
import { subscriptions } from '../services/subscriptions/service.js';
import { SubscriptionError } from '../services/subscriptions/gateway.js';
import { configureSubscriptions, provisionSubscriptionPlans, setSubscriptionEnforcement, subscriptionAdminState, setCapacityEnforcement } from '../services/subscriptions/admin.js';
import { getCatalog, catalogAdminState, createCatalogDraft, saveCatalogDraft, publishCatalog, retireCatalog } from '../services/subscriptions/catalog.js';
import { BillingOrganizationError } from '../services/billing/organizations.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { logger } from '../utils/logger.js';

const planInput = z.object({ catalogVersion: z.number().int().positive(), plan: z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/), term: z.enum(['monthly','yearly']) }).strict();
const checkoutInput = z.object({ subscriptionId: z.string().regex(/^sub_[a-zA-Z0-9]+$/), paymentId: z.string().regex(/^pay_[a-zA-Z0-9]+$/), signature: z.string().regex(/^[a-f0-9]{64}$/i) }).strict();
const adminPlanInput = z.object({
  catalogVersion:z.number().int().positive(),plan:z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/),
  term:z.enum(['monthly','yearly']),timing:z.enum(['now','at_term_end']),
  reason:z.string().trim().min(3).max(500),
}).strict();
const adminPlanEndInput = z.object({scope:z.enum(['scheduled','active']),reason:z.string().trim().min(3).max(500)}).strict();
function handle(fn: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try { return res.json(await fn(req)); }
    catch (error) {
      if(error instanceof BillingOrganizationError) return res.status(error.status).json({success:false,error:error.message,code:error.code});
      const capacity=normalizeCapacityError(error); if(capacity) return res.status(capacity.status).json(capacity.toJSON());
      if (error instanceof z.ZodError) return res.status(400).json({ success: false, error: 'Invalid subscription request.' });
      if (error instanceof SubscriptionError) return res.status(error.status).json({ success: false, error: error.message, code: error.code });
      logger.error({ message: error instanceof Error ? error.message : 'Unknown error' }, '[Subscriptions] Request failed');
      return res.status(503).json({ success: false, error: 'Billing is temporarily unavailable. Please try again.', code: 'BILLING_UNAVAILABLE' });
    }
  };
}

export const subscriptionRoutes = Router();
subscriptionRoutes.get('/catalog', (_req,res,next) => { res.set('Cache-Control','no-store'); next(); }, handle(() => getCatalog()));
subscriptionRoutes.use(authenticateToken);
subscriptionRoutes.get('/current', handle(req => subscriptions.state(Number(req.user!.id))));
subscriptionRoutes.post('/start', apiRateLimiter, handle(req => { const input = planInput.parse(req.body); return subscriptions.start(Number(req.user!.id), input.plan, input.term, input.catalogVersion); }));
// Changes use a replacement mandate starting at renewal; authorization precedes cancellation of the old mandate.
subscriptionRoutes.post('/change', apiRateLimiter, handle(req => { const input = planInput.parse(req.body); return subscriptions.start(Number(req.user!.id), input.plan, input.term, input.catalogVersion); }));
subscriptionRoutes.post('/verify', apiRateLimiter, handle(req => { const input = checkoutInput.parse(req.body); return subscriptions.verify(Number(req.user!.id), input.subscriptionId, input.paymentId, input.signature); }));
subscriptionRoutes.post('/refresh', apiRateLimiter, handle(req => subscriptions.refresh(Number(req.user!.id))));
subscriptionRoutes.post('/cancel', apiRateLimiter, handle(req => {
  const { scope } = z.object({ scope: z.enum(['renewal','pending']).default('renewal') }).strict().parse(req.body || {});
  return subscriptions.cancel(Number(req.user!.id), scope);
}));

export const subscriptionAdminRoutes = Router();
subscriptionAdminRoutes.use(authenticateAdminToken, requireSuperAdmin);
subscriptionAdminRoutes.get('/organizations', handle(req => listOrganizationWallets(z.string().trim().max(255).parse(req.query.search??''))));
const adminOrganizationId = (req:Request) => z.coerce.number().int().positive().parse(req.params.organizationId);
subscriptionAdminRoutes.get('/organizations/:organizationId/plan', handle(req => adminPlanOverview(adminOrganizationId(req))));
subscriptionAdminRoutes.post('/organizations/:organizationId/plan', apiRateLimiter, handle(req =>
  assignAdminPlan(Number(req.user!.id),adminOrganizationId(req),adminPlanInput.parse(req.body))));
subscriptionAdminRoutes.post('/organizations/:organizationId/plan/end', apiRateLimiter, handle(req => {
  const input=adminPlanEndInput.parse(req.body);
  return revokeAdminPlan(Number(req.user!.id),adminOrganizationId(req),input.scope,input.reason);
}));
subscriptionAdminRoutes.post('/organizations/:organizationId/credits', apiRateLimiter, handle(req=>{
  const organizationId=z.coerce.number().int().positive().parse(req.params.organizationId);
  const {amount,reason}=z.object({amount:z.number().positive().max(100_000_000),reason:z.string().trim().min(3).max(500)}).strict().parse(req.body);
  return adjustOrganizationCredits(Number(req.user!.id),organizationId,amount,reason);
}));
subscriptionAdminRoutes.get('/catalog', handle(() => catalogAdminState()));
subscriptionAdminRoutes.post('/catalog/drafts', handle(req => createCatalogDraft(Number(req.user!.id))));
const version = (req:Request) => z.coerce.number().int().positive().parse(req.params.version);
subscriptionAdminRoutes.put('/catalog/drafts/:version', handle(req => saveCatalogDraft(Number(req.user!.id),version(req),req.body)));
subscriptionAdminRoutes.post('/catalog/:version/publish', apiRateLimiter, handle(req => publishCatalog(Number(req.user!.id),version(req))));
subscriptionAdminRoutes.post('/catalog/:version/retire', handle(req => retireCatalog(Number(req.user!.id),version(req))));
subscriptionAdminRoutes.put('/capacity-enforcement', handle(req => { const {enabled}=z.object({enabled:z.boolean()}).strict().parse(req.body); return setCapacityEnforcement(Number(req.user!.id),enabled); }));
subscriptionAdminRoutes.get('/', handle(() => subscriptionAdminState()));
subscriptionAdminRoutes.put('/configuration', handle(req => {
  const input = z.object({ credentialId: z.number().int().positive(), webhookSecret: z.string().min(16).max(255).optional() }).strict().parse(req.body);
  return configureSubscriptions(Number(req.user!.id), input.credentialId, input.webhookSecret);
}));
subscriptionAdminRoutes.post('/provision', apiRateLimiter, handle(req => provisionSubscriptionPlans(Number(req.user!.id))));
subscriptionAdminRoutes.put('/enforcement', handle(req => {
  const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
  return setSubscriptionEnforcement(Number(req.user!.id), enabled);
}));
subscriptionAdminRoutes.post('/reconcile', apiRateLimiter, handle(async () => { await subscriptions.runScheduled(); return subscriptionAdminState(); }));

export const subscriptionWebhook = handle(async req => {
  const credentialId = Number(req.params.credentialId);
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!Number.isSafeInteger(credentialId) || credentialId <= 0 || !Buffer.isBuffer(rawBody)) throw new SubscriptionError('Invalid webhook request.');
  await subscriptions.webhook(credentialId, rawBody, String(req.headers['x-razorpay-signature'] || ''), String(req.headers['x-razorpay-event-id'] || ''));
  return { received: true };
});

export async function requireActiveSubscriberForTopUp(req: Request, res: Response, next: NextFunction) {
  try {
    const access = await subscriptions.access(Number(req.user!.id));
    if (!access.canTopUp) return res.status(402).json({ success: false, code: 'SUBSCRIPTION_REQUIRED', error: 'An active paid subscription is required to buy extra credits.' });
    return next();
  } catch {
    return res.status(503).json({ success: false, error: 'Subscription access could not be verified.' });
  }
}
