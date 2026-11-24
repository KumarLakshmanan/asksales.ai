import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { logger } from '../utils/logger.js';
import { redactLogValue } from '../utils/logRedaction.js';

const DOMAINS = new Set(['pricing', 'platform_access', 'credentials']);

export async function getUnifiedAdminAudit(req: Request, res: Response) {
  try {
    const domain = typeof req.query.domain === 'string' && req.query.domain !== 'all' ? req.query.domain : null;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 50);
    const offset = (page - 1) * limit;
    if (domain && !DOMAINS.has(domain)) return res.status(400).json({ error: 'Invalid audit domain' });
    if (search.length > 200) return res.status(400).json({ error: 'Search must be 200 characters or fewer' });
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100
      || !Number.isSafeInteger(offset)) {
      return res.status(400).json({ error: 'Invalid audit pagination' });
    }
    const query = sql`
      WITH audit_events AS (
        SELECT 'pricing'::text AS domain, p.id::text AS source_id, p.action,
               CONCAT(p.domain, ':', COALESCE(p.pricing_key, p.record_id::text, 'global')) AS target,
               p.admin_id, a.name AS admin_name,
               jsonb_build_object('before', p.before_value, 'after', p.after_value, 'effectiveAt', p.effective_at) AS details,
               p.created_at
        FROM pricing_change_audit p LEFT JOIN admins a ON a.id = p.admin_id
        UNION ALL
        SELECT 'platform_access', x.id::text, 'update', CONCAT(x.target_type, ':', x.target_key),
               x.admin_id, a.name,
               jsonb_build_object('userId', x.user_id, 'before', x.before_value, 'after', x.after_value), x.created_at
        FROM platform_access_audit x LEFT JOIN admins a ON a.id = x.admin_id
        UNION ALL
        SELECT 'credentials', c.id::text, c.action, CONCAT(c.platform, ':', COALESCE(c.credential_id::text, 'deleted')),
               c.admin_id, a.name,
               jsonb_build_object('changedFields', c.changed_fields, 'validationStatus', c.validation_status, 'message', c.message), c.created_at
        FROM admin_credential_audit c LEFT JOIN admins a ON a.id = c.admin_id
      ), filtered AS (
        SELECT * FROM audit_events
        WHERE (${domain}::text IS NULL OR domain = ${domain})
          AND (${search}::text = '' OR action ILIKE ${`%${search}%`} OR target ILIKE ${`%${search}%`} OR COALESCE(admin_name, '') ILIKE ${`%${search}%`})
      )
      SELECT entry.*, counts.total_count
      FROM (SELECT COUNT(*)::int AS total_count FROM filtered) counts
      LEFT JOIN LATERAL (
        SELECT * FROM filtered ORDER BY created_at DESC, source_id DESC, domain DESC
        LIMIT ${limit} OFFSET ${offset}
      ) entry ON TRUE
      ORDER BY entry.created_at DESC, entry.source_id DESC, entry.domain DESC
    `;
    const result = await db.execute(query);
    const rows = (result.rows || []) as Array<Record<string, unknown>>;
    const total = Number(rows[0]?.total_count ?? 0);
    return res.json({
      entries: rows.filter(row => row.source_id != null)
        .map(({ total_count: _total, ...row }) => ({ ...row, details: redactLogValue(row.details) })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      domains: Array.from(DOMAINS),
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load unified administrator audit');
    return res.status(500).json({ error: 'Unable to retrieve administrator audit history.' });
  }
}
