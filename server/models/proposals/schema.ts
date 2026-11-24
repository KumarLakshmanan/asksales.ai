import { pgTable, serial, integer, varchar, text, timestamp, boolean, jsonb, decimal, index } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { crmContactsTable } from '../crmContacts/schema';
import { leadsTable } from '../leads/schema';
import { outreachConversationsTable } from '../outreachConversations/schema';
import { chatThreadsTable } from '../chatThreads/schema';
import { companySettings } from '../companySettings/schema';
import { proposalTemplatesTable } from '../proposalTemplates/schema';

export const proposalsTable = pgTable('proposals', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').references(() => crmContactsTable.id, { onDelete: 'set null' }),
  leadId: integer('lead_id').references(() => leadsTable.id, { onDelete: 'set null' }),
  outreachConversationId: integer('outreach_conversation_id').references(() => outreachConversationsTable.id, { onDelete: 'set null' }),
  chatThreadId: integer('chat_thread_id').references(() => chatThreadsTable.id, { onDelete: 'set null' }),
  templateId: integer('template_id').references(() => proposalTemplatesTable.id, { onDelete: 'set null' }),
  // Brand Toolkit the proposal was created with (migration 591).
  brandToolkitId: integer('brand_toolkit_id'),
  proposalNumber: varchar('proposal_number', { length: 50 }).notNull().unique(),
  draftKey: varchar('draft_key', { length: 100 }),
  supersededBy: integer('superseded_by'),
  revision: integer('revision').notNull().default(1),
  title: varchar('title', { length: 500 }).notNull(),
  coverNote: text('cover_note'),
  recipientName: varchar('recipient_name', { length: 255 }),
  recipientEmail: varchar('recipient_email', { length: 320 }),
  publicTokenHash: varchar('public_token_hash', { length: 64 }).unique(),
  publicTokenExpiresAt: timestamp('public_token_expires_at'),
  // Pricing
  currency: varchar('currency', { length: 10 }).default('USD'),
  subtotal: decimal('subtotal', { precision: 12, scale: 2 }).default('0'),
  discountType: varchar('discount_type', { length: 20 }),
  discountValue: decimal('discount_value', { precision: 12, scale: 2 }).default('0'),
  taxRate: decimal('tax_rate', { precision: 5, scale: 2 }).default('0'),
  total: decimal('total', { precision: 12, scale: 2 }).default('0'),
  // KB + Profile
  businessProfileId: integer('business_profile_id').references(() => companySettings.id, { onDelete: 'set null' }),
  knowledgeBaseSections: jsonb('knowledge_base_sections').$type<number[]>().default([]),
  aiGeneratedSummary: text('ai_generated_summary'),
  // Status
  status: varchar('status', { length: 50 }).notNull().default('draft'),
  validUntil: timestamp('valid_until'),
  sentAt: timestamp('sent_at'),
  viewedAt: timestamp('viewed_at'),
  acceptedAt: timestamp('accepted_at'),
  rejectedAt: timestamp('rejected_at'),
  rejectionReason: text('rejection_reason'),
  // Signature
  signatureRequired: boolean('signature_required').default(false),
  signedAt: timestamp('signed_at'),
  signedByName: varchar('signed_by_name', { length: 255 }),
  showTermsAndConditions: boolean('show_terms_and_conditions').default(false),
  termsAndConditions: text('terms_and_conditions'),
  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_proposals_user_id').on(table.userId),
  statusIdx: index('idx_proposals_status').on(table.status),
  contactIdIdx: index('idx_proposals_contact_id').on(table.contactId),
  validUntilIdx: index('idx_proposals_valid_until').on(table.validUntil),
  createdAtIdx: index('idx_proposals_created_at').on(table.createdAt),
  chatThreadIdIdx: index('idx_proposals_chat_thread_id').on(table.chatThreadId),
  templateIdIdx: index('idx_proposals_template_id').on(table.templateId),
  recipientEmailIdx: index('idx_proposals_recipient_email').on(table.recipientEmail),
  publicTokenExpiresAtIdx: index('idx_proposals_public_token_expires_at').on(table.publicTokenExpiresAt),
}));
