import { sql, type SQL } from 'drizzle-orm';
import { db } from '../models/db.js';
import { currentDatabaseScope, requireBusinessScope } from '../tenancy/businessContext.js';
import { firstWinCtes } from './insights/FirstWinReporting.js';

export type LegacyAnalyticsScope = { kind: 'platform' } | { kind: 'business'; userId: number; businessProfileId: number; campaignId: number };
type Executor = Pick<typeof db, 'execute'>;
export class LegacyAnalyticsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function assertScope(scope: LegacyAnalyticsScope) {
  if (scope.kind === 'platform') {
    if (currentDatabaseScope()?.kind !== 'system') throw new LegacyAnalyticsError(403, 'Administrative database scope required');
  } else {
    const active = requireBusinessScope();
    if (active.userId !== scope.userId || active.businessProfileId !== scope.businessProfileId) throw new LegacyAnalyticsError(403, 'Campaign does not match the active business');
    if (!Number.isSafeInteger(scope.campaignId) || scope.campaignId < 1 || scope.campaignId > 2147483647) throw new LegacyAnalyticsError(400, 'Invalid campaign ID');
  }
}
const owner = (scope: LegacyAnalyticsScope, alias: string): SQL => scope.kind === 'platform' ? sql`true`
  : sql`${sql.identifier(alias)}.user_id=${scope.userId} AND ${sql.identifier(alias)}.business_profile_id=${scope.businessProfileId}`;

async function context(scope: LegacyAnalyticsScope) {
  assertScope(scope);
  const crmEnabled = scope.kind === 'platform' || (await (await import('../models/platformAccess/functions.js')).getEffectiveModuleAccess(scope.userId)).some(module => module.key === 'crm' && module.enabled);
  const ctes = sql`${firstWinCtes(scope.kind === 'platform' ? null : scope.userId, scope.kind === 'platform' ? null : scope.businessProfileId, crmEnabled)},
    scoped_campaigns AS (SELECT c.* FROM campaigns c WHERE ${owner(scope, 'c')} ${scope.kind === 'business' ? sql`AND c.id=${scope.campaignId}` : sql``}),
    cohort AS (SELECT l.* FROM leads l WHERE ${owner(scope, 'l')} AND l.deleted_at IS NULL
      ${scope.kind === 'business' ? sql`AND l.campaign_data->>'campaignId'=${String(scope.campaignId)}` : sql``}),
    receipts AS (SELECT sm.* FROM sent_messages sm JOIN cohort l ON l.id=sm.lead_id AND l.user_id=sm.user_id AND l.business_profile_id=sm.business_profile_id
      WHERE sm.is_reply IS NOT TRUE AND (sm.delivery_status='delivered' OR sm.delivered_at IS NOT NULL
        OR (sm.status IN('sent','delivered','opened','clicked','replied','read','accepted') AND COALESCE(sm.delivery_status,'')<>'failed'))),
    cohort_contacts AS (SELECT DISTINCT r.contact_id,r.user_id,r.business_profile_id FROM resolved_contacts r JOIN scoped_contacts c ON c.id=r.original_id
      AND c.user_id=r.user_id AND c.business_profile_id=r.business_profile_id JOIN cohort l ON l.id=c.lead_id AND l.user_id=c.user_id AND l.business_profile_id=c.business_profile_id),
    cohort_wins AS (SELECT w.* FROM first_wins w JOIN cohort_contacts c ON c.contact_id=w.canonical_contact_id AND c.user_id=w.user_id AND c.business_profile_id=w.business_profile_id WHERE w.occurred_at<=now())`;
  return { crmEnabled, ctes };
}

export async function assertLegacyCampaignExists(scope: LegacyAnalyticsScope, executor: Executor = db) {
  assertScope(scope);
  if (scope.kind === 'platform') return;
  const result = await executor.execute(sql`SELECT c.id FROM campaigns c WHERE ${owner(scope, 'c')} AND c.id=${scope.campaignId} LIMIT 1`);
  if (!result.rows.length) throw new LegacyAnalyticsError(404, 'Campaign not found');
}

