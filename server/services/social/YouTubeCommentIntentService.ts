import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { captureOrganicPublishOrigin } from './OrganicPublishAuthority.js';

type ReplyReceipt = { id: string; snippet?: unknown };
type ReplyIntent = { id: string; state: 'dispatching' | 'succeeded' | 'ambiguous' | 'rejected'; request_hash: string; receipt: ReplyReceipt | null; error_message: string | null; error_status: number | null };

/** The unique INSERT is the dispatch fence. No lease or retry reopens it. */
export async function reserveYouTubeCommentIntent(userId: number, credentialId: number, channelId: string, parentId: string, text: string, key: string) {
  const origin = await captureOrganicPublishOrigin(userId);
  const hash = createHash('sha256').update(JSON.stringify({ origin, credentialId, channelId, parentId, text })).digest('hex');
  const claimed = await db.execute(sql`INSERT INTO youtube_comment_intents
    (business_profile_id,user_id,intent_key,request_hash,credential_id,provider_account_id,parent_comment_id,reviewed_text,originating_authority)
    VALUES(${origin.businessProfileId},${userId},${key},${hash},${credentialId},${channelId},${parentId},${text},${JSON.stringify(origin)}::jsonb)
    ON CONFLICT(business_profile_id,user_id,intent_key) DO NOTHING RETURNING id`);
  if (claimed.rows.length) return { created: true as const, id: String(claimed.rows[0].id), origin };
  const existing = await db.execute(sql`SELECT id,state,request_hash,receipt,error_message,error_status FROM youtube_comment_intents
    WHERE business_profile_id=${origin.businessProfileId} AND user_id=${userId} AND intent_key=${key}`);
  const intent = existing.rows[0] as ReplyIntent | undefined;
  return { created: false as const, conflict: !intent || intent.request_hash !== hash, intent, origin };
}

export async function completeYouTubeCommentIntent(id: string, userId: number, businessProfileId: number, receipt: ReplyReceipt) {
  const result = await db.execute(sql`UPDATE youtube_comment_intents
    SET state='succeeded',receipt=${JSON.stringify(receipt)}::jsonb,completed_at=now()
    WHERE id=${id}::bigint AND user_id=${userId} AND business_profile_id=${businessProfileId}
      AND (state='dispatching' OR (state='ambiguous' AND receipt->>'id'=${receipt.id})) RETURNING id`);
  if (!result.rows.length) throw new Error('The reply receipt could not be confirmed.');
}

export async function quarantineYouTubeCommentIntent(id: string, userId: number, businessProfileId: number, message: string, receipt?: ReplyReceipt, rejectedStatus?: number) {
  await db.execute(sql`UPDATE youtube_comment_intents SET state=${rejectedStatus ? 'rejected' : 'ambiguous'},error_message=${message},error_status=${rejectedStatus || null},
      receipt=COALESCE(receipt,${JSON.stringify(receipt || null)}::jsonb),completed_at=now()
    WHERE id=${id}::bigint AND user_id=${userId} AND business_profile_id=${businessProfileId} AND state='dispatching'`);
}
