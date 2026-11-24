import { businessProfileColumn } from "../businessProfileColumn.js";
import {
  bigserial,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  index,
} from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { chatThreadsTable } from '../chatThreads/schema';

export const conversationToolApprovalsTable = pgTable('conversation_tool_approvals', {
  businessProfileId: businessProfileColumn(),
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id').notNull().references(() => chatThreadsTable.id, { onDelete: 'cascade' }),
  requestId: varchar('request_id', { length: 255 }).notNull(),
  toolName: varchar('tool_name', { length: 255 }).notNull(),
  toolArgs: jsonb('tool_args').$type<Record<string, unknown>>().notNull().default({}),
  runId: varchar('run_id', { length: 100 }),
  actionId: varchar('action_id', { length: 160 }),
  resourceType: varchar('resource_type', { length: 80 }),
  resourceId: varchar('resource_id', { length: 160 }),
  resourceRevision: integer('resource_revision'),
  overrides: jsonb('overrides').$type<Record<string, unknown>>(),
  decision: varchar('decision', { length: 16 }).notNull(),
  status: varchar('status', { length: 24 }).notNull(),
  executionResult: jsonb('execution_result'),
  executionError: text('execution_error'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  leaseToken: varchar('lease_token', { length: 100 }),
  leaseExpiresAt: timestamp('lease_expires_at'),
  attemptCount: integer('attempt_count').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  requestUnique: uniqueIndex('conversation_tool_approvals_request_uq').on(table.businessProfileId,
    table.userId,
    table.threadId,
    table.requestId,
    table.toolName,
  ),
  threadIdx: index('conversation_tool_approvals_thread_idx').on(
    table.userId,
    table.threadId,
    table.createdAt,
  ),
  leaseIdx: index('conversation_tool_approvals_lease_idx').on(
    table.status,
    table.leaseExpiresAt,
  ),
  runActionIdx: index('conversation_tool_approvals_run_action_idx').on(
    table.userId,
    table.threadId,
    table.runId,
    table.actionId,
  ),
}));

export type ConversationToolApproval = typeof conversationToolApprovalsTable.$inferSelect;
