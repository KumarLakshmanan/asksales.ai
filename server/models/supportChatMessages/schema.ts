import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, bigint, varchar, text, timestamp, index, jsonb, real, uuid } from "drizzle-orm/pg-core";
import { supportChatSessionsTable } from "../supportChatSessions/schema";

export const supportChatMessagesTable = pgTable("support_chat_messages", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").references(() => supportChatSessionsTable.id, { onDelete: 'cascade' }).notNull(),
  role: varchar("role", { length: 20 }).notNull(),
  requestId: varchar("request_id", { length: 160 }),
  content: text("content").notNull(),
  privacyVaultId: bigint("privacy_vault_id", { mode: "number" }),
  sources: jsonb("sources").default('[]'),
  confidence: real("confidence"),
  metadata: jsonb("metadata").default('{}'),
  deferredCommit: jsonb("deferred_commit"),
  commitToken: uuid("commit_token"),
  processingStatus: varchar("processing_status", { length: 24 }).notNull().default('completed'),
  processingStartedAt: timestamp("processing_started_at"),
  processingExpiresAt: timestamp("processing_expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  sessionIdx: index("idx_support_chat_messages_session").on(table.sessionId),
  createdIdx: index("idx_support_chat_messages_created").on(table.createdAt),
  processingIdx: index("idx_support_chat_messages_processing").on(table.processingStatus, table.processingExpiresAt),
}));

export type SupportChatMessage = typeof supportChatMessagesTable.$inferSelect;
export type InsertSupportChatMessage = typeof supportChatMessagesTable.$inferInsert;
