import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';

const panels = ['Brand Details', 'Visual Identity', 'Voice & Values', 'Content Settings', 'Social Media'];

test('AS010: brand setup keeps one dashboard main and an accessible settings region in every panel', async ({ page, audit }) => {
  await page.setViewportSize(test.info().project.name === 'desktop-chromium'
    ? { width: 1311, height: 841 }
    : { width: 390, height: 844 });

  // The complete dashboard shell uses a synthetic identity and browser-local API responses.
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await installAppShellMocks(page);
  const mutations: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/api/') && !['GET', 'HEAD'].includes(request.method())) {
      mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });

  await page.goto('/dashboard/brand-toolkit/new');
  await expect(page.getByRole('heading', { name: 'Create Brand Toolkit', exact: true })).toBeVisible();
  const main = page.getByRole('main');
  const settings = main.getByRole('region', { name: 'Brand toolkit settings', exact: true });
  const skipLink = page.getByRole('link', { name: 'Skip to content', exact: true });
  await expect(skipLink).toHaveAttribute('href', '#main-content');
  await skipLink.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/dashboard\/brand-toolkit\/new#main-content$/);

  for (const [index, panel] of panels.entries()) {
    const button = page.getByRole('button', { name: panel, exact: true });
    await button.scrollIntoViewIfNeeded();
    await button.focus();
    await page.keyboard.press('Enter');
    const heading = settings.getByRole('heading', { name: panel, exact: true, level: 2 });
    await expect(heading).toBeVisible();
    // Wait for the outgoing animation to leave before checking the active panel.
    await expect(settings.getByRole('heading', { level: 2 })).toHaveCount(1);
    await expect(settings.getByRole('textbox').first()).toBeVisible();
    await expect(settings.getByRole('button', { name: index === panels.length - 1 ? 'Create Toolkit' : 'Continue', exact: true })).toBeEnabled();

    await expect(page.locator('main, [role="main"]')).toHaveCount(1);
    await expect(main).toHaveAttribute('id', 'main-content');
    expect(await main.evaluate(element => element.parentElement?.closest(
      'main, [role="main"], aside, nav, header, footer, section[aria-label], section[aria-labelledby], [role="banner"], [role="navigation"], [role="complementary"], [role="contentinfo"], [role="region"]',
    ) === null)).toBe(true);
    await expect(settings).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
  }

  expect(mutations).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});
