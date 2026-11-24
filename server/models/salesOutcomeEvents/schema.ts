import { boolean, index, integer, numeric, pgTable, serial, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';
import { businessProfileColumn } from '../businessProfileColumn.js';

export const salesOutcomeEventsTable = pgTable('sales_outcome_events', {
  id: serial('id').primaryKey(),
  businessProfileId: businessProfileColumn(),
  userId: integer('user_id').notNull(),
  actorUserId: integer('actor_user_id').notNull(),
  sourceKey: varchar('source_key', { length: 500 }).notNull(),
  kind: varchar('kind', { length: 40 }).notNull(),
  contactId: integer('contact_id'),
  bookingId: integer('booking_id'),
  conversationKind: varchar('conversation_kind', { length: 30 }),
  conversationId: integer('conversation_id'),
  channel: varchar('channel', { length: 30 }).notNull().default('unattributed'),
  amount: numeric('amount', { precision: 20, scale: 6 }),
  currency: varchar('currency', { length: 10 }),
  evidence: varchar('evidence', { length: 30 }).notNull(),
  paymentId: varchar('payment_id', { length: 255 }),
  verified: boolean('verified').notNull().default(false),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
}, (table) => ({
  sourceUnique: uniqueIndex('sales_outcome_events_source_uq').on(table.businessProfileId, table.sourceKey),
  periodIndex: index('sales_outcome_events_period_idx').on(table.businessProfileId, table.occurredAt),
  contactIndex: index('sales_outcome_events_contact_idx').on(table.businessProfileId, table.contactId, table.occurredAt),
}));
