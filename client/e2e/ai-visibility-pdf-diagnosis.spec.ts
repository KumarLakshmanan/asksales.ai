import { jsPDF } from 'jspdf';
import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import type { Page } from '@playwright/test';
import { join } from 'node:path';

// Completed saved records and a valid local PDF; no report/provider generation.
const doc = new jsPDF();
doc.text('AS019 synthetic saved PDF', 20, 30);
const pdf = Buffer.from(doc.output('arraybuffer'));
const project = {
  id: 1, name: 'Synthetic website', domain: 'https://example.test', workspaceId: 3,
  workspace: { role: 'client_reviewer', workspaceName: 'Synthetic workspace', workspaceKind: 'private' },
  source: 'website_search', scoringProfile: 'general', country: 'US', locale: 'en-US',
  monitoringEnabled: false, geoPrompts: [], brandAliases: [], configurationRevision: 1,
};
const reports = [29, 30].map(auditId => ({
  auditId, status: 'completed', createdAt: '2026-08-28T21:22:00Z',
  completedAt: '2026-08-28T21:24:53Z', sizeBytes: pdf.length,
}));

type PdfRead = {
  auditId: number; hasSignal: boolean; aborted: boolean; abortStack?: string;
  outcome: 'pending' | 'response' | 'error'; status?: number; contentType?: string | null; errorName?: string;
};
declare global { interface Window { __as019Reads: PdfRead[] } }

async function expectPdfReads(page: Page, testInfo: import('@playwright/test').TestInfo, completed: number[], developmentAborts: number[], productionAborts: number[] = []) {
  await expect.poll(() => page.evaluate(() => window.__as019Reads.every(read => read.outcome !== 'pending'))).toBe(true);
  const reads = await page.evaluate(() => window.__as019Reads);
  await testInfo.attach('pdf-request-outcomes', { body: JSON.stringify(reads), contentType: 'application/json' });
  expect(reads.filter(read => !read.aborted).map(read => read.auditId)).toEqual(completed);
  expect(reads.filter(read => !read.aborted).every(read => read.outcome === 'response')).toBe(true);
  const aborted = reads.filter(read => read.aborted);
  expect(aborted.map(read => read.auditId)).toEqual(process.env.AS019_RUNTIME === 'production' ? productionAborts : developmentAborts);
  for (const read of aborted) {
    expect(read.hasSignal).toBe(true);
    expect(read.outcome).toBe('error');
    expect(read.errorName).toBe('AbortError');
    if (process.env.AS019_RUNTIME !== 'production') expect(read.abortStack).toMatch(/removeObserver/);
  }
}

async function installSavedReports(page: Page, baseURL: string) {
  const state = {
    status: 200, contentType: 'application/pdf', body: pdf as string | Buffer,
    heldReport: undefined as number | undefined, release: undefined as (() => void) | undefined,
    reads: [] as number[], writes: [] as string[], unexpectedReads: [] as string[],
  };
  // AuthProvider restores cookie sessions and removes legacy bearer tokens.
  await page.context().addCookies([{ name: 'connect.sid', value: 'synthetic-session', url: baseURL, httpOnly: true, sameSite: 'Lax' }]);
  await page.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ id: 4101 }));
    sessionStorage.setItem('active-business-profile:4101', '4102');
    // Synthetic, PDF-only observation. Keep every attempt and prove consumed
    // signal ownership rather than exempting arbitrary browser cancellations.
    window.__as019Reads = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const match = url.pathname.match(/^\/api\/ai-visibility\/audits\/(29|30)\/report$/);
      if (!match) return originalFetch(input, init);
      const signal = init?.signal;
      const read: PdfRead = { auditId: Number(match[1]), hasSignal: Boolean(signal), aborted: false, outcome: 'pending' };
      window.__as019Reads.push(read);
      signal?.addEventListener('abort', () => { read.aborted = true; read.abortStack = new Error('Synthetic PDF cancellation').stack; }, { once: true });
      return originalFetch(input, init).then(response => {
        read.outcome = 'response'; read.status = response.status; read.contentType = response.headers.get('Content-Type');
        return response;
      }, error => { read.outcome = 'error'; read.errorName = error.name; throw error; });
    };
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (!['GET', 'HEAD'].includes(request.method())) {
      state.writes.push(`${request.method()} ${path}`);
      return json({ error: 'All mutations are blocked by AS019 diagnosis.' }, 409);
    }
    if (!path.startsWith('/api/ai-visibility/')) return route.fallback();
    if (path === '/api/ai-visibility/projects') return json({ projects: [project] });
    if (path === '/api/ai-visibility/projects/1') return json({ project });
    if (path.endsWith('/overview')) return json({ project, measurementAudit: null });
    if (path.endsWith('/audits')) return json({ audits: [] });
    if (path.endsWith('/audits/estimate')) return json({ estimate: null });
    if (path.endsWith('/providers')) return json({ providers: [] });
    if (path.endsWith('/reports')) return json({ reports });
    if (path.endsWith('/report-shares')) return json({ shares: [] });
    if (path.endsWith('/report-deliveries')) return json({ deliveries: [] });
    const match = path.match(/^\/api\/ai-visibility\/audits\/(29|30)\/report$/);
    if (match) {
      state.reads.push(Number(match[1]));
      const headers = await request.allHeaders();
      expect(headers.authorization).toBeUndefined();
      expect(headers.cookie).toContain('connect.sid=synthetic-session');
      expect(headers['x-business-profile-id']).toBe('4102');
      if (state.heldReport === Number(match[1])) await new Promise<void>(resolve => { state.release = resolve; });
      if (state.status !== 200) return json({ error: 'Synthetic file transport failure.' }, state.status);
      return route.fulfill({ status: 200, contentType: state.contentType, headers: { 'Content-Disposition': `attachment; filename="synthetic-${match[1]}.pdf"` }, body: state.body });
    }
    state.unexpectedReads.push(path);
    return json({ error: `Unmocked synthetic read: ${path}` }, 404);
  });
  return state;
}

