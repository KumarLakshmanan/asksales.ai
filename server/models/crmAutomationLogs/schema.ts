import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { crmPipelineAutomationsTable } from '../crmPipelineAutomations/schema';
import { crmContactsTable } from '../crmContacts/schema';

export const crmAutomationLogsTable = pgTable('crm_automation_logs', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  automationId: integer('automation_id').notNull().references(() => crmPipelineAutomationsTable.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').references(() => crmContactsTable.id, { onDelete: 'set null' }),
  actionTaken: varchar('action_taken', { length: 255 }),
  result: varchar('result', { length: 50 }).notNull().default('success'),
  errorMessage: text('error_message'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  executedAt: timestamp('executed_at').notNull().defaultNow(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  automationIdIdx: index('idx_crm_automation_logs_automation_id').on(table.automationId),
  userIdIdx: index('idx_crm_automation_logs_user_id').on(table.userId),
  executedAtIdx: index('idx_crm_automation_logs_executed_at').on(table.executedAt),
}));
