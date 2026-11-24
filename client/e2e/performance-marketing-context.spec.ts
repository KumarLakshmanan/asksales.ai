import path from 'node:path';
import { test, expect, installAppShellMocks } from './fixtures/app';

const threadId = 215;
const title = 'Synthetic performance planning context';
const evidence = (name: string) => path.resolve('../qa-results/2026-10-27/performance-marketing-ui', name);

for (const outcome of ['selected', 'missing', 'failed'] as const) {
  test(`planning waits for ${outcome} campaign ICP context without premature setup`, async ({ page, audit }) => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let icpRequests = 0;
    const mutationRequests: string[] = [];
    await page.addInitScript(() => localStorage.setItem('selectedBusinessProfileId', '4102'));
    await page.setViewportSize({ width: 914, height: 900 });
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {
        mutationRequests.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 409, json: { error: 'All mutations and provider actions are blocked in this synthetic QA.' } });
      }
      if (['/api/auth/me', '/api/platform/access', '/api/settings/preferences', '/api/settings/outreach/assistants/catalog', '/api/organizations', '/api/settings/business-profiles', '/api/crm/configuration', '/api/wallet', '/api/notifications/unread/count'].includes(url.pathname)) return route.fallback();
      const json = (value: unknown) => route.fulfill({ json: value });
      if (url.pathname === '/api/chat/threads') return json({ threads: [], total: 0 });
      if (url.pathname === `/api/chat/threads/${threadId}`) return json({ id: threadId, title, businessId: 4102, metadata: {} });
      if (url.pathname.endsWith(`/${threadId}/messages`)) return json({ messages: [], hasMore: false, nextCursor: null });
      if (url.pathname.endsWith(`/${threadId}/tabs`)) return json([
        { tabId: 'overview-215', tabType: 'overview', tabLabel: 'Overview', tabOrder: 0, isActive: false },
        { tabId: 'planning-215', tabType: 'performancemarketing', tabLabel: 'Performance Marketing', tabOrder: 1, isActive: true },
      ]);
      if (url.pathname.endsWith(`/${threadId}/turns`)) return json({ success: true, data: [] });
      if (url.pathname.endsWith(`/${threadId}/context-window`)) return json({ threadId, messageCount: 0, canCompact: false, tokenUsage: { usagePercent: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, estimatedCurrentContextTokens: 0, maxContextTokens: 128000 } });
      if (url.pathname === `/api/icp/thread/${threadId}`) {
        icpRequests++;
        await pending;
        if (outcome === 'failed' && icpRequests === 1) return route.fulfill({ status: 503, json: { error: 'Synthetic context outage' } });
        return json(outcome === 'missing' ? { id: null } : { id: 71, campaignName: 'Approved selected ICP' });
      }
      if (url.pathname === '/api/campaigns/performance/campaigns') return json({ campaigns: [{ id: 31, platform: 'google', campaign_type: 'search', budget: 1000, currency: 'USD', status: 'draft', created_at: '2026-10-27T00:00:00Z' }] });
      if (url.pathname === '/api/widgets') return json({ widgets: [] });
      return json([]);
    });
    await installAppShellMocks(page);
    try {
      await page.goto(`/dashboard/conversations/${threadId}`);
      const panes = page.getByRole('tablist', { name: 'Conversation workspace pane' });
      if (await panes.isVisible()) await panes.getByRole('tab', { name: 'Results', exact: true }).click();
      await expect.poll(() => icpRequests).toBe(1);
      await expect(page.getByRole('status').filter({ hasText: 'Loading campaign context…' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create an ICP', exact: true })).toHaveCount(0);
      await expect(page.getByRole('tab', { name: 'Budget Plan', exact: true })).toHaveCount(0);
      if (outcome === 'selected') await page.screenshot({ path: evidence('context-loading-914.png') });
      release();
      if (outcome === 'missing') {
        await expect(page.getByRole('heading', { name: 'ICP required for campaign planning' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Create an ICP', exact: true })).toBeVisible();
      } else {
        if (outcome === 'failed') {
          await expect(page.getByRole('button', { name: 'Create an ICP', exact: true })).toHaveCount(0);
          await page.getByRole('button', { name: 'Retry campaign context' }).click();
          await expect.poll(() => icpRequests).toBe(2);
        }
        await expect(page.getByRole('tab', { name: 'Budget Plan', exact: true })).toBeVisible();
        if (outcome === 'selected') {
          const planningTabs = page.getByRole('tab', { name: 'Budget Plan', exact: true }).locator('..');
          for (const tab of await planningTabs.getByRole('tab').all()) {
            expect(await tab.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
          }
          await page.getByRole('tab', { name: 'Optimize', exact: true }).click();
          await expect(page.getByRole('spinbutton', { name: 'Impressions', exact: true })).toBeVisible();
          await expect(page.getByRole('spinbutton', { name: 'Click-through rate (%)', exact: true })).toBeVisible();
          await expect(page.getByText('Current Metrics (JSON)', { exact: true })).toHaveCount(0);
          await page.screenshot({ path: evidence('optimization-fields-914.png') });
        }
      }
      expect(mutationRequests).toEqual([]);
      expect(audit.consoleErrors).toEqual(outcome === 'failed'
        ? [expect.stringMatching(/^Failed to load resource:.*503/)] : []);
    } finally { release(); }
  });
}
