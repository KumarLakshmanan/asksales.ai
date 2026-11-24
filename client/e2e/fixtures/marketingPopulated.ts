import type { Page } from '@playwright/test';

// Deliberately synthetic, populated data for visual and interaction review.
// This fixture intercepts requests locally; it never seeds an application database.
const stamp = '2026-10-30T12:00:00Z';
const days = Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
const media = (id: number) => `http://127.0.0.1:3462/__marketing_fixture/${id}.svg`;
const sampleNames = ['Weekend escapes', 'Resort enquiries', 'Autumn offers', 'Garden dining', 'Mountain mornings', 'Family stays', 'City retreats', 'Monsoon memories'];
export const populatedCampaigns = sampleNames.map((name, i) => ({
  id: i === 0 ? 'awareness' : i + 6, name: `Sample · ${name}`, source: i === 0 ? 'provider_cache' : 'managed',
  status: i === 2 ? 'paused' : 'active', providerStatus: i === 2 ? 'PAUSED' : 'ACTIVE',
  objective: ['awareness', 'leads', 'sales', 'engagement', 'traffic', 'leads', 'sales', 'traffic'][i],
  adPlatform: i === 6 ? 'google' : 'meta', platformCampaignId: i === 0 ? 'awareness' : `sample-${i}`,
  accountRegistryId: 12, currency: 'INR', budgetAmount: 25000, campaignAiConsent: i === 3,
  aiState: i === 1 ? 'insufficient_data' : i === 3 ? 'healthy' : 'recommendation', openRecommendations: i === 1 ? 1 : 0,
  metricsUpdatedAt: i === 1 ? '2026-10-24T12:00:00Z' : stamp,
  metrics: { spend: 8148.37 + i * 412, impressions: 240000 + i * 12000, reach: 232000 + i * 8000,
    clicks: 2400 + i * 150, leads: 92 + i * 8, conversions: 24 + i * 3, conversionValue: 120000 + i * 5000,
    engagements: 1300 + i * 92, installs: i === 4 ? 0 : null, ctr: 1.2, cpc: 3.4, cpm: 34 },
}));
const actions = [
  { id: 1, action_type: 'import_provider_campaign', actor_type: 'user', rationale: 'Sample campaign imported for monitoring. Provider delivery was unchanged.', created_at: stamp, provider_outcome: {} },
  { id: 2, action_type: 'evaluate', actor_type: 'system', rationale: 'Sample advisory evaluation recorded. No live provider action.', created_at: stamp, provider_outcome: {} },
];
export const populatedDetail = (managed: boolean) => ({
  campaign: { id: managed ? 7 : 'awareness', name: managed ? 'Sample · Resort enquiries' : 'Sample · Weekend escapes',
    objective: managed ? 'leads' : 'awareness', currency: 'INR', provider_status: managed ? 'PAUSED' : 'ACTIVE',
    ad_platform: 'meta', platformCampaignId: 'awareness', metrics_updated_at: stamp,
    reporting_window: { start: days[0], end: days[29] } },
  settings: { mode: 'advisory', analyticsSyncMinutes: 30, policyVersion: 'ads-pause-v1' },
  policy: { enabled: false, reportOnly: !managed, policyVersion: 'ads-pause-v1', thresholds: { targetCpl: 120, spendLimit: 25000 } },
  units: [
    { platform: 'meta', targetType: 'ad_set', targetKey: 'set-1', parentTargetKey: 'awareness', name: 'Sample · Weekend travellers', providerStatus: 'ACTIVE', metricsUpdatedAt: stamp, aggregate: { spend: 8148.37, reach: 232000, impressions: 240000, clicks: 2400, leads: 92 } },
    ...['Poolside mornings', 'Pet friendly escapes', 'Garden dining'].map((name, i) => ({
      platform: 'meta', targetType: 'ad', targetKey: `ad-${i + 1}`, parentTargetKey: 'set-1', name: `Sample · ${name}`,
      providerStatus: 'ACTIVE', metricsUpdatedAt: stamp,
      creative: { id: `creative-${i}`, name, primaryText: 'Make room for a slower weekend. Explore our sample resort collection.', headline: name,
        imageUrl: media(i), thumbnailUrl: media(i), destinationUrl: 'https://example.test/stays', callToActionType: 'LEARN_MORE' },
      aggregate: { spend: 2500 + i * 100, reach: 75000 + i * 2000, impressions: 80000 + i * 3000, clicks: 800 + i * 30, leads: 28 + i, ctr: 1.1, cpm: 32, frequency: 1.3 },
    })),
  ],
  evaluations: managed ? [{ id: 1, target_type: 'campaign', state: 'insufficient_data', confidence: null, rationale: 'Restore fresh measurements before evaluating delivery.', created_at: stamp }] : [],
  recommendations: managed ? [
    { id: 1, category: 'tracking', title: 'Restore campaign measurement', rationale: 'Fresh delivery evidence is required before making a performance assessment.', status: 'open', confidence: null,
      evidence: { objective: 'leads', affectedUnit: { platform: 'meta', targetType: 'campaign', targetKey: '7', name: 'Sample · Resort enquiries' },
        evidenceWindow: { start: days[0], end: days[29], metricsUpdatedAt: '2026-10-24T12:00:00Z' }, currentMetrics: { spend: 8148.37, impressions: 240000, reach: 232000, leads: 92 }, ruleResults: [] },
      expected_direction: 'Restore reliable measurement', suggested_next_step: 'Inspect sync diagnostics and refresh evidence.', created_at: stamp },
    { id: 2, category: 'tracking', title: 'Add UTM parameters to the destination', rationale: 'Use campaign-specific attribution to compare referral traffic.', status: 'accepted', confidence: 0.7,
      expected_direction: 'Improve attribution coverage', suggested_next_step: 'Review destination URL parameters before publishing.', created_at: stamp },
  ] : [],
  actions: managed ? actions : [], performanceTrace: days.map((date, i) => ({ date, spend: 140 + i * 7 + (i % 5) * 22, reach: 4200 + i * 120, leads: 2 + i % 4, clicks: 50 + i * 3 })),
  historicalBaselines: [], providerAggregate: { spend: 8148.37, impressions: 240000, reach: 232000, clicks: 2400, leads: 92, engagements: 1300 },
  accountIdentity: { platform: 'meta', adAccountId: 'sample-12', adAccountName: 'Sample hospitality', facebookPageId: 'sample-page', facebookPageName: 'Sample Stays', instagramUsername: 'sample.stays' },
  monitoring: { state: managed ? 'monitored' : 'report_only', canImport: !managed },
  analysisReadiness: { status: managed ? 'blocked' : 'import_required', baselineAvailable: false, successfulSyncWindows: managed ? 1 : 0,
    blockers: managed ? [{ code: 'metricsFresh', message: 'Sample evidence is stale. Refresh measurements before reviewing performance.' }] : [] },
  automationEligibility: { eligible: false, blockers: [{ code: 'accountMode', message: 'Account is in advisory mode.' }, { code: 'campaignConsent', message: 'Campaign pause consent is off.' }], candidateTargets: [] },
  currentAssessment: { rationale: 'Sample provider results are available. Import this campaign for a saved advisory assessment.', blockers: [], suggestedNextStep: 'Import the campaign for monitoring.' },
  hierarchyState: { status: 'success', groupCount: 1, adCount: 3 },
});

