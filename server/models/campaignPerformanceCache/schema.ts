import { businessProfileColumn } from "../businessProfileColumn.js";
/**
 * Campaign Performance Cache Schema
 * Caches Meta campaign and adset performance data
 */

 
import { pgTable, serial, integer, varchar, timestamp, jsonb, decimal } from 'drizzle-orm/pg-core';

/**
 * Cached campaign performance snapshots from Meta Ads
 */
export const campaignPerformanceCacheTable = pgTable('campaign_performance_cache', {
  businessProfileId: businessProfileColumn(),
  id: serial('id').primaryKey(),
  
  // User reference
  userId: integer('user_id').notNull(),
  
  // Platform info
  platform: varchar('platform', { length: 50 }).notNull(), // 'meta'
  
  // Entity type and ID
  adAccountId: varchar('ad_account_id', { length: 40 }).notNull().default(''),
  entityType: varchar('entity_type', { length: 50 }).notNull(), // 'campaign', 'adset', 'ad'
  platformEntityId: varchar('platform_entity_id', { length: 255 }).notNull(), // e.g., Meta campaign ID
  
  // Entity name
  name: varchar('name', { length: 500 }),
  status: varchar('status', { length: 50 }),
  
  // Parent reference (for adsets -> campaign, ads -> adset)
  parentEntityId: varchar('parent_entity_id', { length: 255 }),
  
  // Core metrics (lifetime or date range)
  impressions: integer('impressions').default(0),
  clicks: integer('clicks').default(0),
  spend: decimal('spend', { precision: 12, scale: 2 }).default('0'),
  reach: integer('reach').default(0),
  
  // Calculated metrics
  ctr: decimal('ctr', { precision: 8, scale: 4 }).default('0'),
  cpc: decimal('cpc', { precision: 10, scale: 2 }).default('0'),
  cpm: decimal('cpm', { precision: 10, scale: 2 }).default('0'),
  
  // Conversion metrics
  conversions: decimal('conversions', { precision: 18, scale: 6, mode: 'number' }).default(0),
  conversionValue: decimal('conversion_value', { precision: 12, scale: 2 }).default('0'),
  
  // Full platform response (for any additional fields)
  rawData: jsonb('raw_data'),
  
  // Cache metadata
  lastRefreshedAt: timestamp('last_refreshed_at').notNull().defaultNow(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type CampaignPerformanceCacheRecord = typeof campaignPerformanceCacheTable.$inferSelect;
export type InsertCampaignPerformanceCache = typeof campaignPerformanceCacheTable.$inferInsert;
