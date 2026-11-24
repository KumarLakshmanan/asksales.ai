import type { Request, Response } from 'express';
import { businessOwnerUserId, currentDatabaseScope, requireBusinessScope } from '../tenancy/businessContext.js';
import { isPostgresIntegerId } from '../utils/postgresIntegerId.js';
import { logger } from '../utils/logger.js';
import { assertLegacyCampaignExists, LegacyAnalyticsError, readLegacyCampaignAnalytics, readLegacyCampaignTrends, type LegacyAnalyticsScope } from '../services/LegacyCampaignAnalyticsService.js';

/** A role string alone never changes tenant scope into platform authority. */
function reportingScope(req: Request, campaignId: unknown = req.params.id): LegacyAnalyticsScope {
  if (!req.user) throw new LegacyAnalyticsError(401, 'Unauthorized');
  const active = currentDatabaseScope();
  if (active?.kind === 'system') {
    if (!['admin', 'super_admin'].includes(req.user.role || '') || campaignId !== undefined) throw new LegacyAnalyticsError(403, 'Administrative analytics access required');
    return { kind: 'platform' };
  }
  if (active?.kind !== 'business') throw new LegacyAnalyticsError(403, 'An authenticated business profile is required');
  if (!isPostgresIntegerId(campaignId)) throw new LegacyAnalyticsError(400, 'Invalid campaign ID');
  const scope = requireBusinessScope();
  return { kind: 'business', userId: businessOwnerUserId(req), businessProfileId: scope.businessProfileId, campaignId: Number(campaignId) };
}

function fail(error: unknown, res: Response) {
  if (error instanceof LegacyAnalyticsError) return res.status(error.status).json({ message: error.message });
  logger.error({ err: error }, 'Legacy campaign reporting failed');
  return res.status(500).json({ message: 'Unable to retrieve campaign analytics. Please try again.' });
}

export async function getCampaignAnalytics(req: Request, res: Response) {
  try { res.json(await readLegacyCampaignAnalytics(reportingScope(req))); }
  catch (error) { return fail(error, res); }
}

export async function getCampaignPerformanceTrends(req: Request, res: Response) {
  try {
    const scope = reportingScope(req);
    const period = req.query.period ?? '30d';
    if (!['7d', '30d', '90d'].includes(String(period))) throw new LegacyAnalyticsError(400, 'Invalid reporting period');
    const start = new Date(); start.setUTCDate(start.getUTCDate() - Number(String(period).slice(0, -1)) + 1); start.setUTCHours(0, 0, 0, 0);
    res.setHeader('X-Reporting-Basis', 'recorded-event-dates-utc');
    res.json(await readLegacyCampaignTrends(scope, start));
  } catch (error) { return fail(error, res); }
}

export async function getTopHooksAndHashtags(req: Request, res: Response) {
  try {
    const scope = reportingScope(req);
    await assertLegacyCampaignExists(scope);
    res.json({ topHooks: [], topHashtags: [], dataAvailable: false,
      message: 'Hook and hashtag attribution is unavailable without content-level campaign tracking.' });
  } catch (error) { return fail(error, res); }
}

export async function compareCampaigns(req: Request, res: Response) {
  try {
    if (!req.user) throw new LegacyAnalyticsError(401, 'Unauthorized');
    const ids: unknown = req.body?.campaignIds;
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 5 || ids.some(id => typeof id !== 'number' || !isPostgresIntegerId(id)) || new Set(ids).size !== ids.length) {
      throw new LegacyAnalyticsError(400, 'Choose two to five unique campaign IDs');
    }
    const scopes = ids.map(id => reportingScope(req, id));
    // Validate the entire comparison before calculating any member's report.
    await Promise.all(scopes.map(scope => assertLegacyCampaignExists(scope)));
    const reports = await Promise.all(scopes.map(scope => readLegacyCampaignAnalytics(scope)));
    const campaigns = reports.map(report => {
      const campaign = report.campaign!;
      return { id: campaign.id, name: campaign.name, status: campaign.status,
        metrics: { budget: Number(campaign.budget), spent: Number(campaign.spent), roi: null, totalLeads: report.leadsGenerated,
          enrichedLeads: report.funnelData.enriched.value, convertedLeads: report.revenue.convertedLeads, conversionRate: report.revenue.recordedWinRate,
          totalOutreach: report.channelData.reduce((sum, channel) => sum + channel.sent, 0),
          emailsSent: report.channelData.find(channel => channel.channel === 'email')?.sent || 0,
          dmsSent: report.channelData.find(channel => channel.channel === 'instagram')?.sent || 0 },
        reporting: report.reporting, period: { start: campaign.start_date, end: campaign.end_date, createdAt: campaign.created_at } };
    });
    const rates = campaigns.map(campaign => campaign.metrics.conversionRate).filter((rate): rate is number => rate !== null);
    res.json({ success: true, campaigns, aggregates: { avgROI: null, avgConversionRate: rates.length ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : null,
      totalLeadsAcross: campaigns.reduce((sum, campaign) => sum + campaign.metrics.totalLeads, 0), totalSpentAcross: null, spendCurrency: null, bestPerformer: null } });
  } catch (error) { return fail(error, res); }
}
