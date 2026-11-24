import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Embeddings Schema
 * Stores vector embeddings with content, provider/model metadata, and dedup hash.
 * Uses pgvector for similarity search.
 */

import { pgTable, serial, integer, varchar, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';

export const embeddingsTable = pgTable('embeddings', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  sourceType: varchar('source_type', { length: 50 }).notNull(), // 'knowledge_base', 'lead', 'content', 'custom'
  sourceId: integer('source_id'), // FK to source record (nullable for custom text)
  contentHash: varchar('content_hash', { length: 64 }).notNull(), // SHA-256 for dedup
  content: text('content').notNull(), // Original text that was embedded
  provider: varchar('provider', { length: 50 }).notNull(), // 'openai', 'gemini'
  model: varchar('model', { length: 100 }).notNull(), // 'text-embedding-3-small', etc.
  dimensions: integer('dimensions').notNull(),
  // embedding column is managed via raw SQL (pgvector type)
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('idx_embeddings_user_id').on(table.userId),
  index('idx_embeddings_source').on(table.sourceType, table.sourceId),
  uniqueIndex('idx_embeddings_content_hash_model').on(table.businessProfileId,
    table.userId,
    table.sourceType,
    table.sourceId,
    table.contentHash,
    table.provider,
    table.model,
  ),
]);

export type EmbeddingRecord = typeof embeddingsTable.$inferSelect;
export type InsertEmbedding = typeof embeddingsTable.$inferInsert;