test('valid saved report transport mounts previews for two saved reports', async ({ page, audit, baseURL }, testInfo) => {
  const state = await installSavedReports(page, baseURL!);
  const response = await page.goto('/dashboard/ai-visibility/websites/1/reports');
  expect(response?.headers()['content-security-policy']).toContain("frame-src 'self' blob:");
  expect(response?.headers()['content-security-policy']).toContain("object-src 'none'");
  const preview = page.getByRole('region', { name: 'Report preview' });
  await expect(preview.getByTitle('PDF preview for analysis 29')).toHaveAttribute('src', /^blob:/);
  await expect(preview.getByRole('alert')).toHaveCount(0);
  // A mounted iframe proves transport/blob creation only. Native PDF rendering
  // is inspected separately; do not turn this assertion into a viewer claim.
  await preview.getByTitle('PDF preview for analysis 29').scrollIntoViewIfNeeded();
  const evidenceDir = process.env.AS019_EVIDENCE_DIR;
  await testInfo.attach('saved-pdf-29', { body: await preview.screenshot({ path: evidenceDir ? join(evidenceDir, `${testInfo.project.name}-saved-pdf-29.png`) : undefined }), contentType: 'image/png' });
  await testInfo.attach('pdf-viewer-diagnostics', {
    body: JSON.stringify({ nativePdfViewerEnabled: await page.evaluate(() => navigator.pdfViewerEnabled), policyErrors: audit.consoleErrors.filter(error => /content security policy|object-src|frame-src/i.test(error)) }),
    contentType: 'application/json',
  });
  await page.getByRole('button', { name: /Analysis #30/ }).click();
  await expect(preview.getByTitle('PDF preview for analysis 30')).toHaveAttribute('src', /^blob:/);
  await expectPdfReads(page, testInfo, [29, 30], [29, 30]);
  if (process.env.AS019_RUNTIME === 'production') expect(state.reads).toEqual([29, 30]);
  expect(state.writes).toEqual([]);
  expect(state.unexpectedReads).toEqual([]);
  await expectNoHorizontalOverflow(page);
});

test('persistent HTTP failure reproduces generic error after read-only Retry; recovered transport mounts preview', async ({ page, baseURL }, testInfo) => {
  const state = await installSavedReports(page, baseURL!);
  state.status = 404;
  await page.goto('/dashboard/ai-visibility/websites/1/reports');
  const preview = page.getByRole('region', { name: 'Report preview' });
  const alert = preview.getByRole('alert');
  await expect(alert).toContainText('The PDF preview could not be loaded.');
  await expect(preview.getByTitle('PDF preview for analysis 29')).toHaveCount(0);
  await expect(preview.getByRole('button', { name: 'Download PDF' })).toBeEnabled();
  const initialReads = state.reads.length;
  await alert.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => state.reads.length).toBeGreaterThan(initialReads);
  await expect(alert).toContainText('The PDF preview could not be loaded.');
  const evidenceDir = process.env.AS019_EVIDENCE_DIR;
  await testInfo.attach('persistent-http-404-after-retry', { body: await preview.screenshot({ path: evidenceDir ? join(evidenceDir, `${testInfo.project.name}-http-404-after-retry.png`) : undefined }), contentType: 'image/png' });
  state.status = 200;
  await alert.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(preview.getByTitle('PDF preview for analysis 29')).toHaveAttribute('src', /^blob:/);
  await expect(alert).toHaveCount(0);
  expect(state.reads.every(id => id === 29)).toBe(true);
  await expectPdfReads(page, testInfo, [29, 29, 29], [29]);
  expect(state.writes).toEqual([]);
  expect(state.unexpectedReads).toEqual([]);
  await expectNoHorizontalOverflow(page);
});

for (const status of [401, 403]) {
  test(`saved PDF HTTP ${status} keeps authorization recovery explicit without a viewer`, async ({ page, baseURL }, testInfo) => {
    const state = await installSavedReports(page, baseURL!);
    state.status = status;
    await page.goto('/dashboard/ai-visibility/websites/1/reports');
    const preview = page.getByRole('region', { name: 'Report preview' });
    await expect(preview.getByRole('alert')).toContainText(status === 401 ? 'sign in again' : 'permission');
    await expect(preview.locator('iframe')).toHaveCount(0);
    await expect(preview.getByRole('link', { name: 'Open PDF in a new tab' })).toHaveCount(0);
    await preview.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(preview.getByRole('alert')).toContainText(`HTTP ${status}`);
    await expectPdfReads(page, testInfo, [29, 29], [29]);
    if (process.env.AS019_RUNTIME === 'production') expect(state.reads).toEqual([29, 29]);
    expect(state.writes).toEqual([]);
    expect(state.unexpectedReads).toEqual([]);
    await expectNoHorizontalOverflow(page);
  });
}

for (const invalid of [
  { name: 'HTML success', contentType: 'text/html', body: '<html>Synthetic login page</html>' },
  { name: 'mislabeled HTML', contentType: 'application/pdf', body: '<html>Synthetic storage response</html>' },
  { name: 'empty PDF', contentType: 'application/pdf', body: '' },
]) {
  test(`saved PDF rejects ${invalid.name} and recovers only after validated bytes`, async ({ page, baseURL }, testInfo) => {
    const state = await installSavedReports(page, baseURL!);
    state.contentType = invalid.contentType;
    state.body = invalid.body;
    await page.goto('/dashboard/ai-visibility/websites/1/reports');
    const preview = page.getByRole('region', { name: 'Report preview' });
    await expect(preview.getByRole('alert')).toContainText('valid PDF');
    await expect(preview.locator('iframe')).toHaveCount(0);
    await expect(preview.getByRole('link', { name: 'Open PDF in a new tab' })).toHaveCount(0);
    state.contentType = 'application/pdf';
    state.body = pdf;
    await preview.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(preview.getByTitle('PDF preview for analysis 29')).toHaveAttribute('src', /^blob:/);
    await expect(preview.getByRole('link', { name: 'Save PDF' })).toHaveAttribute('download', 'ai-visibility-audit-29.pdf');
    await expectPdfReads(page, testInfo, [29, 29], [29]);
    if (process.env.AS019_RUNTIME === 'production') expect(state.reads).toEqual([29, 29]);
    expect(state.writes).toEqual([]);
    expect(state.unexpectedReads).toEqual([]);
    await expectNoHorizontalOverflow(page);
  });
}

test('saved PDF provides recovery when the browser cannot embed PDFs', async ({ page, baseURL }, testInfo) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'pdfViewerEnabled', { value: false }));
  const state = await installSavedReports(page, baseURL!);
  await page.goto('/dashboard/ai-visibility/websites/1/reports');
  const preview = page.getByRole('region', { name: 'Report preview' });
  await expect(preview.getByText('This browser cannot display PDFs inline.', { exact: false })).toBeVisible();
  await expect(preview.locator('iframe')).toHaveCount(0);
  const open = preview.getByRole('link', { name: 'Open PDF in a new tab' });
  await expect(open).toHaveAttribute('href', /^blob:/);
  await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(preview.getByRole('link', { name: 'Save PDF' })).toHaveAttribute('download', 'ai-visibility-audit-29.pdf');
  await testInfo.attach('unsupported-inline-viewer', { body: await preview.screenshot(), contentType: 'image/png' });
  await expectPdfReads(page, testInfo, [29], [29]);
  if (process.env.AS019_RUNTIME === 'production') expect(state.reads).toEqual([29]);
  expect(state.writes).toEqual([]);
  expect(state.unexpectedReads).toEqual([]);
  await expectNoHorizontalOverflow(page);
});

