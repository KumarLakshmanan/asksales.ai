/**
 * Embedding Settings Schema
 * Single-row admin configuration for default embedding provider/model
 */

import { pgTable, serial, varchar, jsonb, timestamp } from 'drizzle-orm/pg-core';

export const embeddingSettingsTable = pgTable('embedding_settings', {
  id: serial('id').primaryKey(),
  defaultProvider: varchar('default_provider', { length: 50 }).notNull().default('openai'),
  defaultModel: varchar('default_model', { length: 100 }).notNull().default('text-embedding-3-small'),
  enabledProviders: jsonb('enabled_providers').$type<string[]>().notNull().default(['openai']),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type EmbeddingSettingsRecord = typeof embeddingSettingsTable.$inferSelect;
export type InsertEmbeddingSettings = typeof embeddingSettingsTable.$inferInsert;
