import { writeFile } from 'node:fs/promises';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow, installAppShellMocks } from './fixtures/app';
import { onboardingFixture } from './fixtures/workspace-setup';

const panels = [
  ['Brand Details', 'Brand Details'],
  ['Visual Identity', 'Visual Identity'],
  ['Voice & Values', 'Voice & Values'],
  ['Content Settings', 'Content Settings'],
  ['Social Media', 'Social Media'],
] as const;

async function settled(page: Page, button: Locator) {
  await button.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  // Framer entrance animations and CSS state transitions must finish before
  // measuring. Transient opacity during entrance is not a contrast defect.
  await expect.poll(() => page.locator('#main-content').evaluate(element => {
    const opaque = [...element.querySelectorAll('[style]')].every(node =>
      !node.getClientRects().length || getComputedStyle(node).opacity === '1');
    const animating = element.getAnimations({ subtree: true }).some(animation =>
      animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity);
    return opaque && !animating;
  })).toBe(true);
}

async function measure(button: Locator) {
  return button.evaluate(element => {
    const rgba = (value: string) => {
      const channels = value.match(/[\d.]+/g)?.map(Number);
      if (!channels || channels.length < 3) throw new Error(`Unsupported color: ${value}`);
      return [...channels.slice(0, 3), channels[3] ?? 1];
    };
    const composite = (front: number[], back: number[]) =>
      front.slice(0, 3).map((channel, index) => channel * front[3] + back[index] * (1 - front[3]));
    const luminance = (rgb: number[]) => rgb.map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const ancestors: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
    let background = [255, 255, 255];
    const opacity = ancestors.map(node => Number(getComputedStyle(node).opacity));
    for (const node of ancestors) {
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none') throw new Error('Non-flat background needs pixel sampling');
      background = composite(rgba(style.backgroundColor), background);
    }
    const style = getComputedStyle(element);
    const foreground = composite(rgba(style.color), background);
    const light = luminance(foreground);
    const dark = luminance(background);
    const rect = element.getBoundingClientRect();
    return {
      foreground: style.color,
      background: style.backgroundColor,
      effectiveBackground: background,
      contrast: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05),
      opacity,
      border: style.borderColor,
      boxShadow: style.boxShadow,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      focusVisible: element.matches(':focus-visible'),
      inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
      ring: getComputedStyle(document.documentElement).getPropertyValue('--ring').trim(),
    };
  });
}

type Sample = Awaited<ReturnType<typeof measure>> & { consumer: string; state: string };

test.beforeEach(async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) return route.abort('blockedbyclient');
    return route.fallback();
  });
  // Known shell reads remain synthetic when the build uses a separate local API
  // origin. Keep the external-origin guard ahead of every unmocked request.
  await installAppShellMocks(page);
});

async function checkStates(page: Page, button: Locator, consumer: string, samples: Sample[]) {
  await page.mouse.move(0, 0);
  await button.evaluate(element => (element as HTMLElement).blur());
  await settled(page, button);
  const normal = await measure(button);
  samples.push({ consumer, state: 'normal', ...normal });
  expect(normal.opacity.every(value => value === 1)).toBe(true);
  expect(normal.inViewport).toBe(true);
  expect.soft(normal.contrast, `${consumer}: normal text contrast`).toBeGreaterThanOrEqual(4.5);

  await button.hover();
  await settled(page, button);
  const hover = await measure(button);
  samples.push({ consumer, state: 'hover', ...hover });
  expect.soft(hover.contrast, `${consumer}: hovered text contrast`).toBeGreaterThanOrEqual(4.5);
  expect(hover.foreground).toBe(normal.foreground);
  expect(hover.border).toBe(normal.border);
  expect(hover.background).not.toBe(normal.background);

  await page.mouse.move(0, 0);
  await button.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(button).toBeFocused();
  await settled(page, button);
  const focus = await measure(button);
  samples.push({ consumer, state: 'keyboard-focus', ...focus });
  expect(focus.focusVisible).toBe(true);
  expect(focus.boxShadow).not.toBe(normal.boxShadow);
  expect(focus.background).toBe(normal.background);
  expect.soft(focus.contrast, `${consumer}: focused text contrast`).toBeGreaterThanOrEqual(4.5);
}

