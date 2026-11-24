import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';

const cases = [
  { objective: 'traffic', labels: ['Spend', 'Impressions', 'Clicks', 'CPC'], values: ['$240.00', '4K', '120', '$2.00'] },
  { objective: 'reach', labels: ['Spend', 'Impressions', 'Reach', 'CPM'], values: ['$240.00', '4K', '2K', '$60.00'] },
  { objective: 'leads', labels: ['Spend', 'Clicks', 'Leads', 'CPL'], values: ['$240.00', '120', '8', '$30.00'] },
  { objective: 'sales', labels: ['Spend', 'Clicks', 'Purchases', 'CPA'], values: ['$240.00', '120', '4', '$60.00'] },
];

test('objective chains use distinct measured stages and preserve unavailable values', async ({ page, audit }, info) => {
  const reads: string[] = [];
  let missing = false;
  await page.route('**/*', async route => {
    const request = route.request();
    if (!['localhost', '127.0.0.1'].includes(new URL(request.url()).hostname)) return route.abort();
    if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) {
      audit.blockedMutations.push(`${request.method()} ${request.url()}`);
      return route.abort();
    }
    return route.fallback();
  });
  await page.route('**/api/campaigns/analytics/provider/meta/chain*', async route => {
    const url = new URL(route.request().url());
    expect(route.request().method()).toBe('GET');
    expect(url.searchParams.get('account')).toBe('12');
    expect(url.searchParams.get('period')).toBe('7d');
    const objective = url.pathname.split('/').pop()!.replace('chain-', '');
    const unavailable = missing;
    reads.push(`${objective}:${unavailable ? 'unavailable' : 'measured'}`);
    await route.fulfill({ json: {
      campaign: { id: `chain-${objective}`, name: `Synthetic ${objective} chain`, objective, currency: 'USD', provider_status: 'PAUSED', ad_platform: 'meta' },
      settings: { mode: 'off', analyticsSyncMinutes: 15, policyVersion: 'ads-pause-v1' },
      policy: { enabled: false, reportOnly: true, policyVersion: 'ads-pause-v1', thresholds: {} },
      units: [], evaluations: [], recommendations: [], actions: [], performanceTrace: [], historicalBaselines: [],
      providerAggregate: unavailable
        ? { spend: 240, impressions: null, clicks: null, reach: null, leads: null, conversions: null }
        : { spend: 240, impressions: 4000, clicks: 120, reach: 2000, leads: 8, conversions: 4 },
      monitoring: { state: 'report_only', canImport: false },
    } });
  });
  const card = page.locator('.shadcn-card').filter({ has: page.getByText('Objective performance', { exact: true }) });
  for (const item of cases) {
    // Missing evidence comes from the synthetic API response, never a provider.
    for (const unavailable of [false, true]) {
      missing = unavailable;
      await page.goto(`/dashboard/ads/campaigns/provider/meta/chain-${item.objective}?account=12&period=7d${unavailable ? '&unit=unavailable' : ''}`);
      await expect(page.getByRole('heading', { name: `Synthetic ${item.objective} chain` })).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      await expect(card).toBeInViewport();
      await expect(card.locator('p.text-xs')).toHaveText(item.labels);
      await expect(card.locator('p.font-mono')).toHaveText(unavailable ? ['$240.00', '—', '—', '—'] : item.values);
      expect(new Set(await card.locator('p.text-xs').allTextContents()).size).toBe(4);
      expect(await page.evaluate(() => window.visualViewport?.scale || 1)).toBeCloseTo(1, 2);
      await expectNoHorizontalOverflow(page);
      if (item.objective === 'traffic') await page.screenshot({ path: info.outputPath(`traffic-${unavailable ? 'unavailable' : 'measured'}.png`), fullPage: true });
    }
  }
  expect(reads).toEqual(cases.flatMap(item => [`${item.objective}:measured`, `${item.objective}:unavailable`]));
  expect(audit.consoleErrors).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
  await info.attach('objective-chain-reads', { body: JSON.stringify(reads), contentType: 'application/json' });
});
