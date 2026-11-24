import { businessProfileColumn } from "../businessProfileColumn.js";
import {
  bigint,
  bigserial,
  boolean,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { companySettings } from '../companySettings/schema';

export const knowledgeIndexVersionsTable = pgTable('knowledge_index_versions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  versionKey: varchar('version_key', { length: 160 }).notNull(),
  provider: varchar('provider', { length: 50 }).notNull(),
  model: varchar('model', { length: 120 }).notNull(),
  dimensions: integer('dimensions').notNull(),
  state: varchar('state', { length: 20 }).notNull().default('building'),
  activatedAt: timestamp('activated_at'),
  retiredAt: timestamp('retired_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('uq_knowledge_index_version_key').on(table.versionKey)]);

export const knowledgeDocumentsTable = pgTable('knowledge_documents', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  businessProfileId: integer('business_profile_id').references(() => companySettings.id, { onDelete: 'set null' }),
  legacyEntryId: integer('legacy_entry_id'),
  sourceType: varchar('source_type', { length: 30 }).notNull(),
  title: varchar('title', { length: 255 }).notNull(),
  description: varchar('description', { length: 1000 }),
  sourceUrl: varchar('source_url', { length: 2048 }),
  ownerUserId: integer('owner_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
  audience: varchar('audience', { length: 20 }).notNull().default('customer'),
  accessScope: varchar('access_scope', { length: 30 }).notNull().default('tenant'),
  usageScopes: text('usage_scopes').array().notNull().default(['support_answer']),
  allowedChannels: text('allowed_channels').array().notNull().default([]),
  locale: varchar('locale', { length: 24 }),
  productScope: jsonb('product_scope').$type<Record<string, unknown>>().notNull().default({}),
  currentPublishedVersionId: bigint('current_published_version_id', { mode: 'number' }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const knowledgeDocumentVersionsTable = pgTable('knowledge_document_versions', {
  businessProfileId: businessProfileColumn(),
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  documentId: bigint('document_id', { mode: 'number' }).notNull(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  versionNo: integer('version_no').notNull(),
  status: varchar('status', { length: 30 }).notNull().default('draft'),
  contentHash: varchar('content_hash', { length: 64 }).notNull(),
  normalizedContent: text('normalized_content').notNull(),
  authority: varchar('authority', { length: 40 }).notNull().default('owner_authored'),
  privacyClassification: varchar('privacy_classification', { length: 30 }).notNull().default('business'),
  effectiveAt: timestamp('effective_at'),
  expiresAt: timestamp('expires_at'),
  reviewDueAt: timestamp('review_due_at'),
  reviewedBy: integer('reviewed_by').references(() => usersTable.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at'),
  supersedesVersionId: bigint('supersedes_version_id', { mode: 'number' }),
  extractionStatus: varchar('extraction_status', { length: 20 }).notNull().default('completed'),
  lexicalIndexStatus: varchar('lexical_index_status', { length: 20 }).notNull().default('queued'),
  vectorIndexStatus: varchar('vector_index_status', { length: 20 }).notNull().default('queued'),
  diagnostics: jsonb('diagnostics').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const knowledgeChunksTable = pgTable('knowledge_chunks', {
  businessProfileId: businessProfileColumn(),
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  documentId: bigint('document_id', { mode: 'number' }).notNull(),
  versionId: bigint('version_id', { mode: 'number' }).notNull(),
  ordinal: integer('ordinal').notNull(),
  evidenceId: varchar('evidence_id', { length: 180 }).notNull(),
  displayText: text('display_text').notNull(),
  searchText: text('search_text').notNull(),
  sectionPath: text('section_path').array().notNull().default([]),
  pageNumber: integer('page_number'),
  sheetName: varchar('sheet_name', { length: 255 }),
  rowStart: integer('row_start'),
  rowEnd: integer('row_end'),
  charStart: integer('char_start'),
  charEnd: integer('char_end'),
  tokenCount: integer('token_count').notNull(),
  previousChunkId: bigint('previous_chunk_id', { mode: 'number' }),
  nextChunkId: bigint('next_chunk_id', { mode: 'number' }),
  accessScope: varchar('access_scope', { length: 30 }).notNull().default('tenant'),
  sensitivity: varchar('sensitivity', { length: 30 }).notNull().default('business'),
  exactIdentifiers: text('exact_identifiers').array().notNull().default([]),
  injectionFlags: text('injection_flags').array().notNull().default([]),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('uq_knowledge_chunk_evidence').on(table.evidenceId)]);

export const knowledgeRetrievalAuditsTable = pgTable('knowledge_retrieval_audits', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  businessProfileId: integer('business_profile_id').references(() => companySettings.id, { onDelete: 'set null' }),
  purpose: varchar('purpose', { length: 40 }).notNull(),
  channel: varchar('channel', { length: 40 }).notNull(),
  audience: varchar('audience', { length: 20 }).notNull(),
  queryFingerprint: varchar('query_fingerprint', { length: 64 }).notNull(),
  retrievalStatus: varchar('retrieval_status', { length: 30 }).notNull(),
  indexVersionKey: varchar('index_version_key', { length: 160 }),
  filters: jsonb('filters').$type<Record<string, unknown>>().notNull().default({}),
  candidateSummary: jsonb('candidate_summary').$type<Record<string, unknown>>().notNull().default({}),
  selectedEvidenceIds: text('selected_evidence_ids').array().notNull().default([]),
  latencyMs: integer('latency_ms').notNull().default(0),
  reranked: boolean('reranked').notNull().default(false),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const knowledgeRuntimeSettingsTable = pgTable('knowledge_runtime_settings', {
  id: smallint('id').primaryKey().default(1),
  knowledgeV2Enabled: boolean('knowledge_v2_enabled').notNull().default(false),
  maintenanceMode: boolean('maintenance_mode').notNull().default(false),
  activeIndexVersionId: bigint('active_index_version_id', { mode: 'number' }),
  updatedBy: integer('updated_by').references(() => usersTable.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const knowledgeGovernanceAuditsTable = pgTable('knowledge_governance_audits', {
  businessProfileId: businessProfileColumn(),
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  documentId: bigint('document_id', { mode: 'number' }),
  versionId: bigint('version_id', { mode: 'number' }),
  actorUserId: integer('actor_user_id').references(() => usersTable.id, { onDelete: 'set null' }),
  action: varchar('action', { length: 40 }).notNull(),
  reason: varchar('reason', { length: 1000 }),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type KnowledgeDocument = typeof knowledgeDocumentsTable.$inferSelect;
export type KnowledgeDocumentVersion = typeof knowledgeDocumentVersionsTable.$inferSelect;
export type KnowledgeChunk = typeof knowledgeChunksTable.$inferSelect;
