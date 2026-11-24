import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, uuid, varchar, jsonb, integer, timestamp } from "drizzle-orm/pg-core";
import { workflowSessionsTable } from "../workflowSessions/schema";
import { chatThreadsTable } from "../chatThreads/schema";
import { randomUUID } from "crypto";

export const agentExecutionsTable = pgTable("agent_executions", {
  businessProfileId: businessProfileColumn(),
  id: uuid("id").$defaultFn(() => randomUUID()).primaryKey(),
  workflowId: uuid("workflow_id").notNull().references(() => workflowSessionsTable.id, { onDelete: "cascade" }),
  agentType: varchar("agent_type", { length: 50 }),
  action: varchar("action", { length: 255 }),
  input: jsonb("input"),
  output: jsonb("output"),
  threadId: integer("thread_id").references(() => chatThreadsTable.id, { onDelete: "set null" }),
  status: varchar("status", { length: 20 }),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AgentExecution = typeof agentExecutionsTable.$inferSelect;
export type InsertAgentExecution = typeof agentExecutionsTable.$inferInsert;
