import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';

export const systemAlertsTable = pgTable('system_alerts', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  ticketId: integer('ticket_id'),
  title: text('title').notNull(),
  message: text('message').notNull(),
  type: varchar('type', { length: 50 }).notNull().default('info'),
  severity: varchar('severity', { length: 50 }).notNull().default('medium'),
  read: boolean('read').notNull().default(false),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
