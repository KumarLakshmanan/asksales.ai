/**
 * Performance Metrics Functions
 * Database operations for ad campaign performance metrics
 */

import { db } from '../db';
import { performanceMetricsTable, type PerformanceMetricRecord, type InsertPerformanceMetric } from './schema';
import { eq, and, between, desc, sql } from 'drizzle-orm';

export const PerformanceMetricModel = {
  /**
   * Get metric by ID
   */
  async getById(id: number): Promise<PerformanceMetricRecord | undefined> {
    const result = await db
      .select()
      .from(performanceMetricsTable)
      .where(eq(performanceMetricsTable.id, id))
      .limit(1);
    return result[0];
  },

  /**
   * Get metrics for a campaign
   */
  async getByCampaignId(campaignId: number): Promise<PerformanceMetricRecord[]> {
    return await db
      .select()
      .from(performanceMetricsTable)
      .where(eq(performanceMetricsTable.campaignId, campaignId))
      .orderBy(desc(performanceMetricsTable.date));
  },

  /**
   * Get metrics for date range
   */
  async getByDateRange(
    campaignId: number,
    startDate: string,
    endDate: string
  ): Promise<PerformanceMetricRecord[]> {
    return await db
      .select()
      .from(performanceMetricsTable)
      .where(
        and(
          eq(performanceMetricsTable.campaignId, campaignId),
          between(performanceMetricsTable.date, startDate, endDate)
        )
      )
      .orderBy(performanceMetricsTable.date);
  },

  /**
   * Get daily metrics (hour is NULL)
   */
  async getDailyMetrics(
    campaignId: number,
    startDate: string,
    endDate: string
  ): Promise<PerformanceMetricRecord[]> {
    return await db
      .select()
      .from(performanceMetricsTable)
      .where(
        and(
          eq(performanceMetricsTable.campaignId, campaignId),
          between(performanceMetricsTable.date, startDate, endDate),
          sql`${performanceMetricsTable.hour} IS NULL`
        )
      )
      .orderBy(performanceMetricsTable.date);
  },

  /**
   * Get hourly metrics for a specific date
   */
  async getHourlyMetrics(
    campaignId: number,
    date: string
  ): Promise<PerformanceMetricRecord[]> {
    return await db
      .select()
      .from(performanceMetricsTable)
      .where(
        and(
          eq(performanceMetricsTable.campaignId, campaignId),
          eq(performanceMetricsTable.date, date),
          sql`${performanceMetricsTable.hour} IS NOT NULL`
        )
      )
      .orderBy(performanceMetricsTable.hour);
  },

  /**
   * Insert or update metric (upsert)
   */
  async upsert(metric: InsertPerformanceMetric): Promise<PerformanceMetricRecord> {
    const result = await db
      .insert(performanceMetricsTable)
      .values({
        ...metric,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          performanceMetricsTable.campaignId,
          performanceMetricsTable.platform,
          performanceMetricsTable.date,
          performanceMetricsTable.hour,
        ],
        set: {
          impressions: metric.impressions,
          clicks: metric.clicks,
          spend: metric.spend,
          reach: metric.reach,
          conversions: metric.conversions,
          conversionValue: metric.conversionValue,
          videoViews: metric.videoViews,
          videoViewsComplete: metric.videoViewsComplete,
          linkClicks: metric.linkClicks,
          postEngagements: metric.postEngagements,
          leads: metric.leads,
          leadValue: metric.leadValue,
          ctr: metric.ctr,
          cpc: metric.cpc,
          cpm: metric.cpm,
          cpa: metric.cpa,
          roas: metric.roas,
          platformData: metric.platformData,
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  },

  /**
   * Bulk insert or update metrics
   */
  async upsertMany(metrics: InsertPerformanceMetric[]): Promise<void> {
    if (metrics.length === 0) return;

    // Process in batches of 100
    const batchSize = 100;
    for (let i = 0; i < metrics.length; i += batchSize) {
      const batch = metrics.slice(i, i + batchSize);
      await db
        .insert(performanceMetricsTable)
        .values(
          batch.map((m) => ({
            ...m,
            createdAt: new Date(),
            updatedAt: new Date(),
          }))
        )
        .onConflictDoUpdate({
          target: [
            performanceMetricsTable.campaignId,
            performanceMetricsTable.platform,
            performanceMetricsTable.date,
            performanceMetricsTable.hour,
          ],
          set: {
            // Use excluded.column to reference the incoming values
            impressions: sql`excluded.impressions`,
            clicks: sql`excluded.clicks`,
            spend: sql`excluded.spend`,
            reach: sql`excluded.reach`,
            conversions: sql`excluded.conversions`,
            conversionValue: sql`excluded.conversion_value`,
            videoViews: sql`excluded.video_views`,
            videoViewsComplete: sql`excluded.video_views_complete`,
            linkClicks: sql`excluded.link_clicks`,
            postEngagements: sql`excluded.post_engagements`,
            leads: sql`excluded.leads`,
            leadValue: sql`excluded.lead_value`,
            ctr: sql`excluded.ctr`,
            cpc: sql`excluded.cpc`,
            cpm: sql`excluded.cpm`,
            cpa: sql`excluded.cpa`,
            roas: sql`excluded.roas`,
            platformData: sql`excluded.platform_data`,
            updatedAt: sql`now()`,
          },
        });
    }
  },

  /**
   * Get aggregated metrics for a campaign
   */
  async getAggregatedMetrics(campaignId: number): Promise<{
    totalImpressions: number;
    totalClicks: number;
    totalSpend: string;
    totalConversions: number;
    avgCtr: string;
    avgCpc: string;
  } | undefined> {
    const result = await db
      .select({
        totalImpressions: sql<number>`SUM(${performanceMetricsTable.impressions})::int`,
        totalClicks: sql<number>`SUM(${performanceMetricsTable.clicks})::int`,
        totalSpend: sql<string>`SUM(${performanceMetricsTable.spend})::numeric`,
        totalConversions: sql<number>`SUM(${performanceMetricsTable.conversions})::int`,
        avgCtr: sql<string>`AVG(${performanceMetricsTable.ctr})::numeric`,
        avgCpc: sql<string>`AVG(${performanceMetricsTable.cpc})::numeric`,
      })
      .from(performanceMetricsTable)
      .where(
        and(
          eq(performanceMetricsTable.campaignId, campaignId),
          sql`${performanceMetricsTable.hour} IS NULL` // Only daily metrics
        )
      );

    return result[0];
  },

  /**
   * Delete old metrics
   */
  async deleteOldMetrics(olderThan: string): Promise<number> {
    const result = await db
      .delete(performanceMetricsTable)
      .where(sql`${performanceMetricsTable.date} < ${olderThan}`)
      .returning();
    return result.length;
  },

  /**
   * Delete metrics for a campaign
   */
  async deleteByCampaign(campaignId: number): Promise<void> {
    await db.delete(performanceMetricsTable).where(eq(performanceMetricsTable.campaignId, campaignId));
  },
};
