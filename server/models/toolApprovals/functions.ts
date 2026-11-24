/**
 * Tool Approvals Functions
 * CRUD operations for tool approval records
 */

import { db } from '../db';
import { toolApprovalsTable, type InsertToolApproval, type ToolApproval } from './schema';
import { eq, and, desc, lt, or } from 'drizzle-orm';

export const ToolApprovalModel = {
  async create(data: InsertToolApproval): Promise<ToolApproval> {
    const [result] = await db.insert(toolApprovalsTable).values(data).returning();
    return result;
  },

  async findById(id: number): Promise<ToolApproval | undefined> {
    const [result] = await db.select().from(toolApprovalsTable).where(eq(toolApprovalsTable.id, id));
    return result;
  },

  async findPendingByUser(userId: number): Promise<ToolApproval[]> {
    return db.select().from(toolApprovalsTable)
      .where(and(
        eq(toolApprovalsTable.userId, userId),
        eq(toolApprovalsTable.status, 'pending')
      ))
      .orderBy(desc(toolApprovalsTable.createdAt));
  },

  async findByThread(threadId: number, userId?: number): Promise<ToolApproval[]> {
    return db.select().from(toolApprovalsTable)
      .where(userId === undefined
        ? eq(toolApprovalsTable.threadId, threadId)
        : and(eq(toolApprovalsTable.threadId, threadId), eq(toolApprovalsTable.userId, userId)))
      .orderBy(desc(toolApprovalsTable.createdAt));
  },

  async approve(id: number, comment?: string): Promise<ToolApproval | undefined> {
    const [result] = await db.update(toolApprovalsTable)
      .set({
        status: 'approved',
        userDecision: 'approve',
        userComment: comment,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(toolApprovalsTable.id, id))
      .returning();
    return result;
  },

  async reject(id: number, comment?: string): Promise<ToolApproval | undefined> {
    const [result] = await db.update(toolApprovalsTable)
      .set({
        status: 'rejected',
        userDecision: 'reject',
        userComment: comment,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(toolApprovalsTable.id, id))
      .returning();
    return result;
  },

  async expirePending(olderThanMinutes: number = 30): Promise<number> {
    const expiryDate = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    const result = await db.update(toolApprovalsTable)
      .set({ status: 'expired', isExpired: true, updatedAt: new Date() })
      .where(and(
        eq(toolApprovalsTable.status, 'pending'),
        or(
          lt(toolApprovalsTable.expiresAt, new Date()),
          lt(toolApprovalsTable.createdAt, expiryDate),
        ),
      ))
      .returning();
    return result.length;
  },
};
