import type { ToolCallResult } from './toolCallingLoop.js';
import { asRecord as record } from '../../../shared/records.js';

const metric = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Interpret the executor's data envelope without inventing missing metrics. */
export function generateAnalyticsInsights(results: ToolCallResult[]): string {
  const insights: string[] = [];
  for (const result of results) {
    if (result.toolName !== 'analytics_query' || !result.success) continue;
    const output = record(record(result.result).output);
    const data = record(output.data);
    const campaigns = output.queryType === 'campaign' ? output.data : data.campaigns;
    if (Array.isArray(campaigns)) {
      for (const value of campaigns) {
        const campaign = record(value);
        const impressions = metric(campaign.impressions);
        const ctr = metric(campaign.ctr);
        if (campaign.hasPerformanceData !== true || !impressions || ctr === null || ctr > 100) continue;
        const name = typeof campaign.campaignName === 'string' ? campaign.campaignName : 'Unnamed campaign';
        if (ctr < 1) insights.push(`Campaign "${name}" has a measured CTR of ${ctr}% across ${impressions} impressions. Review the creative and targeting before making changes.`);
        else if (ctr > 3) insights.push(`Campaign "${name}" has a measured CTR of ${ctr}% across ${impressions} impressions. CTR alone does not establish profitability.`);
      }
    }
    const leads = output.queryType === 'lead' ? data : record(data.leads);
    if ((metric(leads.totalLeads) ?? 0) > 0) {
      const conversionRate = metric(leads.conversionRate);
      const avgScore = metric(leads.avgLeadScore);
      if (conversionRate !== null && conversionRate < 10) insights.push(`Lead conversion rate is ${conversionRate}%. Review qualification and follow-up against the reporting period.`);
      if (avgScore !== null && avgScore < 50) insights.push(`Average lead score is ${avgScore}. Review the qualification criteria and source quality.`);
    }
    const outreach = output.queryType === 'outreach' ? data : record(data.outreach);
    if ((metric(outreach.totalSent) ?? 0) > 0) {
      const openRate = metric(outreach.openRate);
      const replyRate = metric(outreach.replyRate);
      if (openRate !== null && openRate < 20) insights.push(`Recorded open rate is ${openRate}%. Check tracking coverage and the reporting period before changing subject lines.`);
      if (replyRate !== null && replyRate < 5) insights.push(`Recorded reply rate is ${replyRate}%. Review message relevance and the reporting period.`);
    }
  }
  return insights.length ? `\n\n**Insights & Recommendations:**\n${[...new Set(insights)].map(value => `- ${value}`).join('\n')}` : '';
}
