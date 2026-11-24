import { count, desc, eq } from 'drizzle-orm';
import { db } from '../db.js';
import { adminsTable } from '../admins/schema.js';
import { pricingAuditTable } from './schema.js';

export type PricingAuditDomain = 'credit_pricing' | 'api_pricing' | 'storage_pricing' | 'storage_plan';

export async function listPricingAudit(options: {
  domain?: PricingAuditDomain;
  limit: number;
  offset: number;
}) {
  const condition = options.domain ? eq(pricingAuditTable.domain, options.domain) : undefined;
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: pricingAuditTable.id,
        domain: pricingAuditTable.domain,
        recordId: pricingAuditTable.recordId,
        pricingKey: pricingAuditTable.pricingKey,
        action: pricingAuditTable.action,
        adminId: pricingAuditTable.adminId,
        adminName: adminsTable.name,
        adminEmail: adminsTable.email,
        beforeValue: pricingAuditTable.beforeValue,
        afterValue: pricingAuditTable.afterValue,
        effectiveAt: pricingAuditTable.effectiveAt,
        createdAt: pricingAuditTable.createdAt,
      })
      .from(pricingAuditTable)
      .leftJoin(adminsTable, eq(pricingAuditTable.adminId, adminsTable.id))
      .where(condition)
      .orderBy(desc(pricingAuditTable.createdAt), desc(pricingAuditTable.id))
      .limit(options.limit)
      .offset(options.offset),
    db.select({ total: count() }).from(pricingAuditTable).where(condition),
  ]);
  return { entries: rows, total: Number(totalRow?.total ?? 0) };
}

export function pricingAuditValues(input: {
  domain: PricingAuditDomain;
  recordId?: number | null;
  pricingKey?: string | null;
  action: 'create' | 'update' | 'delete' | 'seed';
  adminId?: number | null;
  beforeValue?: unknown;
  afterValue?: unknown;
}) {
  return {
    domain: input.domain,
    recordId: input.recordId ?? null,
    pricingKey: input.pricingKey ?? null,
    action: input.action,
    adminId: input.adminId ?? null,
    beforeValue: (input.beforeValue ?? null) as Record<string, unknown> | null,
    afterValue: (input.afterValue ?? null) as Record<string, unknown> | null,
    effectiveAt: new Date(),
  };
}
