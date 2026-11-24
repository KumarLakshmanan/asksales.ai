import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";
import { chatThreadsTable } from "../chatThreads/schema";

export const chatSummariesTable = pgTable("chat_summaries", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  threadId: integer("thread_id").references(() => chatThreadsTable.id, { onDelete: 'cascade' }).notNull(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  summaryText: text("summary_text").notNull(),
  keyEntities: jsonb("key_entities").$type<string[]>().default([]),
  timeline: jsonb("timeline").$type<string[]>().default([]),
  fromMessageId: integer("from_message_id"),
  toMessageId: integer("to_message_id"),
  messageCount: integer("message_count").default(0),
  tokenCounts: jsonb("token_counts").$type<{
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  }>().default({}),
  version: integer("version").default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  threadIdIdx: index("chat_summaries_thread_id_idx").on(table.threadId),
  userIdIdx: index("chat_summaries_user_id_idx").on(table.userId),
}));

export type ChatSummaryRecord = typeof chatSummariesTable.$inferSelect;
export type InsertChatSummary = typeof chatSummariesTable.$inferInsert;
