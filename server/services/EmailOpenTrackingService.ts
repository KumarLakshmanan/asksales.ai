import { randomUUID, createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { requireBusinessScope, withSystemScope, withBusinessScope } from '../tenancy/businessContext.js';
import { getOutreachSettingsByUserId } from '../models/outreachSettings/functions.js';
import { absoluteEmailLogo } from '../../shared/emailDesigns.js';

export function appendEmailOpenPixel(html: string, url: string): string {
  const pixel = `<img data-asksales-open-tracker="true" src="${url}" width="1" height="1" alt="" style="width:1px;height:1px;border:0;opacity:0.01" />`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}</body>`) : html + pixel;
}
/** Gmail has no open webhook. A pixel observes image loads, never a guaranteed read. */
export async function prepareEmailOpenTracking(userId: number, html: string, intent?: string, accountId?: string): Promise<{ html: string; trackingId?: string }> {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) throw new Error('Invalid email tracking scope');
  const settings = await getOutreachSettingsByUserId(userId);
  if (settings?.enableTracking === false) return { html };
  if (!accountId?.trim()) throw new Error('An exact sending account is required for email tracking');
  const origin = process.env.CLIENT_URL || process.env.FRONTEND_URL || process.env.APP_URL || 'https://asksales.ai';
  const publicUrl = absoluteEmailLogo('/api/email-events/open/', origin);
  if (!publicUrl) return { html };
  const account = accountId.trim().toLowerCase();
  const key = createHash('sha256').update(`${account}:${intent || randomUUID()}`).digest('hex');
  const result = await db.execute(sql`INSERT INTO email_open_tracking(id,user_id,business_profile_id,intent_key,provider_account_id)
    VALUES(${randomUUID()},${userId},${scope.businessProfileId},${key},${account})
    ON CONFLICT(business_profile_id,user_id,intent_key) DO UPDATE SET intent_key=EXCLUDED.intent_key RETURNING id`);
  const id = String(result.rows[0].id);
  return { html: appendEmailOpenPixel(html, `${publicUrl}${id}.gif`), trackingId: id };
}
export async function confirmEmailOpenTracking(id: string, providerMessageId: string, rfcMessageId?: string) {
  const scope = requireBusinessScope();
  await db.execute(sql`UPDATE email_open_tracking SET accepted_at=COALESCE(accepted_at,now()),provider_message_id=${providerMessageId},rfc_message_id=${rfcMessageId || null}
    WHERE id=${id} AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}`);
}
export async function recordEmailImageLoad(id: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return;
  // The only public lookup is an unguessable token; no recipient or email body is returned.
  const result = await withSystemScope('Resolve opaque email image-load receipt', () => db.execute(sql`
    SELECT user_id,business_profile_id FROM email_open_tracking WHERE id=${id}
      AND accepted_at IS NOT NULL AND created_at>now()-interval '180 days' LIMIT 1`));
  const row = result.rows[0];
  if (!row) return;
  await withBusinessScope({ userId: Number(row.user_id), businessProfileId: Number(row.business_profile_id) }, () => db.execute(sql`
    UPDATE email_open_tracking SET opened_at=COALESCE(opened_at,now()),last_opened_at=now(),open_count=LEAST(open_count+1,10000)
    WHERE id=${id} AND accepted_at IS NOT NULL AND (last_opened_at IS NULL OR last_opened_at<now()-interval '10 minutes')`));
}
export async function attachEmailOpenTracking<T extends { id: number; externalMessageId: string | null; rfcMessageId?: string | null; providerMessageId?: string | null }>(messages: T[]): Promise<T[]> {
  const scope = requireBusinessScope();
  const ids = messages.map(message => message.id);
  if (!ids.length) return messages;
  const list = sql.join(ids.map(id => sql`${id}`), sql`, `);
  const result = await db.execute(sql`SELECT m.id AS message_id,t.opened_at,t.open_count FROM email_open_tracking t
    JOIN outreach_messages m ON m.user_id=t.user_id AND m.business_profile_id=t.business_profile_id
      AND (t.provider_message_id=m.provider_message_id OR t.provider_message_id=m.external_message_id OR t.rfc_message_id=m.rfc_message_id)
    JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id AND c.business_profile_id=m.business_profile_id
      AND lower(COALESCE(NULLIF(m.provider_account_id,''),c.provider_account_id))=t.provider_account_id
    WHERE t.user_id=${scope.userId} AND t.business_profile_id=${scope.businessProfileId} AND t.accepted_at IS NOT NULL
      AND m.direction='outbound' AND c.channel IN ('email','gmail') AND m.id IN (${list})`);
  return messages.map(message => {
    const row = result.rows.find((receipt: Record<string, unknown>) => Number(receipt.message_id) === message.id);
    return row ? { ...message, emailTracking: { source: 'image_load', openedAt: row.opened_at, openCount: Number(row.open_count), enabled: true } } : message;
  });
}
