import { businessProfileColumn } from "../businessProfileColumn.js";
import { pgTable, serial, integer, varchar, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { enrichmentRunsTable } from '../enrichmentRuns/schema.js';

export const enrichmentStepsTable = pgTable('enrichment_steps', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  runId: integer('run_id').notNull().references(() => enrichmentRunsTable.id, { onDelete: 'cascade' }),
  stepNumber: integer('step_number').notNull().default(0),
  stepType: varchar('step_type', { length: 50 }).notNull(),
  platform: varchar('platform', { length: 50 }),
  actorId: varchar('actor_id', { length: 255 }),
  subType: varchar('sub_type', { length: 50 }),
  identifier: text('identifier'),
  status: varchar('status', { length: 20 }).notNull().default('running'),
  input: jsonb('input'),
  output: jsonb('output'),
  itemsCount: integer('items_count').default(0),
  durationMs: integer('duration_ms'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
