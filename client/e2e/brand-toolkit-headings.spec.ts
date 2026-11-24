import { test, expect, expectNoHorizontalOverflow, installAppShellMocks } from './fixtures/app';

const panels = [
  { title: 'Brand Details', subsections: [] },
  { title: 'Visual Identity', subsections: ['Color Palette', 'Typography Fonts'] },
  { title: 'Voice & Values', subsections: [] },
  { title: 'Content Settings', subsections: ['Audience Guidance'] },
  { title: 'Social Media', subsections: [] },
];

test('AS011: brand setup keeps meaningful headings when its sidebar title is hidden', async ({ page, audit, isMobile }, testInfo) => {
  const mutations: string[] = [];
  const pageErrors: string[] = [];
  const cancelledPrefetches = new Set<string>();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => {
    if (request.failure()?.errorText === 'net::ERR_ABORTED' && request.headers()['next-router-prefetch'] === '1') {
      cancelledPrefetches.add(`${request.method()} ${request.url()}: net::ERR_ABORTED`);
    }
  });
  // Contain every API request locally, then install the synthetic shell identity.
  await page.route('**/api/**', route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      mutations.push(`${route.request().method()} ${route.request().url()}`);
    }
    return route.fulfill({ json: {} });
  });
  await installAppShellMocks(page);

  const viewport = isMobile ? { width: 390, height: 844 } : { width: 1311, height: 841 };
  await page.setViewportSize(viewport);
  await page.goto('/dashboard/brand-toolkit/new');
  const content = page.locator('#main-content');
  const title = content.getByRole('heading', { name: 'Create Brand Toolkit', level: 1, exact: true });
  await expect(title).toBeVisible();

  // Also cross lg in both directions without reloading or changing the panel.
  for (const width of [viewport.width, 1023, 1024, viewport.width]) {
    await page.setViewportSize({ width, height: viewport.height });
    const sidebarTitle = content.locator('aside').getByText('Brand', { exact: true });
    if (width < 1024) await expect(sidebarTitle).toBeHidden();
    else await expect(sidebarTitle).toBeVisible();

    for (const panel of panels) {
      await test.step(`${width}px: ${panel.title}`, async () => {
        const button = content.getByRole('button', { name: panel.title, exact: true });
        await button.focus();
        await page.keyboard.press('Enter');
        const heading = content.getByRole('heading', { name: panel.title, level: 2, exact: true });
        await expect(heading).toBeVisible();
        await expect(content.getByRole('heading', { level: 2 })).toHaveText([panel.title]);
        await expect(content.getByRole('heading', { level: 3 })).toHaveText(panel.subsections);
        await expect(content.getByRole('heading', { level: 4 })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);

        // These snapshots reflect the headings exposed for assistive navigation,
        // including CSS visibility, rather than only inspecting DOM tag names.
        const headings = (await content.ariaSnapshot()).split('\n').filter(line => /^\s*- heading /.test(line)).map(line => line.trim());
        expect(headings).toEqual([
          '- heading "Create Brand Toolkit" [level=1]',
          `- heading "${panel.title}" [level=2]`,
          ...panel.subsections.map(name => `- heading "${name}" [level=3]`),
        ]);
      });
    }
  }
  // Next may cancel speculative sidebar prefetches as responsive links change.
  // Keep those in the audit while still rejecting failed application requests.
  await testInfo.attach('browser-audit', { body: JSON.stringify({ mutations, pageErrors, audit, cancelledPrefetches: [...cancelledPrefetches] }), contentType: 'application/json' });
  expect(mutations).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
  expect(audit.failedRequests.filter(request => !cancelledPrefetches.has(request))).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
});
