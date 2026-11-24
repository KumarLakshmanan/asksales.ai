/**
 * Instagram Webhook Events Model
 */

import { db } from "../db";
import { instagramWebhookEventsTable, type InstagramWebhookEvent, type NewInstagramWebhookEvent } from "./schema";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { eq, desc, and, sql } from "drizzle-orm";

export const InstagramWebhookEventModel = {
  async create(data: NewInstagramWebhookEvent): Promise<InstagramWebhookEvent> {
    const [event] = await db
      .insert(instagramWebhookEventsTable)
      .values(data)
      .returning();
    return event;
  },

  async findById(id: number): Promise<InstagramWebhookEvent | null> {
    const [event] = await db
      .select()
      .from(instagramWebhookEventsTable)
      .where(eq(instagramWebhookEventsTable.id, id))
      .limit(1);
    return event || null;
  },

  async findByEventType(eventType: string, limit = 50): Promise<InstagramWebhookEvent[]> {
    return db
      .select()
      .from(instagramWebhookEventsTable)
      .where(eq(instagramWebhookEventsTable.eventType, eventType))
      .orderBy(desc(instagramWebhookEventsTable.timestamp))
      .limit(limit);
  },

  async findUnprocessed(limit = 50): Promise<InstagramWebhookEvent[]> {
    return db
      .select()
      .from(instagramWebhookEventsTable)
      .where(eq(instagramWebhookEventsTable.isProcessed, false))
      .orderBy(desc(instagramWebhookEventsTable.timestamp))
      .limit(limit);
  },

  async markAsProcessed(id: number, aiReplyText?: string): Promise<void> {
    await db
      .update(instagramWebhookEventsTable)
      .set({
        isProcessed: true,
        aiReplyGenerated: !!aiReplyText,
        aiReplyText: aiReplyText || null,
      })
      .where(eq(instagramWebhookEventsTable.id, id));
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getStats(days = 7): Promise<any[]> {
    const result = await db.execute(sql`
      SELECT 
        event_type,
        COUNT(*) as count,
        MAX(timestamp) as last_received
      FROM instagram_webhook_events
      WHERE timestamp > NOW() - INTERVAL '${days} days'
      GROUP BY event_type
      ORDER BY count DESC
    `);
    return result.rows;
  },

  async getRecent(limit = 100): Promise<InstagramWebhookEvent[]> {
    return db
      .select()
      .from(instagramWebhookEventsTable)
      .orderBy(desc(instagramWebhookEventsTable.timestamp))
      .limit(limit);
  },
};

export { instagramWebhookEventsTable, type InstagramWebhookEvent, type NewInstagramWebhookEvent };
