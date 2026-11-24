import { test, expect } from './fixtures/app';

test.use({ video: 'off', launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });

for (const width of [390, 768, 1440]) {
  test(`paid brief is review-only and remains explicit after reload at ${width}px`, async ({ page, audit }, info) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    const mutations: string[] = [];
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort('blockedbyclient');
      if (url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(route.request().method())) mutations.push(`${route.request().method()} ${url.pathname}`);
        if (url.pathname === '/api/agents') return route.fulfill({ json: { agents: [] } });
        if (url.pathname === '/api/chat/agents') return route.fulfill({ json: { agents: [] } });
        return route.fallback();
      }
      return route.continue();
    });
    await page.goto('/dashboard/ads/create?platform=google');
    await expect(page.getByRole('heading', { name: 'Create a paid campaign' })).toBeVisible();
    await page.getByLabel('Campaign name').fill('Synthetic review-only campaign');
    await page.getByLabel('Budget guidance').fill('USD 100 total');
    await page.getByLabel('Audience, offer, and destination').fill('Synthetic audience. Demo only. https://example.test/offer');
    await expect(page.getByRole('combobox', { name: 'Platform', exact: true })).toHaveValue('google');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`brief-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Continue with Performance Marketing' }).click();
    await expect(page).toHaveURL(/paidAdBrief=/);
    const brief = new URL(page.url()).searchParams.get('paidAdBrief')!;
    expect(brief).toContain('USD 100 total');
    expect(brief).toContain('Platform: google');
    expect(brief).toContain('explicit publishing approval');
    await expect(page.getByRole('button', { name: 'Use this campaign brief' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Use this campaign brief' })).toBeVisible();
    expect(mutations.filter(path => /publish|autonomous|send|messages/.test(path))).toEqual([]);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`handoff-${width}.png`), fullPage: true });
    await info.attach('browser-audit', { body: JSON.stringify({ ...audit, pageErrors }, null, 2), contentType: 'application/json' });
    expect(pageErrors).toEqual([]);
  });
}

for (const width of [390, 1440]) {
  test(`manual research retries and saved research reload at ${width}px`, async ({ page, audit }, info) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    let enabled = false;
    const saved = { id: 501, status: 'succeeded', references: [], message: 'Synthetic observations saved. Competitor performance is unknown.', created_at: '2026-10-23T00:00:00Z', expires_at: null };
    const requestIds: string[] = [];
    const unexpectedMutations: string[] = [];
    await page.route('**/*', async route => {
      const req = route.request(); const url = new URL(req.url());
      if (!['127.0.0.1','localhost'].includes(url.hostname)) return route.abort('blockedbyclient');
      const path = url.pathname;
      if (path === '/api/campaigns/analytics/dashboard') return route.fulfill({ json: { currency:'USD', availableCurrencies:['USD'], campaigns:[], dailyTrends:[], summary:{totalCampaigns:0,activeCampaigns:0,totalSpend:0,totalImpressions:0,totalClicks:0,totalReach:0,totalConversions:0,avgCtr:0,avgCpc:0,avgCpm:0,changes:{impressions:null,clicks:null,spend:null,ctr:null}}, aiSummary:{settings:{mode:'off',analyticsSyncMinutes:15,policyVersion:'ads-pause-v1'},consentedCampaigns:0,totalCampaigns:0,watchedUnits:0,pausedUnits:0,lastEvaluationAt:null,dataFreshnessAt:null,recentActions:[]} } });
      if (path === '/api/campaigns/accounts') return route.fulfill({ json:{accounts:[]} });
      if (path.endsWith('/creative-intelligence/capabilities')) return route.fulfill({json:{enabled,commercialLibraryCountries:['GB']}});
      if (path.endsWith('/creative-intelligence/briefs')) return route.fulfill({json:[]});
      if (path.endsWith('/creative-intelligence/research') && req.method()==='POST') {
        requestIds.push(req.postDataJSON().requestId);
        return requestIds.length===1 ? route.fulfill({status:503,json:{error:'Synthetic research outage. Retry your saved request.'}}) : route.fulfill({status:202,json:saved});
      }
      if (path.endsWith('/creative-intelligence/research/501')) return route.fulfill({json:saved});
      if (path.startsWith('/api/') && !['GET','HEAD'].includes(req.method())) {
        unexpectedMutations.push(`${req.method()} ${path}`);
        return route.fulfill({status:409,json:{error:'Unexpected mutation blocked by audit.'}});
      }
      return route.fallback();
    });
    await page.goto('/dashboard/ads?tab=recommendations');
    await expect(page.getByText('New competitor research is not enabled', {exact:false})).toBeVisible();
    enabled = true;
    await page.getByRole('button',{name:'Check availability again'}).click();
    await page.getByLabel('Competitor name').fill('Synthetic competitor');
    await page.getByLabel('Observed ad copy').fill('Observed product demo. No measured performance.');
    await page.getByRole('button',{name:'Save research',exact:true}).click();
    await expect(page.getByRole('alert').filter({hasText:'Synthetic research outage'})).toBeVisible();
    await page.getByRole('button',{name:'Save research',exact:true}).click();
    await expect(page).toHaveURL(/creativeResearch=501/);
    expect(requestIds).toHaveLength(2); expect(requestIds[1]).toBe(requestIds[0]);
    await expect(page.getByText(saved.message,{exact:false})).toBeVisible();
    await page.reload();
    await expect(page.getByText(saved.message,{exact:false})).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(unexpectedMutations).toEqual([]);
    await page.getByText(saved.message,{exact:false}).scrollIntoViewIfNeeded();
    await page.screenshot({path:info.outputPath(`research-${width}.png`),fullPage:true});
    for (const name of ['Campaigns','Automation & activity','Overview']) {
      await page.getByRole('tab',{name,exact:true}).click();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    }
    await info.attach('browser-audit', { body: JSON.stringify({ ...audit, pageErrors }, null, 2), contentType: 'application/json' });
    expect(pageErrors).toEqual([]);
  });
}
