/**
 * Credits one chat turn used, shown under the reply.
 *
 * Every model call in a turn is billed with the turn's request ID as its
 * operation ID, and each deduction is awaited inside the call, so the total
 * is complete once the turn has returned.
 */
import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger.js';

export async function turnCreditsUsed(userId: number, requestId: string): Promise<number> {
  const { db } = await import('../models/db.js');
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(credits_used), 0)::float AS credits
    FROM credit_event_logs
    WHERE user_id = ${userId}
      AND created_at > NOW() - INTERVAL '2 hours'
      AND metadata->'_insights'->>'operationId' = ${requestId}
  `);
  const credits = Number((result.rows[0] as { credits?: unknown } | undefined)?.credits);
  return Number.isFinite(credits) && credits > 0 ? Math.round(credits * 100) / 100 : 0;
}

interface TurnResult {
  threadId?: number;
  response?: { messageId?: unknown; metadata?: Record<string, unknown> } | null;
}

/** Adds `creditsUsed` to the reply sent back and to the saved message. Never fails the turn. */
export async function attachTurnCredits<T extends TurnResult>(userId: number, requestId: string | undefined, result: T): Promise<T> {
  const response = result?.response;
  const messageId = Number(response?.messageId);
  if (!requestId || !response || !Number.isSafeInteger(messageId) || messageId <= 0 || !result.threadId) return result;
  try {
    const creditsUsed = await turnCreditsUsed(userId, requestId);
    if (!creditsUsed) return result;
    response.metadata = { ...(response.metadata || {}), creditsUsed };
    const { db } = await import('../models/db.js');
    await db.execute(sql`
      UPDATE chat_messages
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('creditsUsed', ${creditsUsed}::float)
      WHERE id = ${messageId} AND thread_id = ${result.threadId} AND user_id = ${userId}
    `);
  } catch (err) {
    logger.warn({ err, requestId }, '[turnCredits] Could not record the credits this reply used');
  }
  return result;
}
