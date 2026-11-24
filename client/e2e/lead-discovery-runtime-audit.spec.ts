import { readFileSync } from 'node:fs';
import { expect, test, installAppShellMocks, expectNoHorizontalOverflow } from './fixtures/app';

test('browser request persists enrichment and survives reload through real auth, HTTP, RLS and Redis', async ({ page }, info) => {
  const fixture = JSON.parse(readFileSync('/tmp/lead-discovery-browser-fixture.json', 'utf8'));
  const apiHeaders = { Authorization: `Bearer ${fixture.token}`, 'X-Business-Profile-Id': String(fixture.businessProfileId) };
  const consoleErrors: string[] = [];
  const requests: { method: string; path: string; status: number }[] = [];
  await installAppShellMocks(page);
  await page.addInitScript(value => {
    localStorage.setItem('token', value.token);
    localStorage.setItem('user', JSON.stringify({ id: value.userId }));
    sessionStorage.setItem(`active-business-profile:${value.userId}`, String(value.businessProfileId));
  }, fixture);
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (/^\/api\/(?:auth\/me|platform\/access|settings\/business-profiles|wallet|leads|enrichments)(?:\/|$)/.test(url.pathname)) {
      const response = await route.fetch({ url: `http://127.0.0.1:58080${url.pathname}${url.search}` });
      requests.push({ method: route.request().method(), path: url.pathname, status: response.status() });
      return route.fulfill({ response });
    }
    if (/^\/api\/(?:chat\/threads|settings\/preferences|organizations|crm\/configuration|notifications\/unread\/count)$/.test(url.pathname)) return route.fallback();
    return route.fulfill({ json: {} });
  });
  await page.goto('/dashboard/enrichment');
  await expect(page.getByRole('button', { name: /Synthetic saved discovery/ })).toBeVisible();
  const newButton = page.getByRole('button', { name: /^New enrichment$/i });
  await newButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  const identifier = `synthetic_browser_${Date.now()}`;
  await page.getByPlaceholder(/username|handle|URL/i).fill(identifier);
  const beforeWallet = await page.request.get('http://127.0.0.1:58080/api/wallet', { headers: apiHeaders });
  const beforeBalance = (await beforeWallet.json()).balance;
  const started = page.waitForResponse(response => response.url().includes('/api/enrichments/by-handle') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start Enrichment', exact: true }).click();
  const startResponse = await started;
  const created = await startResponse.json();
  const requestKey = startResponse.request().headers()['idempotency-key'];
  expect(requestKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(created.success).toBe(true);
  const id = created.data.runId;
  await expect.poll(async () => {
    const response = await page.request.get(`http://127.0.0.1:58080/api/enrichments/${id}`, { headers: apiHeaders });
    return (await response.json()).data.status;
  }).toBe('completed');
  const detail = await (await page.request.get(`http://127.0.0.1:58080/api/enrichments/${id}`, { headers: apiHeaders })).json();
  expect(detail.data.billingStatus).toBe('settled');
  const replay = await page.request.post('http://127.0.0.1:58080/api/enrichments/by-handle', { headers: { ...apiHeaders, 'Idempotency-Key': requestKey }, data: startResponse.request().postDataJSON() });
  expect((await replay.json()).data).toEqual(expect.objectContaining({ runId: id, replayed: true }));
  const afterWallet = await page.request.get('http://127.0.0.1:58080/api/wallet', { headers: apiHeaders });
  const afterBalance = (await afterWallet.json()).balance;
  expect(afterBalance).toBe(beforeBalance - Number(detail.data.billingCredits));
  await expect(page.getByRole('link', { name: `Available credits: ${Number(afterBalance).toLocaleString('en-US')}` })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: new RegExp(identifier) }).click();
  await expect(page.getByText('Enrichment complete', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
  await page.screenshot({ path: info.outputPath('real-api-enrichment.png'), fullPage: true });
  await info.attach('runtime-requests', { body: JSON.stringify(requests), contentType: 'application/json' });
  expect(requests.some(value => value.method === 'POST' && value.path === '/api/enrichments/by-handle' && value.status === 200)).toBe(true);
  expect(consoleErrors).toEqual([]);
});