export async function readLegacyCampaignAnalytics(scope: LegacyAnalyticsScope, executor: Executor = db) {
  const { crmEnabled, ctes } = await context(scope);
  const result = await executor.execute(sql`${ctes}, channel_receipts AS (
      SELECT CASE WHEN channel IN('gmail','resend') THEN 'email' ELSE channel END channel,count(*)::int sent,
        count(*) FILTER(WHERE reply_received_at IS NOT NULL OR status='replied')::int replied FROM receipts GROUP BY 1
    ), channel_wins AS (SELECT CASE WHEN channel IN('gmail','resend') THEN 'email' ELSE channel END channel,count(*)::int wins FROM cohort_wins GROUP BY 1)
    SELECT
      (SELECT count(*)::int FROM scoped_campaigns) AS campaign_count,
      (SELECT count(*) FILTER(WHERE status='active')::int FROM scoped_campaigns) AS active_campaigns,
      (SELECT count(*) FILTER(WHERE status='completed')::int FROM scoped_campaigns) AS completed_campaigns,
      (SELECT COALESCE(sum(spent),0) FROM scoped_campaigns) AS spend_units,
      (SELECT row_to_json(c) FROM scoped_campaigns c ORDER BY c.id LIMIT 1) AS campaign,
      (SELECT count(*)::int FROM cohort) AS leads,
      (SELECT count(*) FILTER(WHERE email_status='valid' OR NULLIF(trim(phone),'') IS NOT NULL)::int FROM cohort) AS enriched,
      (SELECT count(DISTINCT lead_id)::int FROM receipts) AS contacted,
      (SELECT count(DISTINCT lead_id)::int FROM receipts WHERE opened_at IS NOT NULL OR open_count>0 OR reply_received_at IS NOT NULL OR status IN('opened','read','replied')) AS engaged,
      (SELECT count(*)::int FROM cohort_contacts) AS crm_contacts,
      (SELECT count(*)::int FROM cohort_wins) AS wins,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('channel',COALESCE(r.channel,w.channel),'outreached',COALESCE(r.sent,0),'sent',COALESCE(r.sent,0),'replied',COALESCE(r.replied,0),'conversions',COALESCE(w.wins,0)) ORDER BY COALESCE(r.channel,w.channel)),'[]')
        FROM channel_receipts r FULL JOIN channel_wins w ON w.channel=r.channel) AS channels,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('source',source,'count',total,'qualityScore',round(score/10)) ORDER BY total DESC,source),'[]') FROM (
        SELECT COALESCE(NULLIF(source,''),'Unknown') source,count(*)::int total,COALESCE(avg(fit_score),0) score FROM cohort GROUP BY 1) counts) AS sources,
      (SELECT COALESCE(sum(COALESCE(linkedin_follower_count,0)+COALESCE(twitter_followers,0)),0) FROM cohort) AS followers,
      (SELECT count(*) FILTER(WHERE linkedin IS NOT NULL)::int FROM cohort) AS linkedin_profiles,
      (SELECT count(*) FILTER(WHERE twitter IS NOT NULL)::int FROM cohort) AS twitter_profiles,
      (SELECT count(*)::int FROM receipts WHERE channel IN('email','gmail','resend')) AS emails_sent,
      (SELECT count(*) FILTER(WHERE opened_at IS NOT NULL OR open_count>0 OR status='opened')::int FROM receipts WHERE channel IN('email','gmail','resend')) AS emails_opened,
      (SELECT count(*) FILTER(WHERE clicked_at IS NOT NULL OR click_count>0 OR status='clicked')::int FROM receipts WHERE channel IN('email','gmail','resend')) AS emails_clicked,
      (SELECT count(*) FILTER(WHERE reply_received_at IS NOT NULL OR status='replied')::int FROM receipts WHERE channel IN('email','gmail','resend')) AS emails_replied`);
  const row = result.rows[0];
  if (scope.kind === 'business' && Number(row.campaign_count) === 0) throw new LegacyAnalyticsError(404, 'Campaign not found');
  const leads = Number(row.leads), contacted = Number(row.contacted), enriched = Number(row.enriched), engaged = Number(row.engaged), emailSent = Number(row.emails_sent);
  const percent = (amount: number, total: number) => total > 0 ? Math.round(1000 * amount / total) / 10 : null;
  type Channel = { channel: string; sent: number; outreached: number; replied: number; conversions: number | null };
  return {
    reporting: { scope: scope.kind, campaignId: scope.kind === 'business' ? scope.campaignId : null, campaignDomain: 'legacy_campaigns', cohortLink: 'leads.campaignData.campaignId',
      messageBasis: 'recorded_outbound_receipts_to_linked_leads', campaignAttribution: false, conversionBasis: 'first_lifetime_win_per_canonical_linked_crm_contact',
      conversionCoverage: crmEnabled ? 'recorded_events_only' : 'restricted', historicalWinTimesInferred: false, spendCurrency: null },
    roi: null, roiChange: null, totalSpend: null, rawSpendUnits: Number(row.spend_units), totalRevenue: null,
    leadsGenerated: leads, enrichmentRate: percent(enriched, leads), outreachRate: percent(contacted, leads), totalOutreached: contacted,
    activeCampaigns: Number(row.active_campaigns), completedCampaigns: Number(row.completed_campaigns),
    channelData: (row.channels as Channel[]).map(channel => ({ ...channel, conversions: crmEnabled ? Number(channel.conversions) : null })),
    funnelData: { leadsFound: { value: leads, percentage: leads ? 100 : null }, enriched: { value: enriched, percentage: percent(enriched, leads) }, outreached: { value: contacted, percentage: percent(contacted, leads) }, engaged: { value: engaged, percentage: percent(engaged, leads) } },
    leadSources: row.sources as Array<{ source: string; count: number; qualityScore: number }>,
    socialMedia: { totalFollowers: Number(row.followers), totalReach: null, engagementRate: null, linkedinProfiles: Number(row.linkedin_profiles), twitterProfiles: Number(row.twitter_profiles) },
    sentiment: { positive: null, neutral: null, negative: null },
    emailPerformance: { openRate: percent(Number(row.emails_opened), emailSent), clickRate: percent(Number(row.emails_clicked), emailSent), replyRate: percent(Number(row.emails_replied), emailSent), totalSent: emailSent },
    revenue: { totalRevenue: null, pipelineValue: null, overallROI: null, convertedLeads: crmEnabled ? Number(row.wins) : null, linkedCrmContacts: crmEnabled ? Number(row.crm_contacts) : null,
      recordedWinRate: crmEnabled ? percent(Number(row.wins), Number(row.crm_contacts)) : null },
    campaign: scope.kind === 'business' ? row.campaign as { id: number; name: string; status: string; budget: number; spent: number; start_date: string; end_date: string | null; created_at: string } : null,
  };
}

