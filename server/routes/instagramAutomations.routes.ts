import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { Router, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';
import { authenticateToken } from '../middleware/auth.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { db } from '../models/db.js';
import { logger } from '../utils/logger.js';
import {
  InstagramAutomationError,
  InstagramAutomationProvider,
  requireInstagramAutomationAccount,
  instagramAutomationReadiness,
} from '../services/instagramAutomations/InstagramAutomationProvider.js';
import {
  automationScope,
  getInstagramAutomationOverview,
  getInstagramProfile,
  saveInstagramProfile,
  listInstagramRules,
  saveInstagramRule,
  deleteInstagramRule,
  reorderInstagramRules,
  duplicateInstagramRule,
  testInstagramRule,
} from '../services/instagramAutomations/InstagramAutomationConfiguration.js';
import type { InstagramProfileKind } from '../../shared/instagramAutomations.js';
const router = Router();
type Handler = (req: Request, userId: number, accountId: string) => Promise<unknown>;
const handler = (work: Handler) => async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req),
      accountId = String(req.params.accountId);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    await requireInstagramAutomationAccount(userId, accountId);
    return res.json({ success: true, data: await work(req, userId, accountId) });
  } catch (error) {
    const capacity=normalizeCapacityError(error);
    if(capacity) return res.status(capacity.status).json(capacity.toJSON());
    if (error instanceof InstagramAutomationError)
      return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, 'Instagram automation request failed');
    return res
      .status(500)
      .json({ error: 'The Instagram automation request could not be completed.' });
  }
};
const kind = (req: Request): InstagramProfileKind => {
  if (!['menu', 'icebreakers'].includes(req.params.kind))
    throw new InstagramAutomationError('Unknown profile setting.');
  return req.params.kind as InstagramProfileKind;
};
const id = (value: unknown): number => {
  const n = Number(value);
  if (
    !['number', 'string'].includes(typeof value) ||
    (typeof value === 'string' && !/^\d+$/.test(value)) ||
    !Number.isSafeInteger(n) ||
    n < 1 ||
    n > 2147483647
  )
    throw new InstagramAutomationError('Invalid identifier.');
  return n;
};
router.use(authenticateToken);
router.get(
  '/:accountId',
  handler((_req, userId, accountId) => getInstagramAutomationOverview(userId, accountId))
);
router.get('/:accountId/readiness', handler(async (req, userId, accountId) => {
  if (req.query.verify !== undefined && req.query.verify !== '1') throw new InstagramAutomationError('Invalid connection verification option.');
  const account = await requireInstagramAutomationAccount(userId, accountId);
  return req.query.verify === '1' ? new InstagramAutomationProvider(account).connectionHealth() : instagramAutomationReadiness(account);
}));
router.get(
  '/:accountId/profiles/:kind',
  handler(
    async (req, userId, accountId) =>
      (await getInstagramProfile(userId, accountId, kind(req))) || null
  )
);
router.put(
  '/:accountId/profiles/:kind',
  handler((req, userId, accountId) =>
    saveInstagramProfile(
      userId,
      accountId,
      kind(req),
      req.body.config,
      req.body.revision,
      req.body.publish === true
    )
  )
);
router.delete(
  '/:accountId/profiles/:kind',
  handler((req, userId, accountId) =>
    saveInstagramProfile(
      userId,
      accountId,
      kind(req),
      { locales: [] },
      req.body?.revision,
      true,
      true
    )
  )
);
router.get(
  '/:accountId/rules',
  handler((_req, userId, accountId) => listInstagramRules(userId, accountId))
);
router.post(
  '/:accountId/rules',
  handler((req, userId, accountId) => saveInstagramRule(userId, accountId, req.body.definition))
);
router.put(
  '/:accountId/rules/order',
  handler((req, userId, accountId) => reorderInstagramRules(userId, accountId, req.body.ids))
);
router.put(
  '/:accountId/rules/:id',
  handler((req, userId, accountId) =>
    saveInstagramRule(
      userId,
      accountId,
      req.body.definition,
      id(req.params.id),
      req.body.status,
      req.body.revision
    )
  )
);
router.post('/:accountId/rules/:id/duplicate', handler((req, userId, accountId) => duplicateInstagramRule(userId, accountId, id(req.params.id), id(req.body?.revision))));
router.post('/:accountId/rules/:id/test', handler((req, userId, accountId) => testInstagramRule(userId, accountId, id(req.params.id), req.body)));
router.delete(
  '/:accountId/rules/:id',
  handler(async (req, userId, accountId) => {
    await deleteInstagramRule(userId, accountId, id(req.params.id), id(req.body?.revision));
    return { deleted: true };
  })
);
router.get(
  '/:accountId/media',
  handler(async (req, userId, accountId) => {
    if (
      req.query.after !== undefined &&
      (typeof req.query.after !== 'string' || req.query.after.length > 2000)
    )
      throw new InstagramAutomationError('Invalid media cursor.');
    return new InstagramAutomationProvider(
      await requireInstagramAutomationAccount(userId, accountId)
    ).media(req.query.after as string | undefined);
  })
);
router.get(
  '/:accountId/runs',
  handler(async (req, userId, accountId) => {
    const scope = automationScope(userId),
      cursor = req.query.cursor !== undefined ? id(req.query.cursor) : null,
      ruleId = req.query.ruleId !== undefined ? id(req.query.ruleId) : null;
    const rows =
      await db.execute(sql`SELECT id,rule_id AS "ruleId",rule_name AS "ruleName",source_key AS "sourceKey",status,reason,
    private_message_id AS "privateMessageId",public_message_id AS "publicMessageId",created_at AS "createdAt",updated_at AS "updatedAt",
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',e.effect_key,'status',e.status,'error',e.error) ORDER BY e.id),'[]'::jsonb)
      FROM instagram_automation_effects e WHERE e.run_id=instagram_automation_runs.id AND e.user_id=${userId} AND e.business_profile_id=${scope.businessProfileId}) AS effects
    FROM instagram_automation_runs WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND account_id=${accountId}
      AND status<>'unmatched' AND (${ruleId}::integer IS NULL OR rule_id=${ruleId}::integer)
      AND (${cursor}::integer IS NULL OR id<${cursor}::integer) ORDER BY id DESC LIMIT 51`);
    return {
      runs: rows.rows.slice(0, 50),
      nextCursor: rows.rows.length > 50 ? rows.rows[49].id : null,
    };
  })
);
export default router;
