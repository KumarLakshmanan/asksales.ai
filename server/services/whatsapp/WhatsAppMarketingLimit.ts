/**
 * Meta holds marketing templates back from people who have had several
 * marketing messages recently (error 131049). Sending them another marketing
 * template soon after usually meets the same limit, so the composer warns
 * before launch. Only the recipients' own recent failures are checked: Meta
 * does not publish the limit itself.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { currentBusinessScope } from '../../tenancy/businessContext.js';
import { templateCategory } from './WhatsAppBillingService.js';

export const MARKETING_LIMIT_WINDOW_HOURS = 24;
export const MAX_MARKETING_LIMIT_LEADS = 5000;

export interface MarketingLimitCheck {
  /** False for utility and authentication templates, which this limit does not apply to. */
  marketing: boolean;
  /** Contacts Meta held a marketing message back from in the last 24 hours, or is holding now. */
  leadIds: number[];
}

export async function recentMarketingLimitLeads(input: {
  userId: number;
  leadIds: number[];
  phoneNumberId?: string;
  templateName?: string;
  templateLanguage?: string;
}): Promise<MarketingLimitCheck> {
  const marketing = (await templateCategory(input.userId, input.templateName, input.templateLanguage)) === 'marketing';
  const leadIds = [...new Set(input.leadIds)].filter(id => Number.isSafeInteger(id) && id > 0).slice(0, MAX_MARKETING_LIMIT_LEADS);
  if (!marketing || !leadIds.length) return { marketing, leadIds: [] };
  const businessProfileId = currentBusinessScope()?.businessProfileId;
  const result = await db.execute(sql`SELECT DISTINCT c.lead_id
    FROM outreach_messages m JOIN outreach_conversations c
      ON c.id = m.conversation_id AND c.user_id = m.user_id
    WHERE m.user_id = ${input.userId}
      AND c.channel = 'whatsapp'
      AND c.lead_id IN (${sql.join(leadIds.map(id => sql`${id}`), sql`, `)})
      AND (${businessProfileId ?? null}::int IS NULL OR c.business_profile_id = ${businessProfileId ?? null})
      AND (${input.phoneNumberId ?? null}::text IS NULL OR c.provider_account_id = ${input.phoneNumberId ?? null})
      AND m.created_at > NOW() - make_interval(days => 30)
      AND (
        (m.status = 'pending'
          AND m.metadata->'outreachQueue'->>'reason' = 'provider_limit'
          AND m.metadata->'outreachQueue'->>'providerCode' = '131049')
        OR EXISTS (SELECT 1 FROM instagram_webhook_events e
          WHERE e.user_id = m.user_id
            AND e.event_type = 'whatsapp_failed'
            AND e.message_id = COALESCE(m.provider_message_id, m.external_message_id, m.waba_message_id)
            AND e.raw_data#>>'{status,errors,0,code}' = '131049'
            AND e.created_at > NOW() - make_interval(hours => ${MARKETING_LIMIT_WINDOW_HOURS})))`);
  return {
    marketing,
    leadIds: (result.rows as Array<{ lead_id: number | string }>).map(row => Number(row.lead_id)).sort((a, b) => a - b),
  };
}
