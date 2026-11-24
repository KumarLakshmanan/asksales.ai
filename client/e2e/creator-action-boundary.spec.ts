import path from 'node:path';
import { test, expect, installAppShellMocks, expectNoHorizontalOverflow } from './fixtures/app';

const threadId = 214;
const title = 'Synthetic campaign creator boundary';
const tabs = [
  { tabId: 'overview-214', tabType: 'overview', tabLabel: 'Overview', tabOrder: 0, isActive: false },
  { tabId: 'adcopy-214', tabType: 'content-adcopy', tabLabel: 'Ad Copy', tabOrder: 1, isActive: true },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('selectedBusinessProfileId', '4102'));
  await page.route('**/api/**', route => {
    const req = route.request();
    const url = new URL(req.url());
    if (!['GET', 'HEAD'].includes(req.method())) return route.fulfill({ status: 409, json: { error: 'Generation, saving, and external actions are blocked in boundary QA.' } });
    if (['/api/auth/me', '/api/platform/access', '/api/settings/preferences', '/api/settings/outreach/assistants/catalog', '/api/organizations', '/api/settings/business-profiles', '/api/crm/configuration', '/api/wallet', '/api/notifications/unread/count'].includes(url.pathname)) return route.fallback();
    const json = (value: unknown) => route.fulfill({ json: value });
    if (url.pathname === '/api/chat/threads') return json({ threads: [], total: 0 });
    if (url.pathname === `/api/chat/threads/${threadId}`) return json({ id: threadId, title, businessId: 4102, metadata: { selectedBrandToolkitId: 71 } });
    if (url.pathname.endsWith(`/${threadId}/messages`)) return json({ messages: [], hasMore: false, nextCursor: null });
    if (url.pathname.endsWith(`/${threadId}/tabs`)) return json(tabs);
    if (url.pathname.endsWith(`/${threadId}/turns`)) return json({ success: true, data: [] });
    if (url.pathname.endsWith(`/${threadId}/context-window`)) return json({ threadId, messageCount: 0, canCompact: false, tokenUsage: { usagePercent: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, estimatedCurrentContextTokens: 0, maxContextTokens: 128000 } });
    if (url.pathname.endsWith(`/${threadId}/overview`)) return json({ thread: { id: threadId, title }, stats: {}, activeAgents: [], workflowExecutions: [], timeline: [] });
    if (url.pathname === '/api/content/brand-toolkits') return json([{ id: 71, brandName: 'Synthetic brand', isDefault: true, isActive: true, isApproved: true }]);
    if (url.pathname === '/api/content/assets/counts') return json({ ad_copy: 1 });
    if (url.pathname === '/api/content/assets') return json(url.searchParams.get('type') === 'ad_copy' ? [{ id: 277, version: 1, title: 'Saved ad boundary proof', channel: 'facebook', content: JSON.stringify({ headline: 'Saved ad boundary proof', primaryText: 'Synthetic saved content. No generation or delivery takes place.' }), createdAt: '2026-10-26T00:00:00Z' }] : []);
    if (url.pathname === '/api/content/studio/estimates') return json({ text: { ready: true, credits: 1 }, image: { ready: true, credits: 1 }, video: { ready: true, credits: 1 } });
    if (url.pathname === '/api/widgets') return json({ widgets: [] });
    if (url.pathname === `/api/icp/thread/${threadId}`) return json(null);
    return json([]);
  });
  await installAppShellMocks(page);
});

for (const width of [914, 615]) {
  test(`embedded ad action stays inside the full conversation result pane at ${width}px`, async ({ page, audit }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/dashboard/conversations/${threadId}`);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: 30_000 });
    const workspaceTabs = page.getByRole('tablist', { name: 'Conversation workspace pane' });
    if (await workspaceTabs.isVisible()) await workspaceTabs.getByRole('tab', { name: 'Results', exact: true }).click();
    const pane = page.locator('#conversation-result-panel');
    await expect(pane.locator('[data-creator-workspace]')).toBeVisible();
    await expect(pane.getByText('Saved ad boundary proof', { exact: true }).first()).toBeVisible();
    const action = pane.locator('[data-creator-action-proxy]');
    await expect(action).toBeVisible();
    await expect(action).toBeDisabled();
    const geometry = await action.evaluate(node => {
      const pane = node.closest('#conversation-result-panel')!;
      const rect = node.getBoundingClientRect(); const bounds = pane.getBoundingClientRect();
      return { position: getComputedStyle(node).position, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, paneLeft: bounds.left, paneRight: bounds.right, paneTop: bounds.top, paneBottom: bounds.bottom };
    });
    expect(geometry.position).not.toBe('fixed');
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.paneLeft);
    expect(geometry.right).toBeLessThanOrEqual(geometry.paneRight);
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.paneTop);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.paneBottom + 1);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    if (await composer.isVisible()) {
      const box = (await composer.boundingBox())!;
      expect(geometry.left >= box.x + box.width || geometry.right <= box.x || geometry.top >= box.y + box.height || geometry.bottom <= box.y).toBe(true);
      expect(await composer.evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })).toBe(true);
    }
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: path.resolve(`../qa-results/2026-10-26/creator-action-boundary/embedded-${width}.png`) });
    if (await workspaceTabs.isVisible()) {
      await workspaceTabs.getByRole('tab', { name: 'Chat', exact: true }).click();
      await expect(action).not.toBeVisible();
      await expect(composer).toBeVisible();
    }
    expect(pageErrors).toEqual([]);
    expect(audit.blockedMutations).toEqual([]);
  });

  test(`standalone ad creator keeps its viewport action at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dashboard/saved-templates/ads/generate');
    const workspace = page.getByRole('tablist', { name: 'Creation workspace' });
    await workspace.getByRole('tab', { name: 'Preview', exact: true }).click();
    const action = page.locator('[data-creator-action-proxy]');
    await expect(action).toBeVisible();
    expect(await action.evaluate(node => getComputedStyle(node).position)).toBe('fixed');
    const box = (await action.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: path.resolve(`../qa-results/2026-10-26/creator-action-boundary/standalone-${width}.png`) });
  });
}
