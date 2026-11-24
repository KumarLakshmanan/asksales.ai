import type { Locator, Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';

const shellReads = new Set(['/api/auth/me', '/api/platform/access', '/api/settings/preferences',
  '/api/settings/business-profiles', '/api/organizations', '/api/wallet', '/api/crm/configuration',
  '/api/notifications/unread/count', '/api/settings/outreach/assistants/catalog']);
let blocked: string[];

test.beforeEach(async ({ page, context, baseURL }, info) => {
  blocked = [];
  await info.attach('case-context', { contentType: 'application/json', body: JSON.stringify({
    repeatIndex: info.repeatEachIndex, project: info.project.name, viewport: page.viewportSize(),
  }) });
  // Known synthetic API handlers run before this context guard. Nothing else
  // may contact an external origin or perform a write, upload, job or send.
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (['GET', 'HEAD'].includes(request.method()) && url.origin === new URL(baseURL!).origin) return route.fallback();
    blocked.push(`${request.method()} ${url.origin}${url.pathname}`);
    await route.fulfill({ status: 409, json: { error: 'Read-only Knowledge feedback fixture.' } });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD'].includes(request.method())) {
      blocked.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 409, json: { error: 'All Knowledge mutations are blocked.' } });
    }
    if (shellReads.has(path)) return route.fallback();
    return route.fulfill({ json: {} });
  });
  await page.addInitScript(() => {
    const events: { type: string; control: string; trusted: boolean }[] = [];
    Object.assign(window, { __knowledgeFeedbackEvents: events });
    for (const type of ['pointerdown', 'click', 'keydown', 'focusin']) document.addEventListener(type, event => {
      const target = event.target instanceof Element ? event.target.closest('input, textarea, button') : null;
      const control = target?.id || (target?.tagName === 'BUTTON' ? target.textContent?.trim() : '');
      if (control?.startsWith('knowledge-') || control === 'Save' || control === 'Save Entry') {
        events.push({ type, control, trusted: event.isTrusted });
      }
    }, true);
  });
});

test.afterEach(async ({ page, audit }, info) => {
  await info.attach('strict-audit', { contentType: 'application/json', body: JSON.stringify({ blocked, ...audit }) });
  await info.attach('delivered-form-events', { contentType: 'application/json', body: JSON.stringify(
    await page.evaluate(() => (window as unknown as { __knowledgeFeedbackEvents: unknown }).__knowledgeFeedbackEvents)
  ) });
  expect(blocked).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
  expect(audit.failedRequests).toEqual([]);
});

async function submit(page: Page, button: Locator, control: Locator, message: string, input: 'pointer' | 'Enter' | 'Space') {
  if (input === 'pointer') await button.click();
  else {
    await button.focus();
    await page.keyboard.press(input);
  }
  await expect(control).toBeFocused();
  await expect(control).toHaveAttribute('aria-invalid', 'true');
  await expect(control).toHaveAccessibleDescription(new RegExp(message));
  const error = page.getByRole('main').getByRole('alert');
  await expect(error).toHaveText(message);
  await expect(error).toBeVisible();
  // Inline, announced feedback stays visible without a duplicate floating
  // validation stack occupying either Save control's pointer target.
  expect(await page.locator('[data-sonner-toast]').count()).toBe(0);
  // Native focus need not bring the error below a tall textarea into view.
  // Review it with ordinary scrolling, preserving the invalid field's focus.
  await error.scrollIntoViewIfNeeded();
  await expect(error).toBeInViewport();
  await expect(control).toBeFocused();
}

