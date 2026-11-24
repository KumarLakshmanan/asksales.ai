import { expect, test } from './fixtures/app';

test('AS008 names setup controls across all five panels without server mutations', async ({ page }) => {
  const mutations: string[] = [];
  // Fill any unmatched shell reads locally; every write is blocked, including
  // analysis, toolkit persistence and logo upload.
  await page.context().route('**/api/**', route => route.fulfill({ json: {} }));
  await page.route('**/api/**', async route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      mutations.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      await route.fulfill({ status: 409, json: { error: 'No writes in this accessibility regression.' } });
      return;
    }
    await route.fallback();
  });
  await page.goto('/dashboard/brand-toolkit/new');
  await expect(page.getByRole('heading', { name: 'Create Brand Toolkit' })).toBeVisible();

  const panels = [
    ['Brand Details', ['Auto-fill from Website', 'Brand Name', 'Tagline', 'Website', 'Industry', 'Contact Email', 'Phone Number', 'Mission Statement', 'Business Description']],
    ['Visual Identity', ['Logo Usage Guidelines', 'Image Style Reference', 'Image & Video Instructions', 'Primary Colors 1 hex value', 'Secondary Colors 1 hex value', 'Accent Color hex value', 'Heading Font', 'Body Font', 'Accent Font']],
    ['Voice & Values', ['Voice Type', 'Custom Tone Guidelines', 'Brand Values', 'Brand Keywords', 'Personality Traits', 'Voice Keywords', "Voice Do's", "Voice Don'ts"]],
    ['Content Settings', ['Global Generation Instructions', 'Approved Sample Content', 'Content Pillars', 'Content Formats', 'Default Hashtags', 'Default CTAs', 'Audience Pain Points', 'Audience Goals', 'Audience Language Style', 'Audience Triggers']],
    ['Social Media', ['LinkedIn Page', 'Twitter / X', 'Instagram Profile', 'Facebook Page', 'YouTube Channel']],
  ] as const;
  const form = page.locator('main').filter({ has: page.getByRole('heading', { name: 'Brand Details', exact: true }) }).last();
  const nameId = await page.getByRole('textbox', { name: 'Brand Name', exact: true }).getAttribute('id');
  await expect(page.getByRole('textbox', { name: 'Brand Name', exact: true })).toHaveAttribute('required', '');

  for (const [panel, names] of panels) {
    await page.getByRole('button', { name: panel, exact: true }).click();
    await expect(page.getByRole('heading', { name: panel, exact: true })).toBeVisible();
    for (const name of names) {
      await expect(page.getByRole('textbox', { name, exact: true })).toBeVisible();
    }
    const ids = await page.locator('[id]').evaluateAll(elements => elements.map(element => element.id));
    expect(new Set(ids).size).toBe(ids.length);
    if (panel === 'Voice & Values' || panel === 'Content Settings') {
      for (const name of names.slice(2)) {
        await expect(page.getByRole('button', { name: `Add ${name}`, exact: true })).toBeVisible();
      }
    }
    if (panel === 'Visual Identity') {
      for (const label of ['Primary Colors', 'Secondary Colors', 'Accent Color']) {
        // Playwright matches each aria-labelledby reference individually.
        const picker = page.getByLabel(label, { exact: true }).and(page.locator('input[type="color"]'));
        await expect(picker).toHaveAttribute('type', 'color');
        await expect(picker).toHaveAccessibleName(`${label}${label === 'Accent Color' ? '' : ' 1'} color picker`);
      }
      await page.getByRole('button', { name: 'Add Color to primary palette' }).click();
      await expect(page.getByRole('textbox', { name: 'Primary Colors 2 hex value' })).toBeVisible();
      await page.getByRole('button', { name: 'Remove primary color 2' }).click();
    }
  }

  await page.getByRole('button', { name: 'Voice & Values', exact: true }).click();
  const values = page.getByRole('textbox', { name: 'Brand Values', exact: true });
  await expect(values).toBeVisible();
  await expect(values).toHaveAccessibleDescription('Core principles guiding your business decisions.');
  await values.focus();
  await values.fill('Trust');
  await page.keyboard.press('Enter');
  await expect(values).toBeFocused();
  await expect(values).toHaveValue('');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Add Brand Values', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Remove Trust from Brand Values' })).toBeVisible();
  await page.getByRole('button', { name: 'Brand Details', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Brand Name', exact: true })).toHaveAttribute('id', nameId!);
  await expect(form.getByRole('textbox', { name: 'Website', exact: true })).toBeVisible();
  expect(mutations).toEqual([]);
});
