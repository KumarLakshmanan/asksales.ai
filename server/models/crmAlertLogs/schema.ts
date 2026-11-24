import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { crmAlertsTable } from '../crmAlerts/schema';
import { crmContactsTable } from '../crmContacts/schema';

export const crmAlertLogsTable = pgTable('crm_alert_logs', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  alertId: integer('alert_id').notNull().references(() => crmAlertsTable.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  contactId: integer('contact_id').references(() => crmContactsTable.id, { onDelete: 'set null' }),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  eventData: jsonb('event_data').default({}),
  notifiedUser: boolean('notified_user').notNull().default(false),
  notifiedContact: boolean('notified_contact').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