export async function readLegacyCampaignTrends(scope: LegacyAnalyticsScope, start: Date, executor: Executor = db) {
  await assertLegacyCampaignExists(scope, executor);
  const { crmEnabled, ctes } = await context(scope);
  const result = await executor.execute(sql`${ctes}, daily AS (
    SELECT created_at::date AS day,count(*)::int leads,0::int contacted,0::int wins FROM cohort
      WHERE created_at>=${start.toISOString()}::timestamptz AT TIME ZONE 'UTC' AND created_at<=now() AT TIME ZONE 'UTC' GROUP BY 1
    UNION ALL SELECT sent_at::date,0,count(DISTINCT lead_id)::int,0 FROM receipts
      WHERE sent_at>=${start.toISOString()}::timestamptz AT TIME ZONE 'UTC' AND sent_at<=now() AT TIME ZONE 'UTC' GROUP BY 1
    UNION ALL SELECT (occurred_at AT TIME ZONE 'UTC')::date,0,0,count(*)::int FROM cohort_wins WHERE occurred_at>=${start.toISOString()}::timestamptz GROUP BY 1
  ) SELECT day::text date,sum(leads)::int AS leads_created,sum(contacted)::int AS leads_contacted,sum(wins)::int AS recorded_wins FROM daily GROUP BY day ORDER BY day`);
  return result.rows.map((row: Record<string, unknown>) => ({ date: String(row.date), leadsCreated: Number(row.leads_created), leadsContacted: Number(row.leads_contacted),
    leadsEnriched: null, recordedWins: crmEnabled ? Number(row.recorded_wins) : null, basis: 'recorded_event_dates_utc' }));
}
