import { boolean, index, integer, jsonb, pgTable, serial, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { adminsTable } from '../admins/schema.js';

export const intentClassifierCredentialsTable = pgTable('intent_classifier_credentials', {
  id: serial('id').primaryKey(),
  platform: varchar('platform', { length: 50 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  apiKey: text('api_key').notNull(),
  apiSecret: text('api_secret'),
  isEncrypted: boolean('is_encrypted').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  priority: varchar('priority', { length: 20 }).notNull().default('normal'),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  lastUsedAt: timestamp('last_used_at'),
  usageCount: integer('usage_count').notNull().default(0),
  lastValidatedAt: timestamp('last_validated_at'),
  validationStatus: varchar('validation_status', { length: 20 }),
  validationMessage: text('validation_message'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, table => ({
  activePriorityIdx: index('intent_classifier_credentials_active_priority_idx').on(table.isActive, table.priority),
}));

export const intentClassifierCredentialAuditTable = pgTable('intent_classifier_credential_audit', {
  id: serial('id').primaryKey(),
  credentialId: integer('credential_id'),
  platform: varchar('platform', { length: 50 }).notNull(),
  action: varchar('action', { length: 20 }).notNull(),
  adminId: integer('admin_id').references(() => adminsTable.id, { onDelete: 'set null' }),
  changedFields: jsonb('changed_fields').$type<string[]>().notNull().default([]),
  validationStatus: varchar('validation_status', { length: 20 }),
  message: text('message'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, table => ({
  credentialIdx: index('intent_classifier_credential_audit_credential_idx').on(table.credentialId, table.createdAt),
}));

export type IntentClassifierCredential = typeof intentClassifierCredentialsTable.$inferSelect;
export type InsertIntentClassifierCredential = typeof intentClassifierCredentialsTable.$inferInsert;
