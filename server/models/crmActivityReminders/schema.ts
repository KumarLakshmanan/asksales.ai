import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { crmActivitiesTable } from '../crmActivities/schema';
import { crmContactsTable } from '../crmContacts/schema';

export const crmActivityRemindersTable = pgTable('crm_activity_reminders', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  activityId: integer('activity_id').references(() => crmActivitiesTable.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').references(() => crmContactsTable.id, { onDelete: 'set null' }),
  reminderDueAt: timestamp('reminder_due_at').notNull(),
  reminderType: varchar('reminder_type', { length: 50 }).notNull().default('followup'),
  status: varchar('status', { length: 50 }).notNull().default('pending'),
  title: varchar('title', { length: 500 }),
  description: text('description'),
  timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Kolkata'),
  sentAt: timestamp('sent_at'),
  lastSentAt: timestamp('last_sent_at'),
  snoozedUntil: timestamp('snoozed_until'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_crm_activity_reminders_user_id').on(table.userId),
  statusIdx: index('idx_crm_activity_reminders_status').on(table.status),
  dueAtIdx: index('idx_crm_activity_reminders_due_at').on(table.reminderDueAt),
  contactIdIdx: index('idx_crm_activity_reminders_contact_id').on(table.contactId),
}));
