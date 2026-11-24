/**
 * Budget Plans Functions
 * Database operations for budget planning
 */

import { db } from '../db';
import { budgetPlansTable, type BudgetPlanRecord, type InsertBudgetPlan } from './schema';
import { eq, and, desc } from 'drizzle-orm';

export const BudgetPlanModel = {
  /**
   * Get budget plan by ID
   */
  async getById(id: number): Promise<BudgetPlanRecord | undefined> {
    const result = await db
      .select()
      .from(budgetPlansTable)
      .where(eq(budgetPlansTable.id, id))
      .limit(1);
    return result[0];
  },

  /**
   * Get all budget plans for a user
   */
  async getByUserId(userId: number): Promise<BudgetPlanRecord[]> {
    return await db
      .select()
      .from(budgetPlansTable)
      .where(eq(budgetPlansTable.userId, userId))
      .orderBy(desc(budgetPlansTable.createdAt));
  },

  /**
   * Get budget plans by workflow
   */
  async getByWorkflowId(workflowId: number): Promise<BudgetPlanRecord[]> {
    return await db
      .select()
      .from(budgetPlansTable)
      .where(eq(budgetPlansTable.workflowId, workflowId))
      .orderBy(desc(budgetPlansTable.createdAt));
  },

  /**
   * Get budget plans by status
   */
  async getByStatus(userId: number, status: string): Promise<BudgetPlanRecord[]> {
    return await db
      .select()
      .from(budgetPlansTable)
      .where(
        and(
          eq(budgetPlansTable.userId, userId),
          eq(budgetPlansTable.status, status)
        )
      )
      .orderBy(desc(budgetPlansTable.createdAt));
  },

  /**
   * Get active budget plans
   */
  async getActive(userId: number): Promise<BudgetPlanRecord[]> {
    return await this.getByStatus(userId, 'active');
  },

  /**
   * Create new budget plan
   */
  async create(plan: InsertBudgetPlan): Promise<BudgetPlanRecord> {
    // Calculate remaining budget
    const remainingBudget = plan.totalBudget;

    const result = await db
      .insert(budgetPlansTable)
      .values({
        ...plan,
        remainingBudget,
      })
      .returning();
    return result[0];
  },

  /**
   * Update budget plan
   */
  async update(id: number, updates: Partial<InsertBudgetPlan>): Promise<BudgetPlanRecord | undefined> {
    const result = await db
      .update(budgetPlansTable)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(budgetPlansTable.id, id))
      .returning();
    return result[0];
  },

  /**
   * Update status
   */
  async updateStatus(id: number, status: string): Promise<BudgetPlanRecord | undefined> {
    return await this.update(id, { status });
  },

  /**
   * Update spent amount and recalculate remaining budget
   */
  async updateSpent(id: number, spentAmount: string): Promise<BudgetPlanRecord | undefined> {
    const plan = await this.getById(id);
    if (!plan) return undefined;

    const totalBudget = parseFloat(plan.totalBudget);
    const spent = parseFloat(spentAmount);
    const remaining = totalBudget - spent;

    // Update status if budget exceeded
    const status = remaining < 0 ? 'exceeded' : plan.status;

    return await this.update(id, {
      spentAmount,
      remainingBudget: remaining.toFixed(2),
      status,
    });
  },

  /**
   * Increment spent amount by delta
   */
  async incrementSpent(id: number, delta: number): Promise<BudgetPlanRecord | undefined> {
    const plan = await this.getById(id);
    if (!plan) return undefined;

    const currentSpent = parseFloat(plan.spentAmount || '0');
    const newSpent = currentSpent + delta;

    return await this.updateSpent(id, newSpent.toFixed(2));
  },

  /**
   * Delete budget plan
   */
  async delete(id: number): Promise<void> {
    await db.delete(budgetPlansTable).where(eq(budgetPlansTable.id, id));
  },
};
