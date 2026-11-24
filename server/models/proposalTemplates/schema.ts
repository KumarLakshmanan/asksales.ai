import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, boolean, jsonb, index } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import type { ProposalLineItem } from '../../../shared/proposals.js';

export interface ProposalTemplateSection {
  title: string;
  body: string;
  kind: 'cover' | 'content' | 'terms' | 'closing';
  instruction?: string;
}

export interface ProposalTemplateContent {
  sections: ProposalTemplateSection[];
  placeholders: string[];
  warnings: string[];
  requiredFields?: string[];
}

export const proposalTemplatesTable = pgTable('proposal_templates', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => usersTable.id, { onDelete: 'cascade' }),
  published: boolean('published').notNull().default(false),
  templateKey: varchar('template_key', { length: 100 }),
  version: integer('version').notNull().default(1),
  name: varchar('name', { length: 255 }).notNull(),
  category: varchar('category', { length: 100 }).notNull().default('General'),
  description: text('description'),
  templateType: varchar('template_type', { length: 50 }).default('legacy'),
  isDefault: boolean('is_default').default(false),
  coverNote: text('cover_note'),
  lineItems: jsonb('line_items').$type<ProposalLineItem[]>().default([]),
  termsAndConditions: text('terms_and_conditions'),
  includeKnowledgeBase: boolean('include_knowledge_base').default(true),
  includeBusinessProfile: boolean('include_business_profile').default(true),
  sourceFileName: varchar('source_file_name', { length: 255 }),
  sourceMimeType: varchar('source_mime_type', { length: 120 }),
  sourceText: text('source_text'),
  sourceHtml: text('source_html'),
  templateContent: jsonb('template_content').$type<ProposalTemplateContent>().default({ sections: [], placeholders: [], warnings: [] }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_proposal_templates_user_id').on(table.userId),
}));
