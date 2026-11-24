import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Widget States Schema
 * Tracks interactive widget states for chat-conversation UI components.
 * Persists form values across page reloads and supports draft/save/submit lifecycle.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { pgTable, serial, integer, varchar, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { usersTable } from '../users/schema';
import { chatThreadsTable } from '../chatThreads/schema';
import { chatMessagesTable } from '../chatMessages/schema';

export const widgetStatesTable = pgTable('widget_states', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id').notNull().references(() => chatThreadsTable.id),
  messageId: integer('message_id').references(() => chatMessagesTable.id),

  // Widget identity
  toolName: varchar('tool_name', { length: 255 }).notNull(),
  widgetType: varchar('widget_type', { length: 100 }).notNull(),
  runId: varchar('run_id', { length: 100 }),
  actionId: varchar('action_id', { length: 160 }),
  idempotencyKey: varchar('idempotency_key', { length: 200 }),

  // Form state — AI pre-fills from tool call arguments, user can edit
  formValues: jsonb('form_values').$type<Record<string, unknown>>().default({}),

  // Lifecycle status
  // active = drawer is open, user can interact
  // draft = user closed without submitting, values saved
  // submitted = user submitted, tool executed
  // cancelled = user explicitly cancelled
  status: varchar('status', { length: 50 }).notNull().default('active'),

  // Submission details
  submittedAt: timestamp('submitted_at'),
  submittedValues: jsonb('submitted_values').$type<Record<string, unknown>>(),
  executionResult: jsonb('execution_result'),
  executionError: text('execution_error'),
  executionStartedAt: timestamp('execution_started_at'),
  executionCompletedAt: timestamp('execution_completed_at'),
  executionLeaseToken: varchar('execution_lease_token', { length: 100 }),
  executionLeaseExpiresAt: timestamp('execution_lease_expires_at'),
  executionAttemptCount: integer('execution_attempt_count').notNull().default(0),

  // Which agent created this widget
  agentType: varchar('agent_type', { length: 100 }),

  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  threadIdx: index('widget_states_thread_idx').on(table.threadId),
  userIdx: index('widget_states_user_idx').on(table.userId),
  statusIdx: index('widget_states_status_idx').on(table.status),
  messageIdx: index('widget_states_message_idx').on(table.messageId),
  executionLeaseIdx: index('widget_states_execution_lease_idx').on(
    table.status,
    table.executionLeaseExpiresAt,
  ),
  runActionIdx: index('widget_states_run_action_idx').on(table.userId, table.threadId, table.runId, table.actionId),
  idempotencyUq: uniqueIndex('widget_states_user_idempotency_uq')
    .on(table.businessProfileId, table.userId, table.idempotencyKey)
    .where(sql`${table.idempotencyKey} IS NOT NULL`),
}));

export type WidgetState = typeof widgetStatesTable.$inferSelect;
export type InsertWidgetState = typeof widgetStatesTable.$inferInsert;
