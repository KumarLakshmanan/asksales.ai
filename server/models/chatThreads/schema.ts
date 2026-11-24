import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";
import { companySettings } from "../companySettings/schema";

export const chatThreadsTable = pgTable("chat_threads", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  businessId: integer("business_id").references(() => companySettings.id, { onDelete: 'set null' }), // Link to business/company
  title: varchar("title", { length: 255 }),
  selectedAgent: varchar("selected_agent", { length: 255 }), // Current selected agent for this thread
  metadata: jsonb("metadata").default('{}'), // Session data like selected brand toolkit
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),       // soft delete — null means active
  deletedBy: integer("deleted_by").references(() => usersTable.id, { onDelete: 'set null' }),
}, (table) => ({
  userIdIdx: index("chat_threads_user_id_idx").on(table.userId),
  businessIdIdx: index("chat_threads_business_id_idx").on(table.businessId),
  createdAtIdx: index("chat_threads_created_at_idx").on(table.createdAt),
  deletedAtIdx: index("chat_threads_deleted_at_idx").on(table.deletedAt),
}));

export type ChatThreadRecord = typeof chatThreadsTable.$inferSelect;
export type InsertChatThread = typeof chatThreadsTable.$inferInsert;