async function evidence(info: TestInfo, samples: Sample[]) {
  const path = info.outputPath('computed-contrast.json');
  await writeFile(path, JSON.stringify({ project: info.project.name, viewport: info.project.name.startsWith('mobile') ? '390x844' : '1311x841', samples }, null, 2));
  await info.attach('computed-contrast', {
    path,
    contentType: 'application/json',
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`AS012: settled Brand setup primary action contrast in ${theme}`, async ({ page, audit }, info) => {
    await page.setViewportSize(info.project.name.startsWith('mobile') ? { width: 390, height: 844 } : { width: 1311, height: 841 });
    const fixture = await onboardingFixture(page);
    await page.route('**/api/settings/preferences', route => route.fulfill({ json: { theme, language: 'en', timezone: 'UTC' } }));
    await page.goto('/dashboard/brand-toolkit/new');
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /light/);
    await expect(page.getByRole('heading', { name: 'Brand Details', exact: true })).toBeVisible();
    await page.locator('input[name="brandName"]').fill('Synthetic AS012 Brand');
    const action = page.locator('#main-content .sticky button.border-primary');
    const samples: Sample[] = [];
    for (const [index, [panel, heading]] of panels.entries()) {
      if (index) await page.locator('#main-content nav').getByRole('button', { name: panel, exact: true }).click();
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await expect(action).toHaveText(index === 4 ? 'Create Toolkit' : 'Continue');
      await expect(action).toBeEnabled();
      await checkStates(page, action, panel, samples);
      await expectNoHorizontalOverflow(page);
      const screenshot = info.outputPath(`${theme}-${index + 1}.png`);
      await page.screenshot({ path: screenshot, style: 'nextjs-portal { display:none!important }' });
      await info.attach(`${theme}-${panel}`, { path: screenshot, contentType: 'image/png' });
    }
    await evidence(info, samples);
    expect(samples[0].primary).toBe(theme === 'dark' ? '217 91% 60%' : '221 83% 53%');
    expect(samples[0].ring).toBe(samples[0].primary);
    expect(samples[0].foreground).toBe('rgb(255, 255, 255)');

    // Hold a synthetic save in flight to exercise the real disabled state.
    let releaseSave!: () => void;
    const saving = new Promise<void>(resolve => { releaseSave = resolve; });
    await page.route('**/api/content/brand-toolkits', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      await saving;
      return route.fulfill({ status: 500, json: { error: 'Synthetic save failure' } });
    });
    try {
      await action.click();
      await expect(action).toBeDisabled();
      await expect.poll(() => action.evaluate(element => getComputedStyle(element).opacity)).toBe('0.5');
      const disabled = await action.evaluate(element => ({ opacity: getComputedStyle(element).opacity, pointerEvents: getComputedStyle(element).pointerEvents }));
      expect(disabled).toEqual({ opacity: '0.5', pointerEvents: 'none' });
    } finally {
      releaseSave();
    }
    await expect(action).toBeEnabled();
    expect(fixture.toolkits).toHaveLength(0);
    expect(audit.blockedMutations).toEqual([]);
  });

  test(`AS012: shared primary Button consumers retain action states in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize(info.project.name.startsWith('mobile') ? { width: 390, height: 844 } : { width: 1311, height: 841 });
    await onboardingFixture(page);
    await page.route('**/api/settings/preferences', route => route.fulfill({ json: { theme, language: 'en', timezone: 'UTC' } }));
    const samples: Sample[] = [];
    await page.goto('/dashboard/brand-toolkit');
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /light/);
    await checkStates(page, page.getByRole('button', { name: 'Create Your First Brand', exact: true }), 'Empty toolkit list', samples);
    await page.route('**/api/settings/leads', route => route.fulfill({ json: { leadSources: ['google', 'yelp'] } }));
    await page.goto('/dashboard/settings/leads');
    const save = page.getByRole('button', { name: 'Save Settings', exact: true });
    await expect(save).toBeDisabled();
    expect(await save.evaluate(element => getComputedStyle(element).opacity)).toBe('0.5');
    await page.getByRole('button', { name: 'Disable Yelp lead source', exact: true }).click();
    await expect(save).toBeEnabled();
    await checkStates(page, save, 'Lead source settings', samples);
    await expectNoHorizontalOverflow(page);
    await evidence(info, samples);
  });
}
