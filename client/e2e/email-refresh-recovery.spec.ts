import { test, expect, expectNoHorizontalOverflow, installAppShellMocks } from './fixtures/app';
import type { Locator, Page } from '@playwright/test';

const baseline = process.env.EMAIL_REFRESH_BASELINE === '1';
const evidenceDir = process.env.EMAIL_REFRESH_EVIDENCE_DIR;
test.setTimeout(60_000);
const heldGates = new Set<() => void>();
const apiAudits = new WeakMap<Page, Array<{ method: string; path: string; profile: string | null }>>();
test.afterEach(async ({ page }, testInfo) => {
  for (const release of heldGates) release();
  heldGates.clear();
  await testInfo.attach('mock-api-audit', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
    viewport: page.viewportSize(), allApiRequestsMocked: true,
    requests: apiAudits.get(page) || [],
  })) });
});
test.use({ video: 'off', serviceWorkers: 'block', launchOptions: process.env.EMAIL_REFRESH_CHROMIUM_PATH ? { executablePath: process.env.EMAIL_REFRESH_CHROMIUM_PATH } : {} });
const gmail = { connected: true, email: 'mailbox@example.test', watchStatus: 'active', configSource: 'default' };
const domain = (id = 'domain-a', value = 'known-dns-value') => ({
  id: id === 'domain-a' ? 1 : 2, resendDomainId: id, name: `${id}.example.test`, status: 'pending',
  region: 'us-east-1', createdAt: '2026-10-01',
  dnsRecords: [{ record: 'DKIM', name: 'fixture._domainkey', type: 'TXT', ttl: 'Auto', status: 'pending', value }],
});

