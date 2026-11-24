import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema.js';

/**
 * Tenant-scoped cache for public links supplied in support conversations.
 * Only normalized, bounded facts are stored here; raw actor/crawler payloads
 * and provider credentials never enter this table.
 */
export const externalContentEnrichmentsTable = pgTable('external_content_enrichments', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  urlHash: varchar('url_hash', { length: 64 }).notNull(),
  canonicalUrl: text('canonical_url').notNull(),
  platform: varchar('platform', { length: 32 }).notNull().default('website'),
  status: varchar('status', { length: 24 }).notNull(), // resolved | unavailable
  resolutionSource: varchar('resolution_source', { length: 32 }).notNull(), // post_cache | apify | crawler | unavailable
  actorId: varchar('actor_id', { length: 160 }),
  actorRunId: varchar('actor_run_id', { length: 160 }),
  normalizedData: jsonb('normalized_data').$type<Record<string, unknown>>().notNull().default({}),
  context: text('context'),
  errorCode: varchar('error_code', { length: 64 }),
  errorMessage: text('error_message'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  tenantUrlUq: uniqueIndex('external_content_enrichments_tenant_url_uq').on(table.businessProfileId, table.userId, table.urlHash),
  expiresIdx: index('external_content_enrichments_expires_idx').on(table.expiresAt),
  tenantStatusIdx: index('external_content_enrichments_tenant_status_idx').on(table.userId, table.status),
}));

export type ExternalContentEnrichmentRecord = typeof externalContentEnrichmentsTable.$inferSelect;
