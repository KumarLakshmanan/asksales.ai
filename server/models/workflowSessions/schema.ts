import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, uuid, varchar, text, integer, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";
import { chatThreadsTable } from "../chatThreads/schema";
import { randomUUID } from "crypto";

export const workflowSessionsTable = pgTable("workflow_sessions", {
  businessProfileId: businessProfileColumn(),
  id: uuid("id").$defaultFn(() => randomUUID()).primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  userPrompt: text("user_prompt").notNull(),
  stage: varchar("stage", { length: 50 }).default("initial"),
  progress: integer("progress").default(0),
  currentTask: varchar("current_task", { length: 255 }),
  threadId: integer("thread_id").references(() => chatThreadsTable.id, { onDelete: "cascade" }),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type WorkflowSession = typeof workflowSessionsTable.$inferSelect;
export type InsertWorkflowSession = typeof workflowSessionsTable.$inferInsert;
