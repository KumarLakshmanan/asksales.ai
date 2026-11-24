import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Performance Metrics Schema
 * Daily/hourly metrics for ad campaign performance tracking
 */

import { pgTable, serial, integer, varchar, text, date, timestamp, decimal, jsonb, unique } from 'drizzle-orm/pg-core';

export const performanceMetricsTable = pgTable('performance_metrics', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  
  // Campaign reference
  campaignId: integer('campaign_id').notNull(),
  platform: varchar('platform', { length: 50 }).notNull(), // 'meta', 'google'
  platformCampaignId: varchar('platform_campaign_id', { length: 255 }).notNull(),
  userId: integer('user_id'),
  
  // Time dimension
  date: date('date').notNull(),
  hour: integer('hour'), // NULL for daily aggregation, 0-23 for hourly
  
  // Core metrics
  impressions: integer('impressions').notNull().default(0),
  clicks: integer('clicks').notNull().default(0),
  spend: decimal('spend', { precision: 12, scale: 2 }).notNull().default('0'),
  reach: integer('reach').default(0),
  
  // Conversion metrics
  conversions: decimal('conversions', { precision: 18, scale: 6, mode: 'number' }).default(0),
  conversionValue: decimal('conversion_value', { precision: 12, scale: 2 }).default('0'),
  
  // Engagement metrics
  videoViews: integer('video_views').default(0),
  videoViewsComplete: integer('video_views_complete').default(0),
  linkClicks: integer('link_clicks').default(0),
  postEngagements: integer('post_engagements').default(0),
  
  // Lead-specific metrics
  leads: integer('leads').default(0),
  leadValue: decimal('lead_value', { precision: 12, scale: 2 }).default('0'),
  
  // Calculated metrics
  ctr: decimal('ctr', { precision: 9, scale: 6 }).default('0'), // Click-through rate
  cpc: decimal('cpc', { precision: 10, scale: 2 }).default('0'), // Cost per click
  cpm: decimal('cpm', { precision: 10, scale: 2 }).default('0'), // Cost per mille
  cpa: decimal('cpa', { precision: 10, scale: 2 }).default('0'), // Cost per acquisition
  roas: decimal('roas', { precision: 10, scale: 2 }).default('0'), // Return on ad spend
  
  // Platform-specific data
  platformData: jsonb('platform_data'), // Additional platform-specific metrics
  sourceScope: varchar('source_scope', { length: 24 }).notNull().default('managed'),
  syncStatus: varchar('sync_status', { length: 24 }).notNull().default('succeeded'),
  syncError: text('sync_error'),
  providerStatus: varchar('provider_status', { length: 64 }),
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  // Ensure unique metrics per campaign/date/hour combination
  uniqueCampaignPlatformDateHour: unique().on(table.campaignId, table.platform, table.date, table.hour),
}));

export type PerformanceMetricRecord = typeof performanceMetricsTable.$inferSelect;
export type InsertPerformanceMetric = typeof performanceMetricsTable.$inferInsert;
