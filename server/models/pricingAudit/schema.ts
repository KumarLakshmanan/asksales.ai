import { index, integer, jsonb, pgTable, serial, timestamp, varchar } from 'drizzle-orm/pg-core';
import { adminsTable } from '../admins/schema.js';

export const pricingAuditTable = pgTable('pricing_change_audit', {
  id: serial('id').primaryKey(),
  domain: varchar('domain', { length: 50 }).notNull(),
  recordId: integer('record_id'),
  pricingKey: varchar('pricing_key', { length: 150 }),
  action: varchar('action', { length: 20 }).notNull(),
  adminId: integer('admin_id').references(() => adminsTable.id, { onDelete: 'set null' }),
  beforeValue: jsonb('before_value').$type<Record<string, unknown> | null>(),
  afterValue: jsonb('after_value').$type<Record<string, unknown> | null>(),
  effectiveAt: timestamp('effective_at').notNull().defaultNow(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  domainRecordIdx: index('pricing_change_audit_domain_record_idx').on(table.domain, table.recordId, table.createdAt),
  createdIdx: index('pricing_change_audit_created_idx').on(table.createdAt),
  adminIdx: index('pricing_change_audit_admin_idx').on(table.adminId),
}));

export type PricingAuditRecord = typeof pricingAuditTable.$inferSelect;
