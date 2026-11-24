import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { usersTable } from '../users/schema';

export const crmContactImportsTable = pgTable('crm_contact_imports', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  fileName: varchar('file_name', { length: 500 }).notNull(),
  totalRecords: integer('total_records').default(0),
  requestFingerprint: varchar('request_fingerprint', { length: 64 }),
  processedRecords: integer('processed_records').notNull().default(0),
  successCount: integer('success_count').default(0),
  errorCount: integer('error_count').default(0),
  skippedCount: integer('skipped_count').default(0),
  importType: varchar('import_type', { length: 50 }).default('new'),
  columnMapping: jsonb('column_mapping').$type<Record<string, string>>().default({}),
  importStatus: varchar('import_status', { length: 50 }).notNull().default('queued'),
  errorSummary: jsonb('error_summary').$type<Array<{ row: number; error: string }>>().default([]),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  uploadedAt: timestamp('uploaded_at'),
  completedAt: timestamp('completed_at'),
}, (table) => ({
  fingerprintUq: uniqueIndex('crm_import_fingerprint_uq').on(table.businessProfileId, table.userId, table.requestFingerprint).where(sql`${table.requestFingerprint} IS NOT NULL`),
  userIdIdx: index('idx_crm_contact_imports_user_id').on(table.userId),
  statusIdx: index('idx_crm_contact_imports_status').on(table.importStatus),
}));
