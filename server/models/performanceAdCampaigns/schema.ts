import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Performance Ad Campaigns Schema
 * Ad campaign definitions for Meta/Google performance marketing
 */

import { pgTable, serial, integer, varchar, text, timestamp, boolean, jsonb, decimal } from 'drizzle-orm/pg-core';

export const performanceAdCampaignsTable = pgTable('performance_ad_campaigns', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  
  // Campaign details
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  objective: varchar('objective', { length: 100 }).notNull(), // leads, traffic, conversions, etc.
  objectiveSource: varchar('objective_source', { length: 32 }),
  objectiveRationale: text('objective_rationale'),
  
  // Platform
  adPlatform: varchar('ad_platform', { length: 50 }).notNull(), // 'meta', 'google'
  platformCampaignId: varchar('platform_campaign_id', { length: 255 }), // External campaign ID
  adAccountId: varchar('ad_account_id', { length: 255 }),
  
  // Budget
  budgetType: varchar('budget_type', { length: 50 }).notNull(), // 'daily', 'lifetime'
  budgetAmount: decimal('budget_amount', { precision: 12, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 10 }).default('USD'),
  spentAmount: decimal('spent_amount', { precision: 12, scale: 2 }).default('0'),
  
  // Targeting
  targeting: jsonb('targeting').notNull(), // Audience, geo, demographics
  locations: jsonb('locations').notNull().default([]),
  landingPageUrl: text('landing_page_url'),
  
  // Creative
  adCreatives: jsonb('ad_creatives'), // Ad copy, images, videos
  
  // Schedule
  startDate: timestamp('start_date').notNull(),
  endDate: timestamp('end_date'),
  
  // Status
  status: varchar('status', { length: 50 }).notNull().default('draft'), // draft, active, paused, completed
  localStatus: varchar('local_status', { length: 32 }).notNull().default('draft'),
  providerStatus: varchar('provider_status', { length: 64 }),
  validationErrors: jsonb('validation_errors').notNull().default([]),
  lastProviderError: text('last_provider_error'),
  isActive: boolean('is_active').notNull().default(false),
  
  // Performance metrics (cached)
  impressions: integer('impressions').default(0),
  clicks: integer('clicks').default(0),
  conversions: decimal('conversions', { precision: 18, scale: 6, mode: 'number' }).default(0),
  reach: integer('reach').default(0),
  ctr: decimal('ctr', { precision: 5, scale: 2 }).default('0'), // Click-through rate
  cpc: decimal('cpc', { precision: 10, scale: 2 }).default('0'), // Cost per click
  cpa: decimal('cpa', { precision: 10, scale: 2 }).default('0'), // Cost per acquisition
  roas: decimal('roas', { precision: 10, scale: 2 }).default('0'), // Return on ad spend
  
  // Optimization
  bidStrategy: varchar('bid_strategy', { length: 100 }),
  optimizationGoal: varchar('optimization_goal', { length: 100 }),
  
  // Settings
  settings: jsonb('settings'), // Additional platform-specific settings
  contentContext: jsonb('content_context').notNull().default({}),
  idempotencyKey: varchar('idempotency_key', { length: 160 }),
  autoActivate: boolean('auto_activate').notNull().default(true),
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  launchedAt: timestamp('launched_at'),
  lastSyncedAt: timestamp('last_synced_at'), // Last metrics sync
  version: integer('version').notNull().default(1),
});

export type PerformanceAdCampaignRecord = typeof performanceAdCampaignsTable.$inferSelect;
export type InsertPerformanceAdCampaign = typeof performanceAdCampaignsTable.$inferInsert;
