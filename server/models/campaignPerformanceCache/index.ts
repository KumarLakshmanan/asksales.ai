/**
 * Campaign Performance Cache Model
 * Handles caching of Meta/Google campaign and adset performance data
 */

import { db } from '../db';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { campaignPerformanceCacheTable, type InsertCampaignPerformanceCache, type CampaignPerformanceCacheRecord } from './schema';
import { logger } from '../../utils/logger.js';

export interface CachedCampaignPerformance {
  id: number;
  userId: number;
  platform: string;
  entityType: string;
  adAccountId: string;
  platformEntityId: string;
  name: string | null;
  status: string | null;
  parentEntityId: string | null;
  impressions: number;
  clicks: number;
  spend: number;
  reach: number;
  ctr: number;
  cpc: number;
  cpm: number;
  conversions: number;
  conversionValue: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawData: any;
  lastRefreshedAt: Date;
}

export class CampaignPerformanceCacheModel {
  /**
   * Store or update campaign/adset performance
   */
  static async upsertPerformance(data: Omit<InsertCampaignPerformanceCache, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
    try {
      const raw = data.rawData as Record<string, any> | undefined;
      data = {...data, adAccountId: String(data.adAccountId || raw?.accountIdentity?.adAccountId || '').replace(/^act_/, '')};
      return await db.transaction(async (tx: typeof db) => {
        // Serialize the same provider entity across manual and worker refreshes.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${data.userId}:${data.platform}:${data.adAccountId}:${data.entityType}:${data.platformEntityId}`}, 0))`);
      // Check if record exists
      const existing = await tx.select({ id: campaignPerformanceCacheTable.id })
        .from(campaignPerformanceCacheTable)
        .where(and(
          eq(campaignPerformanceCacheTable.userId, data.userId),
          eq(campaignPerformanceCacheTable.platform, data.platform),
          eq(campaignPerformanceCacheTable.adAccountId, data.adAccountId || ""),
          eq(campaignPerformanceCacheTable.entityType, data.entityType),
          eq(campaignPerformanceCacheTable.platformEntityId, data.platformEntityId)
        ))
        .limit(1);

      if (existing.length > 0) {
        // Update existing
        await tx.update(campaignPerformanceCacheTable)
          .set({
            ...data,
            updatedAt: new Date(),
            lastRefreshedAt: new Date(),
          })
          .where(eq(campaignPerformanceCacheTable.id, existing[0].id));
        return existing[0].id;
      } else {
        // Insert new
        const result = await tx.insert(campaignPerformanceCacheTable)
          .values({
            ...data,
            lastRefreshedAt: new Date(),
          })
          .returning({ id: campaignPerformanceCacheTable.id });
        return result[0].id;
      }
      });
    } catch (error) {
      logger.error({ err: error }, '[CampaignPerformanceCacheModel] Error upserting performance:');
      throw error;
    }
  }

  /**
   * Bulk upsert multiple performance records
   */
  static async bulkUpsertPerformance(records: Omit<InsertCampaignPerformanceCache, 'id' | 'createdAt' | 'updatedAt'>[]): Promise<void> {
    try {
      for (const record of records) {
        await this.upsertPerformance(record);
      }
    } catch (error) {
      logger.error({ err: error }, '[CampaignPerformanceCacheModel] Error bulk upserting performance:');
      throw error;
    }
  }

  /**
   * Get cached campaigns for a user
   */
  static async getCachedCampaigns(
    userId: number,
    platform: string = 'meta'
  ): Promise<CachedCampaignPerformance[]> {
    try {
      const results = await db.select()
        .from(campaignPerformanceCacheTable)
        .where(and(
          eq(campaignPerformanceCacheTable.userId, userId),
          eq(campaignPerformanceCacheTable.platform, platform),
          eq(campaignPerformanceCacheTable.entityType, 'campaign')
        ))
        .orderBy(desc(campaignPerformanceCacheTable.lastRefreshedAt));

      return results.map(this.transformRecord);
    } catch (error) {
      logger.error({ err: error }, '[CampaignPerformanceCacheModel] Error getting cached campaigns:');
      throw error;
    }
  }

  /**
   * Get cached adsets for a campaign
   */
  static async getCachedAdsets(
    userId: number,
    campaignId: string,
    platform: string = 'meta'
  ): Promise<CachedCampaignPerformance[]> {
    try {
      const results = await db.select()
        .from(campaignPerformanceCacheTable)
        .where(and(
          eq(campaignPerformanceCacheTable.userId, userId),
          eq(campaignPerformanceCacheTable.platform, platform),
          eq(campaignPerformanceCacheTable.entityType, 'adset'),
          eq(campaignPerformanceCacheTable.parentEntityId, campaignId)
        ))
        .orderBy(desc(campaignPerformanceCacheTable.lastRefreshedAt));

      return results.map(this.transformRecord);
    } catch (error) {
      logger.error({ err: error }, '[CampaignPerformanceCacheModel] Error getting cached adsets:');
      throw error;
    }
  }

