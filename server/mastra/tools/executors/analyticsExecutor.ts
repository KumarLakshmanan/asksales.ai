/**
 * Analytics Tool Executors
 * Handles analytics queries for campaigns, leads, and outreach
 */

import type { ToolContext } from '../toolRegistry.js';
import type { ToolResult } from '../../state';
import { logger } from '../../../utils/logger.js';
import { TAB_TYPES } from '../../tabConfig';
import type { CampaignReport,CampaignReportFilters } from '../../../../shared/campaignReporting.js';
import {campaignReportCard} from '../../../../shared/campaignReporting.js';
import { toNumber } from './executorValues.js';
import type { SQL } from 'drizzle-orm';
import { resolvePaidAnalyticsDateRange, type PaidAnalyticsDateRange, type PaidAnalyticsPeriod } from './paidAnalyticsPeriod.js';

interface AnalyticsMetric {
  metric: string;
  value: number | string;
  change?: number;
  trend?: 'up' | 'down' | 'stable';
}

interface CampaignAnalytics {
  campaignId: string;
  campaignName: string;
  status: string;
  localStatus: string;
  lastRecordedProviderStatus: string | null;
  providerVerifiedLive: false;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpc: number;
  spend: number;
  currency: string;
  roi: number;
  platform?: string;
  hasPerformanceData: boolean;
  performanceClassification?: 'high' | 'low' | 'measured' | 'insufficient_data';
}

interface LeadAnalytics {
  totalLeads: number;
  qualifiedLeads: number;
  convertedLeads: number;
  conversionRate: number;
  avgLeadScore: number;
  bySource: Record<string, number>;
  byStatus: Record<string, number>;
}

interface OutreachAnalytics {
  report: CampaignReport;
  totalSent: number;
  delivered: number;
  opened: number;
  clicked: number;
  replied: number;
  openRate: number;
  clickRate: number;
  replyRate: number;
  byChannel: Record<string, number>;
}

