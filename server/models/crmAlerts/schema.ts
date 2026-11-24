import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';

export const crmAlertsTable = pgTable('crm_alerts', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  conditions: jsonb('conditions').default({}),
  enabled: boolean('enabled').notNull().default(true),
  notifyUser: boolean('notify_user').notNull().default(true),
  notifyContact: boolean('notify_contact').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
