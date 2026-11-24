import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';

const panels = [
  { name: 'Brand Details', count: 7 },
  { name: 'Visual Identity', count: 1 },
  { name: 'Voice & Values', count: 7 },
  { name: 'Content Settings', count: 8 },
  { name: 'Social Media', count: 5 },
];
const placeholderSelector = '#main-content input[placeholder]:placeholder-shown';

async function mockLocalAccount(page: Page, theme: 'light' | 'dark') {
  // Every API request is synthetic, including unexpected reads. Never reach a backend.
  const mutations: string[] = [];
  await page.route('**/api/**', async route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      mutations.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      await route.fulfill({ status: 409, json: { error: 'No writes in contrast regression fixtures.' } });
      return;
    }
    await route.fulfill({ json: {} });
  });
  await installAppShellMocks(page);
  await page.route('**/api/settings/preferences', route => route.fulfill({ json: { theme, language: 'en', timezone: 'UTC' } }));
  await page.route('**/api/settings/profile', route => route.fulfill({ json: {
    name: 'Synthetic Owner', email: 'owner@example.test', phone: '', avatar: '', bio: '',
  } }));
  await page.route('**/api/settings/profile/notification-preferences', route => route.fulfill({ json: { leadAlerts: true, campaignUpdates: true } }));
  await page.addInitScript(selectedTheme => localStorage.setItem('theme', selectedTheme), theme);
  return mutations;
}

async function readPlaceholder(input: Locator) {
  await input.scrollIntoViewIfNeeded();
  await expect(input).toBeInViewport();
  // Framer Motion's entrance is driven by JS; getAnimations() alone does not cover it.
  await expect.poll(() => input.evaluate(element => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (Number(style.opacity) !== 1) return false;
      if (style.transform !== 'none' && style.transform !== 'matrix(1, 0, 0, 1, 0, 0)') return false;
      if (node.getAnimations().some(animation => animation.playState === 'running')) return false;
    }
    return true;
  })).toBe(true);
  await input.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  return input.evaluate(element => {
    const rgba = (color: string) => {
      const values = color.match(/[\d.]+/g)?.map(Number);
      if (!values || values.length < 3) throw new Error(`Unsupported computed color: ${color}`);
      return [values[0], values[1], values[2], values[3] ?? 1];
    };
    const composite = (foreground: number[], background: number[]) =>
      foreground.slice(0, 3).map((channel, index) => channel * foreground[3] + background[index] * (1 - foreground[3]));
    const luminance = (rgb: number[]) => {
      const linear = rgb.map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const chain: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) chain.unshift(node);
    let background = [255, 255, 255];
    for (const node of chain) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none') throw new Error('Sample background image pixels instead of assuming a solid surface.');
      background = composite(rgba(style.backgroundColor), background);
    }
    const placeholder = getComputedStyle(element, '::placeholder');
    const color = rgba(placeholder.color);
    color[3] *= Number(placeholder.opacity);
    const foreground = composite(color, background);
    const first = luminance(foreground), second = luminance(background);
    return {
      placeholder: element.getAttribute('placeholder'),
      color: placeholder.color,
      placeholderOpacity: placeholder.opacity,
      textColor: getComputedStyle(element).color,
      background, foreground,
      ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
    };
  });
}

type Sample = Awaited<ReturnType<typeof readPlaceholder>> & { panel: string };

async function recordEvidence(page: Page, info: TestInfo, theme: string, samples: Sample[]) {
  await info.attach(`placeholder-contrast-${theme}`, {
    body: JSON.stringify(samples, null, 2), contentType: 'application/json',
  });
  if (process.env.AS013_EVIDENCE_DIR) {
    const folder = path.join(process.env.AS013_EVIDENCE_DIR, info.project.name, theme);
    await mkdir(folder, { recursive: true });
    const surface = info.title.includes('Brand') ? 'brand' : info.title.includes('override') ? 'enrichment' : 'settings';
    await writeFile(path.join(folder, `${surface}.json`), JSON.stringify(samples, null, 2));
  }
  await expectNoHorizontalOverflow(page);
}