export async function executeAnalyticsQuery(
  input: {
    query_type: 'campaign' | 'lead' | 'outreach' | 'overview';
    question?: string;
    scope?: 'current_campaign' | 'all_owned';
    filters?: {
      date_range?: { start: string; end: string };
      period?: PaidAnalyticsPeriod;
      campaign_id?: string;
      platform?: string;
      status?: string;
      import_id?: number;
      import_source?: 'crm' | 'campaign';
      account_id?: string;
      message_kind?: 'outreach' | 'follow_up' | 'all';
    };
    metrics?: string[];
    outreach_filters?:Partial<CampaignReportFilters>;
  },
  context: ToolContext
): Promise<ToolResult> {
  try {
    const { webSocketEmitter } = await import('../../../services/agents/WebSocketEmitter');
    const userId = toNumber(context.userId);
    const threadId = toNumber(context.threadId);
    const semanticScope = context.intentAnalysis?.semanticRequest?.scope;
    const scope = (semanticScope === 'current_campaign' ? semanticScope : input.scope)
      || (semanticScope !== 'unspecified' ? semanticScope : undefined)
      || (Number.isSafeInteger(threadId) && threadId > 0 ? 'current_campaign' : 'all_owned');
    const currentCampaignOnly = scope === 'current_campaign';
    if (currentCampaignOnly && (!Number.isSafeInteger(threadId) || threadId <= 0)) {
      throw new Error('A current conversation is required for campaign-scoped analytics.');
    }
    // Conversation IDs are not paid-campaign IDs. Scope through the saved,
    // authoritative conversation association, never a name or numeric guess.
    const paidDateRange = input.query_type === 'outreach' ? null : resolvePaidAnalyticsDateRange(input.filters);
    const campaignFilters = {
      ...input.filters,
      ...(currentCampaignOnly ? { thread_id: threadId } : {}),
      ...(paidDateRange ? { resolved_date_range: paidDateRange } : {}),
    };
    if(currentCampaignOnly && input.outreach_filters?.workspaceId && input.outreach_filters.workspaceId!==threadId) throw new Error('These filters select another workspace. Keep the requested current conversation scope.');
    const outreachFilters:Partial<CampaignReportFilters>={
      // Backward compatibility for executor callers from before the public
      // canonical filters existed. Paid IDs never leak into overview outreach.
      ...(!input.outreach_filters && input.query_type==='outreach' ? {
        ...(input.filters?.campaign_id ? {campaignId:Number(input.filters.campaign_id)} : {}),
        ...(input.filters?.import_id ? {importId:input.filters.import_id,importSource:input.filters.import_source} : {}),
        ...(input.filters?.platform ? {channel:input.filters.platform as CampaignReportFilters['channel']} : {}),
        ...(input.filters?.account_id ? {accountId:input.filters.account_id} : {}),
        ...(input.filters?.date_range ? {from:input.filters.date_range.start,to:input.filters.date_range.end} : {}),
        ...(input.filters?.message_kind ? {messageKind:input.filters.message_kind} : {}),
      } : {}),...input.outreach_filters,...(currentCampaignOnly ? {workspaceId:threadId} : {}),
    };
    const scopeLabel = `${currentCampaignOnly ? `Current conversation #${threadId}` : 'Account-wide saved data'}${paidDateRange ? ` · ${paidDateRange.start} to ${paidDateRange.end}` : ''}`;
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let analyticsData: any;
    let summary: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let visualizations: any[] = [];

    switch (input.query_type) {
      case 'campaign':
        analyticsData = await getCampaignAnalytics(userId, campaignFilters);
        summary = generateCampaignSummary(analyticsData);
        visualizations = generateCampaignVisualizations(analyticsData);
        break;
        
      case 'lead':
        analyticsData = await getLeadAnalytics(userId, campaignFilters);
        summary = generateLeadSummary(analyticsData);
        visualizations = generateLeadVisualizations(analyticsData);
        break;
        
      case 'outreach':
        analyticsData = await getOutreachAnalytics(userId, outreachFilters);
        summary = generateOutreachSummary(analyticsData);
        visualizations = generateOutreachVisualizations(analyticsData);
        break;
        
      case 'overview':
      default:
        analyticsData = await getOverviewAnalytics(userId, campaignFilters,outreachFilters);
        summary = generateOverviewSummary(analyticsData);
        visualizations = generateOverviewVisualizations(analyticsData);
        break;
    }

    // Open analytics tab with the data
    webSocketEmitter.emit(userId, 'open_tab', {
      thread_id: toNumber(context.threadId),
      tabType: TAB_TYPES.ANALYTICS,
      tabLabel: `${input.query_type.charAt(0).toUpperCase() + input.query_type.slice(1)} Analytics`,
      data: { 
        queryType: input.query_type,
        scope,
        ...(currentCampaignOnly ? { threadId } : {}),
        analyticsData,
        visualizations,
        filters: input.query_type==='outreach' ? outreachFilters : input.filters,
        scopeLabel,
      },
    });

    return {
      success: true,
      toolName: 'analytics_query',
      output: {
        queryType: input.query_type,
        scope,
        ...(currentCampaignOnly ? { threadId } : {}),
        ...(paidDateRange ? { dateRange: paidDateRange } : {}),
        scopeLabel,
        data: analyticsData,
        ...(input.query_type==='outreach' ? {card:campaignReportCard(analyticsData.report)} : {}),
        summary,
        visualizations,
        message: `📊 ${input.query_type.charAt(0).toUpperCase() + input.query_type.slice(1)} analytics loaded! Check the Analytics tab for detailed visualizations.`,
      },
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[Analytics Executor] Query error');
    return { success: false, toolName: 'analytics_query', error: error.message };
  }
}

async function getCampaignAnalytics(
  userId: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filters?: any
): Promise<CampaignAnalytics[]> {
  try {
    const { db } = await import('../../../models/db.js');
    const { sql } = await import('drizzle-orm');
    // Inside a reporting period only that period's daily rows count. Lifetime
    // totals stored on the campaign must not stand in for a period.
    const range: PaidAnalyticsDateRange | null = filters?.resolved_date_range ?? null;
    const lifetime = (column: SQL) => (range ? sql`NULL` : column);
    const result = await db.execute(sql`
      SELECT
        pac.id,
        pac.name,
        pac.ad_platform AS platform,
        COALESCE(pac.currency, 'USD') AS currency,
        pac.local_status,
        pac.provider_status,
        COALESCE(pac.provider_status, pac.local_status, pac.status, 'draft') AS status,
        COALESCE(SUM(pm.impressions) FILTER (WHERE pm.hour IS NULL), ${lifetime(sql`pac.impressions`)}, 0)::int AS impressions,
        COALESCE(SUM(pm.clicks) FILTER (WHERE pm.hour IS NULL), ${lifetime(sql`pac.clicks`)}, 0)::int AS clicks,
        COALESCE(SUM(pm.conversions) FILTER (WHERE pm.hour IS NULL), ${lifetime(sql`pac.conversions`)}, 0)::numeric AS conversions,
        COALESCE(SUM(pm.spend) FILTER (WHERE pm.hour IS NULL), ${lifetime(sql`pac.spent_amount`)}, 0)::numeric AS spend,
        COALESCE(SUM(pm.conversion_value) FILTER (WHERE pm.hour IS NULL), 0)::numeric AS conversion_value,
        COUNT(pm.id) FILTER (WHERE pm.hour IS NULL)::int AS metric_rows
      FROM performance_ad_campaigns pac
      LEFT JOIN performance_metrics pm
        ON pm.campaign_id = pac.id
       AND pm.user_id = pac.user_id
       ${range ? sql`AND pm.date >= ${range.start}::date AND pm.date <= ${range.end}::date` : sql``}
      WHERE pac.user_id = ${userId}
        ${filters?.thread_id ? sql`AND pac.settings->'context'->>'threadId' = ${String(filters.thread_id)}` : sql``}
      GROUP BY pac.id
      ORDER BY pac.created_at DESC
    `);
    const campaignIdFilter = Number(filters?.campaign_id);
    const platformFilter = typeof filters?.platform === 'string' ? filters.platform.toLowerCase() : null;
    const statusFilter = typeof filters?.status === 'string' ? filters.status.toLowerCase() : null;
    const campaigns = (result.rows as Array<Record<string, unknown>>)
      .filter((row) => !Number.isSafeInteger(campaignIdFilter) || campaignIdFilter <= 0 || Number(row.id) === campaignIdFilter)
      .filter((row) => !platformFilter || String(row.platform || '').toLowerCase() === platformFilter)
      .filter((row) => !statusFilter || String(row.status || '').toLowerCase() === statusFilter)
      .map((row): CampaignAnalytics => {
        const impressions = Number(row.impressions || 0);
        const clicks = Number(row.clicks || 0);
        const conversions = Number(row.conversions || 0);
        const spend = Number(row.spend || 0);
        const conversionValue = Number(row.conversion_value || 0);
        const metricRows = Number(row.metric_rows || 0);
        const hasPerformanceData = metricRows > 0 || impressions > 0 || clicks > 0 || conversions > 0 || spend > 0;
        return {
          campaignId: String(row.id),
          campaignName: String(row.name || 'Unnamed Campaign'),
          status: String(row.status || 'draft'),
          localStatus: String(row.local_status || 'draft'),
          lastRecordedProviderStatus: row.provider_status == null ? null : String(row.provider_status),
          providerVerifiedLive: false,
          platform: String(row.platform || ''),
          impressions,
          clicks,
          conversions,
          ctr: impressions > 0 ? Math.round((clicks / impressions) * 10_000) / 100 : 0,
          cpc: clicks > 0 ? Math.round((spend / clicks) * 100) / 100 : 0,
          spend,
          currency: String(row.currency || 'USD').toUpperCase(),
          roi: spend > 0 ? Math.round((conversionValue / spend) * 100) / 100 : 0,
          hasPerformanceData,
          performanceClassification: hasPerformanceData ? 'measured' : 'insufficient_data',
        };
      });

    const measured = campaigns.filter(campaign => campaign.hasPerformanceData);
    if (measured.length >= 2) {
      const score = (campaign: CampaignAnalytics) =>
        campaign.roi * 1_000_000 + campaign.conversions * 1_000 + campaign.ctr;
      const ranked = [...measured].sort((a, b) => score(b) - score(a));
      ranked[0].performanceClassification = 'high';
      ranked[ranked.length - 1].performanceClassification = 'low';
    }
    return campaigns;
  } catch (error) {
    logger.error({ err: error }, '[Analytics] Error fetching campaign data');
    throw new Error('Campaign analytics are unavailable; the saved data could not be read.');
  }
}

async function getLeadAnalytics(
  userId: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  filters?: any
): Promise<LeadAnalytics> {
  try {
    const { db } = await import('../../../models/db.js');
    const { leadsTable } = await import('../../../models/leads/schema');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { eq, sql, and } = await import('drizzle-orm');
    
    const leads = await db.select().from(leadsTable).where(and(
      eq(leadsTable.userId, userId),
      filters?.thread_id ? sql`(
        ${leadsTable.campaignData}->>'threadId' = ${String(filters.thread_id)}
        OR EXISTS (SELECT 1 FROM icp_profiles icp
          WHERE icp.id = ${leadsTable.promptId} AND icp.user_id = ${userId}
            AND icp.thread_id = ${filters.thread_id})
      )` : undefined,
    ));
    const totalLeads = leads.length;
    
    if (totalLeads === 0) {
      return {
        totalLeads: 0,
        qualifiedLeads: 0,
        convertedLeads: 0,
        conversionRate: 0,
        avgLeadScore: 0,
        bySource: {},
        byStatus: {},
      };
    }
    
    // Calculate real status counts
    const byStatus: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let qualifiedLeads = 0;
    let convertedLeads = 0;
    
    for (const lead of leads) {
      // Count by status
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status = (lead as any).leadStatus || (lead as any).status || 'new';
      byStatus[status] = (byStatus[status] || 0) + 1;
      
      if (status === 'qualified') qualifiedLeads++;
      if (status === 'converted') convertedLeads++;
      
      // Count by source
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const source = (lead as any).source || 'Unknown';
      bySource[source] = (bySource[source] || 0) + 1;
    }
    
    const conversionRate = totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100 * 10) / 10 : 0;
    
    // Calculate average lead score from actual data if available
    let totalScore = 0;
    let scoredLeads = 0;
    for (const lead of leads) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const leadScore = (lead as any).leadScore;
      const score = typeof leadScore === 'number' && leadScore > 0 ? leadScore : ((lead as any).icpScore ?? leadScore);
      if (typeof score === 'number' && Number.isFinite(score)) {
        totalScore += score;
        scoredLeads++;
      }
    }
    const avgLeadScore = scoredLeads > 0 ? Math.round(totalScore / scoredLeads) : 0;
    
    return {
      totalLeads,
      qualifiedLeads,
      convertedLeads,
      conversionRate,
      avgLeadScore,
      bySource,
      byStatus,
    };
  } catch (error) {
    logger.error({ err: error }, '[Analytics] Error fetching lead data');
    throw new Error('Lead analytics are unavailable; the saved data could not be read.');
  }
}

