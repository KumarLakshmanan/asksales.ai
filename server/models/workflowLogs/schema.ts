import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, varchar, text, timestamp, integer, json, boolean, pgEnum } from "drizzle-orm/pg-core";
import { usersTable } from "../users/schema";
import { chatThreadsTable } from "../chatThreads/schema";

// Enum for log types
export const workflowLogTypeEnum = pgEnum('workflow_log_type', [
  'workflow_start',
  'workflow_complete',
  'workflow_error',
  'actor_start',
  'actor_progress',
  'actor_complete',
  'actor_error',
  'lead_saved',
  'post_saved',
  'step',
  'warning',
  'info'
]);

// Enum for log status
export const workflowLogStatusEnum = pgEnum('workflow_log_status', [
  'pending',
  'running',
  'completed',
  'error',
  'paused',
  'cancelled'
]);

/**
 * Workflow Logs Table
 * Stores detailed logs for all workflow executions
 */
export const workflowLogs = pgTable("workflow_logs", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  threadId: integer("thread_id").references(() => chatThreadsTable.id, { onDelete: 'set null' }),
  executionId: varchar("execution_id", { length: 255 }).notNull(),
  
  // Log categorization
  logType: workflowLogTypeEnum("log_type").notNull().default('info'),
  status: workflowLogStatusEnum("status").default('running'),
  
  // Core log data
  platform: varchar("platform", { length: 100 }),
  actorId: varchar("actor_id", { length: 255 }),
  actorName: varchar("actor_name", { length: 255 }),
  nodeId: varchar("node_id", { length: 255 }),
  
  // Message and details
  message: text("message").notNull(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  details: json("details").$type<Record<string, any>>(),
  
  // Progress tracking
  leadsCount: integer("leads_count"),
  totalLeads: integer("total_leads"),
  progressPercent: integer("progress_percent"),
  
  // Error tracking
  errorMessage: text("error_message"),
  errorStack: text("error_stack"),
  
  // Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Workflow Activity Executions Table
 * Stores summary information for each lead generation workflow execution
 * (Separate from the visual workflow builder's workflow_executions table)
 */
export const workflowActivityExecutions = pgTable("workflow_activity_executions", {
  businessProfileId: businessProfileColumn(),
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  threadId: integer("thread_id").references(() => chatThreadsTable.id, { onDelete: 'set null' }),
  executionId: varchar("execution_id", { length: 255 }).notNull().unique(),
  
  // Execution metadata
  workflowName: varchar("workflow_name", { length: 255 }),
  platforms: json("platforms").$type<string[]>(),
  status: workflowLogStatusEnum("status").notNull().default('pending'),
  
  // Progress tracking
  totalLeadsExpected: integer("total_leads_expected"),
  totalLeadsGenerated: integer("total_leads_generated").default(0),
  platformsCompleted: integer("platforms_completed").default(0),
  platformsTotal: integer("platforms_total"),
  
  // Input parameters
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputParams: json("input_params").$type<Record<string, any>>(),
  
  // Result summary
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: json("result").$type<Record<string, any>>(),
  errorMessage: text("error_message"),
  
  // Pause/Resume tracking
  isPaused: boolean("is_paused").default(false),
  pausedAt: timestamp("paused_at"),
  resumedAt: timestamp("resumed_at"),
  
  // Timestamps
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

export type WorkflowLog = typeof workflowLogs.$inferSelect;
export type NewWorkflowLog = typeof workflowLogs.$inferInsert;
export type WorkflowActivityExecution = typeof workflowActivityExecutions.$inferSelect;
export type NewWorkflowActivityExecution = typeof workflowActivityExecutions.$inferInsert;
