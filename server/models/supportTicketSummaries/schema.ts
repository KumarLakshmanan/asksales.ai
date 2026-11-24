import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { supportTicketsTable } from '../supportTickets/schema';

export interface SupportTicketSummaryPayload {
  issue: string;
  customerIntent: string;
  importantFacts: string[];
  actionsAttempted: string[];
  unresolvedQuestions: string[];
  recommendedNextAction: string;
  sentiment: string | null;
  risk: string | null;
  sourceReferences: Array<{ source: string; messageId: number; label: string }>;
}

export const supportTicketSummariesTable = pgTable('support_ticket_summaries', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  ticketId: integer('ticket_id').notNull().references(() => supportTicketsTable.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 24 }).notNull().default('stale'),
  summary: jsonb('summary').$type<SupportTicketSummaryPayload>(),
  sourceCursor: varchar('source_cursor', { length: 320 }),
  model: varchar('model', { length: 120 }),
  promptVersion: varchar('prompt_version', { length: 40 }).notNull().default('v1'),
  error: text('error'),
  generatedAt: timestamp('generated_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  ticketUq: uniqueIndex('support_ticket_summaries_ticket_uq').on(table.businessProfileId, table.userId, table.ticketId),
  statusIdx: index('support_ticket_summaries_status_idx').on(table.status, table.updatedAt),
}));

export type SupportTicketSummaryRecord = typeof supportTicketSummariesTable.$inferSelect;