async function getOutreachAnalytics(
  userId: number,
  filters:Partial<CampaignReportFilters>={}
): Promise<OutreachAnalytics> {
  const { getCampaignReport } = await import('../../../services/outreach/CampaignReportingService.js');
  const report = await getCampaignReport(userId,filters);
  const rate = (value: number) => report.counts.accepted ? Math.round(value/report.counts.accepted*1000)/10 : 0;
  return {report,totalSent:report.counts.accepted,delivered:report.counts.delivered,
    opened:report.counts.opened,clicked:report.counts.clicked,replied:report.engagement.respondingCustomers,
    openRate:rate(report.counts.opened),clickRate:rate(report.counts.clicked),replyRate:report.engagement.responseRate,
    byChannel:Object.fromEntries(report.channels.map(channel=>[channel.channel,channel.accepted]))};
}

async function getOverviewAnalytics(
  userId: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filters?: any,
  outreachFilters:Partial<CampaignReportFilters>={}
): Promise<{
  campaigns: CampaignAnalytics[];
  leads: LeadAnalytics;
  outreach: OutreachAnalytics;
  keyMetrics: AnalyticsMetric[];
}> {
  const [campaigns, leads, outreach] = await Promise.all([
    getCampaignAnalytics(userId, filters),
    getLeadAnalytics(userId, filters),
    getOutreachAnalytics(userId, outreachFilters),
  ]);

  const keyMetrics: AnalyticsMetric[] = [
    { metric: 'Total Leads', value: leads.totalLeads },
    { metric: 'Conversion Rate', value: `${leads.conversionRate}%` },
    { metric: 'Outreach Open Rate', value: `${outreach.openRate}%` },
    {
      metric: 'Campaign ROAS',
      value: campaigns.some(campaign => campaign.hasPerformanceData)
        ? `${(campaigns.filter(campaign => campaign.hasPerformanceData).reduce((sum, campaign) => sum + campaign.roi, 0) / campaigns.filter(campaign => campaign.hasPerformanceData).length).toFixed(2)}x`
        : 'Insufficient data',
    },
  ];

  return { campaigns, leads, outreach, keyMetrics };
}