test('repeated invalid submissions keep both Save controls reachable through Q&A, file removal and empty URL recovery', async ({ page }, info) => {
  await page.goto('/dashboard/knowledge-base/new');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const saveEntry = page.getByRole('button', { name: 'Save Entry', exact: true });
  const title = page.getByRole('textbox', { name: 'Title', exact: true });
  const description = page.getByRole('textbox', { name: 'Description', exact: true });
  await expect(title).toHaveAttribute('required', '');
  await expect(description).not.toHaveAttribute('required');
  await submit(page, save, title, 'Title is required', 'Enter');
  await title.fill('Synthetic entry');
  await expect(title).not.toHaveAttribute('aria-invalid', 'true');

  for (let cycle = 0; cycle < 3; cycle++) {
    await page.getByRole('button', { name: 'Document', exact: true }).click();
    const content = page.getByRole('textbox', { name: 'Document Content', exact: true });
    await expect(content).toHaveAttribute('required', '');
    await submit(page, save, content, 'Content is required for document entries', 'pointer');

    await page.getByRole('button', { name: 'Q&A Pairs', exact: true }).click();
    const question = page.getByRole('textbox', { name: 'Question 1', exact: true });
    const answer = page.getByRole('textbox', { name: 'Answer 1', exact: true });
    await question.fill('');
    const qaError = 'At least one Q&A pair with both question and answer is required';
    await submit(page, save, question, qaError, 'pointer');
    await question.fill('Synthetic question');
    await expect(question).not.toHaveAttribute('aria-invalid', 'true');
    await submit(page, saveEntry, answer, qaError, 'Space');
    await page.getByRole('button', { name: /Add Another Q&A Pair/ }).click();
    await expect(question).not.toHaveAttribute('required');
    await expect(page.getByRole('textbox', { name: 'Answer 2', exact: true })).not.toHaveAttribute('required');
    await page.getByRole('button', { name: 'Remove Q&A pair 2', exact: true }).press('Enter');
    await expect(question).toBeFocused();
    await expect(question).toHaveAttribute('required', '');

    await page.getByRole('button', { name: 'File Upload', exact: true }).click();
    const file = page.locator('#knowledge-file');
    const choose = page.getByRole('button', { name: 'Choose file', exact: true });
    await expect(file).toHaveAttribute('required', '');
    await submit(page, save, choose, 'Please upload a file', 'pointer');
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    await (await chooser).setFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic local text') });
    const remove = page.getByRole('button', { name: 'Remove file', exact: true });
    await expect(remove).toBeFocused();
    await expect(file).not.toHaveAttribute('required');
    await remove.press('Enter');
    await expect(choose).toBeFocused();
    await expect(file).toHaveAttribute('required', '');

    await page.getByRole('button', { name: 'Website URL', exact: true }).click();
    const url = page.getByRole('textbox', { name: 'Website URL', exact: true });
    await expect(url).toHaveAttribute('required', '');
    await expect(url).toHaveValue('');
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    await submit(page, save, url, 'URL is required', 'pointer');
    // Retry at the same normal pointer target, then activate both controls by
    // keyboard while the error is still visible. No dismissal or timer wait.
    await submit(page, save, url, 'URL is required', 'pointer');
    await submit(page, save, url, 'URL is required', 'Enter');
    await submit(page, saveEntry, url, 'URL is required', 'Space');
    await url.fill('   ');
    await expect(url).not.toHaveAttribute('aria-invalid', 'true');
    await submit(page, saveEntry, url, 'URL is required', 'pointer');
    await url.fill('');
    await expect(url).not.toHaveAttribute('aria-invalid', 'true');

    await save.scrollIntoViewIfNeeded();
    const geometry = await save.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { save: rect.toJSON(), hitIsSave: element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)),
        width: innerWidth, height: innerHeight, scale: visualViewport?.scale, zoom: getComputedStyle(document.documentElement).zoom };
    });
    expect(geometry.hitIsSave).toBe(true);
    expect(geometry.width).toBe(page.viewportSize()?.width);
    expect(geometry.height).toBe(page.viewportSize()?.height);
    expect(geometry.scale).toBe(1);
    expect(geometry.zoom).toBe('1');
    await expectNoHorizontalOverflow(page);
    await info.attach(`cycle-${cycle}-geometry`, { contentType: 'application/json', body: JSON.stringify(geometry) });
    await submit(page, save, url, 'URL is required', 'pointer');
    await page.screenshot({ path: info.outputPath(`cycle-${cycle}-url-invalid.png`), fullPage: true });
    await url.fill('https://synthetic.example.test');
    await expect(url).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    await url.fill('');
  }
  const saveEvents = await page.evaluate(() => {
    const events = (window as unknown as { __knowledgeFeedbackEvents: { type: string; control: string; trusted: boolean }[] }).__knowledgeFeedbackEvents;
    return events.filter(event => event.control === 'Save' || event.control === 'Save Entry');
  });
  expect(saveEvents.filter(event => event.type === 'pointerdown')).toHaveLength(21);
  expect(saveEvents.filter(event => event.type === 'click')).toHaveLength(31);
  expect(saveEvents.every(event => event.trusted)).toBe(true);
});