test('selecting another report cancels its loading read and never replaces the current preview', async ({ page, baseURL }, testInfo) => {
  const state = await installSavedReports(page, baseURL!);
  state.heldReport = 29;
  const canceled: string[] = [];
  page.on('requestfailed', request => {
    if (new URL(request.url()).pathname === '/api/ai-visibility/audits/29/report') canceled.push(request.failure()?.errorText || 'unknown');
  });
  await page.goto('/dashboard/ai-visibility/websites/1/reports');
  const preview = page.getByRole('region', { name: 'Report preview' });
  await expect(preview.getByRole('status')).toHaveText('Loading PDF preview…');
  await expect(preview.locator('iframe')).toHaveCount(0);
  await page.getByRole('button', { name: /Analysis #30/ }).click();
  await expect(preview.getByTitle('PDF preview for analysis 30')).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => canceled).toEqual(process.env.AS019_RUNTIME === 'production' ? ['net::ERR_ABORTED'] : ['net::ERR_ABORTED', 'net::ERR_ABORTED']);
  state.release?.();
  await expect(preview.getByTitle('PDF preview for analysis 29')).toHaveCount(0);
  await expect(preview.getByRole('alert')).toHaveCount(0);
  await testInfo.attach('owned-pdf-selection-cancellation', { body: JSON.stringify({ canceled, reads: state.reads }), contentType: 'application/json' });
  await expectPdfReads(page, testInfo, [30], [29, 29, 30], [29]);
  if (process.env.AS019_RUNTIME === 'production') expect(state.reads).toEqual([29, 30]);
  expect(state.writes).toEqual([]);
  expect(state.unexpectedReads).toEqual([]);
  await expectNoHorizontalOverflow(page);
});
