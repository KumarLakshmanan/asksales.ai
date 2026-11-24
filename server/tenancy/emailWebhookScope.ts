import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { withSystemScope, type BusinessScope } from './businessContext.js';

/** Called only after provider signature verification. A mailbox/domain or an
 * exact delivery receipt must identify one business, even within one account. */
export async function resolveResendBusiness(event: { type?: string; data?: Record<string, unknown> }, recipients: string[]): Promise<BusinessScope | null> {
  return withSystemScope('Resolve verified email event owner', async () => {
    const id = typeof event.data?.email_id === 'string' ? event.data.email_id : '';
    const domainId = typeof event.data?.id === 'string' ? event.data.id : '';
    const emails = recipients.map(value => value.trim().toLowerCase());
    const domains = emails.map(value => value.split('@')[1]).filter(Boolean);
    const result = event.type === 'email.received'
      ? await db.execute(sql`SELECT DISTINCT user_id,business_profile_id FROM (
          SELECT user_id,business_profile_id FROM email_senders WHERE lower(trim(email))=ANY(${emails}::text[]) AND is_verified=TRUE
          UNION ALL SELECT user_id,business_profile_id FROM resend_domains WHERE lower(name)=ANY(${domains}::text[]) AND status='verified'
          UNION ALL SELECT u.id AS user_id,p.id AS business_profile_id FROM users u JOIN company_settings p ON p.user_id=u.id
            WHERE lower(u.email)=ANY(${emails}::text[]) AND p.legacy_webhook_profile=TRUE
        ) owners WHERE business_profile_id IS NOT NULL LIMIT 2`)
      : event.type === 'domain.updated'
        ? await db.execute(sql`SELECT DISTINCT user_id,business_profile_id FROM resend_domains WHERE resend_domain_id=${domainId} AND business_profile_id IS NOT NULL LIMIT 2`)
        : await db.execute(sql`SELECT DISTINCT user_id,business_profile_id FROM (
            SELECT user_id,business_profile_id FROM outreach_messages WHERE provider_message_id=${id} OR external_message_id=${id}
            UNION ALL SELECT user_id,business_profile_id FROM sent_messages WHERE message_id=${id}
            UNION ALL SELECT user_id,business_profile_id FROM support_member_notification_deliveries WHERE provider_message_id=${id}
          ) owners WHERE ${id}<>'' AND business_profile_id IS NOT NULL LIMIT 2`);
    if (result.rows.length===0 && id && event.type!=='email.received') {
      const ready=await db.execute(sql`SELECT to_regclass('crm_automation_run_steps') IS NOT NULL AS ready`);
      if (ready.rows[0]?.ready) {
        const automation=await db.execute(sql`SELECT DISTINCT user_id,business_profile_id FROM crm_automation_run_steps WHERE channel='email' AND provider_message_id=${id} LIMIT 2`);
        if (automation.rows.length===1) return {kind:'business',userId:Number(automation.rows[0].user_id),businessProfileId:Number(automation.rows[0].business_profile_id)};
        // An authenticated early callback may precede the send response. Use only a uniquely owned verified sender domain.
        const from=typeof event.data?.from==='string' ? event.data.from : '';
        const domain=from.match(/@([^\s>]+)/)?.[1]?.toLowerCase() || '';
        const owner=await db.execute(sql`SELECT DISTINCT user_id,business_profile_id FROM resend_domains WHERE lower(name)=${domain} AND status='verified' AND ${domain}<>'' LIMIT 2`);
        if (owner.rows.length===1) return {kind:'business',userId:Number(owner.rows[0].user_id),businessProfileId:Number(owner.rows[0].business_profile_id)};
      }
    }
    if (result.rows.length !== 1) return null;
    return { kind:'business', userId:Number(result.rows[0].user_id), businessProfileId:Number(result.rows[0].business_profile_id) };
  });
}