for (const theme of ['light', 'dark'] as const) {
  test(`Brand setup input placeholders meet 4.5:1 in ${theme} after entrance animations`, async ({ page, audit }, info) => {
    const mutations = await mockLocalAccount(page, theme);
    await page.goto('/dashboard/brand-toolkit/new');
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
    await expect(page.getByRole('heading', { name: 'Create Brand Toolkit' })).toBeVisible();
    const samples: Sample[] = [];
    for (const panel of panels) {
      await page.locator('#main-content').getByRole('button', { name: panel.name, exact: true }).click();
      await expect(page.getByRole('heading', { name: panel.name, exact: true })).toBeVisible();
      const labels = await page.locator('#main-content label').allTextContents();
      expect(labels.length).toBeGreaterThan(0);
      const inputs = page.locator(placeholderSelector);
      await expect(inputs).toHaveCount(panel.count);
      for (const input of await inputs.all()) {
        samples.push({ panel: panel.name, ...await readPlaceholder(input) });
        if (process.env.AS013_EVIDENCE_DIR) {
          const folder = path.join(process.env.AS013_EVIDENCE_DIR, info.project.name, theme);
          await mkdir(folder, { recursive: true });
          await input.screenshot({ path: path.join(folder, `input-${samples.length}.png`), scale: 'css' });
        }
      }
      // Persistent labels and entered text must survive the placeholder change.
      const placeholder = (await inputs.first().getAttribute('placeholder'))!;
      const first = page.getByPlaceholder(placeholder, { exact: true });
      await first.fill('Synthetic example');
      await expect(first).toHaveValue('Synthetic example');
      expect(await first.evaluate(element => getComputedStyle(element).color)).toBe(samples.at(-panel.count)!.textColor);
      await expect(first).toHaveAttribute('placeholder', placeholder);
      await first.fill('');
      expect(await page.locator('#main-content label').allTextContents()).toEqual(labels);
      await expectNoHorizontalOverflow(page);
      if (process.env.AS013_EVIDENCE_DIR) {
        await page.getByRole('heading', { name: panel.name, exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(process.env.AS013_EVIDENCE_DIR, info.project.name, theme, `${panel.name.replace(/\W+/g, '-')}.png`),
          fullPage: true, scale: 'css',
        });
      }
    }
    await recordEvidence(page, info, theme, samples);
    expect(samples).toHaveLength(28);
    for (const sample of samples) expect.soft(sample.ratio, `${sample.panel}: ${sample.placeholder}`).toBeGreaterThanOrEqual(4.5);
    expect(mutations).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
    expect(audit.failedRequests).toEqual([]);
  });

  test(`shared Input profile and password consumers retain contrast and editing in ${theme}`, async ({ page, audit }, info) => {
    const mutations = await mockLocalAccount(page, theme);
    await page.goto('/dashboard/settings');
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
    await expect(page.getByLabel('Full Name')).toHaveValue('Synthetic Owner');
    await expect(page.getByLabel('Email Address')).toBeDisabled();
    const samples: Sample[] = [];
    for (const panel of ['Profile', 'Security']) {
      await page.getByRole('button', { name: panel, exact: true }).click();
      const inputs = page.locator(placeholderSelector);
      await expect(inputs).toHaveCount(panel === 'Profile' ? 2 : 3);
      for (const input of await inputs.all()) samples.push({ panel, ...await readPlaceholder(input) });
    }
    const password = page.getByLabel('Current Password', { exact: true });
    await password.fill('Synthetic-password');
    await expect(password).toHaveValue('Synthetic-password');
    await expect(password).toHaveAttribute('type', 'password');
    await recordEvidence(page, info, theme, samples);
    for (const sample of samples) expect.soft(sample.ratio, `${sample.panel}: ${sample.placeholder}`).toBeGreaterThanOrEqual(4.5);
    expect(mutations).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
    expect(audit.failedRequests).toEqual([]);
  });

  test(`shared Input keeps the enrichment consumer's placeholder override in ${theme}`, async ({ page, audit }, info) => {
    const mutations = await mockLocalAccount(page, theme);
    await page.route('**/api/enrichments?*', route => route.fulfill({ json: [] }));
    await page.goto('/dashboard/enrichment');
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
    const input = page.getByPlaceholder('Search enrichments...', { exact: true });
    const sample = { panel: 'Enrichment search', ...await readPlaceholder(input) };
    // This consumer explicitly uses the opaque muted color in both themes.
    const mutedColor = await page.getByText('0 enrichment runs', { exact: true }).evaluate(element => getComputedStyle(element).color);
    expect(sample.color).toBe(mutedColor);
    expect(sample.ratio).toBeGreaterThanOrEqual(4.5);
    await input.fill('Synthetic search');
    await expect(input).toHaveValue('Synthetic search');
    await input.fill('');
    await recordEvidence(page, info, theme, [sample]);
    expect(mutations).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
    expect(audit.failedRequests).toEqual([]);
  });
}
