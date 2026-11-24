/**
 * Conversation Threads Model Functions
 */

import { db } from '../db';
import { conversationThreadsTable, ConversationThreadRecord, InsertConversationThread } from './schema';
import { eq, and } from 'drizzle-orm';

export const ConversationThreadModel = {
  /**
   * Create a new conversation thread
   */
  async create(data: InsertConversationThread): Promise<ConversationThreadRecord> {
    const [thread] = await db
      .insert(conversationThreadsTable)
      .values(data)
      .returning();
    
    return thread;
  },

  /**
   * Find thread by ID
   */
  async findById(id: number): Promise<ConversationThreadRecord | undefined> {
    const [thread] = await db
      .select()
      .from(conversationThreadsTable)
      .where(eq(conversationThreadsTable.id, id))
      .limit(1);
    
    return thread;
  },

  /**
   * Find thread by lead and channel
   */
  async findByLeadAndChannel(
    leadId: number,
    channel: string
  ): Promise<ConversationThreadRecord | undefined> {
    const [thread] = await db
      .select()
      .from(conversationThreadsTable)
      .where(
        and(
          eq(conversationThreadsTable.leadId, leadId),
          eq(conversationThreadsTable.channel, channel)
        )
      )
      .limit(1);
    
    return thread;
  },

  /**
   * Find or create thread by lead and channel
   */
  async findOrCreate(
    leadId: number,
    userId: number,
    channel: string
  ): Promise<ConversationThreadRecord> {
    const existing = await this.findByLeadAndChannel(leadId, channel);
    
    if (existing) {
      return existing;
    }

    return this.create({
      leadId,
      userId,
      channel,
    });
  },

  /**
   * Find all threads for a lead
   */
  async findByLead(leadId: number): Promise<ConversationThreadRecord[]> {
    return db
      .select()
      .from(conversationThreadsTable)
      .where(eq(conversationThreadsTable.leadId, leadId));
  },

  /**
   * Update thread
   */
  async update(id: number, data: Partial<InsertConversationThread>): Promise<ConversationThreadRecord | undefined> {
    const [updated] = await db
      .update(conversationThreadsTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(conversationThreadsTable.id, id))
      .returning();
    
    return updated;
  },

  /**
   * Record new message in thread
   */
  async recordMessage(
    id: number,
    direction: 'inbound' | 'outbound'
  ): Promise<void> {
    const [thread] = await db
      .select()
      .from(conversationThreadsTable)
      .where(eq(conversationThreadsTable.id, id))
      .limit(1);

    if (thread) {
      await db
        .update(conversationThreadsTable)
        .set({
          messageCount: thread.messageCount + 1,
          lastMessageAt: new Date(),
          metadata: {
            ...thread.metadata,
            lastMessageDirection: direction,
          },
          updatedAt: new Date(),
        })
        .where(eq(conversationThreadsTable.id, id));
    }
  },

  /**
   * Archive thread
   */
  async archive(id: number): Promise<void> {
    await db
      .update(conversationThreadsTable)
      .set({
        status: 'archived',
        updatedAt: new Date(),
      })
      .where(eq(conversationThreadsTable.id, id));
  },

  /**
   * Mark as spam
   */
  async markSpam(id: number): Promise<void> {
    await db
      .update(conversationThreadsTable)
      .set({
        status: 'spam',
        updatedAt: new Date(),
      })
      .where(eq(conversationThreadsTable.id, id));
  },

  /**
   * Unsubscribe thread
   */
  async unsubscribe(id: number): Promise<void> {
    await db
      .update(conversationThreadsTable)
      .set({
        status: 'unsubscribed',
        updatedAt: new Date(),
      })
      .where(eq(conversationThreadsTable.id, id));
  },
};
