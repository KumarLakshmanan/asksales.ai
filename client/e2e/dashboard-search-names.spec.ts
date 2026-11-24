import { createServer } from 'node:http';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';
import { failureText, installCampaignRequestAudit, observeConversationNavigationBodies } from './fixtures/campaign-request-audit';
import { searchBookings, searchCampaigns, searchNoMatch, searchRoomTypes, searchRuns } from '../src/__tests__/fixtures/as017Searches';

const shellReads = new Set([
  '/api/auth/me', '/api/platform/access', '/api/settings/preferences', '/api/organizations',
  '/api/settings/business-profiles', '/api/crm/configuration', '/api/wallet', '/api/notifications/unread/count',
]);

// Every API request is fulfilled locally, and every write is rejected before reaching a backend.
test.beforeEach(async ({ page, audit }) => {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['GET', 'HEAD'].includes(request.method())) {
      audit.blockedMutations.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 409, json: { error: 'Unexpected write in AS017 read-only regression.' } });
    }
    if (shellReads.has(url.pathname)) return route.fallback();
    if (url.pathname === '/api/enrichments') return route.fulfill({ json: searchRuns });
    if (url.pathname === '/api/chat/threads') {
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 10);
      return route.fulfill({ json: { threads: searchCampaigns.slice(offset, offset + limit), total: searchCampaigns.length, limit, offset } });
    }
    const conversation = url.pathname.match(/^\/api\/chat\/threads\/(\d+)(?:\/(messages|tabs|turns|overview|context-window))?$/);
    if (conversation) {
      const thread = searchCampaigns.find(campaign => campaign.id === Number(conversation[1]));
      if (!thread) return route.fulfill({ status: 404, json: { error: 'Unknown synthetic conversation' } });
      if (conversation[2] === 'messages') return route.fulfill({ json: { messages: [{
        id: thread.id * 10, role: 'agent', agentType: 'orchestrator',
        content: `Synthetic saved message for campaign ${thread.id}`, createdAt: thread.createdAt,
      }], hasMore: false, nextCursor: null } });
      if (conversation[2] === 'tabs') return route.fulfill({ json: [{
        tabId: `overview-${thread.id}`, tabType: 'overview', tabLabel: 'Overview', tabOrder: 0, isActive: true,
      }] });
      if (conversation[2] === 'turns') return route.fulfill({ json: [] });
      if (conversation[2] === 'context-window') return route.fulfill({ json: {
        threadId: thread.id, messageCount: 1, summary: null, lastCompactedAt: null, canCompact: false,
        tokenUsage: { totalTokens: 0, promptTokens: 0, completionTokens: 0, estimatedCurrentContextTokens: 0,
          maxContextTokens: 128000, modelName: 'synthetic-no-model-call', usagePercent: 0 },
      } });
      if (conversation[2] === 'overview') return route.fulfill({ json: {
        thread, stats: { ...thread.stats, messageCount: 1, contentAssetsCount: 0, agentExecutionsCount: 0, scrapingCount: 0 },
        icp: null, activeAgents: [], workflowExecutions: [], timeline: [],
      } });
      return route.fulfill({ json: thread });
    }
    if (/^\/api\/icp\/thread\/\d+$/.test(url.pathname)) return route.fulfill({ json: null });
    if (url.pathname === '/api/settings/business-profiles/4102') return route.fulfill({ json: {
      id: 4102, name: 'Regression Business', companyName: 'Regression Company', isDefault: true,
    } });
    if (url.pathname === '/api/widgets') return route.fulfill({ json: { widgets: [] } });
    if (url.pathname === '/api/hotel/property') return route.fulfill({ json: { property: {
      id: 41, name: 'Synthetic hotel', currency: 'USD', timezone: 'UTC',
    } } });
    if (url.pathname === '/api/hotel/summary') return route.fulfill({ json: {
      totalRoomTypes: searchRoomTypes.length, totalBookings: searchBookings.length,
      confirmedBookings: searchBookings.length, revenueByCurrency: { USD: 100 },
    } });
    if (url.pathname === '/api/hotel/room-types') return route.fulfill({ json: { roomTypes: searchRoomTypes } });
    if (url.pathname === '/api/hotel/bookings') return route.fulfill({ json: { bookings: searchBookings } });
    return route.fulfill({ json: {} });
  });
});

