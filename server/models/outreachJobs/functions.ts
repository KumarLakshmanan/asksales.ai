/**
 * Outreach Jobs Functions
 * Database operations for outreach job queue
 */

import { db } from '../db';
import { outreachJobsTable, type OutreachJobRecord, type InsertOutreachJob } from './schema';
import { eq, and, lte, inArray } from 'drizzle-orm';

export const OutreachJobModel = {
  /**
   * Get job by ID
   */
  async getById(id: number): Promise<OutreachJobRecord | undefined> {
    const result = await db.select().from(outreachJobsTable).where(eq(outreachJobsTable.id, id)).limit(1);
    return result[0];
  },

  /**
   * Get all pending jobs scheduled before a given date
   */
  async getPendingJobs(before: Date): Promise<OutreachJobRecord[]> {
    return await db
      .select()
      .from(outreachJobsTable)
      .where(
        and(
          eq(outreachJobsTable.status, 'pending'),
          lte(outreachJobsTable.scheduledFor, before)
        )
      )
      .orderBy(outreachJobsTable.scheduledFor);
  },

  /**
   * Get jobs by campaign ID
   */
  async getByCampaignId(campaignId: number): Promise<OutreachJobRecord[]> {
    return await db
      .select()
      .from(outreachJobsTable)
      .where(eq(outreachJobsTable.campaignId, campaignId))
      .orderBy(outreachJobsTable.scheduledFor);
  },

  /**
   * Get jobs by lead ID
   */
  async getByLeadId(leadId: number): Promise<OutreachJobRecord[]> {
    return await db
      .select()
      .from(outreachJobsTable)
      .where(eq(outreachJobsTable.leadId, leadId))
      .orderBy(outreachJobsTable.scheduledFor);
  },

  /**
   * Create new outreach job
   */
  async create(job: InsertOutreachJob): Promise<OutreachJobRecord> {
    const result = await db.insert(outreachJobsTable).values(job).returning();
    return result[0];
  },

  /**
   * Create multiple jobs
   */
  async createMany(jobs: InsertOutreachJob[]): Promise<OutreachJobRecord[]> {
    return await db.insert(outreachJobsTable).values(jobs).returning();
  },

  /**
   * Update job status
   */
  async updateStatus(
    id: number,
    status: string,
    updates: Partial<OutreachJobRecord> = {}
  ): Promise<OutreachJobRecord | undefined> {
    const result = await db
      .update(outreachJobsTable)
      .set({
        status,
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(outreachJobsTable.id, id))
      .returning();
    return result[0];
  },

  /**
   * Mark job as sent
   */
  async markSent(id: number, externalMessageId: string): Promise<OutreachJobRecord | undefined> {
    const result = await db
      .update(outreachJobsTable)
      .set({
        status: 'sent',
        sentAt: new Date(),
        externalMessageId,
        updatedAt: new Date(),
      })
      .where(eq(outreachJobsTable.id, id))
      .returning();
    return result[0];
  },

  /**
   * Mark job as failed
   */
  async markFailed(id: number, error: string, attempts: number): Promise<OutreachJobRecord | undefined> {
    const result = await db
      .update(outreachJobsTable)
      .set({
        status: 'failed',
        error,
        attempts,
        lastAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(outreachJobsTable.id, id))
      .returning();
    return result[0];
  },

  /**
   * Cancel jobs by campaign ID
   */
  async cancelByCampaign(campaignId: number): Promise<number> {
    const result = await db
      .update(outreachJobsTable)
      .set({
        status: 'cancelled',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(outreachJobsTable.campaignId, campaignId),
          eq(outreachJobsTable.status, 'pending')
        )
      )
      .returning();
    return result.length;
  },

  /**
   * Delete old completed jobs
   */
  async deleteOldJobs(olderThan: Date): Promise<number> {
    const result = await db
      .delete(outreachJobsTable)
      .where(
        and(
          inArray(outreachJobsTable.status, ['sent', 'failed', 'cancelled']),
          lte(outreachJobsTable.updatedAt, olderThan)
        )
      )
      .returning();
    return result.length;
  },

  /**
   * Phase 5.15 / MODEL-010: mark a job as a dead-letter.
   * Called by the outreach worker when `attempts >= maxAttempts` and the
   * last attempt failed. The UI uses the `is_dead_letter` flag to show a
   * "needs manual review" view.
   */
  async markDeadLetter(id: number, errorMessage: string): Promise<void> {
    await db
      .update(outreachJobsTable)
      .set({
        isDeadLetter: true,
        status: 'failed',
        error: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(outreachJobsTable.id, id));
  },
};
