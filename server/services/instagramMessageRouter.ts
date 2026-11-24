/**
 * Instagram Message Router
 * 
 * Centralized routing logic for all outbound Instagram messages.
 * Uses the official Graph API for eligible outreach.
 * 
 * Also enforces daily rate limits via Redis and delays BullMQ jobs
 * that exceed the limit instead of dropping them.
 */

import { db } from '../models/db.js';
import { eq, and, sql } from 'drizzle-orm';
import { outreachConversationsTable } from '../models/outreachConversations/schema.js';
import { getRedisConnection } from '../infrastructure/redis.js';
import { type InstagramDMResult } from './instagramService.js';
import { logger } from '../utils/logger.js';
import { assertCustomerDeliveryRuntime, deliverySetupFailure } from './assistants/CustomerDeliveryGate.js';
import { resolveInstagramAccountContext } from './instagramAccountSelectionService.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RoutedMessageOptions {
  providerAccountId?: string;
  conversationId?: number;
  userId: number;
  leadId: number;
  recipientUsername: string;
  message: string;
  /** If true, this is a welcome message for a new follower. */
  isWelcomeMessage?: boolean;
  /** If true, this is a follow-up in an existing sequence */
  isFollowUp?: boolean;
  /** The caller has already atomically reserved this message's outreach credit. */
  skipCreditDeduction?: boolean;
}

export interface RoutedMessageResult extends InstagramDMResult {
  method: 'graph_api' | 'delayed';
}

// ─── Rate Limiting ───────────────────────────────────────────────────────────

/**
 * Get the Redis key for tracking daily outreach count per user (H5: scoped per pageId when known).
 * Key expires at midnight UTC.
 */
function getDailyCounterKey(userId: number, pageId?: string): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return pageId
    ? `instagram:daily_outreach:${userId}:${pageId}:${today}`
    : `instagram:daily_outreach:${userId}:${today}`;
}

/**
 * Check how many outreach messages have been sent today by this user (per pageId when supplied).
 */
async function getDailySentCount(userId: number, pageId?: string): Promise<number> {
  try {
    const redis = getRedisConnection();
    const count = await redis.get(getDailyCounterKey(userId, pageId));
    return count ? parseInt(count, 10) : 0;
  } catch {
    // If Redis is down, fall back to DB count
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const result = await db.execute(
      sql`SELECT COUNT(*)::int as cnt FROM sent_messages
          WHERE user_id = ${userId}
          AND channel = 'instagram'
          AND sent_at >= ${todayStart.toISOString()}`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (result.rows[0] as any)?.cnt || 0;
  }
}

/**
 * Increment the daily sent counter in Redis.
 */
async function incrementDailyCount(userId: number, pageId?: string): Promise<void> {
  try {
    const redis = getRedisConnection();
    const key = getDailyCounterKey(userId, pageId);
    await redis.incr(key);
    // Set TTL to 25 hours so the key auto-expires
    await redis.expire(key, 90000);
  } catch (err) {
    logger.warn({ err }, '[InstagramRouter] Failed to increment Redis counter, continuing');
  }
}

// ─── Conversation State Detection ────────────────────────────────────────────

/**
 * Check if the recipient has previously replied (i.e., an open conversation exists).
 * This is used to avoid applying the cold-outreach daily limit to replies.
 */
async function hasRecipientReplied(userId: number, leadId: number, providerAccountId?: string): Promise<boolean> {
  try {
    const conversations = await db.select()
      .from(outreachConversationsTable)
      .where(and(
        eq(outreachConversationsTable.userId, userId),
        eq(outreachConversationsTable.leadId, leadId),
        eq(outreachConversationsTable.channel, 'instagram'),
        ...(providerAccountId ? [eq(outreachConversationsTable.providerAccountId, providerAccountId)] : []),
      ))
      .limit(1);

    if (conversations.length === 0) return false;

    const conv = conversations[0];
    // If the status is 'replied' or the last message was from the lead, conversation is open
    return conv.status === 'replied' || conv.lastMessageBy === 'lead';
  } catch (err) {
    logger.warn({ err, userId, leadId }, '[InstagramRouter] Error checking conversation state');
    return false;
  }
}

// ─── Settings Retrieval ──────────────────────────────────────────────────────

/** Get the selected official account's daily limit and Page ID. */
async function getUserInstagramSettings(userId: number, providerAccountId?: string): Promise<{
  dailyOutreachLimit: number;
  pageId?: string;
}> {
  try {
    const context = await resolveInstagramAccountContext(userId, providerAccountId ? { accountIdentifier: providerAccountId } : {});
    const settings = context?.credential.sessionData as { dailyOutreachLimit?: number; pageId?: string } | null;
    const configuredLimit = Number(settings?.dailyOutreachLimit);
    return {
      dailyOutreachLimit: Number.isInteger(configuredLimit) && configuredLimit >= 0 ? Math.min(configuredLimit, 20) : 20,
      pageId: settings?.pageId,
    };
  } catch (err) {
    logger.warn({ err }, '[InstagramRouter] Error fetching settings, using defaults');
    return { dailyOutreachLimit: 20 };
  }
}

// ─── Core Router ─────────────────────────────────────────────────────────────

/** Send an Instagram message through the selected official Meta account. */
export async function routeInstagramMessage(options: RoutedMessageOptions): Promise<RoutedMessageResult> {
  const { userId, leadId, recipientUsername, message, isWelcomeMessage, skipCreditDeduction } = options;
  let providerAccountId: string;
  try {
    assertCustomerDeliveryRuntime('instagram');
    const { resolveMetaSendAccount } = await import('./outreach/MetaSendAccount.js');
    providerAccountId = await resolveMetaSendAccount(userId, 'instagram', options);
  } catch (error) {
    const setupFailure = deliverySetupFailure(error);
    if (setupFailure) return { ...setupFailure, username: recipientUsername, method: 'graph_api', outcomeUnknown: false };
    return {
      success: false,
      username: recipientUsername,
      error: error instanceof Error ? error.message : 'Instagram account selection is required.',
      method: 'graph_api',
    };
  }

  const replied = !isWelcomeMessage && await hasRecipientReplied(userId, leadId, providerAccountId);
  const settings = await getUserInstagramSettings(userId, providerAccountId);
  if (!replied && await getDailySentCount(userId, settings.pageId) >= settings.dailyOutreachLimit) {
    return { success: false, username: recipientUsername, error: 'DAILY_LIMIT_REACHED', method: 'delayed' };
  }

  const { sendInstagramDM } = await import('./instagramService.js');
  const result = await sendInstagramDM({
    userId,
    recipientId: recipientUsername,
    message,
    providerAccountId,
    conversationId: options.conversationId,
    skipCreditDeduction,
  });
  if (result.success && !replied) await incrementDailyCount(userId, settings.pageId);
  return {
    ...result,
    success: result.success,
    username: recipientUsername,
    messageId: result.externalMessageId,
    error: result.error,
    method: 'graph_api',
  };
}

/**
 * Calculate how many milliseconds until the next day's window opens (midnight UTC).
 * Used by callers to delay BullMQ jobs when the daily limit is reached.
 */
export function getDelayUntilTomorrow(): number {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.getTime() - now.getTime();
}

export default {
  routeInstagramMessage,
  getDelayUntilTomorrow,
  getDailySentCount,
  getUserInstagramSettings,
};
