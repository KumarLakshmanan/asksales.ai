import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, decimal, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";
import { chatThreadsTable } from "../chatThreads/schema";
import { chatMessagesTable } from "../chatMessages/schema";

export const scrapingDetailsTable = pgTable("scraping_details", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  messageId: integer("message_id").references(() => chatMessagesTable.id, { onDelete: 'cascade' }).notNull(),
  threadId: integer("thread_id").references(() => chatThreadsTable.id, { onDelete: 'cascade' }).notNull(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  executionId: varchar("execution_id", { length: 255 }),
  platform: varchar("platform", { length: 50 }).notNull(),
  totalLeadsNeeded: integer("total_leads_needed").default(0),
  estimatedLeads: integer("estimated_leads").default(0),
  totalLeadsFound: integer("total_leads_found").default(0),
  progress: decimal("progress", { precision: 5, scale: 2 }).default("0.00"),
  status: varchar("status", { length: 50 }).default("pending"),
  error: text("error"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  threadIdIdx: index("idx_scraping_details_thread_id").on(table.threadId),
  messageIdIdx: index("idx_scraping_details_message_id").on(table.messageId),
  executionIdIdx: index("idx_scraping_details_execution_id").on(table.executionId),
  statusIdx: index("idx_scraping_details_status").on(table.status),
  updatedAtIdx: index("idx_scraping_details_updated_at").on(table.updatedAt),
}));

export type ScrapingDetailRecord = typeof scrapingDetailsTable.$inferSelect;
export type InsertScrapingDetail = typeof scrapingDetailsTable.$inferInsert;
