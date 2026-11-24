import { type Locator, type Page, type TestInfo } from '@playwright/test';
import { expect as appExpect, expectNoHorizontalOverflow, test } from './fixtures/app';

const expect = appExpect.configure({ timeout: 15_000 });

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }, actionTimeout: 15_000, serviceWorkers: 'block', video: 'off' });
test.setTimeout(90_000);

const title = 'Data & connections';
const profiles = [
  { id: 4102, name: 'Regression Business', companyName: 'Regression Company', isDefault: true, role: 'owner' },
  { id: 4103, name: 'Second Regression Business', companyName: 'Second Regression Company', role: 'owner' },
];

async function isolateAnalytics(page: Page, state: 'empty' | 'measured' | 'credential unavailable' = 'empty') {
  const effects: string[] = [];
  const shellReads = ['/api/auth/me', '/api/platform/access', '/api/settings/preferences',
    '/api/settings/outreach/assistants/catalog', '/api/wallet', '/api/notifications/unread/count'];
  // No application traffic can reach a real API/provider, including GET OAuth actions.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) return route.fallback();
    if (url.origin !== new URL(page.url() === 'about:blank' ? process.env.E2E_BASE_URL || 'http://127.0.0.1:3000' : page.url()).origin) {
      effects.push(`External ${url.pathname}`);
      return route.abort();
    }
    return route.fallback();
  });
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['GET', 'HEAD'].includes(request.method()) || /\/(?:oauth|authorize|sync|reconnect|jobs)(?:\/|$)/.test(url.pathname)) {
      effects.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 409, json: { error: 'Analytics focus fixture blocks effects.' } });
    }
    if (shellReads.includes(url.pathname)) return route.fallback();
    if (url.pathname === '/api/settings/business-profiles') return route.fulfill({ json: profiles });
    if (url.pathname === '/api/channel-accounts/instagram_api') return route.fulfill({ json: [{
      id: state === 'credential unavailable' ? '' : 4201, accountIdentifier: 'synthetic-account', accountName: 'synthetic-account', displayName: 'Synthetic account',
      profilePictureUrl: null, isSelected: true, usesInstagramLogin: true, analyticsReady: true,
      analyticsReadinessCode: null, analyticsReadinessMessage: null,
    }] });
    if (url.pathname === '/api/social-analytics/dashboard') return route.fulfill({ json: {
      summary: {}, trends: [], recommendation: { recommendation: null, citations: [] }, bestTime: null, previousPeriod: null,
      freshness: { latestSnapshotAt: state === 'measured' ? '2026-10-10T00:00:00.000Z' : null, snapshotCount: 0, evidenceSourceCount: 0 }, sync: null,
    } });
    if (url.pathname === '/api/social-analytics/content') return route.fulfill({ json: {
      items: [], nextOffset: null, totalPosts: 0, metricTotals: {}, metricCoverage: {}, formats: [], timeline: [],
      topContent: [], rankingMetric: 'reach', truncated: false, sync: null,
    } });
    if (url.pathname === '/api/leads') return route.fulfill({ json: { data: [], total: 0, totalPages: 0, page: 1, pageSize: 15 } });
    if (url.pathname === '/api/leads/stats') return route.fulfill({ json: { success: false } });
    return route.fulfill({ json: [] });
  });
  await page.goto('/dashboard/marketing/analytics');
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Synthetic account', exact: true })).toBeVisible();
  return effects;
}

