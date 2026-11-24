import type { Request, Response } from 'express';
import { listPricingAudit, type PricingAuditDomain } from '../models/pricingAudit/functions.js';
import { logger } from '../utils/logger.js';

const DOMAINS = new Set<PricingAuditDomain>([
  'credit_pricing',
  'api_pricing',
  'storage_pricing',
  'storage_plan',
]);

export async function getPricingAudit(req: Request, res: Response) {
  try {
    const domain = typeof req.query.domain === 'string' && req.query.domain
      ? req.query.domain as PricingAuditDomain
      : undefined;
    if (domain && !DOMAINS.has(domain)) return res.status(400).json({ error: 'Invalid pricing audit domain' });
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
      return res.status(400).json({ error: 'Invalid pagination' });
    }
    const result = await listPricingAudit({ domain, limit, offset });
    return res.json({ success: true, data: { ...result, limit, offset } });
  } catch (error) {
    logger.error({ err: error }, '[AdminPricingAudit] Failed to retrieve pricing history');
    return res.status(500).json({ error: 'Unable to retrieve pricing history.' });
  }
}