async function namedInput(page: Page, name: string, placeholder: string) {
  const input = page.getByRole('textbox', { name, exact: true });
  await expect(input).toHaveCount(1, { timeout: 10_000 });
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute('placeholder', placeholder);
  await expect(input).toHaveAccessibleName(name);
  expect(await input.ariaSnapshot()).toContain(`textbox "${name}"`);
  return input;
}

async function keyboardFocus(page: Page, input: Locator) {
  await input.focus();
  await input.press('Shift+Tab');
  const unfocused = await input.evaluate(node => ({ border: getComputedStyle(node).borderColor, shadow: getComputedStyle(node).boxShadow }));
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();
  await expect.poll(() => input.evaluate(node => ({ border: getComputedStyle(node).borderColor, shadow: getComputedStyle(node).boxShadow }))).not.toEqual(unfocused);
}

async function manualClear(page: Page, input: Locator, name: string) {
  await input.press('ControlOrMeta+a');
  await input.press('Backspace');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');
  await expect(page.getByRole('textbox', { name, exact: true })).toHaveCount(1);
  await expect(input).toHaveAccessibleName(name);
  expect(await input.ariaSnapshot()).toContain(`textbox "${name}"`);
}

async function evidence(page: Page, input: Locator, testInfo: TestInfo, state: string) {
  await expectNoHorizontalOverflow(page);
  const bounds = await input.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await testInfo.attach(state, { body: await input.ariaSnapshot(), contentType: 'text/plain' });
  await page.screenshot({ path: testInfo.outputPath(`${state}.png`), fullPage: true });
}

test('enrichment search keeps its name, keyboard focus and each status scope', async ({ page, audit }, testInfo) => {
  await page.goto('/dashboard/enrichment');
  const name = 'Search enrichment runs';
  const input = await namedInput(page, name, 'Search enrichments...');
  const runsRegion = page.getByRole('complementary', { name: 'Enrichment runs' });
  const runButton = (leadName: string) => runsRegion.getByRole('button', { name: new RegExp(`^${leadName}`) });
  await expect(runButton(searchRuns[0].leadName)).toBeVisible();
  await keyboardFocus(page, input);
  await evidence(page, input, testInfo, 'enrichment-empty');

  for (const status of ['all', 'completed', 'running', 'failed']) {
    const population = searchRuns.filter(run => status === 'all' || (status === 'running' ? ['running', 'pending'].includes(run.status) : run.status === status));
    const statusButton = runsRegion.getByRole('button', { name: new RegExp(`^${status} ${population.length}$`, 'i') });
    await statusButton.click();
    // These existing status controls are buttons with a visual selected state, not ARIA tabs.
    await expect(statusButton).toHaveClass(/bg-primary\/10/);
    for (const run of searchRuns) await expect(runButton(run.leadName)).toHaveCount(population.includes(run) ? 1 : 0);
    await input.focus();
    await input.pressSequentially(population[0].leadEmail);
    await expect(runButton(population[0].leadName)).toBeVisible();
    for (const run of searchRuns.filter(run => run !== population[0])) await expect(runButton(run.leadName)).toHaveCount(0);
    await expect(input).toHaveAccessibleName(name);
    await input.fill(searchNoMatch);
    await expect(page.getByText('No results match your search', { exact: true })).toBeVisible();
    await namedInput(page, name, 'Search enrichments...');
    await expect(statusButton).toHaveClass(/bg-primary\/10/);
    if (status === 'completed') await evidence(page, input, testInfo, 'enrichment-no-match');
    await manualClear(page, input, name);
    for (const run of searchRuns) await expect(runButton(run.leadName)).toHaveCount(population.includes(run) ? 1 : 0);
    await expect(statusButton).toHaveClass(/bg-primary\/10/);
  }
  await runsRegion.getByRole('button', { name: new RegExp(`^all ${searchRuns.length}$`, 'i') }).click();
  for (const run of searchRuns) await expect(runButton(run.leadName)).toBeVisible();
  await keyboardFocus(page, input);
  await evidence(page, input, testInfo, 'enrichment-cleared');
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
  expect(audit.failedRequests).toEqual([]);
});

