import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { requireBusinessScope } from '../tenancy/businessContext.js';
import { reportingThreadLeadIds } from './threadLeadCohort.js';
import { firstWinCtes } from './insights/FirstWinReporting.js';
import { getEffectiveModuleAccess } from '../models/platformAccess/functions.js';
import type { ThreadReportingSummary } from '../../shared/threadReporting.js';

/** Called after thread authorization. Aggregate the complete cohort separately
 * from bounded previews; no delivery status is treated as a sales conversion. */
/** Whether CRM outcomes may be reported for this account. Resolve it before
 * opening a transaction: the lookup uses its own pooled connections. */
export async function threadReportingCrmEnabled(userId: number): Promise<boolean> {
  return (await getEffectiveModuleAccess(userId)).some(module => module.key === 'crm' && module.enabled);
}

export async function threadReporting(userId: number, threadId: number, executor: Pick<typeof db, 'execute'> = db, crmAccess?: boolean): Promise<ThreadReportingSummary> {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) throw new Error('Thread account does not match active business');
  const crmEnabled = crmAccess ?? await threadReportingCrmEnabled(userId);
  const result = await executor.execute(sql`${firstWinCtes(userId, scope.businessProfileId, crmEnabled)}, cohort AS (
    SELECT l.* FROM leads l WHERE l.user_id=${userId} AND l.business_profile_id=${scope.businessProfileId} AND l.deleted_at IS NULL
      AND l.id IN (${reportingThreadLeadIds(userId, scope.businessProfileId, threadId)})
  ), messages AS (
    SELECT sm.* FROM sent_messages sm JOIN cohort l ON l.id=sm.lead_id
      WHERE sm.user_id=${userId} AND sm.business_profile_id=${scope.businessProfileId} AND sm.is_reply IS NOT TRUE
  ), sent AS (
    -- A provider-rejected send (delivery_status 'failed') never reached the customer.
    SELECT * FROM messages WHERE delivery_status='delivered' OR delivered_at IS NOT NULL
      OR (status IN ('sent','delivered','opened','clicked','replied','read','accepted') AND COALESCE(delivery_status,'')<>'failed')
  ), cohort_contacts AS (
    SELECT DISTINCT r.contact_id FROM resolved_contacts r JOIN scoped_contacts c ON c.id=r.original_id JOIN cohort l ON l.id=c.lead_id
  ) SELECT
    (SELECT count(*)::int FROM cohort) AS leads,
    (SELECT count(*)::int FROM content_assets WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND thread_id=${threadId}) AS content_assets,
    (SELECT count(*)::int FROM messages) AS messages,
    (SELECT count(*)::int FROM sent) AS sent,
    (SELECT count(*)::int FROM messages WHERE status='pending') AS pending,
    (SELECT count(DISTINCT lead_id)::int FROM sent) AS contacted_leads,
    (SELECT count(DISTINCT lead_id)::int FROM sent WHERE reply_received_at IS NOT NULL OR opened_at IS NOT NULL OR open_count>0 OR status IN('opened','read','replied')) AS engaged_leads,
    (SELECT count(*)::int FROM cohort_contacts) AS crm_contacts,
    (SELECT count(*)::int FROM first_wins w JOIN cohort_contacts c ON c.contact_id=w.canonical_contact_id WHERE w.occurred_at<=now()) AS converted_contacts,
    (SELECT COALESCE(jsonb_object_agg(source,total),'{}') FROM (SELECT COALESCE(NULLIF(source,''),'Unknown') source,count(*)::int total FROM cohort GROUP BY 1) counts) AS by_source,
    (SELECT COALESCE(jsonb_object_agg(status,total),'{}') FROM (SELECT COALESCE(NULLIF(lead_status,''),NULLIF(status,''),'Unknown') status,count(*)::int total FROM cohort GROUP BY 1) counts) AS by_status,
    (SELECT COALESCE(jsonb_object_agg(channel,total),'{}') FROM (SELECT channel,count(*)::int total FROM messages GROUP BY 1) counts) AS by_channel,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('name',channel,'outreach',total,'replied',replied) ORDER BY channel),'[]') FROM (
      SELECT channel,count(*)::int total,count(*) FILTER(WHERE reply_received_at IS NOT NULL OR status='replied')::int replied FROM sent GROUP BY channel) counts) AS channels,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('week',week,'outreached',total) ORDER BY week),'[]') FROM (
      SELECT to_char(date_trunc('week',sent_at),'YYYY-MM-DD') week,count(*)::int total FROM sent GROUP BY 1) counts) AS timeline`);
  const row = result.rows[0];
  return { leads: Number(row.leads), contentAssets: Number(row.content_assets), messages: Number(row.messages), sent: Number(row.sent), pending: Number(row.pending),
    contactedLeads: Number(row.contacted_leads), engagedLeads: Number(row.engaged_leads), crmContacts: crmEnabled ? Number(row.crm_contacts) : null, convertedContacts: crmEnabled ? Number(row.converted_contacts) : null,
    bySource: row.by_source as Record<string, number>, byStatus: row.by_status as Record<string, number>, byChannel: row.by_channel as Record<string, number>,
    channels: row.channels as ThreadReportingSummary['channels'], timeline: row.timeline as ThreadReportingSummary['timeline'] };
}
