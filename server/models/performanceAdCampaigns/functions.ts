/**
 * Performance Ad Campaigns Functions
 * Database operations for performance marketing ad campaigns
 */

import { db } from '../db';
import { performanceAdCampaignsTable, type PerformanceAdCampaignRecord, type InsertPerformanceAdCampaign } from './schema';
 
import { eq, and, desc } from 'drizzle-orm';

export const PerformanceAdCampaignModel = {
  /**
   * Get campaign by ID
   */
  async getById(id: number): Promise<PerformanceAdCampaignRecord | undefined> {
    const result = await db
      .select()
      .from(performanceAdCampaignsTable)
      .where(eq(performanceAdCampaignsTable.id, id))
      .limit(1);
    return result[0];
  },

  /**
   * Get campaign by platform campaign ID
   */
  async getByPlatformId(platformCampaignId: string): Promise<PerformanceAdCampaignRecord | undefined> {
    const result = await db
      .select()
      .from(performanceAdCampaignsTable)
      .where(eq(performanceAdCampaignsTable.platformCampaignId, platformCampaignId))
      .limit(1);
    return result[0];
  },

  /**
   * Get all campaigns for a user
   */
  async getByUserId(userId: number): Promise<PerformanceAdCampaignRecord[]> {
    return await db
      .select()
      .from(performanceAdCampaignsTable)
      .where(eq(performanceAdCampaignsTable.userId, userId))
      .orderBy(desc(performanceAdCampaignsTable.createdAt));
  },

  /**
   * Get campaigns by platform
   */
  async getByPlatform(userId: number, platform: string): Promise<PerformanceAdCampaignRecord[]> {
    return await db
      .select()
      .from(performanceAdCampaignsTable)
      .where(
        and(
          eq(performanceAdCampaignsTable.userId, userId),
          eq(performanceAdCampaignsTable.adPlatform, platform)
        )
      )
      .orderBy(desc(performanceAdCampaignsTable.createdAt));
  },

  /**
   * Get active campaigns
   */
  async getActive(userId: number): Promise<PerformanceAdCampaignRecord[]> {
    return await db
      .select()
      .from(performanceAdCampaignsTable)
      .where(
        and(
          eq(performanceAdCampaignsTable.userId, userId),
          eq(performanceAdCampaignsTable.isActive, true)
        )
      );
  },

  /**
   * Get active campaigns by platform (for metrics ingestion)
   */
  async getActiveByPlatform(platform: string): Promise<PerformanceAdCampaignRecord[]> {
    return await db
      .select()
      .from(performanceAdCampaignsTable)
      .where(
        and(
          eq(performanceAdCampaignsTable.adPlatform, platform),
          eq(performanceAdCampaignsTable.isActive, true)
        )
      );
  },

  /**
   * Create new campaign
   */
  async create(campaign: InsertPerformanceAdCampaign): Promise<PerformanceAdCampaignRecord> {
    const result = await db.insert(performanceAdCampaignsTable).values(campaign).returning();
    return result[0];
  },

  /**
   * Update campaign
   */
  async update(
    id: number,
    updates: Partial<InsertPerformanceAdCampaign>
  ): Promise<PerformanceAdCampaignRecord | undefined> {
    const result = await db
      .update(performanceAdCampaignsTable)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(performanceAdCampaignsTable.id, id))
      .returning();
    return result[0];
  },

  /**
   * Update campaign status
   */
  async updateStatus(
    id: number,
    status: string,
    isActive: boolean
  ): Promise<PerformanceAdCampaignRecord | undefined> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: any = {
      status,
      isActive,
      updatedAt: new Date(),
    };

    if (status === 'active' && isActive && !updates.launchedAt) {
      updates.launchedAt = new Date();
    }

    const result = await db
      .update(performanceAdCampaignsTable)
      .set(updates)
      .where(eq(performanceAdCampaignsTable.id, id))
      .returning();
    return result[0];
  },

  /**
   * Update campaign metrics (cached performance data)
   */
  async updateMetrics(
    id: number,
    metrics: Partial<{
      impressions: number;
      clicks: number;
      conversions: number;
      reach: number;
      spentAmount: string;
      ctr: string;
      cpc: string;
      cpa: string;
      roas: string;
    }>
  ): Promise<PerformanceAdCampaignRecord | undefined> {
    const result = await db
      .update(performanceAdCampaignsTable)
      .set({
        ...metrics,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(performanceAdCampaignsTable.id, id))
      .returning();
    return result[0];
  },

  /**
   * Set platform campaign ID after publishing
   */
  async setPlatformCampaignId(
    id: number,
    platformCampaignId: string
  ): Promise<PerformanceAdCampaignRecord | undefined> {
    return await this.update(id, { platformCampaignId });
  },

  /**
   * Delete campaign
   */
  async delete(id: number): Promise<void> {
    await db.delete(performanceAdCampaignsTable).where(eq(performanceAdCampaignsTable.id, id));
  },
};
