import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, varchar, integer, jsonb, boolean, text, timestamp } from 'drizzle-orm/pg-core';

export const webhookEventsTable = pgTable('webhook_events', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  platform: varchar('platform', { length: 50 }).notNull(),
  eventType: varchar('event_type', { length: 100 }),
  pageId: varchar('page_id', { length: 100 }),
  userId: integer('user_id'),
  payload: jsonb('payload'),
  signatureValid: boolean('signature_valid').default(true),
  processed: boolean('processed').default(false),
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow(),
});
