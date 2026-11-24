import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), toast: vi.fn(), replace: vi.fn(), push: vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 1 } }) }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(window.location.search), useRouter: () => ({ replace: mocks.replace, push: mocks.push }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a> }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, post: mocks.post, put: mocks.put, patch: mocks.patch } }));
vi.mock('recharts', () => ({ Area: () => null, AreaChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>, CartesianGrid: () => null, ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>, Tooltip: () => null, XAxis: () => null, YAxis: () => null }));

import CampaignDetailPage, { creativeFatigueSignal } from '@/components/performance-marketing/CampaignDetailPage';

const providerDetail = {
  campaign: { id: 'provider:meta:campaign-7', name: 'Lead engine', objective: 'leads', currency: 'INR', provider_status: 'PAUSED', ad_platform: 'meta', platformCampaignId: 'campaign-7', metrics_updated_at: '2026-08-29T12:00:00Z' },
  settings: { mode: 'advisory', analyticsSyncMinutes: 30, policyVersion: 'ads-pause-v1' },
  policy: { enabled: false, policyVersion: 'ads-pause-v1', thresholds: {}, reportOnly: true },
  units: [
    { platform: 'meta', targetType: 'ad_set', targetKey: 'set-1', parentTargetKey: 'campaign-7', name: 'Warm audience', providerStatus: 'CAMPAIGN_PAUSED', aggregate: { spend: 150, impressions: 2500, clicks: 70, conversions: 4 } },
    { platform: 'meta', targetType: 'ad', targetKey: 'ad-1', parentTargetKey: 'set-1', name: 'Proof creative', providerStatus: 'CAMPAIGN_PAUSED', creative: { name: 'Internal creative name', headline: 'Reply while intent is high' }, aggregate: { spend: 90, impressions: 1500, clicks: 50, conversions: 4 } },
  ],
  evaluations: [], recommendations: [], actions: [], performanceTrace: [], historicalBaselines: [],
  providerAggregate: { spend: 240, impressions: 4000, clicks: 120, conversions: 8, leads: 8 },
  accountIdentity: { adAccountName: 'Oro Circle Ads', facebookPageName: 'Oro Circle', instagramUsername: 'orocircle' },
  monitoring: { state: 'report_only', importedCampaignId: null, canImport: true },
  analysisReadiness: { status: 'import_required', blockers: [{ code: 'importRequired', message: 'Import this campaign into AskSales monitoring.' }], baselineAvailable: false, successfulSyncWindows: 0 },
  automationEligibility: { eligible: false, blockers: [{ code: 'importRequired', message: 'Import required.' }] }, currentAssessment: null,
};

