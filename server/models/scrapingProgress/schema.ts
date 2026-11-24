import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, uuid, varchar, integer, timestamp } from "drizzle-orm/pg-core";
import { workflowSessionsTable } from "../workflowSessions/schema";
import { randomUUID } from "crypto";

export const scrapingProgressTable = pgTable("scraping_progress", {
  businessProfileId: businessProfileColumn(),
  id: uuid("id").$defaultFn(() => randomUUID()).primaryKey(),
  workflowId: uuid("workflow_id").notNull().references(() => workflowSessionsTable.id, { onDelete: "cascade" }),
  channelName: varchar("channel_name", { length: 50 }),
  status: varchar("status", { length: 20 }).default("pending"),
  progress: integer("progress").default(0),
  leadsFound: integer("leads_found").default(0),
  estimatedLeads: integer("estimated_leads"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type ScrapingProgress = typeof scrapingProgressTable.$inferSelect;
export type InsertScrapingProgress = typeof scrapingProgressTable.$inferInsert;