export function generateCampaignSummary(data: CampaignAnalytics[]): string {
  if (data.length === 0) return 'No campaigns found for the selected filters.';
  const measured = data.filter(campaign => campaign.hasPerformanceData);
  if (measured.length === 0) {
    return `📊 **Campaign Performance Summary**\n- **${data.length}** saved campaign(s)\n- No provider performance rows or spend have been recorded yet.\n- Campaign statuses are local or last-recorded provider states, not a live provider check.\n- A high-performing or low-performing ad cannot be identified truthfully until impressions, clicks, spend, and conversion data are synced.`;
  }
  
  const spendByCurrency = new Map<string, number>();
  for (const campaign of measured) {
    const currency = campaign.currency || 'USD';
    spendByCurrency.set(currency, (spendByCurrency.get(currency) || 0) + campaign.spend);
  }
  // Currency amounts cannot be summed across unlike currencies without an
  // explicit exchange rate and valuation date.
  const spendSummary = [...spendByCurrency].map(([currency, amount]) => `${currency} ${amount.toFixed(2)}`).join('; ');
  const avgCtr = measured.reduce((a, c) => a + c.ctr, 0) / measured.length;
  const totalConversions = measured.reduce((a, c) => a + c.conversions, 0);
  const high = measured.find(campaign => campaign.performanceClassification === 'high');
  const low = measured.find(campaign => campaign.performanceClassification === 'low');
  
  return `📊 **Campaign Performance Summary**
- **${measured.length}** campaign(s) with measured provider data
- **${spendSummary}** recorded spend
- **${avgCtr.toFixed(2)}%** average CTR
- **${totalConversions}** total conversions
- Campaign statuses are local or last-recorded provider states, not a live provider check.
${high && low ? `- High performer: **${high.campaignName}**\n- Low performer: **${low.campaignName}**` : '- Only one measured campaign is available, so comparative high/low ranking is not yet valid.'}`;
}

