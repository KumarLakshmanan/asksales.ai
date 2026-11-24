import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Sequence Executions Schema
 * Tracks lead enrollment in sequences and execution progress
 */

import { pgTable, serial, integer, varchar, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const sequenceExecutionsTable = pgTable('sequence_executions', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  sequenceId: integer('sequence_id').notNull(), // FK to message_sequences
  leadId: integer('lead_id').notNull(), // FK to leads
  userId: integer('user_id').notNull(),
  
  // Execution state
  currentStep: integer('current_step').notNull().default(0), // 0 = not started, 1-N = step number
  status: varchar('status', { length: 20 }).notNull().default('active'), // 'active', 'paused', 'completed', 'failed', 'cancelled'
  
  // Timing
  startedAt: timestamp('started_at').notNull().defaultNow(),
  nextScheduledAt: timestamp('next_scheduled_at'), // When next message should be sent
  completedAt: timestamp('completed_at'),
  pausedAt: timestamp('paused_at'),
  
  // Statistics
  totalMessagesSent: integer('total_messages_sent').notNull().default(0),
  repliesReceived: integer('replies_received').notNull().default(0),
  linksClicked: integer('links_clicked').notNull().default(0),
  
  // Metadata
  metadata: jsonb('metadata').$type<{
    pauseReason?: string;
    lastError?: string;
    sentMessageIds?: number[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    customData?: Record<string, any>;
  }>(),
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type SequenceExecutionRecord = typeof sequenceExecutionsTable.$inferSelect;
export type InsertSequenceExecution = typeof sequenceExecutionsTable.$inferInsert;
