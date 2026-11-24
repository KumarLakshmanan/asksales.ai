import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, text, integer, timestamp, serial, varchar, jsonb, index } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";
import { chatThreadsTable } from "../chatThreads/schema";

export const chatMessagesTable = pgTable("chat_messages", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  threadId: integer("thread_id").references(() => chatThreadsTable.id),
  role: varchar("role", { length: 20 }).notNull(), // 'user' or 'assistant'
  content: text("content").notNull(),
  agentType: varchar("agent_type", { length: 100 }), // 'orchestrator', 'lead_generation', 'content_studio', etc.
  metadata: jsonb("metadata"), // Additional metadata like tokens used, model version, etc.
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),       // soft delete — null means active
  deletedBy: integer("deleted_by").references(() => usersTable.id, { onDelete: 'set null' }),
}, (table) => ({
  userIdIdx: index("chat_messages_user_id_idx").on(table.userId),
  threadIdIdx: index("chat_messages_thread_id_idx").on(table.threadId),
  createdAtIdx: index("chat_messages_created_at_idx").on(table.createdAt),
  // Phase 3.5: thread pagination (ORDER BY created_at) — compound index covers WHERE threadId = ? ORDER BY created_at
  threadCreatedAtIdx: index("chat_messages_thread_created_at_idx").on(table.threadId, table.createdAt),
  deletedAtIdx: index("chat_messages_deleted_at_idx").on(table.deletedAt),
}));

export type ChatMessageRecord = typeof chatMessagesTable.$inferSelect;
export type InsertChatMessage = typeof chatMessagesTable.$inferInsert;
