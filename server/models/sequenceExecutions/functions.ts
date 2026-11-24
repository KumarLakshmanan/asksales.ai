/**
 * Sequence Executions Model Functions
 */

import { db } from '../db';
import { sequenceExecutionsTable, SequenceExecutionRecord, InsertSequenceExecution } from './schema';
import { eq, and, lte } from 'drizzle-orm';

export const SequenceExecutionModel = {
  /**
   * Create a new sequence execution (enroll lead)
   */
  async create(data: InsertSequenceExecution): Promise<SequenceExecutionRecord> {
    const [execution] = await db
      .insert(sequenceExecutionsTable)
      .values(data)
      .returning();
    
    return execution;
  },

  /**
   * Find execution by ID
   */
  async findById(id: number): Promise<SequenceExecutionRecord | undefined> {
    const [execution] = await db
      .select()
      .from(sequenceExecutionsTable)
      .where(eq(sequenceExecutionsTable.id, id))
      .limit(1);
    
    return execution;
  },

  /**
   * Find execution by sequence and lead
   */
  async findBySequenceAndLead(sequenceId: number, leadId: number): Promise<SequenceExecutionRecord | undefined> {
    const [execution] = await db
      .select()
      .from(sequenceExecutionsTable)
      .where(
        and(
          eq(sequenceExecutionsTable.sequenceId, sequenceId),
          eq(sequenceExecutionsTable.leadId, leadId)
        )
      )
      .limit(1);
    
    return execution;
  },

  /**
   * Find all executions for a sequence
   */
  async findBySequence(sequenceId: number): Promise<SequenceExecutionRecord[]> {
    return db
      .select()
      .from(sequenceExecutionsTable)
      .where(eq(sequenceExecutionsTable.sequenceId, sequenceId));
  },

  /**
   * Find due messages (executions ready to send next message)
   */
  async findDue(now: Date = new Date()): Promise<SequenceExecutionRecord[]> {
    return db
      .select()
      .from(sequenceExecutionsTable)
      .where(
        and(
          eq(sequenceExecutionsTable.status, 'active'),
          lte(sequenceExecutionsTable.nextScheduledAt, now)
        )
      );
  },

  /**
   * Update execution
   */
  async update(id: number, data: Partial<InsertSequenceExecution>): Promise<SequenceExecutionRecord | undefined> {
    const [updated] = await db
      .update(sequenceExecutionsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(sequenceExecutionsTable.id, id))
      .returning();
    
    return updated;
  },

  /**
   * Pause execution
   */
  async pause(id: number, reason?: string): Promise<void> {
    await db
      .update(sequenceExecutionsTable)
      .set({
        status: 'paused',
        pausedAt: new Date(),
        metadata: { pauseReason: reason },
        updatedAt: new Date(),
      })
      .where(eq(sequenceExecutionsTable.id, id));
  },

  /**
   * Resume execution
   */
  async resume(id: number, nextScheduledAt: Date): Promise<void> {
    await db
      .update(sequenceExecutionsTable)
      .set({
        status: 'active',
        pausedAt: null,
        nextScheduledAt,
        updatedAt: new Date(),
      })
      .where(eq(sequenceExecutionsTable.id, id));
  },

  /**
   * Complete execution
   */
  async complete(id: number): Promise<void> {
    await db
      .update(sequenceExecutionsTable)
      .set({
        status: 'completed',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sequenceExecutionsTable.id, id));
  },

  /**
   * Increment message sent count
   */
  async incrementMessagesSent(id: number): Promise<void> {
    const [execution] = await db
      .select()
      .from(sequenceExecutionsTable)
      .where(eq(sequenceExecutionsTable.id, id))
      .limit(1);

    if (execution) {
      await db
        .update(sequenceExecutionsTable)
        .set({
          totalMessagesSent: execution.totalMessagesSent + 1,
          updatedAt: new Date(),
        })
        .where(eq(sequenceExecutionsTable.id, id));
    }
  },

  /**
   * Record reply received
   */
  async recordReply(id: number): Promise<void> {
    const [execution] = await db
      .select()
      .from(sequenceExecutionsTable)
      .where(eq(sequenceExecutionsTable.id, id))
      .limit(1);

    if (execution) {
      await db
        .update(sequenceExecutionsTable)
        .set({
          repliesReceived: execution.repliesReceived + 1,
          updatedAt: new Date(),
        })
        .where(eq(sequenceExecutionsTable.id, id));
    }
  },

  /**
   * Record link click
   */
  async recordClick(id: number): Promise<void> {
    const [execution] = await db
      .select()
      .from(sequenceExecutionsTable)
      .where(eq(sequenceExecutionsTable.id, id))
      .limit(1);

    if (execution) {
      await db
        .update(sequenceExecutionsTable)
        .set({
          linksClicked: execution.linksClicked + 1,
          updatedAt: new Date(),
        })
        .where(eq(sequenceExecutionsTable.id, id));
    }
  },
};