const posts = Array.from({ length: 8 }, (_, i) => ({
  id: String(123 + i), platform: 'instagram', type: ['image', 'reel', 'carousel', 'image'][i % 4],
  publishedAt: `2026-10-${String(28 - i * 2).padStart(2, '0')}T12:30:00Z`, caption: `Sample · ${sampleNames[i]}. A little more time outdoors, a little closer to what matters.`,
  permalink: `https://example.test/posts/${123 + i}`, thumbnailUrl: media(i), mediaUrl: media(i), mediaType: 'IMAGE', children: [],
  metrics: { views: 6200 + i * 170, reach: 4800 + i * 180, engagements: 420 + i * 17, likes: 350 + i * 10, comments: 8 + i, shares: 28 + i, saved: 34 + i, profile_visits: 76 + i, follows: 9 + i, clicks: 24 + i },
  metricsUpdatedAt: stamp, limitations: [], contributionPercent: 12.5,
}));
const trends = days.map((date, i) => ({ date, reach: 3200 + i * 90 + (i % 4) * 180, engagements: 220 + i * 12,
  views: 4200 + i * 120, followers: 18200 + i * 24, engagement_rate: 6.5, clicks: 28 + i, impressions: 5100 + i * 170 }));
const content = {
  items: posts, nextOffset: null, totalPosts: 32, matchedPosts: 8, metricTotals: { reach: 162400, views: 204600, engagements: 12480, profile_visits: 1840 },
  metricCoverage: { reach: 32, views: 32, engagements: 32, profile_visits: 32 },
  formats: ['image', 'reel', 'carousel'].map((type, i) => ({ type, posts: 8 + i * 2, metricTotals: { reach: 26000 + i * 12000, engagements: 1800 + i * 300 }, metricCoverage: { reach: 8 + i * 2, engagements: 8 + i * 2 } })),
  timeline: days.map((date, i) => ({ date, posts: i % 3 === 0 ? 1 : 0, reels: i % 4 === 0 ? 1 : 0, stories: i % 2 === 0 ? 1 : 0, items: [] })),
  topContent: posts.slice(0, 3), rankingMetric: 'reach', truncated: false,
  sync: { status: 'success', last_succeeded_at: stamp, limitations: [] },
};
const listening = Array.from({ length: 8 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, body: ['Is the pool open during the weekend?', 'We loved the garden breakfast. Thank you!', 'Could you share your pet policy?', 'Saving this for our next family break.'][i % 4],
  source: i === 3 ? 'manual' : 'official_api', kind: i === 3 ? 'manual' : i === 5 ? 'tags' : 'comments', sentiment: i % 3 === 0 ? 'neutral' : 'positive',
  author_handle: `sample_guest_${i + 1}`, public_url: 'https://example.test/comment', occurred_at: stamp,
  post: i === 3 ? null : { id: '123', caption: posts[0].caption, type: 'image', thumbnailUrl: media(0), permalink: posts[0].permalink },
  metadata: { reviewStatus: i === 2 ? 'reviewed' : 'unreviewed', sentimentSource: 'sample', collection: 'official_api' },
}));
const reports = Array.from({ length: 4 }, (_, i) => ({
  id: `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`, name: ['Sample · Weekly social pulse', 'Sample · Monthly account review', 'Sample · Campaign wrap-up', 'Sample · Content performance'][i],
  filters: { platform: 'instagram', accountIdentifier: 'sample-social', relativeDays: 30, timezone: 'Asia/Kolkata' },
  schedule_definition: i === 2 ? null : { frequency: i === 1 ? 'monthly' : 'weekly', dayOfWeek: 1, dayOfMonth: 1, localTime: '09:00', timezone: 'Asia/Kolkata' },
  delivery_channel: i === 1 ? 'email' : 'in_app', delivery_target: i === 1 ? 'review@example.test' : null, paused: i === 3,
  last_run_at: stamp, created_at: days[0],
}));