describe('dedicated Paid Ads campaign pages', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/dashboard/ads/campaigns/provider/meta/campaign-7'); Object.values(mocks).forEach(mock => mock.mockReset()); mocks.get.mockResolvedValue(providerDetail); });

  it('loads the full campaign page with an objective-specific funnel and hierarchy tab', async () => {
    render(<CampaignDetailPage source="provider" platform="meta" campaignId="campaign-7"/>);
    expect(await screen.findByRole('heading', { name: 'Lead engine' })).toBeInTheDocument();
    for (const label of ['Spend', 'Clicks', 'Leads', 'CPL']) expect(within(screen.getByRole('group', { name: 'Objective performance metrics' })).getByText(label)).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Ads & ad sets' }), { button: 0 });
    fireEvent.click(screen.getByRole('tab', { name: 'Ads & ad sets' }));
    expect(mocks.replace).toHaveBeenCalledWith(expect.stringContaining('tab=delivery'), { scroll: false });
    expect(screen.getByText('Warm audience')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Recommendations' }), { button: 0 });
    fireEvent.click(screen.getByRole('tab', { name: 'Recommendations' }));
    expect(screen.getByRole('tab', { name: 'Recommendations' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Campaign review')).toBeInTheDocument();
    expect(screen.getByText('Import this campaign for saved evaluations and an advisory recommendation history.')).toBeInTheDocument();
    expect(mocks.replace).toHaveBeenCalledWith(expect.stringContaining('tab=recommendations'), { scroll: false });
  }, 15_000);

  it('uses connected account identity and never substitutes the creative name', async () => {
    window.history.replaceState(null, '', '/dashboard/ads/campaigns/provider/meta/campaign-7?tab=creative');
    render(<CampaignDetailPage source="provider" platform="meta" campaignId="campaign-7"/>);
    expect(await screen.findAllByText('Oro Circle').then(matches => matches[0])).toBeInTheDocument();
    expect(screen.queryByText('Internal creative name')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Instagram' }));
    expect(await screen.findAllByText('@orocircle')).not.toHaveLength(0);
  });

  it('imports, evaluates, and navigates to the managed canonical route', async () => {
    mocks.post.mockResolvedValue({ campaign: { id: 42 }, detail: { ...providerDetail, policy: { ...providerDetail.policy, reportOnly: false } } });
    render(<CampaignDetailPage source="provider" platform="meta" campaignId="campaign-7"/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Import for AI monitoring' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/campaigns/autonomous/import-provider', { platform: 'meta', platformCampaignId: 'campaign-7' }));
    expect(mocks.replace).toHaveBeenCalledWith('/dashboard/ads/campaigns/managed/42');
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Analysis ready', description: expect.stringContaining('Meta delivery was not changed') }));
  });

  it('shows a retryable error instead of a false empty hierarchy', async () => {
    mocks.get.mockRejectedValue(new Error('Provider campaign not found.'));
    render(<CampaignDetailPage source="provider" platform="meta" campaignId="stale"/>);
    expect(await screen.findByText('Campaign analytics unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('retains the filtered inventory return route through Meta diagnostic recovery links', async () => {
    const returnTo = '/dashboard/ads?tab=campaigns&objective=leads&status=active&search=Oro';
    window.history.replaceState(null, '', '/dashboard/ads/campaigns/provider/meta/campaign-7?' + new URLSearchParams({ account: '12', period: '7d', tab: 'meta', returnTo }));
    mocks.get.mockImplementation((url: string) => url.includes('meta-diagnostics') ? Promise.reject(new Error('Reconnect Meta Ads.')) : Promise.resolve(providerDetail));
    render(<CampaignDetailPage source="provider" platform="meta" campaignId="campaign-7"/>);
    const link = await screen.findByRole('link', { name: 'Campaign summary' });
    const destination = new URL(link.getAttribute('href')!, 'https://asksales.local');
    expect(destination.pathname).toBe('/dashboard/ads/campaigns/provider/meta/campaign-7');
    expect(destination.searchParams.get('tab')).toBeNull();
    expect(destination.searchParams.get('account')).toBe('12');
    expect(destination.searchParams.get('period')).toBe('7d');
    const inventory = new URL(destination.searchParams.get('returnTo')!, 'https://asksales.local');
    expect(inventory.searchParams.get('objective')).toBe('leads');
    expect(inventory.searchParams.get('status')).toBe('active');
    expect(inventory.searchParams.get('search')).toBe('Oro');
  });

  it('accepts a recommendation and opens the review-only editing workflow', async () => {
    window.history.replaceState(null, '', '/dashboard/ads/campaigns/managed/42?tab=recommendations');
    mocks.patch.mockResolvedValue({ status: 'accepted' });
    mocks.get.mockResolvedValue({
      ...providerDetail,
      campaign: { ...providerDetail.campaign, id: 42 },
      policy: { ...providerDetail.policy, reportOnly: false },
      evaluations: [{ id: 1, state: 'healthy', confidence: 0.8, created_at: '2026-08-29T12:00:00Z' }],
      analysisReadiness: { status: 'ready', blockers: [], baselineAvailable: true, successfulSyncWindows: 3 },
      recommendations: [{ id: 9, category: 'creative', title: 'Refresh the hook', rationale: 'A sibling creative has a stronger CTR.', expected_direction: 'Increase CTR', suggested_next_step: 'Review a revised variant.', confidence: 0.8, status: 'open', created_at: '2026-08-29T12:00:00Z' }],
    });
    render(<CampaignDetailPage source="managed" campaignId="42"/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept and review' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('/api/campaigns/autonomous/42/recommendations/9', { status: 'accepted' }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/ads?tab=campaigns&edit=42&recommendation=9');
  });

  it('keeps blocked data-quality recommendations reviewable without claiming confidence', async () => {
    window.history.replaceState(null, '', '/dashboard/ads/campaigns/managed/42?tab=recommendations');
    mocks.patch.mockResolvedValue({ status: 'accepted' });
    mocks.get.mockResolvedValue({
      ...providerDetail,
      campaign: { ...providerDetail.campaign, id: 42 },
      policy: { ...providerDetail.policy, reportOnly: false },
      evaluations: [{ id: 6, state: 'insufficient_data', confidence: null, created_at: '2026-08-31T12:00:00Z' }],
      analysisReadiness: { status: 'blocked', blockers: [{ code: 'metricsFresh', message: 'Performance metrics are stale.' }], baselineAvailable: false, successfulSyncWindows: 0, latestSyncStatus: 'failed' },
      recommendations: [{ id: 6, evaluation_id: 6, category: 'tracking', title: 'tracking improvement for campaign', rationale: 'Performance data is stale.', expected_direction: 'Restore reliable measurement', suggested_next_step: 'Resolve synchronization issues.', confidence: null, status: 'open', created_at: '2026-08-31T12:00:00Z' }],
    });
    render(<CampaignDetailPage source="managed" campaignId="42"/>);
    expect(await screen.findByText('Restore campaign measurement')).toBeInTheDocument();
    expect(screen.getByText('Analysis blocked')).toBeInTheDocument();
    expect(screen.getByText('Evidence incomplete')).toBeInTheDocument();
    expect(screen.queryByText('100% confidence')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept and inspect data' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('/api/campaigns/autonomous/42/recommendations/6', { status: 'accepted' }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/ads/campaigns/managed/42?tab=technical');
  });

  it('requires a dismissal reason and records implementation notes', async () => {
    window.history.replaceState(null, '', '/dashboard/ads/campaigns/managed/42?tab=recommendations');
    const baseRecommendation = { id: 12, category: 'creative', title: 'Test a stronger hook', rationale: 'CTR declined against the configured target.', evidence: { affectedUnit: { targetType: 'ad', targetKey: 'ad-12', name: 'Proof creative' }, evidenceWindow: { start: '2026-09-01', end: '2026-09-07', metricsUpdatedAt: '2026-09-08T00:00:00Z' }, currentMetrics: { spend: 100, impressions: 2000, clicks: 20, ctr: 1 }, targetMetrics: { targetCtr: 2 } }, expected_direction: 'Increase qualified CTR', suggested_next_step: 'Prepare a revised hook for review.', confidence: 0.8, created_at: '2026-09-08T00:00:00Z' };
    const detail = { ...providerDetail, campaign: { ...providerDetail.campaign, id: 42 }, policy: { ...providerDetail.policy, reportOnly: false }, evaluations: [{ id: 12, state: 'recommendation', confidence: 0.8, created_at: '2026-09-08T00:00:00Z' }], analysisReadiness: { status: 'ready', blockers: [], baselineAvailable: true, successfulSyncWindows: 3 }, recommendations: [{ ...baseRecommendation, status: 'open' }] };
    mocks.get.mockResolvedValue(detail);
    mocks.patch.mockResolvedValue({ recommendation: { ...baseRecommendation, status: 'dismissed' } });
    const first = render(<CampaignDetailPage source="managed" campaignId="42"/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.getByRole('button', { name: 'Dismiss recommendation' })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/brand traffic/i), { target: { value: 'This is an intentional brand-only test.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss recommendation' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('/api/campaigns/autonomous/42/recommendations/12', { status: 'dismissed', dismissReason: 'This is an intentional brand-only test.' }));
    first.unmount();

    mocks.get.mockResolvedValue({ ...detail, recommendations: [{ ...baseRecommendation, status: 'accepted' }] });
    const second = render(<CampaignDetailPage source="managed" campaignId="42"/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark implemented' }));
    fireEvent.change(screen.getByPlaceholderText(/Describe the creative/i), { target: { value: 'Published revised hook after manual review.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark implemented' }));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledWith('/api/campaigns/autonomous/42/recommendations/12', { status: 'implemented', implementationNote: 'Published revised hook after manual review.' }));
    second.unmount();
  });

  it('saves CPL, CPA, ROAS, and spend-limit targets from automation setup', async () => {
    window.history.replaceState(null, '', '/dashboard/ads/campaigns/managed/42?tab=automation');
    const managed = { ...providerDetail, campaign: { ...providerDetail.campaign, id: 42 }, policy: { ...providerDetail.policy, reportOnly: false }, automationEligibility: { eligible: false, blockers: [{ code: 'accountMode', message: 'Account mode is not Live pause.' }], nextEvaluationAt: '2026-09-15T14:00:00Z', candidateTargets: [] } };
    mocks.get.mockResolvedValue(managed);
    mocks.put.mockResolvedValue({ policy: { ...managed.policy, thresholds: { targetCpl: 500, targetCpa: 700, targetRoas: 3, spendLimit: 50000 } } });
    render(<CampaignDetailPage source="managed" campaignId="42"/>);
    fireEvent.change(await screen.findByLabelText('Target CPL (INR)'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Target CPA (INR)'), { target: { value: '700' } });
    fireEvent.change(screen.getByLabelText('Target ROAS'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Campaign spend limit (INR)'), { target: { value: '50000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save business targets' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/campaigns/autonomous/42/policy', { enabled: false, thresholds: { targetCpl: 500, targetCpa: 700, targetRoas: 3, spendLimit: 50000 } }));
  });
});

it('does not display general conversions as lead results in ad rows', async () => {
  window.history.replaceState(null, '', '/dashboard/ads/campaigns/provider/meta/campaign-7?tab=delivery');
  mocks.get.mockResolvedValue({...providerDetail,units:[{...providerDetail.units[1],aggregate:{spend:128,impressions:1000,clicks:50,leads:0,conversions:67}}]});
  render(<CampaignDetailPage source="provider" platform="meta" campaignId="campaign-7"/>);
  await screen.findByRole('heading', {name:'Ad performance ranking'});
  expect(screen.queryByText('67')).not.toBeInTheDocument();
  expect(screen.getAllByText('0').length).toBeGreaterThan(0);
});

describe('creative fatigue evidence',()=>{
  it('requires sufficient delivery before making a fatigue claim',()=>{
    expect(creativeFatigueSignal([{date:'2026-09-01',impressions:999,clicks:10,spend:5,conversions:1}])).toMatchObject({state:'insufficient'});
  });
  it('requires combined CTR, cost, and frequency deterioration',()=>{
    const points=[
      {date:'2026-09-01',impressions:1000,clicks:40,spend:40,conversions:4,frequency:1.2},
      {date:'2026-09-02',impressions:1000,clicks:40,spend:40,conversions:4,frequency:1.3},
      {date:'2026-09-03',impressions:1000,clicks:40,spend:40,conversions:4,frequency:1.4},
      {date:'2026-09-04',impressions:1000,clicks:20,spend:60,conversions:3,frequency:2.2},
      {date:'2026-09-05',impressions:1000,clicks:20,spend:60,conversions:3,frequency:2.3},
      {date:'2026-09-06',impressions:1000,clicks:20,spend:60,conversions:3,frequency:2.4},
    ];
    expect(creativeFatigueSignal(points, 'conversions')).toMatchObject({state:'fatigue',label:'Fatigue signal'});
    expect(creativeFatigueSignal(points.map(point=>({...point,frequency:1.1})), 'conversions')).toMatchObject({state:'watch'});
  });
});

it('shows awareness CPM consistently in summary and ad-set delivery, with no false reconciliation warning',async()=>{
  window.history.replaceState(null,'','/dashboard/ads/campaigns/provider/meta/awareness');
  Object.values(mocks).forEach(mock=>mock.mockReset());
  mocks.get.mockResolvedValue({...providerDetail,campaign:{...providerDetail.campaign,objective:'awareness'},providerAggregate:{spend:255,impressions:100000,reach:80000},units:[{...providerDetail.units[0],aggregate:{spend:255,impressions:100000,reach:80000}}]});
  render(<CampaignDetailPage source="provider" platform="meta" campaignId="awareness"/>);
  expect(await screen.findByText('CPM')).toBeInTheDocument();
  expect(screen.getByText('₹2.55')).toBeInTheDocument();
  fireEvent.mouseDown(screen.getByRole('tab',{name:'Ads & ad sets'}),{button:0});
  fireEvent.click(screen.getByRole('tab',{name:'Ads & ad sets'}));
  expect(screen.getByText('₹2.55')).toBeInTheDocument();
  expect(screen.queryByText('₹0.00')).not.toBeInTheDocument();
  fireEvent.mouseDown(screen.getByRole('tab',{name:'Technical details'}),{button:0});
  fireEvent.click(screen.getByRole('tab',{name:'Technical details'}));
  expect(screen.queryByText('Review differences')).not.toBeInTheDocument();
});
it('uses lead evidence in accessible trend values instead of substituting conversions',async()=>{
  window.history.replaceState(null,'','/dashboard/ads/campaigns/provider/meta/lead');
  Object.values(mocks).forEach(mock=>mock.mockReset());
  mocks.get.mockResolvedValue({...providerDetail,performanceTrace:[{date:'2026-09-18',spend:99,leads:null,conversions:100,clicks:12,reach:50}]});
  render(<CampaignDetailPage source="provider" platform="meta" campaignId="lead"/>);
  expect(await screen.findByText('Accessible trend values')).toBeInTheDocument();
  expect(screen.getByText('Unavailable')).toBeInTheDocument();
  expect(screen.queryByRole('columnheader',{name:'Conversions'})).not.toBeInTheDocument();
});

function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; }
it.each(['success','error'])('ignores an older account/period response after the current context succeeds (%s)',async outcome=>{
 Object.values(mocks).forEach(mock=>mock.mockReset());
 const old=deferred<typeof providerDetail>();const current=deferred<typeof providerDetail>();
 mocks.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
 window.history.replaceState(null,'','/dashboard/ads/campaigns/provider/meta/campaign-7?account=11&period=7d');
 const view=render(<CampaignDetailPage source="provider" platform="meta" campaignId="campaign-7"/>);
 await waitFor(()=>expect(mocks.get).toHaveBeenCalledTimes(1));
 window.history.replaceState(null,'','/dashboard/ads/campaigns/provider/meta/campaign-7?account=12&period=30d');
 view.rerender(<CampaignDetailPage source="provider" platform="meta" campaignId="campaign-7"/>);
 await waitFor(()=>expect(mocks.get).toHaveBeenCalledTimes(2));
 await act(async()=>current.resolve({...providerDetail,campaign:{...providerDetail.campaign,name:'Current account evidence'}}));
 expect(await screen.findByRole('heading',{name:'Current account evidence'})).toBeInTheDocument();
 await act(async()=>outcome==='success'?old.resolve({...providerDetail,campaign:{...providerDetail.campaign,name:'Old account evidence'}}):old.reject(new Error('Old context failure')));
 expect(screen.getByRole('heading',{name:'Current account evidence'})).toBeInTheDocument();
 expect(screen.queryByText(/Old account evidence|Old context failure/)).not.toBeInTheDocument();
});
it('clears prior-context evidence while the next account is loading and ignores late import navigation',async()=>{
 Object.values(mocks).forEach(mock=>mock.mockReset());mocks.get.mockResolvedValueOnce(providerDetail);
 const pending=deferred<any>();mocks.post.mockReturnValue(pending.promise);
 window.history.replaceState(null,'','/dashboard/ads/campaigns/provider/meta/campaign-7?account=11&period=7d');
 const view=render(<CampaignDetailPage source="provider" platform="meta" campaignId="campaign-7"/>);
 fireEvent.click(await screen.findByRole('button',{name:'Import for AI monitoring'}));
 mocks.get.mockReturnValue(new Promise(()=>{}));
 window.history.replaceState(null,'','/dashboard/ads/campaigns/provider/meta/campaign-7?account=12&period=30d');
 view.rerender(<CampaignDetailPage source="provider" platform="meta" campaignId="campaign-7"/>);
 expect(screen.queryByRole('heading',{name:'Lead engine'})).not.toBeInTheDocument();
 await act(async()=>pending.resolve({campaign:{id:42},detail:providerDetail}));
 expect(mocks.replace).not.toHaveBeenCalled();expect(mocks.toast).not.toHaveBeenCalled();
});

it('retains direct-link account and period context after provider import',async()=>{
 Object.values(mocks).forEach(mock=>mock.mockReset());mocks.get.mockResolvedValue(providerDetail);mocks.post.mockResolvedValue({campaign:{id:42}});
 window.history.replaceState(null,'','/dashboard/ads/campaigns/provider/meta/campaign-7?account=12&period=7d');
 render(<CampaignDetailPage source="provider" platform="meta" campaignId="campaign-7"/>);
 fireEvent.click(await screen.findByRole('button',{name:'Import for AI monitoring'}));
 await waitFor(()=>expect(mocks.replace).toHaveBeenCalled());
 const target=new URL(mocks.replace.mock.calls[0][0],'https://asksales.local');
 expect(target.pathname).toBe('/dashboard/ads/campaigns/managed/42');
 expect(target.searchParams.get('account')).toBe('12');expect(target.searchParams.get('period')).toBe('7d');
 const back=new URL(target.searchParams.get('returnTo')!,'https://asksales.local');expect(back.searchParams.get('account')).toBe('12');expect(back.searchParams.get('period')).toBe('7d');
});

describe('objective performance metric chain', () => {
  const cases = [
    { objective: 'traffic', labels: ['Spend', 'Impressions', 'Clicks', 'CPC'], values: ['$240.00', '4K', '120', '$2.00'], preceding: 'impressions', result: 'clicks' },
    { objective: 'reach', labels: ['Spend', 'Impressions', 'Reach', 'CPM'], values: ['$240.00', '4K', '2K', '$60.00'], preceding: 'impressions', result: 'reach' },
    { objective: 'leads', labels: ['Spend', 'Clicks', 'Leads', 'CPL'], values: ['$240.00', '120', '8', '$30.00'], preceding: 'clicks', result: 'leads' },
    { objective: 'sales', labels: ['Spend', 'Clicks', 'Purchases', 'CPA'], values: ['$240.00', '120', '4', '$60.00'], preceding: 'clicks', result: 'conversions' },
  ];
  function renderedChain() {
    const content = screen.getByRole('group', { name: 'Objective performance metrics' });
    expect(content).not.toBeNull();
    return Array.from(content!.children).map(cell => Array.from(cell.querySelectorAll('p')).map(text => text.textContent));
  }
  async function show(objective: string, metrics: Record<string, number | null | undefined>) {
    window.history.replaceState(null, '', `/dashboard/ads/campaigns/provider/meta/chain?account=12&period=7d`);
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.get.mockResolvedValue({ ...providerDetail, campaign: { ...providerDetail.campaign, name: 'Synthetic metric chain', objective, currency: 'USD' }, providerAggregate: metrics });
    render(<CampaignDetailPage source="provider" platform="meta" campaignId="chain"/>);
    await screen.findByRole('heading', { name: 'Synthetic metric chain' });
    expect(mocks.get).toHaveBeenCalledWith('/api/campaigns/analytics/provider/meta/chain?period=7d&account=12');
    return renderedChain();
  }
  const metrics = { spend: 240, impressions: 4000, clicks: 120, reach: 2000, leads: 8, conversions: 4 };

  it.each(cases)('shows distinct truthful labels and values for $objective', async ({ objective, labels, values }) => {
    const chain = await show(objective, metrics);
    expect(chain.map(([label]) => label)).toEqual(labels);
    expect(new Set(chain.map(([label]) => label)).size).toBe(4);
    expect(chain.map(([, value]) => value)).toEqual(values);
  });

  it.each(cases)('keeps an unavailable preceding metric unavailable for $objective', async ({ objective, labels, preceding, values }) => {
    const chain = await show(objective, { ...metrics, [preceding]: null });
    expect(chain.map(([label]) => label)).toEqual(labels);
    expect(chain[1][1]).toBe('—');
    expect(chain[2][1]).toBe(values[2]);
  });

  it.each(cases)('preserves measured zero results for $objective without inventing a zero unit cost', async ({ objective, result }) => {
    const chain = await show(objective, { ...metrics, [result]: 0 });
    expect(chain[2][1]).toBe('0');
    expect(chain[3][1]).toBe(objective === 'reach' ? '$60.00' : '—');
  });

  it.each(cases)('keeps missing objective results unavailable for $objective', async ({ objective, result }) => {
    const chain = await show(objective, { ...metrics, [result]: undefined });
    expect(chain[2][1]).toBe('—');
    expect(chain[3][1]).toBe(objective === 'reach' ? '$60.00' : '—');
  });
});
