import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';

const contacts = Array.from({ length: 690 }, (_, index) => ({
  id: index + 1, leadId: null, firstName: `Contact ${index + 1}`, lastName: 'Example',
  email: `contact${index + 1}@example.test`, company: 'Example Company', phone: null,
  pipelineStatus: index % 2 ? 'contacted' : 'new', status: 'new', currency: 'USD',
  dealValue: '1250', tags: [], createdAt: '2026-01-01T00:00:00Z',
}));

test.beforeEach(async ({ page }) => {
  // Synthetic records only; never allow requests to reach an account or backend.
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await installAppShellMocks(page);
  await page.route('**/api/crm/**', async route => {
    expect(route.request().method()).toBe('GET');
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/configuration')) return route.fallback();
    if (url.pathname.endsWith('/assignees')) return route.fulfill({ json: [] });
    if (url.pathname.endsWith('/analytics')) {
      return route.fulfill({ json: { totalContacts: 690, winRate: 12, pipelineValueByCurrency: { USD: '1250' } } });
    }
    const search = url.searchParams.get('search')?.toLowerCase();
    const stage = url.searchParams.get('pipelineStatus');
    const filtered = contacts.filter(contact => (!search || contact.firstName.toLowerCase().includes(search)) && (!stage || contact.pipelineStatus === stage));
    const limit = Number(url.searchParams.get('limit') || 20);
    const offset = (Number(url.searchParams.get('page') || 1) - 1) * limit;
    return route.fulfill({ json: { contacts: filtered.slice(offset, offset + limit), total: filtered.length, totalPages: Math.ceil(filtered.length / limit) } });
  });
});

test('Contacts shows four full desktop rows and discoverable primary controls', async ({ page }, testInfo) => {
  if (testInfo.project.name.includes('desktop')) await page.setViewportSize({ width: 1311, height: 841 });
  await page.goto('/dashboard/crm/contacts');
  await expect(page.getByRole('link', { name: 'Contact 1 Example', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(page.getByRole('button', { name: 'Add Contact', exact: true })).toBeInViewport();
  await expect(page.getByRole('textbox', { name: 'Search contacts' })).toBeInViewport();
  await expect(page.getByRole('combobox', { name: 'Saved view' })).toBeInViewport();
  await expect(page.getByRole('combobox', { name: 'Filter by pipeline stage' })).not.toBeVisible();
  const rows = await page.locator('article').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }));
  if (page.viewportSize()?.width === 1311) {
    expect(rows.filter(row => row.top >= 0 && row.bottom <= 841).length).toBeGreaterThanOrEqual(4);
  }
  console.log(JSON.stringify({ viewport: page.viewportSize(), firstRowTop: rows[0]?.top, fullRows: rows.filter(row => row.top >= 0 && row.bottom <= (page.viewportSize()?.height || 0)).length }));
  const metrics = page.getByText('CRM metrics', { exact: true });
  await metrics.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Win rate', { exact: true })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByText('Win rate', { exact: true })).not.toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('contacts.png') });
  const navigation = page.getByRole('navigation', { name: 'CRM workspace' });
  await expect(navigation.getByRole('link')).toHaveCount(5);
  await expect(page.getByRole('navigation', { name: 'People directories' })).toHaveCount(0);
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  for (const name of ['Import', 'Export filtered CSV', 'Sync to Email Outreach', 'CRM Configuration', 'Add Lead']) {
    await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');
});

test('Collapsed advanced filters keep chips, server semantics and no-results recovery', async ({ page }, testInfo) => {
  await page.goto('/dashboard/crm/contacts');
  await expect(page.getByRole('link', { name: 'Contact 1 Example' })).toBeVisible();
  const search = page.getByRole('textbox', { name: 'Search contacts' });
  await search.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('combobox', { name: 'Saved view' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Save view', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  const advanced = page.getByRole('button', { name: 'Advanced filters', exact: true });
  await expect(advanced).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(advanced).toHaveAttribute('aria-expanded', 'true');
  await expectNoHorizontalOverflow(page);
  await page.getByRole('combobox', { name: 'Filter by pipeline stage' }).selectOption('contacted');
  await expect(page.getByRole('link', { name: 'Contact 2 Example' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'matching contacts' })).toHaveText('345 matching contacts · 690 total contacts');
  await page.getByRole('button', { name: 'Advanced filters (1)', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Filter by pipeline stage' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove stage filter' })).toHaveText(/Stage: Ongoing/);
  await page.locator('#main-content').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('active-filters.png') });
  await search.fill('unmatched-query');
  await expect(page.getByText('No contacts match these filters.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Contact 1 Example' })).toBeVisible();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Remove stage filter' })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'matching contacts' })).toHaveText('690 matching contacts · 690 total contacts');
});

test('Saved views restore filters while collapsed and pagination supports every row count', async ({ page }) => {
  await page.goto('/dashboard/crm/contacts');
  await expect(page.getByRole('link', { name: 'Contact 1 Example' })).toBeVisible();
  await page.getByRole('button', { name: 'Advanced filters', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter by pipeline stage' }).selectOption('contacted');
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await page.getByLabel('View name', { exact: true }).fill('Ongoing example contacts');
  await page.getByRole('dialog').getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Contact 1 Example' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Saved view' }).selectOption({ label: 'Ongoing example contacts' });
  await expect(page.getByRole('button', { name: 'Remove stage filter' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Filter by pipeline stage' })).not.toBeVisible();
  await page.getByRole('button', { name: 'Remove stage filter' }).click();
  for (const size of [10, 20, 50, 100]) {
    await page.getByRole('combobox', { name: 'Rows per page' }).selectOption(String(size));
    await expect(page.locator('article')).toHaveCount(size);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByRole('link', { name: `Contact ${size + 1} Example`, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Previous page' }).click();
    await expect(page.getByRole('link', { name: 'Contact 1 Example', exact: true })).toBeVisible();
  }
  await expectNoHorizontalOverflow(page);
});
