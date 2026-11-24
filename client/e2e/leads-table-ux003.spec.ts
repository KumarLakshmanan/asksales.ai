import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';

const lead = {
  id: 73001,
  name: 'Alexandra Morgan Example with an intentionally long prospect name',
  company: 'Example Research and Development International Corporation',
  role: 'Director of Research',
  email: 'alexandra.morgan.long.contact.address@example.test',
  phone: '+1 555 010 7300',
  source: 'crm_import',
  status: 'qualified',
  leadStatus: 'qualified',
  score: 91,
  repliedEmails: 1,
  campaignData: { campaignName: 'Example qualification campaign' },
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ id: 4101 }));
    sessionStorage.setItem('active-business-profile:4101', '4102');
  });
  // Keep every request local to synthetic fixtures; no live lead records.
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (/^\/api\/(auth\/me|platform\/access|settings\/preferences|settings\/business-profiles|organizations|crm\/configuration|wallet|chat\/threads|notifications\/unread\/count)$/.test(path)) {
      await route.fallback();
    } else if (path === '/api/leads') {
      await route.fulfill({ json: { data: [lead], total: 1, totalPages: 1 } });
    } else {
      await route.fulfill({ json: { success: false } });
    }
  });
});

test('qualification and primary action fit the default view, with full identity reveal', async ({ page, audit }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile-chromium';
  if (!mobile) await page.setViewportSize({ width: 1311, height: 841 });
  await page.goto('/dashboard/leads');
  if (mobile) {
    const cards = page.getByLabel('Lead cards');
    await expect(cards.getByText('Qualified', { exact: true })).toBeVisible();
    await expect(cards.getByText('Replied', { exact: true })).toBeVisible();
    await expect(cards.getByText('91%', { exact: true })).toBeVisible();
    await expect(cards.getByRole('button', { name: `View ${lead.name}` })).toBeVisible();
    const summary = cards.locator('summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(cards.locator('dd').filter({ hasText: lead.name })).toBeVisible();
    await expect(cards.locator('dd').filter({ hasText: lead.email })).toBeVisible();
    await expect(cards.locator('dd').filter({ hasText: 'CRM import' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await cards.screenshot({ path: '/tmp/UX003-v8-leads-mobile-synthetic.png', scale: 'css' });
  } else {
    const table = page.getByRole('table', { name: 'Leads list' });
    await expect(table).toBeVisible();
    await table.scrollIntoViewIfNeeded();
    const region = page.getByRole('region', { name: 'Scrollable leads table' });
    expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    for (const control of [table.getByRole('columnheader', { name: 'Status', exact: true }), table.getByRole('columnheader', { name: 'Engagement' }), table.getByRole('columnheader', { name: 'Quality score' }), table.getByRole('button', { name: 'View lead details' })]) {
      const bounds = await control.boundingBox();
      const viewport = await region.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(viewport!.x);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width + 1);
    }
    await region.locator('..').locator('..').screenshot({ path: '/tmp/UX003-v8-leads-wide-table-synthetic.png', scale: 'css' });
    const disclosure = table.getByRole('button', { name: `Contact details for ${lead.name}` });
    await disclosure.focus();
    await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const details = page.locator('#lead-contact-73001');
    for (const text of [lead.name, lead.company, lead.role, lead.email, lead.phone, lead.campaignData.campaignName, 'CRM import']) await expect(details.getByText(text, { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
  expect(audit.consoleErrors).toEqual([]);
});

test('column choices persist, reset, and keep identity and actions pinned on keyboard scroll', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-chromium', 'Small viewports use lead cards.');
  await page.setViewportSize({ width: 1311, height: 841 });
  await page.goto('/dashboard/leads');
  const table = page.getByRole('table', { name: 'Leads list' });
  await expect(table).toBeVisible();
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  for (const column of ['Role', 'Email', 'Phone', 'Campaign', 'Source']) await page.getByRole('menuitemcheckbox', { name: column, exact: true }).click();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(table.getByRole('columnheader', { name: 'Email', exact: true })).toBeVisible();
  await expect(table.getByRole('row').nth(1).getByText('CRM import', { exact: true })).toBeVisible();
  const region = page.getByRole('region', { name: 'Scrollable leads table' });
  await region.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await region.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  for (const control of [table.getByRole('button', { name: lead.name, exact: true }), table.getByRole('button', { name: 'View lead details' }), table.getByRole('button', { name: 'More lead actions' })]) {
    const bounds = await control.boundingBox();
    const viewport = await region.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(viewport!.x);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width + 1);
  }
  await table.getByRole('button', { name: `Contact details for ${lead.name}` }).click();
  await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBe(0);
  await expect(page.locator('#lead-contact-73001').getByText(lead.email, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Reset to compact view' }).click();
  await expect(table.getByRole('columnheader', { name: 'Email', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(table.getByRole('columnheader', { name: 'Email', exact: true })).toHaveCount(0);
  await expect(table).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('inline editing, selection and row action menu preserve the lead workflow', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-chromium', 'Desktop inline-edit workflow.');
  await page.setViewportSize({ width: 1311, height: 841 });
  let update: unknown;
  await page.route('**/api/leads/73001', async route => {
    expect(route.request().headers()['x-business-profile-id']).toBe('4102');
    update = route.request().postDataJSON();
    await route.fulfill({ json: { success: true } });
  });
  await page.goto('/dashboard/leads');
  const table = page.getByRole('table', { name: 'Leads list' });
  await table.getByRole('button', { name: 'Edit lead' }).click();
  await expect(table.getByRole('textbox', { name: 'Edit name' })).toBeFocused();
  await table.getByRole('textbox', { name: 'Edit name' }).fill('Updated Synthetic Example');
  await table.getByRole('textbox', { name: 'Edit company' }).fill('Updated Synthetic Company');
  await table.getByRole('textbox', { name: 'Edit role' }).fill('Updated Synthetic Role');
  await table.getByRole('textbox', { name: 'Edit role' }).press('Enter');
  await expect(table.getByRole('button', { name: 'Updated Synthetic Example', exact: true })).toBeVisible();
  expect(update).toEqual({ name: 'Updated Synthetic Example', company: 'Updated Synthetic Company', role: 'Updated Synthetic Role' });
  await table.getByRole('checkbox', { name: 'Select all leads on this page' }).check();
  await expect(page.getByText('1 lead selected', { exact: true })).toBeVisible();
  await table.getByRole('button', { name: 'More lead actions' }).click();
  for (const action of ['Generate Score', 'Enrich Lead', 'Validate Email', 'Review Outreach', 'Delete Lead']) await expect(page.getByRole('menuitem', { name: action, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await table.getByRole('button', { name: 'View lead details' }).click();
  await expect(page).toHaveURL(/\/dashboard\/leads\/view\/73001$/);
});

test('current business, filters and CRM entry points survive the compact layout', async ({ page, audit }) => {
  const queries: URLSearchParams[] = [];
  await page.route('**/api/leads?*', async route => {
    expect(route.request().headers()['x-business-profile-id']).toBe('4102');
    queries.push(new URL(route.request().url()).searchParams);
    await route.fulfill({ json: { data: [lead], total: 1, totalPages: 1 } });
  });
  await page.goto('/dashboard/leads');
  await expect(page.getByRole('navigation', { name: 'People directories' }).getByRole('link', { name: 'CRM Contacts' })).toHaveAttribute('href', '/dashboard/crm/contacts');
  await page.getByRole('button', { name: 'Add Contact', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Add Contact' });
  await expect(create.getByRole('textbox', { name: 'First name' })).toBeVisible();
  await create.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Filter leads' }).click();
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('qualified');
  await page.getByRole('combobox', { name: 'Source', exact: true }).selectOption('crm_import');
  await page.getByRole('combobox', { name: 'Score range' }).selectOption('80-100');
  await page.getByRole('combobox', { name: 'Sort by' }).selectOption('score_desc');
  await page.getByRole('textbox', { name: 'Search leads' }).fill('Alexandra');
  await expect.poll(() => queries.some(query => query.get('status') === 'qualified'
    && query.get('source') === 'crm_import' && query.get('scoreRange') === '80-100'
    && query.get('sortBy') === 'score_desc' && query.get('search') === 'Alexandra')).toBe(true);
  await expectNoHorizontalOverflow(page);
  expect(audit.consoleErrors).toEqual([]);
});

test('AS003 and UX003: compact lead statuses stay labelled and filterable independently of engagement', async ({ page, isMobile }) => {
  const statuses = [
    ['new', 'New'], ['contacted', 'Contacted'], ['replied', 'Replied'],
    ['engaged', 'Engaged'], ['qualified', 'Qualified'], ['converted', 'Converted'],
    ['unqualified', 'Unqualified'], ['rejected', 'Rejected'], ['lost', 'Lost'],
    ['awaiting_review', 'Awaiting Review'],
  ] as const;
  const queries: string[] = [];
  await page.route('**/api/leads?*', async route => {
    expect(route.request().headers()['x-business-profile-id']).toBe('4102');
    const status = new URL(route.request().url()).searchParams.get('status') || 'new';
    queries.push(status);
    await route.fulfill({ json: {
      data: [{ ...lead, name: 'Synthetic status lead', status: 'new', leadStatus: status }],
      total: 1, totalPages: 1, statuses: statuses.map(([value]) => value),
    } });
  });
  await page.goto('/dashboard/leads');
  await expect(page.getByRole('heading', { name: 'All Leads (1)', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Filter leads' }).click();
  const filter = page.getByRole('combobox', { name: 'Status', exact: true });
  const collection = isMobile ? page.getByLabel('Lead cards') : page.getByRole('table', { name: 'Leads list' });
  for (const [value, label] of statuses) {
    await expect(filter.getByRole('option', { name: label, exact: true })).toHaveAttribute('value', value);
    await filter.selectOption(value);
    await expect.poll(() => queries.at(-1)).toBe(value);
    const statusBadge = isMobile
      ? collection.getByText(label, { exact: true }).first()
      : collection.getByRole('row').nth(1).getByRole('cell').nth(2).getByText(label, { exact: true });
    await expect(statusBadge).toBeVisible();
    // Reply counters remain an engagement signal for every pipeline status.
    await expect(collection.getByText('Replied', { exact: true }).last()).toBeVisible();
  }
  await expectNoHorizontalOverflow(page);
});


test('narrow desktop preserves a keyboard scroll affordance and pinned primary action', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-chromium', 'Small viewports use lead cards.');
  await page.setViewportSize({ width: 1024, height: 841 });
  await page.goto('/dashboard/leads');
  const region = page.getByRole('region', { name: 'Scrollable leads table' });
  await expect(region).toBeVisible();
  await expect(page.getByText('Expand for full contact details. Scroll horizontally on narrow screens; identity and actions stay visible.')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await region.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await region.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  const action = region.getByRole('button', { name: 'View lead details' });
  const bounds = await action.boundingBox();
  const viewport = await region.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width + 1);
  await page.screenshot({ path: '/tmp/UX003-v8-leads-narrow-synthetic.png' });
});

test('AS028 pointer and Enter Clear Filters restore first-page records and stable search focus', async ({ page, audit }) => {
  const records = Array.from({ length: 75 }, (_, index) => ({ ...lead, id: 74001 + index, name: `Synthetic lead ${index + 1}` }));
  let empty = false;
  const requests: string[] = [];
  await page.route('**/api/leads?**', route => {
    const url = new URL(route.request().url()); requests.push(url.search);
    const size = Number(url.searchParams.get('pageSize') || 10);
    const current = Number(url.searchParams.get('page') || 1);
    const data = empty || url.searchParams.get('search') ? [] : records;
    return route.fulfill({ json: { data: data.slice((current - 1) * size, current * size), total: data.length, page: current, pageSize: size, totalPages: Math.ceil(data.length / size) } });
  });
  await page.goto('/dashboard/leads');
  const search = page.getByRole('textbox', { name: 'Search leads', exact: true });
  for (const mode of ['pointer', 'enter', 'enter']) {
    await expect(page.getByText('Synthetic lead 1', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await search.fill('zzqa-no-match');
    const clear = page.getByRole('button', { name: 'Clear Filters', exact: true });
    await expect(clear).toBeVisible();
    if (mode === 'pointer') await clear.click(); else { await clear.focus(); await clear.press('Enter'); }
    await expect(search).toBeFocused(); await expect(search).toHaveValue('');
    await expect(clear).toHaveCount(0);
    await expect(page.getByText('Synthetic lead 1', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(search).toBeFocused();
  }
  const next = page.getByRole('button', { name: 'Next page', exact: true });
  await expect(next).toBeEnabled();
  {
    await next.focus(); await next.press('Enter');
    await expect(page.getByText('Synthetic lead 1', { exact: true })).toHaveCount(0);
    await search.fill('zzqa-no-match'); await page.getByRole('button', { name: 'Clear Filters', exact: true }).click();
    await expect(page.getByText('Synthetic lead 1', { exact: true }).filter({ visible: true }).first()).toBeVisible(); await expect(search).toBeFocused();
  }
  empty = true; await page.reload();
  await expect(page.getByRole('heading', { name: 'No leads yet', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear Filters', exact: true })).toHaveCount(0);
  expect(requests.length).toBeGreaterThan(3); expect(audit.consoleErrors).toEqual([]);
});
