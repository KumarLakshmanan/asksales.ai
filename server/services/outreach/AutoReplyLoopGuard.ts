import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';

/**
 * Stops the assistant and another automated sender (an autoresponder, a
 * ticketing bot) from replying to each other forever.
 *
 * A person takes minutes to answer; an autoresponder answers within seconds.
 * So a thread is a loop when, inside `windowMinutes`, the other side has twice
 * answered one of our automatic replies within `botReplySeconds`, and no person
 * on our side has written in between. The caller keeps the next reply as a
 * draft. A customer who simply sends several messages is never held.
 */
export const AUTO_REPLY_LOOP_LIMIT = { botTurns: 2, botReplySeconds: 120, windowMinutes: 30 } as const;

export type LoopMessage = { direction: 'inbound' | 'outbound' | string; isAiGenerated: boolean; at: Date | string | null };

export function isAutoReplyLoop(
  recent: LoopMessage[],
  now: Date = new Date(),
  limit: { botTurns: number; botReplySeconds: number; windowMinutes: number } = AUTO_REPLY_LOOP_LIMIT,
): boolean {
  const since = now.getTime() - limit.windowMinutes * 60_000;
  const messages = recent
    .filter((message) => message.at)
    .map((message) => ({ ...message, time: new Date(message.at as string | Date).getTime() }))
    .filter((message) => message.time >= since)
    .sort((a, b) => a.time - b.time);
  let botTurns = 0;
  for (let index = 1; index < messages.length; index++) {
    const previous = messages[index - 1], message = messages[index];
    // A person on our side wrote, so they are already watching this thread.
    if (message.direction === 'outbound' && !message.isAiGenerated) botTurns = 0;
    if (message.direction === 'inbound' && previous.direction === 'outbound' && previous.isAiGenerated
      && message.time - previous.time <= limit.botReplySeconds * 1000) botTurns += 1;
  }
  return botTurns >= limit.botTurns;
}

export async function autoReplyLoopDetected(userId: number, conversationId: number, now: Date = new Date()): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT direction, COALESCE(is_ai_generated,false) AS "isAiGenerated",
           to_char(COALESCE(sent_at,created_at),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "at"
      FROM outreach_messages
     WHERE conversation_id=${conversationId} AND user_id=${userId}
       AND (direction='inbound' OR (sent_at IS NOT NULL AND status IN ('sent','delivered','read')))
     ORDER BY COALESCE(sent_at,created_at) DESC
     LIMIT 20`);
  return isAutoReplyLoop((result?.rows ?? []) as LoopMessage[], now);
}