test('campaign search retains its current-page name and pagination semantics', async ({ page, audit, baseURL }, testInfo) => {
  const network = installCampaignRequestAudit(page, baseURL!, searchCampaigns.map(campaign => campaign.id));
  const requests: URL[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/chat/threads' && url.searchParams.get('limit') === '10' && url.searchParams.has('offset') && url.searchParams.get('businessProfileId') === '4102') requests.push(url);
  });
  await page.goto('/dashboard/chats');
  const campaignPage = page.getByRole('main');
  const name = 'Filter campaigns on this page';
  let input = await namedInput(page, name, 'Filter this page by campaign title...');
  const firstPopulation = searchCampaigns.slice(0, 10);
  for (const campaign of firstPopulation) await expect(campaignPage.getByText(campaign.title, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View Details', exact: true })).toHaveCount(firstPopulation.length);
  await keyboardFocus(page, input);
  await evidence(page, input, testInfo, 'campaign-empty');
  // The shell also reads campaign history, and development effects can repeat an initial read.
  // Compare against settled page reads to verify typing/clearing cause no server search.
  const firstPageReads = [...requests];
  expect(firstPageReads.length).toBeGreaterThan(0);
  expect(firstPageReads.every(url => url.searchParams.get('offset') === '0')).toBe(true);
  await input.pressSequentially(searchCampaigns[10].title);
  await expect(page.getByText('No campaigns found', { exact: true })).toBeVisible();
  await expect(input).toHaveAccessibleName(name);
  expect(requests).toEqual(firstPageReads);
  await manualClear(page, input, name);
  await expect(page.getByRole('button', { name: 'View Details', exact: true })).toHaveCount(firstPopulation.length);
  expect(requests).toEqual(firstPageReads);

  // Retain a page-two title while paging: filtering still applies only to fetched page records.
  await input.fill(searchCampaigns[10].title);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  input = await namedInput(page, name, 'Filter this page by campaign title...');
  await expect(input).toHaveValue(searchCampaigns[10].title);
  await expect(campaignPage.getByText(searchCampaigns[10].title, { exact: true })).toBeVisible();
  await expect(campaignPage.getByText(searchCampaigns[11].title, { exact: true })).toHaveCount(0);
  const secondPageReads = [...requests];
  expect(secondPageReads.length).toBeGreaterThan(firstPageReads.length);
  expect(secondPageReads.slice(firstPageReads.length).every(url => url.searchParams.get('offset') === '10')).toBe(true);
  await input.fill(searchNoMatch);
  await expect(page.getByText('No campaigns found', { exact: true })).toBeVisible();
  await expect(page.getByText('Try a different search term', { exact: true })).toBeVisible();
  await namedInput(page, name, 'Filter this page by campaign title...');
  await evidence(page, input, testInfo, 'campaign-no-match');
  await manualClear(page, input, name);
  const secondPopulation = searchCampaigns.slice(firstPopulation.length);
  for (const campaign of secondPopulation) await expect(campaignPage.getByText(campaign.title, { exact: true })).toBeVisible();
  for (const campaign of firstPopulation) await expect(campaignPage.getByText(campaign.title, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View Details', exact: true })).toHaveCount(secondPopulation.length);
  await evidence(page, input, testInfo, 'campaign-cleared');
  expect(requests).toEqual(secondPageReads);
  expect(requests.every(url => url.searchParams.get('businessProfileId') === '4102' && !url.searchParams.has('search'))).toBe(true);
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
  await testInfo.attach('campaign-network-audit', { body: JSON.stringify({
    audit, requestFailures: network.requestFailures, expectedCancellations: network.expectedCancellations(),
    httpErrors: network.httpErrors, pageErrors: network.pageErrors,
  }, null, 2), contentType: 'application/json' });
  expect(network.httpErrors).toEqual([]);
  expect(network.pageErrors).toEqual([]);
  expect(network.unexpectedFailures(audit.failedRequests)).toEqual([]);
});

for (const mode of ['grid', 'list'] as const) {
  test(`AS023 campaign ${mode}: interrupted/repeated search, contextual cancellation and row navigation`, async ({ page, audit, baseURL }, testInfo) => {
    const navigationBodies = await observeConversationNavigationBodies(page, baseURL!, searchCampaigns.map(campaign => campaign.id));
    const network = installCampaignRequestAudit(page, baseURL!, searchCampaigns.map(campaign => campaign.id));
    const pageReads: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/api/chat/threads' && url.searchParams.has('offset')) pageReads.push(request.url());
    });
    await page.goto('/dashboard/chats');
    const main = page.getByRole('main');
    const name = 'Filter campaigns on this page';
    const input = await namedInput(page, name, 'Filter this page by campaign title...');
    await expect(main.getByRole('button', { name: 'View Details', exact: true })).toHaveCount(10);
    if (mode === 'list') await main.getByRole('button', { name: 'List view', exact: true }).click();
    const reads = [...pageReads];
    expect(reads.length).toBeGreaterThan(0);
    await keyboardFocus(page, input);
    // Interrupt a partial term with keyboard clearing, then immediately replace
    // it. Repeated no-match/clear cycles must keep the current-page population.
    await input.pressSequentially('Synthe');
    await manualClear(page, input, name);
    for (let cycle = 0; cycle < 2; cycle++) {
      await input.pressSequentially(searchNoMatch);
      await expect(main.getByText('No campaigns found', { exact: true })).toBeVisible();
      await expect(input).toBeFocused();
      await input.fill(searchCampaigns[1].title);
      await expect(main.getByRole('button', { name: /^Delete campaign / })).toHaveCount(1);
      await expect(main.getByText(searchCampaigns[1].title, { exact: true })).toBeVisible();
      await manualClear(page, input, name);
      await expect(main.getByRole('button', { name: /^Delete campaign / })).toHaveCount(10);
      await expect(main.getByText('12 campaigns total', { exact: true })).toBeVisible();
      await expect(main.getByText('Showing 1-10 of 12', { exact: true })).toBeVisible();
    }
    expect(pageReads).toEqual(reads);
    const first = searchCampaigns[0];
    const action = main.getByRole('button', { name: `Delete campaign ${first.title} (ID ${first.id})`, exact: true });
    await input.focus();
    for (let steps = 0; steps < 30; steps++) {
      if (await action.evaluate(node => node === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(action).toBeFocused();
    await expect(action).toHaveAttribute('type', 'button');
    await expect(action).toHaveCSS('opacity', '1');
    await action.press('Enter');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toHaveAccessibleDescription(new RegExp(`${first.title} \\(ID ${first.id}\\)`));
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancel).toBeFocused();
    await cancel.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(action).toBeFocused();
    await input.focus();
    await expect(input).toBeFocused();
    await evidence(page, input, testInfo, `campaign-${mode}-recovered`);

    const target = searchCampaigns[1];
    if (mode === 'grid') {
      const card = main.getByText(target.title, { exact: true }).locator('xpath=ancestor::*[contains(@class,"shadcn-card")]');
      const open = card.getByRole('button', { name: 'Open Chat', exact: true });
      await open.focus();
      await open.press('Enter');
    } else {
      await main.getByRole('row').filter({ has: page.getByText(target.title, { exact: true }) }).click();
    }
    await expect(page).toHaveURL(new RegExp(`/dashboard/conversations/${target.id}$`));
    await expect(main.getByRole('heading', { name: target.title, exact: true })).toBeVisible();
    await expect(main.getByText(`Synthetic saved message for campaign ${target.id}`, { exact: true })).toBeVisible();
    await expect(main.getByText('Conversation could not be loaded', { exact: true })).toHaveCount(0);
    await expect(main.getByRole('tabpanel', { includeHidden: true }).getByText('Scraping', { exact: true })).toHaveCount(1);
    await expect(main.getByRole('button', { name: 'Context usage: 0%', exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const consumedBodies = await navigationBodies();
    network.confirmNavigationBody(page.url(), consumedBodies);
    await testInfo.attach('campaign-navigation-audit', { body: JSON.stringify({
      audit, pageReads, requestFailures: network.requestFailures, expectedCancellations: network.expectedCancellations(),
      consumedBodies, completedNavigations: network.completedNavigations(),
      httpErrors: network.httpErrors, pageErrors: network.pageErrors,
    }, null, 2), contentType: 'application/json' });
    expect(audit.blockedMutations).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
    expect(network.httpErrors).toEqual([]);
    expect(network.pageErrors).toEqual([]);
    expect(network.unexpectedFailures(audit.failedRequests)).toEqual([]);
  });
}

test('AS023 request audit retains real navigation, API, asset, prefetch HTTP/network and page errors', async ({ page, audit, baseURL }, testInfo) => {
  const network = installCampaignRequestAudit(page, baseURL!, searchCampaigns.map(campaign => campaign.id));
  await page.goto('/dashboard/chats');
  await expect(page.getByRole('textbox', { name: 'Filter campaigns on this page', exact: true })).toBeVisible();
  expect(network.unexpectedFailures(audit.failedRequests)).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
  await page.route('**/*as023AuditControl*', route => {
    const control = new URL(route.request().url()).searchParams.get('as023AuditControl');
    if (control === 'http404' || control === 'http500') return route.fulfill({ status: control === 'http404' ? 404 : 500, contentType: 'text/x-component', body: 'Synthetic HTTP error' });
    return route.abort(control === 'offline-prefetch' ? 'connectionrefused' : 'aborted');
  });
  for (const control of ['navigation-rsc', 'api', 'offline-prefetch', 'http404', 'http500']) {
    const url = control === 'api' ? `/api/chat/threads/801?as023AuditControl=${control}` : `/dashboard/conversations/801?as023AuditControl=${control}`;
    const headers: Record<string, string> = control === 'api' ? {} : { rsc: '1' };
    if (['offline-prefetch', 'http404', 'http500'].includes(control)) headers['next-router-prefetch'] = '1';
    await page.evaluate(async ({ url, headers }) => { try { await fetch(url, { headers }); } catch { /* Deliberate local negative control. */ } }, { url, headers });
  }
  await expect(page.addScriptTag({ url: '/as023-synthetic-asset.js?as023AuditControl=asset' })).rejects.toThrow();
  await expect(page.goto('/dashboard/conversations/802?as023AuditControl=document')).rejects.toThrow(/net::ERR_ABORTED/);
  const error = page.waitForEvent('pageerror');
  await page.evaluate(() => {
    console.error('Synthetic AS023 console-error control');
    setTimeout(() => { throw new Error('Synthetic AS023 page-error control'); }, 0);
  });
  await error;
  await expect.poll(() => network.requestFailures.filter(failure => failure.url.includes('as023AuditControl')).length).toBe(5);
  const controls = network.requestFailures.filter(failure => failure.url.includes('as023AuditControl'));
  expect(controls.some(failure => failure.navigation && failure.resourceType === 'document')).toBe(true);
  expect(controls.some(failure => failure.resourceType === 'script')).toBe(true);
  expect(network.unexpectedFailures(audit.failedRequests).filter(text => text.includes('as023AuditControl')).sort()).toEqual(controls.map(failureText).sort());
  expect(network.expectedCancellations().every(failure => !failure.url.includes('as023AuditControl'))).toBe(true);
  expect(network.httpErrors.filter(response => response.url.includes('as023AuditControl')).map(response => response.status)).toEqual([404, 500]);
  expect(network.pageErrors).toContain('Synthetic AS023 page-error control');
  expect(audit.consoleErrors).toContain('Synthetic AS023 console-error control');
  expect(audit.blockedMutations).toEqual([]);
  await testInfo.attach('campaign-negative-controls', { body: JSON.stringify({
    audit, controls, httpErrors: network.httpErrors, pageErrors: network.pageErrors,
  }, null, 2), contentType: 'application/json' });
});

test('AS023 request audit retains aborted navigation bodies after 200 headers and partial consumption', async ({ page, audit }, testInfo) => {
  // A local streaming transport delivers 200 headers and one chunk before a
  // real cancellation. No application server is contacted.
  let duplicateReads = 0;
  const server = createServer((request, response) => {
    if (!request.url?.includes('as023BodyControl')) {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<main>Synthetic AS023 transport fixture</main>');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/x-component' });
    if (request.url.includes('as023BodyControl=duplicate') && ++duplicateReads === 1) {
      response.end('Synthetic complete RSC response\n');
      return;
    }
    response.write('Synthetic partial RSC response\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Synthetic stream did not bind a loopback port');
    const controlOrigin = `http://127.0.0.1:${address.port}`;
    const bodies = await observeConversationNavigationBodies(page, controlOrigin, searchCampaigns.map(campaign => campaign.id));
    const network = installCampaignRequestAudit(page, controlOrigin, searchCampaigns.map(campaign => campaign.id));
    await page.goto(controlOrigin);
    await expect(page.getByRole('main')).toHaveText('Synthetic AS023 transport fixture');
    for (const control of ['signal-abort', 'reader-cancel']) {
      await page.evaluate(async control => {
        const controller = new AbortController();
        const response = await fetch(`/dashboard/conversations/802?_rsc=body-control&as023BodyControl=${control}`, {
          headers: { rsc: '1' }, signal: controller.signal,
        });
        const reader = response.body!.getReader();
        await reader.read();
        if (control === 'signal-abort') controller.abort();
        else await reader.cancel();
        try { await reader.read(); } catch { /* Intentional partial-body control. */ }
      }, control);
    }
    await page.evaluate(async () => {
      const url = '/dashboard/conversations/802?_rsc=duplicate-control&as023BodyControl=duplicate';
      const complete = await fetch(url, { headers: { rsc: '1' } });
      const reader = complete.body!.getReader();
      while (!(await reader.read()).done) { /* Application reader reaches EOF. */ }
      const controller = new AbortController();
      const partial = await fetch(url, { headers: { rsc: '1' }, signal: controller.signal });
      const partialReader = partial.body!.getReader();
      await partialReader.read();
      controller.abort();
      try { await partialReader.read(); } catch { /* Same URL's real failure. */ }
    });
    await expect.poll(() => network.requestFailures.filter(failure => failure.url.includes('as023BodyControl')).length).toBe(3);
    const consumed = await bodies();
    // Supply the claimed destination deliberately: partial bytes and even EOF
    // after reader.cancel must still fail closed.
    network.confirmNavigationBody(`${controlOrigin}/dashboard/conversations/802`, consumed);
    const controls = network.requestFailures.filter(failure => failure.url.includes('as023BodyControl'));
    expect(controls.every(failure => failure.response?.status === 200 && failure.headers.rsc === '1')).toBe(true);
    expect(consumed.filter(body => body.url.includes('as023BodyControl'))).toHaveLength(4);
    expect(consumed.filter(body => !body.url.includes('as023BodyControl=duplicate')).every(body => body.bytesRead > 0 && body.canceled)).toBe(true);
    const duplicates = consumed.filter(body => body.url.includes('as023BodyControl=duplicate'));
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0]).toMatchObject({ ended: true, canceled: false, readError: false });
    expect(duplicates[1]).toMatchObject({ ended: false, canceled: true });
    expect(network.completedNavigations().filter(failure => failure.url.includes('as023BodyControl'))).toEqual([]);
    expect(network.unexpectedFailures(audit.failedRequests).filter(text => text.includes('as023BodyControl')).sort()).toEqual(controls.map(failureText).sort());
    expect(network.httpErrors).toEqual([]);
    expect(network.pageErrors).toEqual([]);
    expect(audit.blockedMutations).toEqual([]);
    await testInfo.attach('campaign-partial-body-controls', { body: JSON.stringify({ audit, controls, consumed }, null, 2), contentType: 'application/json' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('room-type search keeps its own label and tab scope; Bookings retains its label', async ({ page, audit }, testInfo) => {
  await page.goto('/dashboard/hotel?tab=rooms');
  const name = 'Search room types';
  let input = await namedInput(page, name, 'Search room types...');
  const roomsTab = page.getByRole('tab', { name: 'Room Types', exact: true });
  await expect(roomsTab).toHaveAttribute('aria-selected', 'true');
  for (const room of searchRoomTypes) await expect(page.getByRole('heading', { name: room.name, exact: true })).toBeVisible();
  await expect(page.getByText(`Select all (${searchRoomTypes.length})`, { exact: true })).toBeVisible();
  await keyboardFocus(page, input);
  await evidence(page, input, testInfo, 'rooms-empty');
  await input.pressSequentially('suite');
  await expect(page.getByRole('heading', { name: searchRoomTypes[1].name, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: searchRoomTypes[0].name, exact: true })).toHaveCount(0);
  await expect(input).toHaveAccessibleName(name);
  await input.fill(searchNoMatch);
  await expect(page.getByRole('heading', { name: 'No room types found', exact: true })).toBeVisible();
  await expect(page.getByText('Try adjusting your search', { exact: true })).toBeVisible();
  await namedInput(page, name, 'Search room types...');
  await expect(roomsTab).toHaveAttribute('aria-selected', 'true');
  await evidence(page, input, testInfo, 'rooms-no-match');
  await manualClear(page, input, name);
  for (const room of searchRoomTypes) await expect(page.getByRole('heading', { name: room.name, exact: true })).toBeVisible();
  await expect(page.getByText(`Select all (${searchRoomTypes.length})`, { exact: true })).toBeVisible();
  await evidence(page, input, testInfo, 'rooms-cleared');

  const bookingsTab = page.getByRole('tab', { name: 'Bookings', exact: true });
  await bookingsTab.focus();
  await bookingsTab.press('Enter');
  await expect(bookingsTab).toHaveAttribute('aria-selected', 'true');
  const bookingInput = page.getByRole('textbox', { name: 'Search bookings', exact: true });
  await expect(bookingInput).toHaveCount(1);
  await expect(bookingInput).toBeVisible();
  await expect(page.getByRole('textbox', { name, exact: true })).toHaveCount(0);
  await bookingInput.fill(searchNoMatch);
  await expect(bookingInput).toHaveAccessibleName('Search bookings');
  await manualClear(page, bookingInput, 'Search bookings');
  await roomsTab.focus();
  await roomsTab.press('Enter');
  await expect(roomsTab).toHaveAttribute('aria-selected', 'true');
  input = await namedInput(page, name, 'Search room types...');
  await expect(input).toHaveValue('');
  for (const room of searchRoomTypes) await expect(page.getByRole('heading', { name: room.name, exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search bookings', exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
  expect(audit.failedRequests).toEqual([]);
});
