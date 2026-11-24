import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { proposalsTable } from '../proposals/schema';

export const proposalRemindersTable = pgTable('proposal_reminders', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  proposalId: integer('proposal_id').notNull().references(() => proposalsTable.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  reminderDueAt: timestamp('reminder_due_at').notNull(),
  sentAt: timestamp('sent_at'),
  lastSentAt: timestamp('last_sent_at'),
  reminderType: varchar('reminder_type', { length: 50 }).notNull().default('expiry'),
  status: varchar('status', { length: 50 }).notNull().default('pending'),
  timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Kolkata'),
  snoozedUntil: timestamp('snoozed_until'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  proposalIdIdx: index('idx_proposal_reminders_proposal_id').on(table.proposalId),
  userIdIdx: index('idx_proposal_reminders_user_id').on(table.userId),
  statusIdx: index('idx_proposal_reminders_status').on(table.status),
  dueAtIdx: index('idx_proposal_reminders_due_at').on(table.reminderDueAt),
}));