async function mockEmail(page: Page, theme = 'light') {
  const state = { gmailFailure: false, dnsFailure: false, gmailGets: 0, dnsGets: 0, mutations: [] as string[] };
  const requests: Array<{ method: string; path: string; profile: string | null }> = [];
  apiAudits.set(page, requests);
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) requests.push({ method: request.method(), path, profile: request.headers()['x-business-profile-id'] || null });
  });
  await page.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ id: 4101, name: 'Regression Alpha', email: 'regression-alpha@example.test' }));
    sessionStorage.setItem('active-business-profile:4101', '4102');
  });
  // Every API request is fulfilled locally, including unexpected reads/writes.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{}' });
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return route.abort('blockedbyclient');
    return route.continue();
  });
  await installAppShellMocks(page);
  await page.route('**/api/settings/preferences', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ theme, language: 'en', timezone: 'UTC' }) }));
  await page.route('**/api/settings/business-profiles', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { id: 4102, name: 'Regression Business', companyName: 'Regression Company', isDefault: true, role: 'owner' },
    { id: 4103, name: 'Regression Business B', companyName: 'Regression Company B', role: 'member' },
  ]) }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() !== 'GET') {
      state.mutations.push(`${request.method()} ${path}`);
      return reply({ error: 'All mutations blocked by mock' }, 409);
    }
    if (path === '/api/gmail/oauth/status') {
      state.gmailGets++;
      return state.gmailFailure ? reply({ error: 'Mock Gmail unavailable' }, 503) : reply(gmail);
    }
    if (path === '/api/resend/domains') {
      state.dnsGets++;
      return state.dnsFailure ? reply({ error: 'Mock DNS unavailable' }, 503) : reply({ domains: [domain(), domain('domain-b')] });
    }
    if (path === '/api/email-senders') return reply({ senders: [] });
    if (path === '/api/instagram/oauth/status') return reply({ officialApi: { connected: false, authorized: false, username: null } });
    return route.fallback();
  });
  await page.goto('/dashboard/integrations/email');
  await expect(page.getByRole('button', { name: 'Refresh status', exact: true })).toBeEnabled();
  return state;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
  test(`rejected Gmail and DNS refresh recover at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const state = await mockEmail(page);
    const initialGmailGets = state.gmailGets;
    const initialDnsGets = state.dnsGets;
    expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
    const gmailRegion = page.getByRole('region', { name: 'Gmail account', exact: true });
    const gmailRefresh = gmailRegion.getByRole('button', { name: 'Refresh status', exact: true });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    state.gmailFailure = true;
    const rejectedGmail = page.waitForResponse(response => response.url().includes('/api/gmail/oauth/status') && response.status() === 503);
    await gmailRefresh.focus();
    await expect(gmailRefresh).toBeFocused();
    await page.keyboard.press('Enter');
    await rejectedGmail;
    if (baseline) {
      await expect.poll(() => errors.length).toBe(1);
      await expect(gmailRefresh).toBeDisabled();
      await expect(gmailRegion.getByRole('alert')).toHaveCount(0);
    } else {
      await expect(gmailRegion.getByRole('alert')).toContainText('last known');
      expect(await feedbackContrast(gmailRegion.getByRole('alert'))).toBeGreaterThanOrEqual(4.5);
      await expect(gmailRefresh).toBeEnabled();
      await expect(gmailRegion).toContainText('mailbox@example.test');
      const retry = gmailRegion.getByRole('button', { name: 'Retry Gmail status' });
      await retry.focus();
      await expect(retry).toBeFocused();
      if (evidenceDir && [1440, 320].includes(viewport.width)) await page.screenshot({ path: `${evidenceDir}/${testInfo.project.name}-${viewport.width}-gmail-failed.png` });
      state.gmailFailure = false;
      await page.keyboard.press('Space');
      await expect(gmailRegion.getByRole('alert')).toHaveCount(0);
      await expect(gmailRefresh).toBeEnabled();
      expect(state.gmailGets - initialGmailGets).toBe(2);
    }
    const dnsButtons = page.getByRole('button', { name: 'DNS records', exact: true });
    await dnsButtons.first().focus();
    await page.keyboard.press('Enter');
    await expect(dnsButtons.first()).toHaveAttribute('aria-expanded', 'true');
    const records = page.locator('#domain-records-1');
    const refreshDns = records.getByRole('button', { name: 'Refresh records', exact: true });
    state.dnsFailure = true;
    const rejectedDns = page.waitForResponse(response => response.url().includes('/api/resend/domains') && response.status() === 503);
    await refreshDns.focus();
    await page.keyboard.press('Space');
    await rejectedDns;
    if (baseline) {
      await expect.poll(() => errors.length).toBe(2);
      await expect(refreshDns).toBeDisabled();
      await expect(records.getByRole('alert')).toHaveCount(0);
    } else {
      await expect(records.getByRole('alert')).toContainText('last known');
      expect(await feedbackContrast(records.getByRole('alert'))).toBeGreaterThanOrEqual(4.5);
      await expect(records).toContainText('known-dns-value');
      await expect(refreshDns).toBeEnabled();
      const retry = records.getByRole('button', { name: 'Retry DNS records for domain-a.example.test' });
      await retry.focus();
      await expect(retry).toBeFocused();
      if (evidenceDir && [1440, 320].includes(viewport.width)) await page.screenshot({ path: `${evidenceDir}/${testInfo.project.name}-${viewport.width}-dns-failed.png` });
      state.dnsFailure = false;
      await page.keyboard.press('Enter');
      await expect(records.getByRole('alert')).toHaveCount(0);
      await expect(refreshDns).toBeEnabled();
      expect(state.dnsGets - initialDnsGets).toBe(2);
      expect(errors).toEqual([]);
    }
    await expectNoHorizontalOverflow(page);
    expect(state.mutations).toEqual([]);
  });
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = () => { heldGates.delete(release); resolve(); }; });
  heldGates.add(release);
  return { promise, release };
}

async function feedbackContrast(alert: Locator) {
  await expect.poll(() => alert.evaluate(element => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (Number(getComputedStyle(node).opacity) !== 1) return false;
    }
    return true;
  })).toBe(true);
  return alert.evaluate(element => {
    const rgba = (value: string) => {
      const channels = value.match(/[\d.]+/g)?.map(Number);
      if (!channels || channels.length < 3) throw new Error(`Unsupported color: ${value}`);
      return [...channels.slice(0, 3), channels[3] ?? 1];
    };
    const composite = (front: number[], back: number[]) => front.slice(0, 3).map((channel, i) => channel * front[3] + back[i] * (1 - front[3]));
    const luminance = (rgb: number[]) => rgb.map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const ancestors: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
    let background = [255, 255, 255];
    for (const node of ancestors) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none' || Number(style.opacity) !== 1) throw new Error('Feedback contrast must be measured on a settled, flat background');
      background = composite(rgba(style.backgroundColor), background);
    }
    const foreground = composite(rgba(getComputedStyle(element).color), background);
    const light = luminance(foreground), dark = luminance(background);
    return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
  });
}

test('dark theme keeps both scoped retry alerts readable at 320 pixels', async ({ page }) => {
  test.skip(baseline);
  await page.setViewportSize({ width: 320, height: 568 });
  const state = await mockEmail(page, 'dark');
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  state.gmailFailure = true;
  const gmailRegion = page.getByRole('region', { name: 'Gmail account', exact: true });
  await gmailRegion.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(gmailRegion.getByRole('alert')).toContainText('last known');
  expect(await feedbackContrast(gmailRegion.getByRole('alert'))).toBeGreaterThanOrEqual(4.5);
  await gmailRegion.getByRole('button', { name: 'Retry Gmail status' }).focus();
  await expect(gmailRegion.getByRole('button', { name: 'Retry Gmail status' })).toBeFocused();
  await page.getByRole('button', { name: 'DNS records', exact: true }).first().click();
  state.dnsFailure = true;
  const records = page.locator('#domain-records-1');
  await records.getByRole('button', { name: 'Refresh records', exact: true }).click();
  await expect(records.getByRole('alert')).toContainText('last known');
  expect(await feedbackContrast(records.getByRole('alert'))).toBeGreaterThanOrEqual(4.5);
  await records.getByRole('button', { name: 'Retry DNS records for domain-a.example.test' }).focus();
  await expect(records.getByRole('button', { name: 'Retry DNS records for domain-a.example.test' })).toBeFocused();
  await expectNoHorizontalOverflow(page);
  expect(state.mutations).toEqual([]);
});

test('network-rejected Gmail and DNS GETs retain data and allow scoped retry', async ({ page }) => {
  test.skip(baseline);
  const state = await mockEmail(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let failing = true;
  await page.route('**/api/gmail/oauth/status', route => failing ? route.abort('failed') : route.fallback());
  await page.route('**/api/resend/domains', route => failing ? route.abort('failed') : route.fallback());
  const gmailRegion = page.getByRole('region', { name: 'Gmail account', exact: true });
  await gmailRegion.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(gmailRegion.getByRole('alert')).toContainText('last known Gmail status');
  await expect(gmailRegion).toContainText('mailbox@example.test');
  await page.getByRole('button', { name: 'DNS records', exact: true }).first().click();
  const records = page.locator('#domain-records-1');
  await records.getByRole('button', { name: 'Refresh records', exact: true }).click();
  await expect(records.getByRole('alert')).toContainText('last known DNS records');
  await expect(records).toContainText('known-dns-value');
  failing = false;
  await gmailRegion.getByRole('button', { name: 'Retry Gmail status' }).click();
  await records.getByRole('button', { name: 'Retry DNS records for domain-a.example.test' }).click();
  await expect(gmailRegion.getByRole('alert')).toHaveCount(0);
  await expect(records.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(state.mutations).toEqual([]);
});

test('pending refreshes time out, ignore repeated keyboard actions, and recover', async ({ page }) => {
  test.skip(baseline);
  const state = await mockEmail(page);
  await page.clock.install();
  const holdGmail = gate();
  const holdDns = gate();
  let gmailHeld = 0;
  let dnsHeld = 0;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/gmail/oauth/status', async route => {
    if (++gmailHeld > 1) return route.fallback();
    await holdGmail.promise;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...gmail, email: 'obsolete@example.test' }) }).catch(() => {});
  });
  await page.route('**/api/resend/domains', async route => {
    if (++dnsHeld > 1) return route.fallback();
    await holdDns.promise;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ domains: [domain('domain-a', 'obsolete-dns')] }) }).catch(() => {});
  });
  const gmailRegion = page.getByRole('region', { name: 'Gmail account', exact: true });
  const refresh = gmailRegion.getByRole('button', { name: 'Refresh status', exact: true });
  await refresh.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => gmailHeld).toBe(1);
  await expect(refresh).toBeDisabled();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'DNS records', exact: true }).first().click();
  const records = page.locator('#domain-records-1');
  const dnsRefresh = records.getByRole('button', { name: 'Refresh records', exact: true });
  await dnsRefresh.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => dnsHeld).toBe(1);
  await page.keyboard.press('Enter');
  await page.clock.fastForward(15_001);
  await expect(gmailRegion.getByRole('alert')).toContainText('timed out');
  await expect(records.getByRole('alert')).toContainText('timed out');
  await expect(refresh).toBeEnabled();
  await expect(dnsRefresh).toBeEnabled();
  expect(gmailHeld).toBe(1);
  expect(dnsHeld).toBe(1);
  await gmailRegion.getByRole('button', { name: 'Retry Gmail status' }).click();
  await records.getByRole('button', { name: 'Retry DNS records for domain-a.example.test' }).click();
  await expect(gmailRegion.getByRole('alert')).toHaveCount(0);
  await expect(records.getByRole('alert')).toHaveCount(0);
  holdGmail.release();
  holdDns.release();
  await expect(gmailRegion).toContainText('mailbox@example.test');
  await expect(records).toContainText('known-dns-value');
  expect(errors).toEqual([]);
  expect(state.mutations).toEqual([]);
});

test('switching expanded domains protects the newer DNS refresh', async ({ page }) => {
  test.skip(baseline);
  const state = await mockEmail(page);
  const old = gate();
  const latest = gate();
  let calls = 0;
  await page.route('**/api/resend/domains', async route => {
    const index = ++calls;
    expect(route.request().headers()['x-business-profile-id']).toBe('4102');
    await (index === 1 ? old.promise : latest.promise);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ domains: [domain(), domain('domain-b', index === 1 ? 'obsolete-dns' : 'new-domain-b-dns')] }) }).catch(() => {});
  });
  const expand = page.getByRole('button', { name: 'DNS records', exact: true });
  await expand.first().click();
  await page.locator('#domain-records-1').getByRole('button', { name: 'Refresh records', exact: true }).click();
  await expect.poll(() => calls).toBe(1);
  await expand.nth(1).focus();
  await page.keyboard.press('Enter');
  const current = page.locator('#domain-records-2');
  const refresh = current.getByRole('button', { name: 'Refresh records', exact: true });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect.poll(() => calls).toBe(2);
  old.release();
  await expect(refresh).toBeDisabled();
  await expect(current).toContainText('known-dns-value');
  await expect(current.getByRole('alert')).toHaveCount(0);
  latest.release();
  await expect(current).toContainText('new-domain-b-dns');
  await expect(refresh).toBeEnabled();
  expect(state.mutations).toEqual([]);
});

test('workspace changes discard pending data and reload with the current profile header', async ({ page }) => {
  test.skip(baseline);
  const state = await mockEmail(page);
  const old = gate();
  const profiles: string[] = [];
  let held = 0;
  await page.route('**/api/gmail/oauth/status', async route => {
    const profile = route.request().headers()['x-business-profile-id'];
    profiles.push(profile);
    if (profile === '4102') { held++; await old.promise; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...gmail, email: profile === '4103' ? 'workspace-b@example.test' : 'obsolete@example.test' }) }).catch(() => {});
  });
  await page.route('**/api/resend/domains', async route => {
    const profile = route.request().headers()['x-business-profile-id'];
    profiles.push(profile);
    if (profile === '4102') { held++; await old.promise; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ domains: [domain('domain-b', profile === '4103' ? 'workspace-b-dns' : 'obsolete-dns')] }) }).catch(() => {});
  });
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.getByRole('button', { name: 'DNS records', exact: true }).first().click();
  await page.getByRole('button', { name: 'Refresh records', exact: true }).click();
  await expect.poll(() => held).toBe(2);
  await page.evaluate(() => {
    sessionStorage.setItem('active-business-profile:4101', '4103');
    window.dispatchEvent(new Event('business-profile-changed'));
  });
  await expect(page.getByRole('region', { name: 'Gmail account', exact: true })).toContainText('workspace-b@example.test');
  await expect(page.getByRole('button', { name: 'Refresh status', exact: true })).toBeEnabled();
  await expect(page.locator('#domain-records-1')).toHaveCount(0);
  old.release();
  await page.getByRole('button', { name: 'DNS records', exact: true }).click();
  await expect(page.locator('#domain-records-2')).toContainText('workspace-b-dns');
  await expect(page.getByText('obsolete@example.test', { exact: true })).toHaveCount(0);
  expect(profiles).toContain('4103');
  expect(state.mutations).toEqual([]);
});

test('client navigation aborts a pending refresh before returning to the page', async ({ page }) => {
  test.skip(baseline);
  const state = await mockEmail(page);
  const old = gate();
  let held = 0;
  let aborted = 0;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => { if (request.url().includes('/api/gmail/oauth/status')) aborted++; });
  await page.route('**/api/gmail/oauth/status', async route => {
    if (++held > 1) return route.fallback();
    await old.promise;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Mock late failure' }) }).catch(() => {});
  });
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect.poll(() => held).toBe(1);
  const showSidebar = page.getByRole('button', { name: 'Show sidebar', exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  const link = page.getByRole('link', { name: 'Instagram', exact: true }).first();
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/dashboard\/integrations\/instagram$/);
  old.release();
  await expect.poll(() => aborted).toBe(1);
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Refresh status', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Gmail account', exact: true }).getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(state.mutations).toEqual([]);
});
