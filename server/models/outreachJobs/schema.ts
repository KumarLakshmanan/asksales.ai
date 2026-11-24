import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Outreach Jobs Schema
 * Background job queue for scheduled outreach messages
 */

import { pgTable, serial, integer, varchar, text, timestamp, jsonb, boolean, index } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { leadsTable } from '../leads/schema';
import { outreachCampaignsTable } from '../outreachCampaigns/schema';

export const outreachJobsTable = pgTable('outreach_jobs', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => usersTable.id, { onDelete: 'cascade' }).notNull(),
  leadId: integer('lead_id').references(() => leadsTable.id, { onDelete: 'cascade' }).notNull(),
  campaignId: integer('campaign_id').references(() => outreachCampaignsTable.id, { onDelete: 'cascade' }),
  sequenceStepId: integer('sequence_step_id'),

  // Message details
  channel: varchar('channel', { length: 20 }).notNull(), // 'email' or 'sms'
  recipientEmail: varchar('recipient_email', { length: 255 }),
  recipientPhone: varchar('recipient_phone', { length: 50 }),
  subject: varchar('subject', { length: 500 }),
  messageBody: text('message_body').notNull(),

  // Scheduling
  scheduledFor: timestamp('scheduled_for').notNull(),

  // Job status
  status: varchar('status', { length: 20 }).notNull().default('pending'), // pending, processing, sent, failed, cancelled
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  lastAttemptAt: timestamp('last_attempt_at'),
  // Phase 5.15 / MODEL-010: dead-letter marker. Set true when the job has
  // exhausted all retry attempts. The UI filters on this to show a separate
  // "needs manual review" view.
  isDeadLetter: boolean('is_dead_letter').notNull().default(false),

  // Response tracking
  sentAt: timestamp('sent_at'),
  externalMessageId: varchar('external_message_id', { length: 255 }), // SendGrid/Twilio ID
  error: text('error'),
  metadata: jsonb('metadata'), // Additional platform-specific data

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  // Phase 3.5: worker polling query — find pending jobs due for execution
  statusScheduledForIdx: index('outreach_jobs_status_scheduled_for_idx').on(table.status, table.scheduledFor),
  campaignIdIdx: index('outreach_jobs_campaign_id_idx').on(table.campaignId),
  leadIdIdx: index('outreach_jobs_lead_id_idx').on(table.leadId),
  isDeadLetterIdx: index('outreach_jobs_is_dead_letter_idx').on(table.isDeadLetter),
}));

export type OutreachJobRecord = typeof outreachJobsTable.$inferSelect;
export type InsertOutreachJob = typeof outreachJobsTable.$inferInsert;
