import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, uuid, varchar, jsonb, timestamp } from "drizzle-orm/pg-core";
import { workflowSessionsTable } from "../workflowSessions/schema";
import { randomUUID } from "crypto";

export const approvalCheckpointsTable = pgTable("approval_checkpoints", {
  businessProfileId: businessProfileColumn(),
  id: uuid("id").$defaultFn(() => randomUUID()).primaryKey(),
  workflowId: uuid("workflow_id").notNull().references(() => workflowSessionsTable.id, { onDelete: "cascade" }),
  approvalType: varchar("approval_type", { length: 50 }),
  status: varchar("status", { length: 20 }).default("pending"),
  details: jsonb("details"),
  userDecision: varchar("user_decision", { length: 20 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  decidedAt: timestamp("decided_at"),
});

export type ApprovalCheckpoint = typeof approvalCheckpointsTable.$inferSelect;
export type InsertApprovalCheckpoint = typeof approvalCheckpointsTable.$inferInsert;