  /**
   * Get cached individual ads whose parent ad set belongs to a campaign.
   */
  static async getCachedAds(
    userId: number,
    campaignId: string,
    platform: string = 'meta'
  ): Promise<CachedCampaignPerformance[]> {
    try {
      const adsets = await this.getCachedAdsets(userId, campaignId, platform);
      const adsetIds = adsets.map(adset => adset.platformEntityId);
      if (!adsetIds.length) return [];
      const results = await db.select()
        .from(campaignPerformanceCacheTable)
        .where(and(
          eq(campaignPerformanceCacheTable.userId, userId),
          eq(campaignPerformanceCacheTable.platform, platform),
          eq(campaignPerformanceCacheTable.entityType, 'ad'),
          inArray(campaignPerformanceCacheTable.parentEntityId, adsetIds)
        ))
        .orderBy(desc(campaignPerformanceCacheTable.lastRefreshedAt));
      return results.map(this.transformRecord);
    } catch (error) {
      logger.error({ err: error }, '[CampaignPerformanceCacheModel] Error getting cached ads:');
      throw error;
    }
  }

  /**
   * Get last refresh time for user's campaigns
   */
  static async getLastRefreshTime(userId: number, platform: string = 'meta'): Promise<Date | null> {
    try {
      const result = await db.select({ lastRefreshed: campaignPerformanceCacheTable.lastRefreshedAt })
        .from(campaignPerformanceCacheTable)
        .where(and(
          eq(campaignPerformanceCacheTable.userId, userId),
          eq(campaignPerformanceCacheTable.platform, platform)
        ))
        .orderBy(desc(campaignPerformanceCacheTable.lastRefreshedAt))
        .limit(1);

      return result.length > 0 ? result[0].lastRefreshed : null;
    } catch (error) {
      logger.error({ err: error }, '[CampaignPerformanceCacheModel] Error getting last refresh time:');
      return null;
    }
  }

  /**
   * Delete cached data for a user (cleanup)
   */
  static async clearUserCache(userId: number, platform?: string): Promise<void> {
    try {
      if (platform) {
        await db.delete(campaignPerformanceCacheTable)
          .where(and(
            eq(campaignPerformanceCacheTable.userId, userId),
            eq(campaignPerformanceCacheTable.platform, platform)
          ));
      } else {
        await db.delete(campaignPerformanceCacheTable)
          .where(eq(campaignPerformanceCacheTable.userId, userId));
      }
    } catch (error) {
      logger.error({ err: error }, '[CampaignPerformanceCacheModel] Error clearing user cache:');
      throw error;
    }
  }

  /**
   * Update the status of a cached entity
   */
  static async updateStatus(userId: number, platformEntityId: string, status: string): Promise<void> {
    try {
      await db.update(campaignPerformanceCacheTable)
        .set({
          status,
          updatedAt: new Date(),
        })
        .where(and(
          eq(campaignPerformanceCacheTable.userId, userId),
          eq(campaignPerformanceCacheTable.platformEntityId, platformEntityId)
        ));
    } catch (error) {
      logger.error({ err: error }, '[CampaignPerformanceCacheModel] Error updating status:');
      throw error;
    }
  }

  /**
   * Delete a cached entity by its platform ID
   */
  static async deleteByEntityId(userId: number, platformEntityId: string): Promise<void> {
    try {
      const children = await db.select({ platformEntityId: campaignPerformanceCacheTable.platformEntityId })
        .from(campaignPerformanceCacheTable)
        .where(and(
          eq(campaignPerformanceCacheTable.userId, userId),
          eq(campaignPerformanceCacheTable.parentEntityId, platformEntityId)
        ));
      const childIds = (children as Array<{ platformEntityId: string }>).map(child => child.platformEntityId);
      if (childIds.length) {
        await db.delete(campaignPerformanceCacheTable)
          .where(and(
            eq(campaignPerformanceCacheTable.userId, userId),
            inArray(campaignPerformanceCacheTable.parentEntityId, childIds)
          ));
      }
      // Also delete child entities (e.g., adsets when deleting a campaign)
      await db.delete(campaignPerformanceCacheTable)
        .where(and(
          eq(campaignPerformanceCacheTable.userId, userId),
          eq(campaignPerformanceCacheTable.parentEntityId, platformEntityId)
        ));
      
      // Delete the entity itself
      await db.delete(campaignPerformanceCacheTable)
        .where(and(
          eq(campaignPerformanceCacheTable.userId, userId),
          eq(campaignPerformanceCacheTable.platformEntityId, platformEntityId)
        ));
    } catch (error) {
      logger.error({ err: error }, '[CampaignPerformanceCacheModel] Error deleting entity:');
      throw error;
    }
  }

  /**
   * Transform database record to interface
   */
  private static transformRecord(record: CampaignPerformanceCacheRecord): CachedCampaignPerformance {
    return {
      id: record.id,
      userId: record.userId,
      platform: record.platform,
      entityType: record.entityType,
      adAccountId: record.adAccountId,
      platformEntityId: record.platformEntityId,
      name: record.name,
      status: record.status,
      parentEntityId: record.parentEntityId,
      impressions: record.impressions ?? 0,
      clicks: record.clicks ?? 0,
      spend: parseFloat(String(record.spend ?? 0)),
      reach: record.reach ?? 0,
      ctr: parseFloat(String(record.ctr ?? 0)),
      cpc: parseFloat(String(record.cpc ?? 0)),
      cpm: parseFloat(String(record.cpm ?? 0)),
      conversions: record.conversions ?? 0,
      conversionValue: parseFloat(String(record.conversionValue ?? 0)),
      rawData: record.rawData,
      lastRefreshedAt: record.lastRefreshedAt,
    };
  }
}

export { campaignPerformanceCacheTable } from './schema';
