import { db } from "../db";
import { sentMessagesTable, type SentMessageRecord, type InsertSentMessage } from "./schema";
import { leadsTable } from "../leads/schema";
import { readFollowUpActivity } from '../../services/outreach/FollowUpHistoryService.js';
import { isFollowUpChannel } from '../../../shared/followUpChannels.js';
import type { FollowUpActivity } from '../../../shared/followUpActivity.js';
import { and, desc, eq, gte, sql } from "drizzle-orm";

export class SentMessageModel {
  static async findAllByUser(userId: number, since?: Date): Promise<SentMessageRecord[]> {
    const conditions = [eq(sentMessagesTable.userId, userId)];
    if (since) conditions.push(gte(sentMessagesTable.sentAt, since));
    return await db.select().from(sentMessagesTable).where(and(...conditions));
  }

  static async findRecentByUser(userId: number, limit = 50, offset = 0): Promise<SentMessageRecord[]> {
    return db.select().from(sentMessagesTable)
      .where(eq(sentMessagesTable.userId, userId))
      .orderBy(desc(sentMessagesTable.sentAt))
      .limit(Math.min(Math.max(limit, 1), 100))
      .offset(Math.max(offset, 0));
  }

  static async findRecentFollowUpsByUser(userId: number, channel: string, limit = 20, offset = 0): Promise<FollowUpActivity[]> {
    if (!isFollowUpChannel(channel)) return [];
    return readFollowUpActivity(userId, channel, limit, offset);
  }

  static async findById(id: number): Promise<SentMessageRecord | undefined> {
    const result = await db.select().from(sentMessagesTable).where(eq(sentMessagesTable.id, id)).limit(1);
    return result[0];
  }

  static async findByProviderMessageId(
    userId: number,
    messageId: string,
  ): Promise<SentMessageRecord | undefined> {
    const result = await db.select().from(sentMessagesTable).where(and(
      eq(sentMessagesTable.userId, userId),
      eq(sentMessagesTable.messageId, messageId),
    )).limit(1);
    return result[0];
  }

  static async findByLeadId(leadId: number, userId: number, limit = 200): Promise<SentMessageRecord[]> {
    return await db.select().from(sentMessagesTable).where(and(
      eq(sentMessagesTable.leadId, leadId),
      eq(sentMessagesTable.userId, userId),
    )).orderBy(desc(sentMessagesTable.sentAt)).limit(Math.min(Math.max(limit, 1), 200));
  }

  static async create(
    data: InsertSentMessage,
    options: { skipCreditDeduction?: boolean } = {},
  ): Promise<SentMessageRecord> {
    const result = await db.insert(sentMessagesTable).values(data).returning();
    const message = result[0];

    // Deduct credits for outreach message (non-blocking)
    if (data.userId && data.channel && data.status === 'sent' && !options.skipCreditDeduction) {
      try {
        const { deductCreditsForOutreach } = await import('../../services/CreditDeductionHooks.js');
        await deductCreditsForOutreach(data.userId, data.channel, {
          messageId: message.id?.toString(),
          service: 'SentMessageModel',
        });
      } catch (_err) {
        // Credit deduction failure should not break message sending
      }
    }

    if (data.userId && data.leadId && data.channel === 'sms' && data.status === 'sent') {
      await db.update(leadsTable).set({
        smsSent: sql`COALESCE(${leadsTable.smsSent}, 0) + 1`,
        lastContactedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(leadsTable.id, data.leadId),
        eq(leadsTable.userId, data.userId),
      ));

      import('../../services/CRMService').then(({ crmService }) =>
        crmService.autoCreateContactOnOutreachSend(data.userId!, data.leadId, { source: 'sms' })
      ).catch(() => {});
    }

    return message;
  }

  static async update(id: number, data: Partial<InsertSentMessage>): Promise<SentMessageRecord | undefined> {
    const result = await db.update(sentMessagesTable).set(data).where(eq(sentMessagesTable.id, id)).returning();
    return result[0];
  }

  static async delete(id: number): Promise<void> {
    await db.delete(sentMessagesTable).where(eq(sentMessagesTable.id, id));
  }
}
