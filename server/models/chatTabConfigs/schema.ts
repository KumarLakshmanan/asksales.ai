import { businessProfileColumn } from "../businessProfileColumn.js";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { pgTable, serial, integer, varchar, timestamp, index, unique, jsonb } from "drizzle-orm/pg-core";
import { chatThreadsTable } from "../chatThreads/schema";

export const chatTabConfigsTable = pgTable("chat_tab_configs", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  threadId: integer("thread_id").references(() => chatThreadsTable.id, { onDelete: "cascade" }).notNull(),
  tabId: varchar("tab_id", { length: 100 }).notNull(),
  tabType: varchar("tab_type", { length: 50 }).notNull(),
  tabLabel: varchar("tab_label", { length: 255 }).notNull(),
  tabOrder: integer("tab_order").notNull().default(0),
  isActive: integer("is_active").notNull().default(0), // 0 = false, 1 = true (for SQLite/PostgreSQL compatibility)
  tabData: jsonb("tab_data").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  threadIdIdx: index("chat_tab_configs_thread_id_idx").on(table.threadId),
  threadTabIdUnique: unique("chat_tab_configs_thread_tab_id_unique").on(table.threadId, table.tabId),
}));

export type ChatTabConfigRecord = typeof chatTabConfigsTable.$inferSelect;
export type InsertChatTabConfig = typeof chatTabConfigsTable.$inferInsert;
