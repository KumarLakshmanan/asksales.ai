import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, text, varchar, timestamp, jsonb, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { brandToolkitsTable } from '../brandToolkits/schema';
import { companySettings } from '../companySettings/schema';

export const contentTemplatesTable = pgTable('content_templates', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => usersTable.id, { onDelete: 'cascade' }),
  brandToolkitId: integer('brand_toolkit_id').references(() => brandToolkitsTable.id, { onDelete: 'set null' }),
  businessProfileId: integer('business_profile_id').references(() => companySettings.id, { onDelete: 'set null' }),
  
  name: varchar('name', { length: 255 }).notNull(),
  type: varchar('type', { length: 50 }).notNull(), // email, ad_copy, social, landing_page, blog
  
  subject: text('subject'), // For email templates
  content: text('content').notNull(),
  htmlContent: text('html_content'), // Full HTML for email builder templates
  
  // Template variables that can be replaced
  variables: jsonb('variables').$type<string[]>().default([]),
  
  // Metadata
  category: varchar('category', { length: 100 }),
  tags: jsonb('tags').$type<string[]>().default([]),
  description: text('description'),
  thumbnailUrl: text('thumbnail_url'),
  
  // Predefined (admin-created, shared with all users)
  isPredefined: boolean('is_predefined').default(false),
  
  // Usage tracking
  usageCount: integer('usage_count').default(0),
  lastUsedAt: timestamp('last_used_at'),
  
  // Approval status
  isApproved: boolean('is_approved').default(false),
  approvedBy: integer('approved_by').references(() => usersTable.id, { onDelete: 'set null' }),
  approvedAt: timestamp('approved_at'),
  version: integer('version').default(1).notNull(),
  brandContextSnapshot: jsonb('brand_context_snapshot').$type<Record<string, unknown>>().default({}).notNull(),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userTypeUpdatedIdx: index('content_templates_user_type_updated_idx').on(
    table.userId,
    table.type,
    table.updatedAt.desc(),
  ),
}));

export type ContentTemplate = typeof contentTemplatesTable.$inferSelect;
export type NewContentTemplate = typeof contentTemplatesTable.$inferInsert;

export const contentTemplateVersionsTable = pgTable('content_template_versions', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  templateId: integer('template_id').notNull().references(() => contentTemplatesTable.id, { onDelete: 'cascade' }),
  userId: integer('user_id').references(() => usersTable.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
  createdBy: integer('created_by').references(() => usersTable.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  templateVersionIdx: uniqueIndex('content_template_versions_template_version_uq').on(
    table.templateId,
    table.version,
  ),
  userCreatedIdx: index('content_template_versions_user_created_idx').on(
    table.userId,
    table.createdAt.desc(),
  ),
}));

export type ContentTemplateVersion = typeof contentTemplateVersionsTable.$inferSelect;
