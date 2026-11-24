import { businessProfileColumn } from "../businessProfileColumn.js";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { usersTable } from '../users/schema';
import { chatThreadsTable } from '../chatThreads/schema';

export const conversationWorkflowRunsTable = pgTable('conversation_workflow_runs', {
  businessProfileId: businessProfileColumn(),
  id: varchar('id', { length: 100 }).primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id').notNull().references(() => chatThreadsTable.id, { onDelete: 'cascade' }),
  workflowType: varchar('workflow_type', { length: 50 }).notNull().default('campaign'),
  stage: varchar('stage', { length: 64 }).notNull().default('icp_draft'),
  status: varchar('status', { length: 32 }).notNull().default('running'),
  originalRequest: text('original_request'),
  context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => ({
  threadIdx: index('conversation_workflow_runs_thread_idx').on(table.userId, table.threadId, table.updatedAt),
}));

export const conversationWorkflowActionsTable = pgTable('conversation_workflow_actions', {
  businessProfileId: businessProfileColumn(),
  id: varchar('id', { length: 160 }).primaryKey(),
  runId: varchar('run_id', { length: 100 }).notNull().references(() => conversationWorkflowRunsTable.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id').notNull().references(() => chatThreadsTable.id, { onDelete: 'cascade' }),
  actionType: varchar('action_type', { length: 100 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('awaiting_input'),
  idempotencyKey: varchar('idempotency_key', { length: 200 }),
  resourceType: varchar('resource_type', { length: 80 }),
  resourceId: varchar('resource_id', { length: 160 }),
  resourceRevision: integer('resource_revision'),
  input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
  output: jsonb('output').$type<Record<string, unknown>>(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => ({
  runIdx: index('conversation_workflow_actions_run_idx').on(table.runId, table.createdAt),
  threadIdx: index('conversation_workflow_actions_thread_idx').on(table.userId, table.threadId, table.updatedAt),
  idempotencyUq: uniqueIndex('conversation_workflow_actions_idempotency_uq')
    .on(table.runId, table.idempotencyKey)
    .where(sql`${table.idempotencyKey} IS NOT NULL`),
}));

export const leadStrategySelectionsTable = pgTable('lead_strategy_selections', {
  businessProfileId: businessProfileColumn(),
  id: uuid('id').$defaultFn(() => randomUUID()).primaryKey(),
  runId: varchar('run_id', { length: 100 }).notNull().references(() => conversationWorkflowRunsTable.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id').notNull().references(() => chatThreadsTable.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull().default(1),
  status: varchar('status', { length: 24 }).notNull().default('draft'),
  platforms: jsonb('platforms').$type<string[]>().notNull().default([]),
  workflowIds: jsonb('workflow_ids').$type<string[]>().notNull().default([]),
  selection: jsonb('selection').$type<Record<string, unknown>>().notNull().default({}),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runIdx: index('lead_strategy_selections_run_idx').on(table.runId, table.revision),
  revisionUq: uniqueIndex('lead_strategy_selections_run_revision_uq').on(table.runId, table.revision),
}));

export const leadInputSetsTable = pgTable('lead_input_sets', {
  businessProfileId: businessProfileColumn(),
  id: uuid('id').$defaultFn(() => randomUUID()).primaryKey(),
  runId: varchar('run_id', { length: 100 }).notNull().references(() => conversationWorkflowRunsTable.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id').notNull().references(() => chatThreadsTable.id, { onDelete: 'cascade' }),
  strategySelectionId: uuid('strategy_selection_id').references(() => leadStrategySelectionsTable.id, { onDelete: 'set null' }),
  revision: integer('revision').notNull().default(1),
  status: varchar('status', { length: 24 }).notNull().default('draft'),
  inputIds: jsonb('input_ids').$type<number[]>().notNull().default([]),
  platforms: jsonb('platforms').$type<string[]>().notNull().default([]),
  workflowIds: jsonb('workflow_ids').$type<string[]>().notNull().default([]),
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull().default({}),
  approvedBy: integer('approved_by').references(() => usersTable.id, { onDelete: 'set null' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runIdx: index('lead_input_sets_run_idx').on(table.runId, table.revision),
  revisionUq: uniqueIndex('lead_input_sets_run_revision_uq').on(table.runId, table.revision),
}));

export const leadSelectionSnapshotsTable = pgTable('lead_selection_snapshots', {
  businessProfileId: businessProfileColumn(),
  id: uuid('id').$defaultFn(() => randomUUID()).primaryKey(),
  runId: varchar('run_id', { length: 100 }).notNull().references(() => conversationWorkflowRunsTable.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id').notNull().references(() => chatThreadsTable.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull().default(1),
  status: varchar('status', { length: 24 }).notNull().default('draft'),
  leadIds: jsonb('lead_ids').$type<number[]>().notNull(),
  approvedBy: integer('approved_by').references(() => usersTable.id, { onDelete: 'set null' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  runIdx: index('lead_selection_snapshots_run_idx').on(table.runId, table.revision),
  revisionUq: uniqueIndex('lead_selection_snapshots_run_revision_uq').on(table.runId, table.revision),
}));

export type ConversationWorkflowRunRecord = typeof conversationWorkflowRunsTable.$inferSelect;
export type ConversationWorkflowActionRecord = typeof conversationWorkflowActionsTable.$inferSelect;
export type LeadStrategySelectionRecord = typeof leadStrategySelectionsTable.$inferSelect;
export type LeadInputSetRecord = typeof leadInputSetsTable.$inferSelect;
export type LeadSelectionSnapshotRecord = typeof leadSelectionSnapshotsTable.$inferSelect;
