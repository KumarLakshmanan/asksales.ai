import { businessProfileColumn } from "../businessProfileColumn.js";
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { chatThreadsTable } from '../chatThreads/schema';
import { leadInputsTable } from '../leadInputs/schema';

export type LeadProviderRunStatus =
  | 'pending'
  | 'syncing'
  | 'succeeded'
  | 'succeeded_empty'
  | 'partial_success'
  | 'failed'
  | 'cancelled';

/**
 * Durable provider receipt for one reviewed lead-input execution. The row is
 * created before the actor starts and receives the Apify run/dataset IDs as
 * soon as the provider acknowledges them, so a process restart can reconcile
 * the same provider run instead of creating another campaign or lead batch.
 */
export const leadGenerationProviderRunsTable = pgTable('lead_generation_provider_runs', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id').notNull().references(() => chatThreadsTable.id, { onDelete: 'cascade' }),
  leadInputId: integer('lead_input_id').references(() => leadInputsTable.id, { onDelete: 'set null' }),
  executionId: varchar('execution_id', { length: 255 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
  platform: varchar('platform', { length: 100 }).notNull(),
  workflowId: varchar('workflow_id', { length: 255 }).notNull(),
  nodeKey: varchar('node_key', { length: 255 }).notNull(),
  actorId: varchar('actor_id', { length: 255 }).notNull(),
  actorRunId: varchar('actor_run_id', { length: 255 }),
  datasetId: varchar('dataset_id', { length: 255 }),
  status: varchar('status', { length: 32 }).$type<LeadProviderRunStatus>().notNull().default('pending'),
  requestedLeadLimit: integer('requested_lead_limit'),
  fetchedCount: integer('fetched_count').notNull().default(0),
  acceptedCount: integer('accepted_count').notNull().default(0),
  persistedCount: integer('persisted_count').notNull().default(0),
  duplicateCount: integer('duplicate_count').notNull().default(0),
  rejectedCount: integer('rejected_count').notNull().default(0),
  retryCount: integer('retry_count').notNull().default(0),
  checkpoint: jsonb('checkpoint').$type<Record<string, unknown>>().notNull().default({}),
  providerResult: jsonb('provider_result').$type<Record<string, unknown>>(),
  error: text('error'),
  startedAt: timestamp('started_at'),
  heartbeatAt: timestamp('heartbeat_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  idempotencyKeyUq: uniqueIndex('lead_generation_provider_runs_idempotency_uq').on(table.idempotencyKey),
  executionIdx: index('lead_generation_provider_runs_execution_idx').on(table.executionId),
  threadIdx: index('lead_generation_provider_runs_thread_idx').on(table.threadId, table.createdAt),
  statusHeartbeatIdx: index('lead_generation_provider_runs_status_heartbeat_idx').on(table.status, table.heartbeatAt),
}));

export type LeadGenerationProviderRun = typeof leadGenerationProviderRunsTable.$inferSelect;
export type NewLeadGenerationProviderRun = typeof leadGenerationProviderRunsTable.$inferInsert;
