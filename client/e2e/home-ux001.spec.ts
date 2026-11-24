import { test, expect, expectNoHorizontalOverflow, installAppShellMocks } from './fixtures/app';

const campaignTitle = 'Finance leaders campaign with a long, fully accessible title';
test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });

test.beforeEach(async ({ page }) => {
  // Keep this UI regression entirely local, including unexpected API requests.
  await page.route('**/api/**', route => route.fulfill({ json: {}, status: route.request().method() === 'GET' ? 200 : 409 }));
  await installAppShellMocks(page);
  await page.route('**/api/chat/threads?*', route => route.fulfill({ json: {
    threads: Array.from({ length: 10 }, (_, index) => ({ id: 500 + index, title: `${campaignTitle} ${index + 1}`, stats: {}, createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z' })), total: 10,
  } }));
  await page.route('**/api/dashboard/stats', route => route.fulfill({ json: {} }));
  await page.route('**/api/suggestions', route => route.fulfill({ json: { success: true, suggestions: ['Find qualified prospects', 'Draft a useful customer update'] } }));
  await page.route('**/api/setup/onboarding-status', route => route.fulfill({ json: { profile: {}, completedTasks: ['brand'], connectedChannels: [] } }));
});

for (const viewport of [{ width: 1311, height: 841 }, { width: 1024, height: 720 }]) {
  test(`workspace destinations and quick starts are discoverable at ${viewport.width} × ${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto('/dashboard/home');
    await expect(page.getByLabel('What should the team accomplish?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Find qualified prospects', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('home.png') });
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    for (const label of ['Lead Generation', 'Content Creator', 'CRM', 'Support']) {
      await expect(nav.getByRole('button', { name: `${label} pages`, exact: true })).toBeInViewport({ ratio: 1 });
    }
    await expect(nav.getByRole('link', { name: `${campaignTitle} 1`, exact: true })).toBeHidden();
    await expect(page.getByText('Workspace setup complete', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Find qualified prospects', exact: true })).toBeInViewport({ ratio: 0.5 });
    await expectNoHorizontalOverflow(page);
  });
}

test('keyboard expansion persists and campaign labels remain complete', async ({ page }) => {
  await page.setViewportSize({ width: 1311, height: 841 });
  await page.goto('/dashboard/home');
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  const campaigns = nav.getByRole('button', { name: 'Campaign History pages', exact: true });
  await campaigns.focus();
  await page.keyboard.press('Enter');
  const link = nav.getByRole('link', { name: `${campaignTitle} 1`, exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('title', `${campaignTitle} 1`);
  await page.keyboard.press('Tab');
  await expect(nav.getByRole('link', { name: 'New Campaign', exact: true })).toBeFocused();
  await page.reload();
  await expect(link).toBeVisible();
  await campaigns.focus();
  await page.keyboard.press('Space');
  await expect(link).toBeHidden();
  await page.reload();
  await expect(link).toBeHidden();
  await expect(nav.getByRole('button', { name: 'Support pages', exact: true })).toBeInViewport();
  const review = page.locator('summary').filter({ hasText: 'Workspace setup complete' });
  await review.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: /Review your brand toolkit/ })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Refresh workspace next steps' })).toBeFocused();
});

test('incomplete onboarding retains next steps and completed setup fits mobile', async ({ page }, info) => {
  await page.route('**/api/setup/onboarding-status', route => route.fulfill({ json: { profile: { applicationUses: ['sales_leads'], setupGoal: 'Find our first prospects' }, completedTasks: [], connectedChannels: [] } }));
  await page.goto('/dashboard/home');
  await expect(page.getByRole('heading', { name: 'Put your workspace to work' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Add your first prospects.*Next step/ })).toBeVisible();
  await expect(page.getByText('Workspace setup complete', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Your first goal: Find our first prospects', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('incomplete-setup.png') });
  await expectNoHorizontalOverflow(page);
  await page.route('**/api/setup/onboarding-status', route => route.fulfill({ json: { profile: {}, completedTasks: ['brand'], connectedChannels: [] } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByText('Workspace setup complete', { exact: true })).toBeVisible();
  await expect(page.getByLabel('What should the team accomplish?')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath('mobile-home.png') });
});

test('page finder keeps the two Pipeline destinations distinct', async ({ page }) => {
  await page.goto('/dashboard/home');
  await expect(page.getByLabel('What should the team accomplish?')).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Pipeline');
  const options = page.getByRole('option');
  await expect(options.filter({ hasText: 'CRM' })).toHaveCount(1);
  await expect(options.filter({ hasText: 'Support' })).toHaveCount(1);
  await page.keyboard.press('Escape');
});

test('saved expanded campaign history keeps operational destinations first', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.addInitScript(() => localStorage.setItem('navigation:4101:sidebar', JSON.stringify({ open: true, sections: { campaigns: true } })));
  await page.goto('/dashboard/home');
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(nav.getByRole('link', { name: `${campaignTitle} 1`, exact: true })).toBeVisible();
  for (const label of ['Lead Generation', 'Content Creator', 'CRM', 'Support']) {
    await expect(nav.getByRole('button', { name: `${label} pages`, exact: true })).toBeInViewport({ ratio: 1 });
  }
});

test('a workspace with no campaigns retains its first-time next steps', async ({ page, isMobile }) => {
  await page.route('**/api/chat/threads?*', route => route.fulfill({ json: { threads: [], total: 0 } }));
  await page.route('**/api/setup/onboarding-status', route => route.fulfill({ json: { profile: { applicationUses: ['sales_leads'] }, completedTasks: [], connectedChannels: [] } }));
  await page.goto('/dashboard/home');
  await expect(page.getByRole('heading', { name: 'Put your workspace to work' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Add your first prospects.*Next step/ })).toBeVisible();
  await page.getByRole('button', { name: 'Brief an agent', exact: true }).click();
  await expect(page.getByLabel('What should the team accomplish?')).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  if (isMobile) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await expect(nav).toBeVisible();
  await nav.getByRole('button', { name: 'Campaign History pages', exact: true }).click();
  await expect(nav.getByText('No campaigns for this profile', { exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'New Campaign', exact: true })).toHaveAttribute('href', '/dashboard/conversations');
  await expect(nav.getByRole('link', { name: 'All Campaigns', exact: true })).toHaveAttribute('href', '/dashboard/chats');
});

test('sidebar visibility restores after reload', async ({ page }) => {
  await page.setViewportSize({ width: 1311, height: 841 });
  await page.goto('/dashboard/home');
  await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeHidden();
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});
