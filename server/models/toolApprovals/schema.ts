import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Tool Approvals Schema
 * Tracks human-in-the-loop approval requests for AI agent tool executions
 */

import { pgTable, serial, integer, bigint, varchar, text, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import type { AssistantProvenance } from '../../../shared/outreachAssistants.js';

export const toolApprovalsTable = pgTable('tool_approvals', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id'),
  workflowId: varchar('workflow_id', { length: 255 }),
  
  // Tool details
  toolName: varchar('tool_name', { length: 255 }).notNull(),
  toolArgs: jsonb('tool_args'), // Arguments passed to the tool
  argumentDigest: varchar('argument_digest', { length: 96 }),
  agentType: varchar('agent_type', { length: 100 }), // Which agent requested the tool
  
  // Approval status
  status: varchar('status', { length: 50 }).notNull().default('pending'), // 'pending', 'approved', 'rejected', 'expired'
  
  // User decision
  userDecision: varchar('user_decision', { length: 50 }), // 'approve', 'reject'
  userComment: text('user_comment'), // Optional user comment on decision
  decidedAt: timestamp('decided_at'),
  
  // Result
  executionResult: jsonb('execution_result'), // Result after tool execution
  consumedAt: timestamp('consumed_at'),
  consumedExecutionId: bigint('consumed_execution_id', { mode: 'number' }),
  resumePayload: jsonb('resume_payload'),
  assistantProvenance: jsonb('assistant_provenance').$type<AssistantProvenance>(),
  resumeStatus: varchar('resume_status', { length: 32 }).notNull().default('not_required'),
  resumeAttemptCount: integer('resume_attempt_count').notNull().default(0),
  resumeAvailableAt: timestamp('resume_available_at'),
  resumedAt: timestamp('resumed_at'),
  resumeError: text('resume_error'),
  
  // Expiry
  expiresAt: timestamp('expires_at'),
  isExpired: boolean('is_expired').default(false),
  
  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type ToolApproval = typeof toolApprovalsTable.$inferSelect;
export type InsertToolApproval = typeof toolApprovalsTable.$inferInsert;