function generateLeadSummary(data: LeadAnalytics): string {
  return `📊 **Lead Generation Summary**
- **${data.totalLeads}** total leads captured
- **${data.qualifiedLeads}** qualified leads (${((data.qualifiedLeads / data.totalLeads) * 100 || 0).toFixed(1)}%)
- **${data.convertedLeads}** conversions
- **${data.conversionRate}%** conversion rate
- **${data.avgLeadScore}** average lead score`;
}

function generateOutreachSummary(data: OutreachAnalytics): string {
  const {report} = data;
  return `Outreach report, checked ${report.checkedAt}
- ${report.counts.total} outbound messages; ${data.totalSent} accepted by the provider
- ${data.delivered} confirmed delivered; ${report.counts.awaitingConfirmation} awaiting delivery confirmation (included in accepted)
- ${report.counts.queued} queued (${report.counts.retrying} retrying); ${report.counts.failed} failed; ${report.counts.review} need review
- ${data.replied} distinct responding customers (${data.replyRate}% of ${report.uniqueRecipients} recipients)
- Next queued attempt: ${report.nextAttemptAt || 'Not yet scheduled'}
- ${report.definitions.attribution}
- ${report.definitions.history}
[View report](${report.links.report})`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function generateOverviewSummary(data: any): string {
  const topMetrics = data.keyMetrics.slice(0, 3);
  const nextStep = data.campaigns.length === 0
    ? 'Launch one trackable campaign before evaluating spend or ROI.'
    : data.leads.totalLeads > 0 && data.leads.conversionRate === 0
      ? 'Audit lead qualification and conversion tracking before increasing campaign spend.'
      : data.outreach.report?.counts.queued > 0
        ? 'Review the saved queue reasons and retry times before preparing another send.'
        : data.outreach.report?.counts.failed > 0
          ? 'Review the recorded delivery failures before retrying any messages.'
          : data.outreach.totalSent > 0 && data.outreach.openRate === 0 && data.outreach.report?.channels.some((channel: {channel:string})=>channel.channel==='email')
        ? 'For email, validate open tracking before testing another subject line.'
        : 'Scale the strongest-performing campaign while monitoring conversion quality.';

  return `📊 **Overall Performance Dashboard**

**Campaigns:** ${data.campaigns.length} saved campaigns (not a live activation check)
**Leads:** ${data.leads.totalLeads} total leads (${data.leads.conversionRate}% conversion)
**Outreach:** ${data.outreach.totalSent} messages (${data.outreach.openRate}% open rate)

**Key Highlights:**
${topMetrics.map((m: AnalyticsMetric) => `- ${m.metric}: ${m.value} ${m.trend === 'up' ? '📈' : m.trend === 'down' ? '📉' : '➡️'}`).join('\n')}

**Recommended next step:** ${nextStep}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function generateCampaignVisualizations(data: CampaignAnalytics[]): any[] {
  const measured = data.filter(campaign => campaign.hasPerformanceData);
  return [
    {
      type: 'bar',
      title: 'Spend by Campaign',
      data: measured.map(c => ({ label: c.campaignName, value: c.spend, currency: c.currency })),
    },
    {
      type: 'line',
      title: 'CTR by Campaign',
      data: measured.map(c => ({ label: c.campaignName, value: c.ctr })),
    },
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function generateLeadVisualizations(data: LeadAnalytics): any[] {
  return [
    {
      type: 'pie',
      title: 'Leads by Source',
      data: Object.entries(data.bySource).map(([label, value]) => ({ label, value })),
    },
    {
      type: 'funnel',
      title: 'Lead Funnel',
      data: [
        { label: 'Total Leads', value: data.totalLeads },
        { label: 'Qualified', value: data.qualifiedLeads },
        { label: 'Converted', value: data.convertedLeads },
      ],
    },
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function generateOutreachVisualizations(data: OutreachAnalytics): any[] {
  return [
    {
      type: 'pie',
      title: 'Messages by Channel',
      data: Object.entries(data.byChannel).map(([label, value]) => ({ label, value })),
    },
    {
      type: 'bar',
      title: 'Recorded delivery and engagement',
      data: [
        { label: 'Provider accepted', value: data.totalSent },
        { label: 'Confirmed delivered', value: data.delivered },
        { label: 'Recorded opens', value: data.opened },
        { label: 'Tracked link clicks', value: data.clicked },
        { label: 'Responding customers', value: data.replied },
      ],
    },
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function generateOverviewVisualizations(data: any): any[] {
  return [
    ...generateCampaignVisualizations(data.campaigns),
    ...generateLeadVisualizations(data.leads),
    ...generateOutreachVisualizations(data.outreach),
    {
      type: 'kpi',
      title: 'Key Metrics',
      data: data.keyMetrics,
    },
  ];
}
