import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { teamMembersTable } from "../teamMembers/schema";
import { supportTicketsTable } from "../supportTickets/schema";
import { leadsTable } from "../leads/schema";

export const supportChatSessionsTable = pgTable("support_chat_sessions", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  memberId: integer("member_id").references(() => teamMembersTable.id, { onDelete: 'cascade' }).notNull(),
  ticketId: integer("ticket_id").references(() => supportTicketsTable.id, { onDelete: 'set null' }),
  leadId: integer("lead_id").references(() => leadsTable.id, { onDelete: 'set null' }),
  title: varchar("title", { length: 255 }),
  summary: text("summary"),
  clientSessionKey: varchar("client_session_key", { length: 200 }),
  metadata: jsonb("metadata").default('{}'),
  publicToken: varchar("public_token", { length: 96 }),
  sessionExpiresAt: timestamp("session_expires_at"),
  automationMode: varchar("automation_mode", { length: 24 }).notNull().default('ai_active'),
  optedOutAt: timestamp("opted_out_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  memberIdx: index("idx_support_chat_sessions_member").on(table.memberId),
  ticketIdx: index("idx_support_chat_sessions_ticket").on(table.ticketId),
  leadIdx: index("idx_support_chat_sessions_lead").on(table.leadId),
  createdIdx: index("idx_support_chat_sessions_created").on(table.createdAt),
}));

export type SupportChatSession = typeof supportChatSessionsTable.$inferSelect;
export type InsertSupportChatSession = typeof supportChatSessionsTable.$inferInsert;
