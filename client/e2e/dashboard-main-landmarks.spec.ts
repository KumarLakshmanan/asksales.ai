import type { Page, TestInfo } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';
import { installLandmarkFixtures } from './fixtures/dashboard-landmarks';

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });
const website = '/dashboard/ai-visibility/websites/1';
const sections = [
  ['seo', 'SEO health', 'SEO'], ['aeo', 'AEO coverage', 'AEO'], ['geo', 'GEO observations', 'GEO'],
  ['commerce', 'Commerce readiness', 'Commerce'], ['competitors', 'Competitors', 'Competitors'],
  ['fixes', 'Prioritized fixes', 'Fixes'], ['assets', 'Generated assets', 'Assets'], ['reports', 'Reports', 'Reports'],
];
const routes = [
  ['/dashboard/proposals', 'Proposals'],
  ['/dashboard/integrations/instagram/events', 'Events and activity'],
  ['/dashboard/settings/outreach/orchestration', 'AI reply operations'],
  ['/dashboard/ai-visibility', 'AI Visibility websites'], [website, 'Visibility overview'],
  ...sections.map(([view, title]) => [`${website}/${view}`, title]),
];

async function structure(page: Page, heading: string, testInfo?: TestInfo) {
  await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
  await expect(page.locator('#main-content .animate-spin:visible')).toHaveCount(0);
  const facts = await page.locator('main, [role="main"]').evaluateAll(elements => elements.map(element => {
    const bounds = element.getBoundingClientRect();
    return { tag: element.tagName, id: element.id, role: element.getAttribute('role'),
      nested: !!element.parentElement?.closest('main, [role="main"]'),
      visible: bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).visibility !== 'hidden',
      bounds: { width: bounds.width, height: bounds.height, left: bounds.left, top: bounds.top } };
  }));
  // Inspect Chromium's actual accessibility tree in addition to DOM and role locators.
  const cdp = await page.context().newCDPSession(page);
  const tree = await cdp.send('Accessibility.getFullAXTree');
  await cdp.detach();
  const mains = tree.nodes.filter(node => !node.ignored && node.role?.value === 'main');
  const snapshot = await page.locator('body').ariaSnapshot();
  const layout = await page.getByRole('heading', { level: 1, name: heading, exact: true }).evaluate(element => {
    let wrapper = element;
    while (wrapper.parentElement && wrapper.parentElement.id !== 'main-content') wrapper = wrapper.parentElement;
    const bounds = wrapper.getBoundingClientRect();
    return { tag: wrapper.tagName, className: wrapper.className, bounds: {
      width: bounds.width, height: bounds.height, left: bounds.left, top: bounds.top,
    } };
  });
  if (testInfo) await testInfo.attach('landmark-evidence', { contentType: 'application/json', body: JSON.stringify({
    route: new URL(page.url()).pathname, viewport: page.viewportSize(), facts,
    accessibilityMains: mains.map(node => ({ role: node.role?.value, name: node.name?.value })),
    heading, layout, breadcrumb: await page.getByRole('navigation', { name: 'Breadcrumb', exact: true }).innerText(),
  }, null, 2) });
  expect(facts.filter(fact => fact.visible)).toHaveLength(1);
  expect(facts.some(fact => fact.nested)).toBe(false);
  expect(mains).toHaveLength(1);
  expect(snapshot.match(/^\s*- main(?:\s|:|$)/gm)).toHaveLength(1);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.locator('#main-content')).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveAttribute('id', 'main-content');
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb', exact: true });
  await expect(breadcrumb.locator('[aria-current="page"]')).toHaveCount(1);
  expect(await breadcrumb.evaluate(element => !!element.closest('#main-content'))).toBe(true);
  if (new URL(page.url()).pathname.startsWith('/dashboard/ai-visibility') && !new URL(page.url()).pathname.includes('/audits/')) {
    await expect(page.locator('#ai-visibility-title')).toHaveText(heading);
    await expect(page.locator('[aria-labelledby="ai-visibility-title"]')).toHaveCount(1);
    await expect(page.locator('[aria-labelledby="ai-visibility-title"]')).not.toHaveAttribute('role', 'main');
  }
  await expectNoHorizontalOverflow(page);
  if (new URL(page.url()).pathname === '/dashboard/proposals') {
    for (const label of ['Search proposals', 'Status filter', 'Attention filter', 'Sort proposals']) {
      await expect(page.getByLabel(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Proposal settings', exact: true })).toBeVisible();
  }
  if (new URL(page.url()).pathname.includes('/integrations/') && new URL(page.url()).pathname.endsWith('/events')) {
    await expect(page.getByRole('button', { name: 'Refresh activity', exact: true })).toBeVisible();
  }
  if (heading === 'AI reply operations') {
    await expect(page.getByRole('button', { name: 'Refresh data', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toBeVisible();
  }
  const h1 = await page.getByRole('heading', { level: 1, name: heading, exact: true }).boundingBox();
  expect(h1!.x).toBeGreaterThanOrEqual(0);
  expect(h1!.x + h1!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

async function skipToContent(page: Page) {
  const skip = page.getByRole('link', { name: 'Skip to content', exact: true });
  await expect(skip).toHaveAttribute('href', '#main-content');
  await skip.focus();
  await expect(skip).toBeVisible();
  await skip.press('Enter');
  await expect(page).toHaveURL(/#main-content$/);
  // Native fragment navigation establishes the content start for keyboard traversal.
  await page.keyboard.press('Tab');
  expect(await page.locator('#main-content').evaluate(element => element.contains(document.activeElement))).toBe(true);
  const route = new URL(page.url()).pathname;
  if (route === '/dashboard/proposals') {
    await page.getByLabel('Search proposals', { exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Status filter', { exact: true })).toBeFocused();
  } else if (route.endsWith('/events')) {
    await page.getByLabel('Search activity', { exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'All activity', exact: true })).toBeFocused();
  } else if (route === '/dashboard/ai-visibility') {
    await page.getByLabel('Search websites', { exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('combobox', { name: 'Measurement state', exact: true })).toBeFocused();
  } else if (route.startsWith(website)) {
    await page.getByLabel('Select website', { exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Select measurement', { exact: true })).toBeFocused();
  } else {
    await page.getByRole('button', { name: 'Refresh data', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toBeFocused();
  }
}

for (const [route, heading] of routes) {
  test(`AS015 direct load, refresh and skip navigation: ${route}`, async ({ page, audit }, testInfo) => {
    const fixture = await installLandmarkFixtures(page);
    fixture.pause();
    await page.goto(route);
    await expect(page.locator('#main-content')).toBeVisible();
    await expect.poll(() => fixture.pending > 0).toBe(true);
    try {
      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(page.locator('main main, main [role="main"]')).toHaveCount(0);
    } finally {
      fixture.resume();
    }
    await expect.poll(() => fixture.pending).toBe(0);
    await structure(page, heading, testInfo);
    if (route === '/dashboard/proposals') {
      await expect(page.getByRole('heading', { name: 'No proposals match this view', exact: true })).toBeVisible();
    }
    if (route.endsWith('/events')) {
      await expect(page.getByText('Synthetic incoming message', { exact: true })).toBeVisible();
    }
    await page.screenshot({ path: testInfo.outputPath('settled.png'), fullPage: true, animations: 'disabled' });
    await skipToContent(page);
    await page.reload();
    await expect.poll(() => fixture.pending).toBe(0);
    await structure(page, heading);
    expect(fixture.forbiddenActions).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
  });
}

test('AS015 website navigation, leave/return and browser history keep all ten routes current', async ({ page, audit }) => {
  const fixture = await installLandmarkFixtures(page);
  await page.goto('/dashboard/ai-visibility');
  await structure(page, 'AI Visibility websites');
  await page.getByRole('link', { name: 'Open website →', exact: true }).click();
  await structure(page, 'Visibility overview');
  await page.getByRole('link', { name: 'All websites', exact: true }).click();
  await structure(page, 'AI Visibility websites');
  await page.goBack();
  await structure(page, 'Visibility overview');
  await page.goForward();
  await structure(page, 'AI Visibility websites');
  await page.goBack();
  await structure(page, 'Visibility overview');
  for (const [view, heading, label] of sections) {
    const nav = page.getByRole('navigation', { name: 'Synthetic website visibility sections', exact: true });
    // The narrow layout uses a native select; the desktop layout uses section links.
    if (await page.getByRole('combobox', { name: 'Visibility section', exact: true }).isVisible()) {
      await page.getByRole('combobox', { name: 'Visibility section', exact: true }).selectOption(view);
    } else {
      await nav.getByRole('link', { name: label, exact: true }).click();
    }
    await expect(page).toHaveURL(new RegExp(`${website}/${view}$`));
    await structure(page, heading);
    await page.getByRole('link', { name: 'All websites', exact: true }).click();
    await structure(page, 'AI Visibility websites');
    await page.goBack();
    await structure(page, heading);
    await page.goForward();
    await structure(page, 'AI Visibility websites');
    await page.goBack();
    await structure(page, heading);
  }
  expect(fixture.forbiddenActions).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

test('AS015 proposals, Instagram events and orchestration return through dashboard navigation and history', async ({ page, audit }) => {
  const fixture = await installLandmarkFixtures(page);
  // Use the existing page search for a dashboard list entry.
  await page.goto('/dashboard/integrations/instagram');
  await page.getByRole('button', { name: /Find a page in/ }).click();
  await page.getByPlaceholder(/Search pages/).fill('Proposals');
  await page.getByRole('dialog').getByRole('option', { name: /Proposals/ }).first().click();
  await structure(page, 'Proposals');
  fixture.populatedProposals = true;
  await page.reload();
  await expect(page.getByText('Synthetic offer', { exact: true })).toBeVisible();
  await structure(page, 'Proposals');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Instagram', exact: true })).toBeVisible();
  await page.goForward();
  await structure(page, 'Proposals');
  await page.goto('/dashboard/integrations/instagram');
  await page.getByRole('link', { name: 'Events', exact: true }).click();
  await expect(page.getByText('Synthetic incoming message')).toBeVisible();
  await structure(page, 'Events and activity');
  await page.getByRole('link', { name: 'Back to Instagram', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/integrations\/instagram$/);
  await expect(page.getByRole('heading', { name: 'Instagram', exact: true })).toBeVisible();
  await page.goBack();
  await structure(page, 'Events and activity');
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Instagram', exact: true })).toBeVisible();
  await page.goBack();
  await structure(page, 'Events and activity');
  await page.goto('/dashboard/settings/outreach/operations');
  await page.getByRole('link', { name: 'Reply queue', exact: true }).click();
  await structure(page, 'AI reply operations');
  await page.getByRole('button', { name: 'Back to outreach settings', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/settings\/outreach$/);
  await page.goBack();
  await structure(page, 'AI reply operations');
  await page.goForward();
  await expect(page).toHaveURL(/\/dashboard\/settings\/outreach$/);
  await page.goBack();
  await structure(page, 'AI reply operations');
  expect(fixture.forbiddenActions).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

test('AS015 shared Events wrappers and AI audit-detail/error states retain the dashboard main', async ({ page, audit }) => {
  const fixture = await installLandmarkFixtures(page);
  for (const platform of ['facebook', 'whatsapp', 'msg91']) {
    await page.goto(`/dashboard/integrations/${platform}/events`);
    await expect(page.getByText('Synthetic incoming message')).toBeVisible();
    await structure(page, 'Events and activity');
  }
  await page.goto('/dashboard/ai-visibility/audits/11');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await structure(page, await page.getByRole('heading', { level: 1 }).innerText());
  fixture.websiteFails = true;
  await page.goto(website);
  await expect(page.getByText('This website workspace could not be loaded. It may not exist or you may not have access.')).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.locator('main main, main [role="main"]')).toHaveCount(0);
  expect(fixture.forbiddenActions).toEqual([]);
  // The intentionally failed local request can generate a Chromium 404 console message.
  expect(audit.consoleErrors.filter(error => !error.includes('404'))).toEqual([]);
});
