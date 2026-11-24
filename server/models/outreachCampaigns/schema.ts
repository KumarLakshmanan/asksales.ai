import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Outreach Campaigns Schema
 * Campaign definitions for multi-step outreach sequences
 */

import { pgTable, serial, integer, varchar, text, timestamp, boolean, jsonb, index } from 'drizzle-orm/pg-core';

export const outreachCampaignsTable = pgTable('outreach_campaigns', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),

  // Campaign details
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  campaignType: varchar('campaign_type', { length: 50 }).notNull(), // 'email', 'sms', 'mixed'

  // Targeting
  targetAudience: jsonb('target_audience'), // ICP criteria
  leadListIds: jsonb('lead_list_ids'), // Array of lead IDs

  // Sequence settings
  sequenceSteps: jsonb('sequence_steps').notNull(), // Array of step definitions

  // Scheduling
  startDate: timestamp('start_date'),
  endDate: timestamp('end_date'),
  timezone: varchar('timezone', { length: 100 }).default('Asia/Kolkata'),

  // Status
  status: varchar('status', { length: 50 }).notNull().default('draft'), // draft, active, paused, completed, cancelled
  isActive: boolean('is_active').notNull().default(false),

  // Tracking
  totalLeads: integer('total_leads').default(0),
  messagesSent: integer('messages_sent').default(0),
  messagesDelivered: integer('messages_delivered').default(0),
  messagesFailed: integer('messages_failed').default(0),
  opens: integer('opens').default(0),
  clicks: integer('clicks').default(0),
  replies: integer('replies').default(0),
  conversions: integer('conversions').default(0),

  // Settings
  settings: jsonb('settings'), // Additional configuration
  // Brand Toolkit the campaign was created with (FK in migration 589). Every
  // step renders with it; changing the default brand does not affect it.
  brandToolkitId: integer('brand_toolkit_id'),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  launchedAt: timestamp('launched_at'),
  completedAt: timestamp('completed_at'),
}, (table) => ({
  // Phase 3.5: tenant + status filtering
  userIdIdx: index('outreach_campaigns_user_id_idx').on(table.userId),
  statusIdx: index('outreach_campaigns_status_idx').on(table.status),
  userStatusIdx: index('outreach_campaigns_user_status_idx').on(table.userId, table.status),
}));

export type OutreachCampaignRecord = typeof outreachCampaignsTable.$inferSelect;
export type InsertOutreachCampaign = typeof outreachCampaignsTable.$inferInsert;
