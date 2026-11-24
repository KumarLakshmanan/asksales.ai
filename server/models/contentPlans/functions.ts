/**
 * Content Plans Functions
 * Database operations for content planning
 */

import { db } from '../db';
import { contentPlansTable, type ContentPlanRecord, type InsertContentPlan } from './schema';
import { eq, and, desc } from 'drizzle-orm';

export const ContentPlanModel = {
  /**
   * Get content plan by ID
   */
  async getById(id: number): Promise<ContentPlanRecord | undefined> {
    const result = await db
      .select()
      .from(contentPlansTable)
      .where(eq(contentPlansTable.id, id))
      .limit(1);
    return result[0];
  },

  /**
   * Get all content plans for a user
   */
  async getByUserId(userId: number): Promise<ContentPlanRecord[]> {
    return await db
      .select()
      .from(contentPlansTable)
      .where(eq(contentPlansTable.userId, userId))
      .orderBy(desc(contentPlansTable.createdAt));
  },

  /**
   * Get content plans by workflow
   */
  async getByWorkflowId(workflowId: number): Promise<ContentPlanRecord[]> {
    return await db
      .select()
      .from(contentPlansTable)
      .where(eq(contentPlansTable.workflowId, workflowId))
      .orderBy(desc(contentPlansTable.createdAt));
  },

  /**
   * Get content plans by type
   */
  async getByType(userId: number, contentType: string): Promise<ContentPlanRecord[]> {
    return await db
      .select()
      .from(contentPlansTable)
      .where(
        and(
          eq(contentPlansTable.userId, userId),
          eq(contentPlansTable.contentType, contentType)
        )
      )
      .orderBy(desc(contentPlansTable.createdAt));
  },

  /**
   * Get content plans by status
   */
  async getByStatus(userId: number, status: string): Promise<ContentPlanRecord[]> {
    return await db
      .select()
      .from(contentPlansTable)
      .where(
        and(
          eq(contentPlansTable.userId, userId),
          eq(contentPlansTable.status, status)
        )
      )
      .orderBy(desc(contentPlansTable.createdAt));
  },

  /**
   * Create new content plan
   */
  async create(plan: InsertContentPlan): Promise<ContentPlanRecord> {
    const result = await db.insert(contentPlansTable).values(plan).returning();
    return result[0];
  },

  /**
   * Update content plan
   */
  async update(id: number, updates: Partial<InsertContentPlan>): Promise<ContentPlanRecord | undefined> {
    const result = await db
      .update(contentPlansTable)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(contentPlansTable.id, id))
      .returning();
    return result[0];
  },

  /**
   * Update status
   */
  async updateStatus(id: number, status: string): Promise<ContentPlanRecord | undefined> {
    return await this.update(id, { status });
  },

  /**
   * Add generated content to plan
   */
  async addGeneratedContent(
    id: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content: any
  ): Promise<ContentPlanRecord | undefined> {
    const plan = await this.getById(id);
    if (!plan) return undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentContent = (plan.generatedContent as any[]) || [];
    const updatedContent = [...currentContent, content];

    return await this.update(id, { generatedContent: updatedContent });
  },

  /**
   * Delete content plan
   */
  async delete(id: number): Promise<void> {
    await db.delete(contentPlansTable).where(eq(contentPlansTable.id, id));
  },
};
