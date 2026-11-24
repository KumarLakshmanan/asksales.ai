import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";
import { chatThreadsTable } from "../chatThreads/schema";
import { chatMessagesTable } from "../chatMessages/schema";

export const leadInputsTable = pgTable("lead_inputs", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  messageId: integer("message_id").references(() => chatMessagesTable.id, { onDelete: 'cascade' }),
  threadId: integer("thread_id").references(() => chatThreadsTable.id, { onDelete: 'cascade' }).notNull(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  platform: varchar("platform", { length: 50 }).notNull(),
  inputs: jsonb("inputs").notNull(),
  schema: jsonb("schema"),
  actorId: varchar("actor_id", { length: 255 }),
  actorName: varchar("actor_name", { length: 255 }),
  workflowId: varchar("workflow_id", { length: 255 }),
  category: varchar("category", { length: 255 }),
  recommendedSubWorkflows: jsonb("recommended_sub_workflows"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  threadIdIdx: index("idx_lead_inputs_thread_id").on(table.threadId),
  messageIdIdx: index("idx_lead_inputs_message_id").on(table.messageId),
  createdAtIdx: index("idx_lead_inputs_created_at").on(table.createdAt),
}));

export type LeadInputRecord = typeof leadInputsTable.$inferSelect;
export type InsertLeadInput = typeof leadInputsTable.$inferInsert;
