import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8');

describe('AI-controlled ad performance UI contract', () => {
  const performance = read('src/app/dashboard/(main)/ads-analytics/page.tsx');
  const campaigns = read('src/app/dashboard/(main)/ads-campaigns/page.tsx');
  const workspace = read('src/app/dashboard/(main)/ads/page.tsx');
  const social = read('src/app/dashboard/(main)/marketing/analytics/page.tsx');
  const socialReports = read('src/components/social-insights/SocialReportsPanel.tsx');
  const socialListening = read('src/components/social-insights/SocialListeningPanel.tsx');
  const primitives = read('src/components/performance-marketing/WorkspacePrimitives.tsx');
  const analytics = read('src/lib/performanceMarketingAnalytics.ts');
  const documentation = read('../docs/performance-marketing-workspaces.md');
  const nextConfig = read('next.config.ts');
  const creativePreview = read('src/components/performance-marketing/AdCreativePreviewDialog.tsx');
  const campaignPage = read('src/components/performance-marketing/CampaignDetailPage.tsx');
  const campaignRoutes = read('src/components/performance-marketing/campaignRoutes.ts');

  it('shows the control strip, decision-focused overview, explicit AI states, and operational health', () => {
    for (const label of ['Account AI mode', 'Campaign consent', 'Last evaluation', 'Data freshness', 'Units watched', 'AI paused']) {
      expect(performance).toContain(label);
    }
    for (const state of ['Learning', 'Healthy', 'Watch', 'Recommendation', 'AI paused', 'Manual hold', 'Insufficient data']) {
      expect(primitives).toContain(state);
    }
    expect(performance).toContain('providerPauseFailureRate');
    expect(performance).toContain('manualReversalRate');
    expect(performance).toContain('notificationWithinTwoMinutes');
    expect(performance).toContain('Provider failed');
    expect(performance).toContain('Current vs target');
    expect(campaignPage).toContain('function objectiveChain');
    expect(performance).toContain('objectiveUnitPerformance');
  });

  it('provides all shared filters and progressively discloses campaign detail', () => {
    expect(read('src/components/performance-marketing/PaidAdAccountSelector.tsx')).toContain('aria-label="Ad account"');
    for (const label of ['Reporting date range', 'Comparison period']) expect(performance).toContain(`aria-label="${label}"`);
    for (const label of ['Platform', 'Objective', 'Campaign status']) expect(performance).toContain(`label="${label}"`);
    for (const tab of ['Summary', 'Ads &amp; ad sets', 'Creative preview', 'Recommendations', 'Automation &amp; activity', 'Technical details']) {
      expect(campaignPage).toContain(`>${tab}</TabsTrigger>`);
    }
    expect(campaignPage).toContain('Raw rule evidence');
    expect(campaignPage).toContain('Provider and evidence identifiers');
    expect(performance).toContain('aria-label="Trend metric"');
    expect(performance).toContain('managedCampaignHref(campaign.id');
    expect(performance).toContain('providerCampaignHref(campaign.adPlatform');
  });

  it('covers stale cache, sync outage, empty data, mobile overflow, keyboard, and screen-reader affordances', () => {
    expect(performance).toContain('Stale ·');
    expect(performance).toContain('Data connection issues');
    expect(performance).toContain('There are no open recommendations for these filters.');
    expect(performance).toContain('overflow-x-auto');
    expect(read('src/components/ui/button.tsx')).toContain('focus-visible:ring-');
    expect(performance).toContain('aria-label="Allow AI to pause underperforming ads"');
    expect(campaignPage).toContain('Loading campaign evidence');
    expect(campaignPage).toContain('Retry');
    expect(performance).toContain('No campaigns match current filters');
    expect(performance).toContain('Clear filters');
  });

  it('uses one truthful recovery prompt when the Meta connection is missing', () => {
    expect(campaigns).toContain('Meta connection required');
    expect(campaigns).toContain('Cached campaigns remain available below and were not changed.');
    expect(campaigns).toContain('!isMetaConnected && !campaignsError');
  });

  it('opens accepted recommendations in a review-only editing workflow without provider mutation', () => {
    expect(performance).toContain('Accept & edit');
    expect(performance).toContain('/dashboard/ads?tab=campaigns&edit=');
    expect(campaigns).toContain('Accepted recommendation editing workflow');
    expect(campaigns).toContain('Create review draft');
    expect(campaigns).toContain('It does not edit or publish a live provider campaign.');
    expect(campaigns).toContain('/improved-version');
  });

  it('keeps provider-only campaigns visible and requires a consent-off import before AI monitoring', () => {
    expect(performance).toContain('report-only provider records');
    expect(performance).toContain('Import for AI monitoring');
    expect(performance).toContain('/autonomous/import-provider');
    expect(campaigns).toContain('openMetaCampaignAnalytics(campaign.id');
    expect(campaigns).toContain('platform_campaign_id: c.platform_campaign_id');
    expect(campaigns).toContain("monitoredCampaign ? 'Monitored' : 'Not monitored'");
    expect(campaigns).toContain('Preserve the last account aggregate');
    expect(campaigns).toContain('refreshedCampaigns || metaCampaigns');
    expect(campaigns).not.toContain('setMetaCampaigns([])');
    expect(campaigns).toContain('mergeMetaCampaignInventory(liveCampaigns, cachedCampaigns)');
    expect(campaigns).toContain('partial cache');
  });

  it('uses cached Meta campaigns without an avoidable failing live request while disconnected', () => {
    expect(campaigns).toContain('const liveCampaigns = metaConnected ? await loadMetaCampaignsFresh() : null');
    expect(campaigns).toContain("metaCampaignsData = metaConnected ? (await loadMetaCampaignsFresh()) || [] : []");
    expect(campaigns).toContain('onClick={isMetaConnected ? loadDataFresh : connectMeta}');
    expect(campaigns).toContain("'Connect Meta Ads'");
  });

  it('merges paid ads into one workspace and preserves legacy route parameters', () => {
    for (const tab of ['Overview', 'Campaigns', 'Recommendations', 'Automation &amp; activity']) expect(workspace).toContain(tab);
    expect(workspace).toContain('<AdCampaignsWorkspace/>');
    expect(performance).toContain('PERFORMANCE_SECTIONS.has(requestedSection)');
    expect(nextConfig).toContain('source: "/dashboard/ads-campaigns"');
    expect(nextConfig).toContain('destination: "/dashboard/ads?tab=campaigns"');
    expect(nextConfig).toMatch(/value:\s*"\(\?<detail>performance\|units\|recommendations\|history\|evidence\|policy\)"/);
    expect(nextConfig).toContain('destination: "/dashboard/ads?tab=overview&detail=:detail"');
    expect(nextConfig).toContain('source: "/favicon.ico"');
    expect(nextConfig).toContain('destination: "/favicon.svg"');
    expect(workspace).toContain('setActiveTab(tab)');
    expect(workspace).toContain('managedCampaignHref(managedId');
    expect(workspace).toContain('providerCampaignHref(provider, providerCampaign');
    expect(campaignRoutes).toContain('performance: "summary"');
    expect(campaignRoutes).toContain('units: "delivery"');
  });

  it('syncs provider evidence and explains why AI recommendations are absent', () => {
    expect(performance).toContain('Sync provider data');
    expect(performance).toContain('usePaidAdsSection');
    expect(workspace).toContain('PaidAdsSectionProvider section="overview"');
    expect(workspace).toContain('PaidAdsSectionProvider section="recommendations"');
    expect(workspace).toContain('PaidAdsSectionProvider section="automation"');
    expect(performance).toContain('/api/campaigns/meta/cache/refresh');
    expect(performance).toContain('/api/campaigns/analytics/fetch-now');
    expect(performance).toContain('AI analysis is off');
    expect(performance).toContain('Enable Advisory mode');
    expect(performance).toContain('Start AI analysis for this campaign');
    expect(performance).toContain('raw.replace(" ", "T")');
  });

  it('keeps Social Insights analytics-first with account-scoped evidence controls', () => {
    for (const [value, label] of [['overview', 'Overview'], ['listening', 'Listening'], ['competitors', 'Competitors'], ['reports', 'Reports']]) {
      expect(social).toMatch(new RegExp(`<TabsTrigger value="${value}"[\\s\\S]*?\\b${label}\\s*</TabsTrigger>`));
    }
    expect(social).toContain('Data &amp; connections');
    expect(social).toContain('Growth and publishing pattern');
    expect(social).toContain('Evidence-backed content test');
    expect(social).toContain('<SocialReportsPanel');
    expect(socialReports).toContain('Five-field UTC cron');
    expect(socialReports).toContain('sourceReport?.schedule_cron ? ["custom_cron"] : []');
    expect(social).toContain('<SocialListeningPanel');
    expect(socialListening).toContain('aria-label="Listening sentiment"');
    expect(socialListening).toContain('credentialId,');
    expect(social).toContain('accountIdentifier={selectedAccountIdentifier}');
    expect(socialListening).toContain('start: `${startDate}T00:00:00Z`');
    expect(social).toContain('Sync now');
    expect(social).toContain('Connected — first sync needed');
    expect(social).toContain('Organic analytics will appear after reconnecting');
    expect(social).toContain('Use the account status above to restore organic analytics access.');
    expect(social).toContain('setActiveTab(next)');
  });

  it('uses shared progressive-disclosure primitives and privacy-safe product analytics', () => {
    for (const component of ['PerformanceMarketingViewToggle', 'WorkspaceFilterBar', 'FreshnessIndicator', 'PerformanceEmptyState', 'EvidenceDisclosure']) {
      expect(primitives).toContain(`function ${component}`);
    }
    expect(workspace).not.toContain('PerformanceMarketingViewToggle');
    expect(social).not.toContain('PerformanceMarketingViewToggle');
    expect(analytics).toContain('asksales:analytics');
    expect(analytics).toContain('Campaign');
    expect(analytics).toContain('provider resource IDs');
    expect(analytics).toContain('intentionally excluded');
    expect(documentation).toContain('Paid Ads');
    expect(documentation).toContain('Social Insights');
    expect(campaignPage).toContain('Technical details');
  });

  it('keeps campaign inventory filters and technical provider IDs shareable and advanced-only', () => {
    expect(campaigns).toContain("searchParams.get('search')");
    expect(campaigns).toContain("searchParams.get('status')");
    expect(campaigns).toContain("searchParams.get('date')");
    expect(campaigns).toContain("updateInventoryQuery({ search:");
    expect(campaigns).toContain("updateInventoryQuery({ status:");
    expect(campaigns).toContain("updateInventoryQuery({ date:");
    expect(campaigns).not.toContain('advanced && <><span>•</span><span className="font-mono text-xs">ID:');
    expect(workspace).toContain('PaidAdsAdvancedViewProvider advanced={advanced}');
    expect(campaigns).not.toContain("usePaidAdsAdvancedView");
    expect(campaigns).toContain('View details');
    expect(campaigns).toContain("openMetaCampaignAnalytics(campaign.id, 'performance')");
    expect(campaigns).not.toContain("isExpanded ? 'Hide details' : 'View details'");
    expect(campaigns).toContain("providerCampaignHref('meta', providerCampaignId");
  });

  it('keeps provider campaign identity, metrics, and actions in stable responsive regions', () => {
    expect(campaigns).toContain('lg:grid-cols-[minmax(0,1fr)_auto]');
    expect(campaigns).toContain('2xl:grid-cols-[minmax(280px,1fr)_minmax(440px,1.25fr)_auto]');
    expect(campaigns).toContain('hidden min-w-0 grid-cols-4 gap-x-4 gap-y-2 text-right 2xl:grid');
    expect(campaigns).toContain('min-w-0 break-words font-semibold');
    expect(campaigns).not.toContain('hidden grid-cols-8 gap-4 text-right 2xl:grid');
  });

  it('previews campaign, ad-set, and ad creative evidence without provider mutation', () => {
    expect(campaigns).toContain('openManagedCampaignCreativePreview(campaign)');
    expect(campaigns).toContain('openCampaignCreativePreview(campaign)');
    expect(campaigns).toContain('openAdsetCreativePreview(campaign.id, adset)');
    expect(campaigns).toContain('openAdCreativePreview(campaign.id, ad)');
    expect(campaigns).not.toContain('<AdCreativePreviewDialog');
    expect(campaignPage).toContain('<AdCreativePreviewWorkspace');
    expect(creativePreview).toContain('Read-only provider preview');
    expect(creativePreview).toContain('No delivery settings are changed');
    expect(creativePreview).toContain('creative name is intentionally not used as the advertiser identity');
    expect(creativePreview).toContain('Preview never starts a sync or changes the campaign');
    expect(creativePreview).toContain('Facebook preview for');
    expect(creativePreview).toContain('Instagram preview for');
  });

  it('only offers valid provider delivery actions and explains inherited pauses', () => {
    expect(campaigns).toContain("function providerDeliveryAction(status?: string): 'pause' | 'resume' | null");
    expect(campaigns).toContain("if (normalized === 'ACTIVE') return 'pause'");
    expect(campaigns).toContain("if (normalized === 'PAUSED') return 'resume'");
    expect(campaigns).toContain('Delivery action unavailable for');
    expect(campaigns).toContain('Configured active · ad set paused');
  });

});