async function settleFocus(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function settleSheet(dialog: Locator) {
  await expect.poll(() => dialog.evaluate(element => element.getAnimations().every(animation => animation.playState === 'finished'))).toBe(true);
}

async function saveScreenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function expectKeyboardRing(control: Locator) {
  expect(await control.evaluate(element => {
    const style = getComputedStyle(element);
    return { visible: element.matches(':focus-visible'), shadow: style.boxShadow };
  })).toMatchObject({ visible: true, shadow: expect.not.stringMatching(/^none$/) });
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  const viewport = control.page().viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

for (const device of [
  { name: 'desktop 1180x757', options: { viewport: { width: 1180, height: 757 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 } },
  { name: 'mobile 390x844', options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.75 } },
  { name: 'narrow 320x757', options: { viewport: { width: 320, height: 757 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 } },
]) {
  test.describe(device.name, () => {
    test.use(device.options);

    for (const method of ['pointer Close', 'Enter Close', 'Escape', 'backdrop']) {
      test(`repeated ${method} returns to the exact opener`, async ({ page, audit }, info) => {
        const effects = await isolateAnalytics(page);
        expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, zoom: visualViewport?.scale })))
          .toEqual({ ...device.options.viewport, zoom: 1 });
        const opener = page.getByRole('button', { name: title, exact: true });
        const original = await opener.elementHandle();
        const dialog = page.getByRole('dialog', { name: title });
        let timezone: string | undefined;
        for (let cycle = 0; cycle < 3; cycle++) {
          if (method === 'pointer Close') await opener.click();
          else { await opener.focus(); await opener.press('Enter'); }
          await expect(dialog.getByLabel('Timezone', { exact: true })).toBeFocused();
          await settleSheet(dialog);
          timezone ??= await dialog.getByLabel('Timezone', { exact: true }).inputValue();
          await expect(dialog.getByLabel('Timezone', { exact: true })).toHaveValue(timezone);
          await expect(dialog.getByRole('button', { name: 'Sync official data', exact: true })).toBeEnabled();
          await expect(dialog.getByRole('button', { name: 'Recompute best time', exact: true })).toBeDisabled();
          const close = dialog.getByRole('button', { name: 'Close', exact: true });
          // Reverse Tab wraps to Close; forward Tab wraps back to Timezone.
          await page.keyboard.press('Shift+Tab');
          await expect(close).toBeFocused();
          await page.keyboard.press('Tab');
          await expect(dialog.getByLabel('Timezone', { exact: true })).toBeFocused();
          if (method === 'pointer Close') await close.click();
          else if (method === 'Escape') await page.keyboard.press('Escape');
          else if (method === 'backdrop') await page.mouse.click(2, 2);
          else {
            await close.focus();
            await page.keyboard.press('Tab');
            await expect(dialog.getByLabel('Timezone', { exact: true })).toBeFocused();
            await page.keyboard.press('Shift+Tab');
            await expectKeyboardRing(close);
            if (cycle === 0) await saveScreenshot(page, info, 'close-keyboard-focus');
            await close.press('Enter');
          }
          await expect(dialog).toHaveCount(0);
          await settleFocus(page);
          expect(await page.evaluate(element => ({ exact: document.activeElement === element, settledTag: document.activeElement?.tagName }), original))
            .toEqual({ exact: true, settledTag: 'BUTTON' });
          if (method === 'Enter Close' || method === 'Escape') {
            await expectKeyboardRing(opener);
            if (cycle === 0) await saveScreenshot(page, info, 'opener-keyboard-focus');
          }
        }
        await expectNoHorizontalOverflow(page);
        expect(effects).toEqual([]);
        expect(audit.blockedMutations).toEqual([]);
        await info.attach('side-effect-audit', { body: JSON.stringify({ effects, blockedMutations: audit.blockedMutations }), contentType: 'application/json' });
      });
    }

    for (const entry of ['Manage data', 'Connect', 'Open data & connections']) {
      test(`alternate ${entry}: direct, toolbar→alternate and alternating cycles retain actual ownership`, async ({ page, audit }, info) => {
        const effects = await isolateAnalytics(page, entry === 'Manage data' ? 'measured' : 'credential unavailable');
        expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, zoom: visualViewport?.scale })))
          .toEqual({ ...device.options.viewport, zoom: 1 });
        const toolbar = page.getByRole('button', { name: title, exact: true });
        const alternate = page.getByRole('button', { name: entry, exact: true });
        await expect(alternate).toBeVisible();
        const original = (await alternate.elementHandle())!;
        const dialog = page.getByRole('dialog', { name: title });
        for (const phase of ['direct', 'toolbar first', 'alternating']) {
          for (const method of ['unfocused pointer Close', 'keyboard Enter Close', 'keyboard Escape']) {
            if (phase !== 'direct') {
              await toolbar.scrollIntoViewIfNeeded();
              await toolbar.focus();
              await toolbar.press('Enter');
              await expect(dialog.getByLabel('Timezone', { exact: true })).toBeFocused();
              await page.keyboard.press('Escape');
              await expect(dialog).toHaveCount(0);
              await settleFocus(page);
              await expect(toolbar).toBeFocused();
            }
            await alternate.scrollIntoViewIfNeeded();
            if (method === 'unfocused pointer Close') {
              await page.evaluate(element => {
                (document.activeElement as HTMLElement | null)?.blur();
                (element as HTMLButtonElement).click();
              }, original);
            } else { await alternate.focus(); await alternate.press('Enter'); }
            await expect(dialog.getByLabel('Timezone', { exact: true })).toBeFocused();
            await settleSheet(dialog);
            await expect(dialog.getByLabel('Timezone', { exact: true })).toHaveValue('UTC');
            if (method === 'keyboard Escape') await page.keyboard.press('Escape');
            else {
              const close = dialog.getByRole('button', { name: 'Close', exact: true });
              if (method === 'unfocused pointer Close') await close.click();
              else { await close.focus(); await close.press('Enter'); }
            }
            await expect(dialog).toHaveCount(0);
            await settleFocus(page);
            expect(await page.evaluate(element => document.activeElement === element, original)).toBe(true);
            if (method.startsWith('keyboard')) {
              await expectKeyboardRing(alternate);
              if (phase === 'toolbar first' && method === 'keyboard Escape') await saveScreenshot(page, info, 'alternate-opener-keyboard-focus');
            }
          }
        }
        expect(effects).toEqual([]);
        expect(audit.blockedMutations).toEqual([]);
        await info.attach('side-effect-audit', { body: JSON.stringify({ effects, blockedMutations: audit.blockedMutations }), contentType: 'application/json' });
      });

      test(`alternate ${entry}: unavailable opener does not fall back to the toolbar`, async ({ page }) => {
        const effects = await isolateAnalytics(page, entry === 'Manage data' ? 'measured' : 'credential unavailable');
        const toolbar = page.getByRole('button', { name: title, exact: true });
        const alternate = page.getByRole('button', { name: entry, exact: true });
        await expect(alternate).toBeVisible();
        const toolbarElement = (await toolbar.elementHandle())!;
        const alternateElement = (await alternate.elementHandle())!;
        const dialog = page.getByRole('dialog', { name: title });
        for (const state of ['disabled', 'hidden', 'inert']) {
          await toolbar.click();
          await expect(dialog.getByLabel('Timezone', { exact: true })).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(dialog).toHaveCount(0);
          await settleFocus(page);
          await alternate.scrollIntoViewIfNeeded();
          await alternate.click();
          await expect(dialog.getByLabel('Timezone', { exact: true })).toBeFocused();
          await alternateElement.evaluate((element: HTMLButtonElement, state) => {
            element.setAttribute(state, '');
          }, state);
          await page.keyboard.press('Escape');
          await expect(dialog).toHaveCount(0);
          await settleFocus(page);
          expect(await page.evaluate(([toolbar, alternate]) => document.activeElement === toolbar || document.activeElement === alternate, [toolbarElement, alternateElement])).toBe(false);
          await alternateElement.evaluate((element: HTMLButtonElement, state) => element.removeAttribute(state), state);
        }
        expect(effects).toEqual([]);
      });
    }

    test('interrupted exit/reopening and a newer keyboard dialog preserve their focus', async ({ page }) => {
      const effects = await isolateAnalytics(page);
      const opener = page.getByRole('button', { name: title, exact: true });
      const original = (await opener.elementHandle())!;
      const dialog = page.getByRole('dialog', { name: title });
      await opener.click();
      await expect(dialog.getByLabel('Timezone', { exact: true })).toBeFocused();
      await original.evaluate((element: HTMLButtonElement) => {
        const close = document.querySelector<HTMLButtonElement>('[role="dialog"] button:has(.sr-only)')!;
        close.click();
        setTimeout(() => {
          document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          element.click();
        }, 0);
      });
      await expect(dialog).toHaveAttribute('data-state', 'open');
      await settleFocus(page);
      await expect(dialog.getByLabel('Timezone', { exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await settleFocus(page);
      await expect(opener).toBeFocused();
      await opener.press('Enter');
      await expect(dialog.getByLabel('Timezone', { exact: true })).toBeFocused();
      await dialog.getByRole('button', { name: 'Close', exact: true }).press('Enter');
      await page.keyboard.press('Control+k');
      const finder = page.getByRole('dialog', { name: 'Search AskSales.AI' });
      await expect(finder).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await settleFocus(page);
      await expect(finder.getByRole('combobox')).toBeFocused();
      expect(effects).toEqual([]);
    });

    test('newer focus, pointer and keyboard decisions survive a later blur', async ({ page }) => {
      const effects = await isolateAnalytics(page);
      for (const decision of ['focus', 'pointer', 'keyboard']) {
        await page.getByRole('button', { name: title, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: title });
        await expect(dialog.getByLabel('Timezone', { exact: true })).toBeFocused();
        await page.evaluate(decision => {
          const opener = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Data & connections')!;
          const originalFocus = opener.focus.bind(opener);
          (window as Window & { analyticsRestorations?: number }).analyticsRestorations = 0;
          opener.focus = (...args) => {
            (window as Window & { analyticsRestorations?: number }).analyticsRestorations!++;
            originalFocus(...args);
          };
          document.querySelector<HTMLButtonElement>('[role="dialog"] button:has(.sr-only)')!.click();
          setTimeout(() => {
            const destination = document.createElement('button');
            document.body.append(destination);
            if (decision === 'focus') { destination.focus(); destination.blur(); }
            else if (decision === 'pointer') destination.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            else destination.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            destination.remove();
          }, 0);
        }, decision);
        await expect(dialog).toHaveCount(0);
        await settleFocus(page);
        expect(await page.evaluate(() => (window as Window & { analyticsRestorations?: number }).analyticsRestorations)).toBe(0);
      }
      expect(effects).toEqual([]);
    });

    test('a newer route transition retires the Analytics focus session', async ({ page }) => {
      const effects = await isolateAnalytics(page);
      const opener = page.getByRole('button', { name: title, exact: true });
      const original = (await opener.elementHandle())!;
      await opener.click();
      await expect(page.getByRole('dialog', { name: title }).getByLabel('Timezone', { exact: true })).toBeFocused();
      await page.evaluate(() => {
        const opener = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Data & connections')!;
        (window as Window & { analyticsRestorations?: number }).analyticsRestorations = 0;
        opener.focus = () => { (window as Window & { analyticsRestorations?: number }).analyticsRestorations!++; };
        document.querySelector<HTMLButtonElement>('[role="dialog"] button:has(.sr-only)')!.click();
        setTimeout(() => {
          const home = document.querySelector<HTMLAnchorElement>('a[href="/dashboard/home"]')!;
          home.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          home.click();
        }, 0);
      });
      await expect(page).toHaveURL(/\/dashboard\/home$/);
      await expect.poll(() => original.evaluate(element => element.isConnected)).toBe(false);
      await expect(page.getByRole('dialog', { name: title })).toHaveCount(0);
      await settleFocus(page);
      expect(await page.evaluate(() => (window as Window & { analyticsRestorations?: number }).analyticsRestorations)).toBe(0);
      expect(effects).toEqual([]);
    });

    test('a selected-workspace remount retires the old session and gives the new opener its own session', async ({ page }) => {
      const effects = await isolateAnalytics(page);
      const opener = page.getByRole('button', { name: title, exact: true });
      const original = (await opener.elementHandle())!;
      await opener.click();
      await expect(page.getByRole('dialog', { name: title }).getByLabel('Timezone', { exact: true })).toBeFocused();
      await original.evaluate((element: HTMLButtonElement) => {
        (window as Window & { analyticsRestorations?: number }).analyticsRestorations = 0;
        element.focus = () => { (window as Window & { analyticsRestorations?: number }).analyticsRestorations!++; };
        document.querySelector<HTMLButtonElement>('[role="dialog"] button:has(.sr-only)')!.click();
        setTimeout(() => {
          // Synthetic tab-local selection, equivalent to the existing selection event.
          sessionStorage.setItem('active-business-profile:4101', '4103');
          window.dispatchEvent(new Event('business-profile-changed'));
        }, 0);
      });
      await expect(page.getByRole('dialog', { name: title })).toHaveCount(0);
      await expect.poll(() => original.evaluate(element => element.isConnected)).toBe(false);
      await settleFocus(page);
      expect(await page.evaluate(() => (window as Window & { analyticsRestorations?: number }).analyticsRestorations)).toBe(0);
      await opener.focus();
      await opener.press('Enter');
      await expect(page.getByRole('dialog', { name: title }).getByLabel('Timezone', { exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: title })).toHaveCount(0);
      await settleFocus(page);
      await expect(opener).toBeFocused();
      expect(effects).toEqual([]);
    });
  });
}