export async function installPopulatedMarketing(page: Page, options: { connected?: boolean; mutations?: boolean } = {}) {
  await page.clock.setFixedTime(new Date('2026-10-30T12:10:00Z'));
  const audit = { writes: [] as Array<{ path: string; method: string; body: unknown }>, errors: [] as string[], unhandled: [] as string[] };
  page.on('pageerror', error => audit.errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /ErrorBoundary|TypeError|ReferenceError|Rendered (?:more|fewer) hooks/.test(message.text())) audit.errors.push(message.text().slice(0, 1200));
  });
  await page.route('**/__marketing_fixture/*.svg', route => {
    const id = Number(route.request().url().match(/(\d+)\.svg/)?.[1] || 0);
    const colors = ['#c7e9f4', '#d8ead0', '#f1d4ad', '#c7ddd9'];
    return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect fill="${colors[id % 4]}" width="800" height="600"/><circle cx="650" cy="100" r="48" fill="#fff3c6"/><path d="M0 410 180 210 340 420 560 180 800 420V600H0Z" fill="#438c7d"/><path d="M0 490Q260 430 800 520V600H0Z" fill="#74c5d3"/><rect x="345" y="340" width="170" height="100" rx="5" fill="#fff8ed"/><path d="m325 340 105-70 105 70" fill="#b66b45"/><text x="32" y="50" font-family="Arial,sans-serif" font-size="22" fill="#244e57">SAMPLE MEDIA · ${id + 1}</text></svg>` });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (!['GET', 'HEAD'].includes(request.method())) {
      audit.writes.push({ path: p, method: request.method(), body: request.postDataJSON() });
      if (options.mutations && p === '/api/social-analytics/reports') return json({ ...reports[0], ...request.postDataJSON() });
      return json({ error: 'Mutation blocked by populated Marketing review fixture.' }, 409);
    }
    if (/^\/api\/(auth\/me|platform\/access|settings\/preferences|settings\/outreach\/assistants\/catalog|organizations|crm\/configuration|wallet|chat\/threads|notifications\/unread\/count)$/.test(p)) return route.fallback();
    if (p === '/api/settings/business-profiles') return json([{ id: 4102, name: 'Sample review', companyName: 'Sample review', isDefault: true, role: 'owner' }]);
    if (p === '/api/campaigns/accounts') return json({ accounts: [{ id: 12, platform: 'meta', name: 'Sample hospitality', currency: 'INR', timezone: 'Asia/Kolkata', is_manager: false, reporting_available: true, publishing_available: false, verified_at: stamp, last_succeeded_at: stamp, last_attempt_at: stamp, data_available_through: stamp }] });
    if (p === '/api/campaigns/analytics/dashboard') return json({ campaigns: populatedCampaigns, currency: 'INR', availableCurrencies: ['INR'],
      summary: { totalCampaigns: 8, activeCampaigns: 7, totalSpend: 76714.96, totalImpressions: 2256000, totalClicks: 23400, totalReach: 2080000, totalConversions: 276, avgCtr: 1.2, avgCpc: 3.4, avgCpm: 34, changes: { impressions: 12, clicks: 8, spend: 6, ctr: 0.1 }, includesProviderCache: true },
      dailyTrends: days.map((date, i) => ({ date, impressions: 42000 + i * 240, clicks: 420 + i * 12, spend: 1800 + i * 50, reach: 38000 + i * 270, conversions: 6 + i % 5 })),
      aiSummary: { settings: { mode: 'advisory', analyticsSyncMinutes: 30, policyVersion: 'ads-pause-v1' }, consentedCampaigns: 1, totalCampaigns: 7, watchedUnits: 3, pausedUnits: 0, lastEvaluationAt: stamp, dataFreshnessAt: stamp, recentActions: actions },
    });
    if (/\/api\/campaigns\/analytics\/provider\/meta\//.test(p)) return json(populatedDetail(false));
    if (/\/api\/campaigns\/autonomous\/7\/performance$/.test(p)) return json(populatedDetail(true));
    if (p.includes('meta-diagnostics/')) return json({ error: 'Sample recovery state: reconnect Meta Ads to refresh diagnostics.' }, 403);
    if (p === '/api/settings/ads') return json({ settings: { defaultLifetimeBudget: 100, currency: 'USD', locations: [], autonomousOptimizationEnabled: true, liveProviderMutationsEnabled: false, analyticsSyncMinutes: 30 }, readiness: { meta: true, google: false, reasons: {} }, environmentMutationGate: false });
    if (p === '/api/settings/ads/autonomy') return json({ settings: { mode: 'advisory', enabled: true, policyVersion: 'ads-pause-v1', consentedAt: null, notificationEmail: 'review@example.test', defaultThresholds: {} } });
    if (p === '/api/meta/oauth/platforms') return json({ platforms: [{ platform: 'meta', isActive: true, currency: 'INR' }] });
    if (p === '/api/campaigns/creative-intelligence/capabilities') return json({ enabled: true, commercialLibraryCountries: ['GB', 'DE'] });
    if (p === '/api/campaigns/creative-intelligence/briefs') return json([]);
    if (p === '/api/campaigns/creative-intelligence/competitor-profiles') return json({ status: 'unavailable', profiles: [], message: 'Commercial Ads Library API coverage is unavailable in this market. Manual references remain available.' });
    if (p === '/api/campaigns/meta/cache/campaigns') return json({ campaigns: populatedCampaigns.filter(c => c.source === 'provider_cache').map(c => ({ ...c, platformEntityId: c.platformCampaignId, campaignName: c.name, campaignStatus: 'ACTIVE', objective: c.objective, spend: c.metrics.spend, impressions: c.metrics.impressions, reach: c.metrics.reach, lastRefreshedAt: stamp, rawData: { campaign: { lifetime_budget: '2500000' } } })), lastRefreshedAt: stamp });
    if (p === '/api/campaigns/meta/campaigns') return json({ campaigns: [{ id: 'awareness', name: 'Sample · Weekend escapes', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_AWARENESS', lifetime_budget: '2500000', insights: { spend: '8148.37', impressions: '240000', reach: '232000', clicks: '2400' } }] });
    if (p === '/api/campaigns/autonomous') return json({ campaigns: [{ id: 9, name: 'Sample · Hospitality creative draft', local_status: 'draft', objective: 'traffic', budget_amount: 25000, budget_type: 'lifetime', currency: 'INR', ad_platform: 'meta', created_at: stamp, ad_sets: [] }] });
    if (p.startsWith('/api/channel-accounts/')) return json(options.connected !== false && p.endsWith('/instagram_api') ? [{ id: 26, accountIdentifier: 'sample-social', accountName: 'Sample Stays', displayName: 'Sample Stays', profilePictureUrl: media(0), analyticsReady: true, isSelected: true }] : []);
    if (p === '/api/social-analytics/dashboard') return json({ summary: { reach: 162400, engagements: 12480, views: 204600, followers: 18896, engagement_rate: 7.68, clicks: 1840, impressions: 241000 }, trends,
      previousPeriod: { start: '2026-09-01', end: '2026-09-30', summary: { reach: 142000, engagements: 10900, views: 180000 } },
      bestTime: { id: 1, platform: 'instagram', account_identifier: 'sample-social', timezone: 'Asia/Kolkata', sample_size: 32, confidence: 0.72, fallback_used: false, methodology: 'Sample observed engagement by publication hour. Sparse hours have no measurement.', recommended_slots: Array.from({ length: 18 }, (_, i) => ({ dayOfWeek: i % 7, hour: 8 + i % 12, averageEngagement: 40 + i * 9, observations: 2 + i % 3 })) },
      recommendation: { recommendation: 'Sample guidance: compare the weekend content themes using the same reporting window.', citations: [] },
      freshness: { latestSnapshotAt: stamp, snapshotCount: 30, evidenceSourceCount: 32 }, sync: { status: 'success', last_attempt_at: stamp, last_succeeded_at: stamp, next_due_at: null, error_code: null },
    });
    if (p === '/api/social-analytics/content') {
      const kind = url.searchParams.get('kind'); const q = (url.searchParams.get('q') || '').toLowerCase();
      const filtered = posts.filter(item => (!kind || kind === 'all' || item.type === kind) && item.caption.toLowerCase().includes(q));
      return json({ ...content, items: filtered, matchedPosts: filtered.length });
    }
    const postId = p.match(/\/content\/(\d+)$/)?.[1];
    if (postId) return json({ item: posts.find(item => item.id === postId) || posts[0], account: { id: 26, name: 'Sample Stays', identifier: 'sample-social', platform: 'instagram', pictureUrl: media(0) } });
    if (/\/content\/\d+\/comments$/.test(p)) return json({ comments: [{ id: 'comment-1', body: 'Is the pool open during the weekend?', author: 'sample_guest', publishedAt: stamp, likes: 4, isOwn: false, canReply: true, replies: [{ id: 'reply-1', body: 'Sample reply: yes, we will share the opening hours.', author: 'sample.stays', isOwn: true, source: 'sent', publishedAt: stamp, likes: 0 }] }], nextCursor: null, limitation: '', capabilities: { reply: true, moderate: true, reason: null } });
    if (p === '/api/social-analytics/listening') {
      const kind = url.searchParams.get('kind');
      const query = (url.searchParams.get('search') || '').toLowerCase();
      const sentiment = url.searchParams.get('sentiment');
      const review = url.searchParams.get('status');
      const items = listening.filter(item => (!kind || item.kind === kind) && item.body.toLowerCase().includes(query)
        && (!sentiment || item.sentiment === sentiment) && (!review || item.metadata.reviewStatus === review));
      return json({ items, total: items.length, nextOffset: null, summary: { positive: 5, neutral: 3, negative: 0 }, sourceSummary: { comments: 6, tags: 1, manual: 1 } });
    }
    if (p === '/api/social-analytics/competitors') return json(['Hill House', 'Garden Retreats', 'Coast & Co.'].map((name, i) => ({ id: `22222222-2222-4222-8222-${String(i + 1).padStart(12, '0')}`, platform: 'instagram', public_handle: `sample.competitor.${i}`, display_name: `Sample · ${name}`, public_url: 'https://example.test/competitor', is_active: true, last_refresh_status: 'success', last_refresh_attempt_at: stamp, last_refresh_error: null, latest_public_snapshot: { metrics: { followers: 12400 + i * 2000, posts: 160 + i * 30 }, capturedAt: stamp, source: 'manual', sourceUrl: 'https://example.test/evidence' } })));
    if (/\/competitors\/[^/]+\/benchmark$/.test(p)) return json({ benchmark: null, reason: 'Comparable dated evidence is required for growth comparisons.', citations: [] });
    if (p === '/api/social-analytics/reports') return json(reports);
    if (p === '/api/social-analytics/snapshots') return json([{ id: 'sample-snapshot-1', platform: 'instagram', account_identifier: 'sample-social', metric_window_start: days[0], metric_window_end: days[29], metrics: { reach: 162400, engagements: 12480 }, source: 'official_api', source_snapshot_id: 'sample-source-1', timezone: 'Asia/Kolkata' }]);
    if (/\/social-analytics\/reports\/[^/]+\/deliveries$/.test(p)) return json({ deliveries: [], nextOffset: null });
    audit.unhandled.push(`${request.method()} ${p}`);
    return json({ error: `Unmocked populated review endpoint: ${p}` }, 501);
  });
  return audit;
}
