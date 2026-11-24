/**
 * Message Sequences Model Functions
 */

import { db } from '../db';
import { messageSequencesTable, MessageSequenceRecord, InsertMessageSequence } from './schema';
import { eq, and } from 'drizzle-orm';

export const MessageSequenceModel = {
  /**
   * Create a new message sequence
   */
  async create(data: InsertMessageSequence): Promise<MessageSequenceRecord> {
    const [sequence] = await db
      .insert(messageSequencesTable)
      .values(data)
      .returning();
    
    return sequence;
  },

  /**
   * Find sequence by ID
   */
  async findById(id: number): Promise<MessageSequenceRecord | undefined> {
    const [sequence] = await db
      .select()
      .from(messageSequencesTable)
      .where(eq(messageSequencesTable.id, id))
      .limit(1);
    
    return sequence;
  },

  /**
   * Find sequences by user ID
   */
  async findByUserId(userId: number): Promise<MessageSequenceRecord[]> {
    return db
      .select()
      .from(messageSequencesTable)
      .where(eq(messageSequencesTable.userId, userId));
  },

  /**
   * Find active sequences by user and campaign
   */
  async findActive(userId: number, campaignId?: number): Promise<MessageSequenceRecord[]> {
    const conditions = [
      eq(messageSequencesTable.userId, userId),
      eq(messageSequencesTable.isActive, true),
    ];

    if (campaignId) {
      conditions.push(eq(messageSequencesTable.campaignId, campaignId));
    }

    return db
      .select()
      .from(messageSequencesTable)
      .where(and(...conditions));
  },

  /**
   * Update sequence
   */
  async update(id: number, data: Partial<InsertMessageSequence>): Promise<MessageSequenceRecord | undefined> {
    const [updated] = await db
      .update(messageSequencesTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(messageSequencesTable.id, id))
      .returning();
    
    return updated;
  },

  /**
   * Deactivate sequence
   */
  async deactivate(id: number): Promise<void> {
    await db
      .update(messageSequencesTable)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(messageSequencesTable.id, id));
  },

  /**
   * Delete sequence
   */
  async delete(id: number): Promise<void> {
    await db
      .delete(messageSequencesTable)
      .where(eq(messageSequencesTable.id, id));
  },
};
