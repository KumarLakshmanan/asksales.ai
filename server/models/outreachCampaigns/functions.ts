/**
 * Outreach Campaigns Functions
 * Database operations for outreach campaigns
 */

import { db } from '../db';
import { outreachCampaignsTable, type OutreachCampaignRecord, type InsertOutreachCampaign } from './schema';
import { eq, and, desc } from 'drizzle-orm';

export const OutreachCampaignModel = {
  /**
   * Get campaign by ID
   */
  async getById(id: number): Promise<OutreachCampaignRecord | undefined> {
    const result = await db
      .select()
      .from(outreachCampaignsTable)
      .where(eq(outreachCampaignsTable.id, id))
      .limit(1);
    return result[0];
  },

  /**
   * Get all campaigns for a user
   */
  async getByUserId(userId: number): Promise<OutreachCampaignRecord[]> {
    return await db
      .select()
      .from(outreachCampaignsTable)
      .where(eq(outreachCampaignsTable.userId, userId))
      .orderBy(desc(outreachCampaignsTable.createdAt));
  },

  /**
   * Get active campaigns
   */
  async getActive(userId: number): Promise<OutreachCampaignRecord[]> {
    return await db
      .select()
      .from(outreachCampaignsTable)
      .where(
        and(
          eq(outreachCampaignsTable.userId, userId),
          eq(outreachCampaignsTable.isActive, true)
        )
      );
  },

  /**
   * Create new campaign
   */
  async create(campaign: InsertOutreachCampaign): Promise<OutreachCampaignRecord> {
    // Snapshot the brand at creation so a later default change cannot rebrand the campaign.
    if (campaign.brandToolkitId == null) {
      const { defaultBrandToolkitId } = await import('../../services/outreach/WorkflowBrand.js');
      campaign = { ...campaign, brandToolkitId: await defaultBrandToolkitId(campaign.userId) };
    }
    const result = await db.insert(outreachCampaignsTable).values(campaign).returning();
    return result[0];
  },

  /**
   * Update campaign
   */
  async update(id: number, updates: Partial<InsertOutreachCampaign>): Promise<OutreachCampaignRecord | undefined> {
    const result = await db
      .update(outreachCampaignsTable)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(outreachCampaignsTable.id, id))
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
  ): Promise<OutreachCampaignRecord | undefined> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: any = {
      status,
      isActive,
      updatedAt: new Date(),
    };

    if (status === 'active' && isActive) {
      updates.launchedAt = new Date();
    } else if (status === 'completed') {
      updates.completedAt = new Date();
    }

    const result = await db
      .update(outreachCampaignsTable)
      .set(updates)
      .where(eq(outreachCampaignsTable.id, id))
      .returning();
    return result[0];
  },

  /**
   * Update campaign stats
   */
  async updateStats(
    id: number,
    stats: Partial<{
      messagesSent: number;
      messagesDelivered: number;
      messagesFailed: number;
      opens: number;
      clicks: number;
      replies: number;
      conversions: number;
    }>
  ): Promise<OutreachCampaignRecord | undefined> {
    const result = await db
      .update(outreachCampaignsTable)
      .set({
        ...stats,
        updatedAt: new Date(),
      })
      .where(eq(outreachCampaignsTable.id, id))
      .returning();
    return result[0];
  },

  /**
   * Increment stat by delta
   */
  async incrementStat(
    id: number,
    stat: keyof Pick<OutreachCampaignRecord, 'messagesSent' | 'messagesDelivered' | 'messagesFailed' | 'opens' | 'clicks' | 'replies' | 'conversions'>,
    delta: number = 1
  ): Promise<void> {
    // Get current value
    const campaign = await this.getById(id);
    if (!campaign) return;

    const currentValue = (campaign[stat] as number) || 0;
    await this.updateStats(id, { [stat]: currentValue + delta });
  },

  /**
   * Delete campaign
   */
  async delete(id: number): Promise<void> {
    await db.delete(outreachCampaignsTable).where(eq(outreachCampaignsTable.id, id));
  },
};
