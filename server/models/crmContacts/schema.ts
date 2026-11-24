import { businessProfileColumn } from "../businessProfileColumn.js";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { pgTable, serial, integer, varchar, text, timestamp, real, boolean, jsonb, index, decimal } from 'drizzle-orm/pg-core';
import { usersTable } from '../users/schema';
import { leadsTable } from '../leads/schema';

export const crmContactsTable = pgTable('crm_contacts', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
  leadId: integer('lead_id').references(() => leadsTable.id, { onDelete: 'set null' }),
  // Denormalized from lead
  firstName: varchar('first_name', { length: 255 }),
  lastName: varchar('last_name', { length: 255 }),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 100 }),
  company: varchar('company', { length: 255 }),
  role: varchar('role', { length: 255 }),
  linkedinUrl: varchar('linkedin_url', { length: 500 }),
  website: varchar('website', { length: 500 }),
  avatarUrl: varchar('avatar_url', { length: 500 }),
  // Business category (from business profile)
  businessCategoryId: integer('business_category_id'),
  businessCategoryName: varchar('business_category_name', { length: 255 }),
  // CRM fields
  status: varchar('status', { length: 50 }).notNull().default('contacted'),
  priority: varchar('priority', { length: 20 }).default('medium'),
  // Sentiment
  sentimentScore: real('sentiment_score'),
  lastSentimentAnalysisAt: timestamp('last_sentiment_analysis_at'),
  // ICP & Fit
  fitScore: real('fit_score'),
  icpTier: varchar('icp_tier', { length: 50 }),
  // Assignment
  assignedTo: integer('assigned_to').references(() => usersTable.id, { onDelete: 'set null' }),
  tags: jsonb('tags').$type<string[]>().default([]),
  // Activity counters
  totalOutreachSent: integer('total_outreach_sent').default(0),
  totalReplies: integer('total_replies').default(0),
  totalMeetings: integer('total_meetings').default(0),
  // Key dates
  firstContactedAt: timestamp('first_contacted_at'),
  lastContactedAt: timestamp('last_contacted_at'),
  lastActivityAt: timestamp('last_activity_at'),
  nextFollowUpAt: timestamp('next_follow_up_at'),
  // Deal
  dealValue: decimal('deal_value', { precision: 12, scale: 2 }),
  currency: varchar('currency', { length: 10 }).default('USD'),
  // CRM Pipeline
  pipelineStatus: varchar('pipeline_status', { length: 50 }).default('new'),
  lastSentimentStatus: varchar('last_sentiment_status', { length: 50 }),
  // Source
  source: varchar('source', { length: 100 }),
  sourceCampaignId: integer('source_campaign_id'),
  // Notes
  notes: text('notes'),
  // Soft delete
  deletedAt: timestamp('deleted_at'),
  // Retired duplicates resolve to their surviving contact.
  mergedIntoContactId: integer('merged_into_contact_id'),
  // Timestamps
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_crm_contacts_user_id').on(table.userId),
  statusIdx: index('idx_crm_contacts_status').on(table.status),
  leadIdIdx: index('idx_crm_contacts_lead_id').on(table.leadId),
  assignedToIdx: index('idx_crm_contacts_assigned_to').on(table.assignedTo),
  fitScoreIdx: index('idx_crm_contacts_fit_score').on(table.fitScore),
  lastActivityIdx: index('idx_crm_contacts_last_activity').on(table.lastActivityAt),
  emailIdx: index('idx_crm_contacts_email').on(table.email),
  deletedAtIdx: index('idx_crm_contacts_deleted_at').on(table.deletedAt),
  pipelineStatusIdx: index('idx_crm_contacts_pipeline_status').on(table.pipelineStatus),
}));
