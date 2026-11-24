import { firstWinCtes } from './insights/FirstWinReporting.js';
import { getEffectiveModuleAccess } from '../models/platformAccess/functions.js';
import { dashboardUtcWeekStart } from '../../shared/dashboardReporting.js';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { requireBusinessScope } from '../tenancy/businessContext.js';
import type { DashboardReporting } from '../../shared/dashboardReporting.js';

/** Bounded result sets aggregated in SQL, with explicit owner/business predicates
 * in addition to the runtime RLS adapter. These use the dashboard's existing
 * sent_messages evidence; they do not claim complete provider attribution. */
export async function dashboardReporting(userId: number, now = new Date(), executor: Pick<typeof db, 'execute'> = db, crmAccess?: boolean): Promise<DashboardReporting> {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) throw new Error('Dashboard account does not match the active business');
  // Callers inside a transaction pass the access they already resolved: the
  // lookup uses its own pooled connections.
  const crmEnabled = crmAccess ?? (await getEffectiveModuleAccess(userId)).some(module => module.key === 'crm' && module.enabled);
  const end = new Date(now); end.setUTCHours(0, 0, 0, 0); end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end.getTime() - 7 * 86400000);
  // A provider-rejected send (delivery_status 'failed', e.g. a WhatsApp 131049) was never sent to the customer.
  const evidence = sql`sm.is_reply IS NOT TRUE AND (sm.delivery_status='delivered' OR sm.delivered_at IS NOT NULL
    OR (sm.status IN ('sent','delivered','opened','clicked','replied','read','accepted') AND COALESCE(sm.delivery_status,'')<>'failed'))`;
  const week = dashboardUtcWeekStart(now);
  const lastWeek = new Date(week.getTime() - 7 * 86400000);
  // In order, not Promise.all: callers pass a transaction, and one connection
  // runs one statement at a time.
  const daily = await executor.execute(sql`WITH activity AS (
      SELECT created_at::date AS day, count(*) AS leads, 0::bigint AS messages, 0::bigint AS customer_updates
      FROM leads WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId}
        AND created_at>=${start.toISOString()}::timestamptz AT TIME ZONE 'UTC' AND created_at<${end.toISOString()}::timestamptz AT TIME ZONE 'UTC' GROUP BY 1
      UNION ALL
      SELECT sm.sent_at::date, 0, count(*), 0 FROM sent_messages sm JOIN leads l ON l.id=sm.lead_id
        AND l.user_id=sm.user_id AND l.business_profile_id=sm.business_profile_id
      WHERE sm.user_id=${userId} AND sm.business_profile_id=${scope.businessProfileId} AND ${evidence}
        AND sm.sent_at>=${start.toISOString()}::timestamptz AT TIME ZONE 'UTC' AND sm.sent_at<${end.toISOString()}::timestamptz AT TIME ZONE 'UTC' GROUP BY 1
      UNION ALL
      SELECT updated_at::date, 0, 0, count(*) FROM leads WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND lead_type='customer'
        AND updated_at>=${start.toISOString()}::timestamptz AT TIME ZONE 'UTC' AND updated_at<${end.toISOString()}::timestamptz AT TIME ZONE 'UTC' GROUP BY 1
    ) SELECT day::text AS date, sum(leads)::int AS leads, sum(messages)::int AS messages, sum(customer_updates)::int AS customer_updates
      FROM activity GROUP BY day ORDER BY day`);
  const campaigns = await executor.execute(sql`SELECT c.id,c.name,count(*)::int AS sent,
      count(*) FILTER(WHERE sm.opened_at IS NOT NULL OR sm.open_count>0 OR sm.status='opened')::int AS opened,
      count(*) FILTER(WHERE sm.reply_received_at IS NOT NULL OR sm.status='replied')::int AS replied
      FROM sent_messages sm JOIN outreach_campaigns c ON c.id=sm.campaign_id
        AND c.user_id=sm.user_id AND c.business_profile_id=sm.business_profile_id
      JOIN leads l ON l.id=sm.lead_id AND l.user_id=sm.user_id AND l.business_profile_id=sm.business_profile_id
      WHERE sm.user_id=${userId} AND sm.business_profile_id=${scope.businessProfileId} AND ${evidence}
      GROUP BY c.id,c.name ORDER BY count(*) DESC,c.id LIMIT 10`);
  const wins = await executor.execute(sql`${firstWinCtes(userId, scope.businessProfileId, crmEnabled)}
      SELECT (SELECT count(DISTINCT contact_id)::int FROM resolved_contacts) AS contacts,
        count(*)::int AS total,
        count(*) FILTER(WHERE occurred_at>=${week.toISOString()}::timestamptz AND occurred_at<=${now.toISOString()}::timestamptz)::int AS this_week,
        count(*) FILTER(WHERE occurred_at>=${lastWeek.toISOString()}::timestamptz AND occurred_at<${week.toISOString()}::timestamptz)::int AS last_week,
        COALESCE(jsonb_agg(jsonb_build_object('date',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD')))
          FILTER(WHERE occurred_at>=${start.toISOString()}::timestamptz),'[]'::jsonb) AS dates
      FROM first_wins WHERE occurred_at<=${now.toISOString()}::timestamptz`);
  const dailyRows = daily.rows as Array<{ date: string; leads: number; messages: number; customer_updates: number }>;
  const campaignRows = campaigns.rows as Array<{ id: number; name: string; sent: number; opened: number; replied: number }>;
  const byDay = new Map(dailyRows.map(row => [String(row.date), row]));
  const win = wins.rows[0] as { contacts: number; total: number; this_week: number; last_week: number; dates: Array<{ date: string }> };
  const winDates = new Map<string, number>();
  for (const { date } of win.dates) winDates.set(date, (winDates.get(date) || 0) + 1);
  return {
    recordedWins: { total: crmEnabled ? Number(win.total) : null, crmContacts: crmEnabled ? Number(win.contacts) : null, thisWeek: crmEnabled ? Number(win.this_week) : null, lastWeek: crmEnabled ? Number(win.last_week) : null,
      rate: crmEnabled ? (Number(win.contacts) > 0 ? (100 * Number(win.total) / Number(win.contacts)).toFixed(1) : '0.0') : null,
      coverage: crmEnabled ? 'recorded_events_only' : 'restricted', policy: 'first_lifetime_win_per_canonical_contact' },
    reportingVersion: 2,
    reporting: { timezone: 'UTC', activityDays: 7, campaignLimit: 10, basis: 'recorded_outbound_receipts', customerUpdates: 'mutable_customer_record_updates' },
    dailyActivity: Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start.getTime() + index * 86400000).toISOString().slice(0, 10);
      const row = byDay.get(date);
      return { date, leads: Number(row?.leads || 0), messages: Number(row?.messages || 0), customerUpdates: Number(row?.customer_updates || 0), recordedWins: crmEnabled ? winDates.get(date) || 0 : null };
    }),
    campaignPerformance: campaignRows.map(row => ({ id: Number(row.id), name: String(row.name), sent: Number(row.sent), opened: Number(row.opened), replied: Number(row.replied) })),
  };
}
