import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, text, timestamp, index, check, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { supportTicketsTable } from '../supportTickets/schema';
import { usersTable } from '../users/schema';

export const supportTicketReviewsTable = pgTable('support_ticket_reviews', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  ticketId: integer('ticket_id').notNull().references(() => supportTicketsTable.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  rating: integer('rating').notNull(),
  comment: text('comment'),
  tokenConsumedAt: timestamp('token_consumed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  ticketIdIdx: uniqueIndex('support_ticket_reviews_ticket_id_uq').on(table.ticketId),
  userIdIdx: index('idx_support_ticket_reviews_user_id').on(table.userId),
  ratingCheck: check('rating_range_check', sql`${table.rating} >= 1 AND ${table.rating} <= 5`),
}));
