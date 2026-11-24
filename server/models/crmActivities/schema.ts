import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { usersTable } from '../users/schema';
import { crmContactsTable } from '../crmContacts/schema';
import { outreachConversationsTable, outreachMessagesTable } from '../outreachConversations/schema';

export const crmActivitiesTable = pgTable('crm_activities', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').notNull().references(() => crmContactsTable.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 50 }).notNull(),
  subject: varchar('subject', { length: 500 }),
  body: text('body'),
  // Originating source
  outreachConversationId: integer('outreach_conversation_id').references(() => outreachConversationsTable.id, { onDelete: 'set null' }),
  outreachMessageId: integer('outreach_message_id').references(() => outreachMessagesTable.id, { onDelete: 'set null' }),
  // For tasks
  dueAt: timestamp('due_at'),
  completedAt: timestamp('completed_at'),
  priority: varchar('priority', { length: 20 }).default('medium'),
  // Metadata
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  idempotencyKey: varchar('idempotency_key', { length: 200 }),
  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_crm_activities_user_id').on(table.userId),
  contactIdIdx: index('idx_crm_activities_contact_id').on(table.contactId),
  typeIdx: index('idx_crm_activities_type').on(table.type),
  createdAtIdx: index('idx_crm_activities_created_at').on(table.createdAt),
  dueAtIdx: index('idx_crm_activities_due_at').on(table.dueAt),
  userIdempotencyIdx: uniqueIndex('crm_activities_user_idempotency_uq')
    .on(table.businessProfileId, table.userId, table.idempotencyKey)
    .where(sql`${table.idempotencyKey} IS NOT NULL`),
}));
