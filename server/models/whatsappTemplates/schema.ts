import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, jsonb, boolean, uniqueIndex } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema.js';

export const whatsappTemplatesTable = pgTable('whatsapp_templates', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  
  name: varchar('name', { length: 255 }).notNull(),
  language: varchar('language', { length: 50 }).notNull().default('en'),
  category: varchar('category', { length: 50 }).notNull().default('MARKETING'),
  status: varchar('status', { length: 50 }).notNull().default('DRAFT'),
  
  header: text('header'),
  headerType: varchar('header_type', { length: 20 }).default('TEXT'), // TEXT, IMAGE, VIDEO, DOCUMENT
  headerMediaUrl: text('header_media_url'),
  body: text('body').notNull(),
  footer: text('footer'),
  buttons: jsonb('buttons'), // [{type: 'QUICK_REPLY'|'URL'|'PHONE_NUMBER', text, url?, phone_number?}]
  examples: jsonb('examples'), // {"1": "Example value"}
  variableLabels: jsonb('variable_labels'),
  authConfig: jsonb('auth_config'),
  activityHistory: jsonb('activity_history').notNull().default([]),
  approvedSnapshot: jsonb('approved_snapshot'),
  submittedSnapshot: jsonb('submitted_snapshot'),
  
  wabaTemplateId: varchar('waba_template_id', { length: 255 }),
  metaStatus: varchar('meta_status', { length: 50 }),
  submissionStatus: varchar('submission_status', { length: 30 }).notNull().default('local_draft'),
  submittedAt: timestamp('submitted_at'),
  metaRejectionReason: text('meta_rejection_reason'),
  lastSyncedAt: timestamp('last_synced_at'),
  hasLocalChanges: boolean('has_local_changes').notNull().default(true),
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  ownerNameUq: uniqueIndex('whatsapp_templates_owner_name_uq').on(table.businessProfileId, table.userId, table.name),
}));

export type WhatsAppTemplateRecord = typeof whatsappTemplatesTable.$inferSelect;
export type InsertWhatsAppTemplate = typeof whatsappTemplatesTable.$inferInsert;
