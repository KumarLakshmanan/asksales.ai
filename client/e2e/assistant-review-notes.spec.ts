import { test as appTest, expect, expectNoHorizontalOverflow } from './fixtures/app';
import type { Page, Route } from '@playwright/test';
import { emptyAssistantDraft, type AssistantCatalog } from '../../shared/outreachAssistants';
import type { AssistantKnowledgeGap } from '../../shared/assistantOperations';

const apiPath = '/api/settings/outreach/assistants';
const ids = ['c1a11111-1111-4111-8111-111111111111', 'c2a22222-2222-4222-8222-222222222222'];
const keys = ['a'.repeat(40), 'b'.repeat(40)];
type Submission = { route: Route; profile: string; body: { key: string; review: 'open' | 'reviewed'; note: string | null } };
type ReviewFixture = {
  submissions: Submission[];
  refreshes: Route[];
  unexpected: string[];
  holdRefresh: boolean;
  failRefresh: boolean;
  failedRefreshes: number;
  canManage: boolean;
  finishPost: (index: number, status?: number) => Promise<void>;
  finishRefresh: () => Promise<void>;
};
const test = appTest.extend<{ reviews: ReviewFixture }>({
  reviews: async ({ page, baseURL }, provideFixture) => {
    const gaps = new Map<string, AssistantKnowledgeGap[]>();
    const rows = (profile: string) => {
      if (!gaps.has(profile)) gaps.set(profile, ids.map((assistantId, index) => ({
        key: keys[index], assistantId, assistantName: `Synthetic assistant ${index + 1}`, intent: 'hours', count: 1,
        latestAt: '2026-10-11T00:00:00Z', conversationIds: [], reason: 'Synthetic source needs review.', review: 'open', note: null,
      })));
      return gaps.get(profile)!;
    };
    const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const report = (route: Route) => {
      const request = route.request(), url = new URL(request.url());
      const profile = request.headers()['x-business-profile-id'];
      const assistant = url.searchParams.get('assistantId');
      return json(route, { days: Number(url.searchParams.get('days') || 30), assignments: [], metrics: [], usage: [], knowledgeGaps: rows(profile).filter(row => !assistant || row.assistantId === assistant) });
    };
    const fixture: ReviewFixture = {
      submissions: [], refreshes: [], unexpected: [], holdRefresh: true, failRefresh: false, failedRefreshes: 0, canManage: true,
      finishPost: async (index, status = 200) => {
        const { route, profile, body } = fixture.submissions[index];
        if (status !== 200) { await json(route, { error: 'Synthetic save rejected' }, status); return; }
        Object.assign(rows(profile).find(row => row.key === body.key)!, { review: body.review, note: body.note });
        await json(route, { review: body.review });
      },
      finishRefresh: async () => { for (const route of fixture.refreshes.splice(0)) await report(route); },
    };
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(baseURL!).origin) {
        fixture.unexpected.push(`External request blocked: ${route.request().method()} ${url.origin}${url.pathname}`);
        await route.abort('blockedbyclient'); return;
      }
      await route.fallback();
    });
    const shell = ['/api/auth/me', '/api/platform/access', '/api/settings/business-profiles', '/api/settings/preferences', '/api/organizations', '/api/crm/configuration', '/api/wallet', '/api/notifications/unread/count', '/api/chat/threads'];
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (path.startsWith(apiPath)) {
        const profile = request.headers()['x-business-profile-id'];
        expect(['4102', '5102']).toContain(profile);
        if (request.method() === 'POST' && ids.some(id => path === `${apiPath}/${id}/knowledge-gaps/review`)) {
          const body = request.postDataJSON();
          expect(Object.keys(body).sort()).toEqual(['key', 'note', 'review']);
          expect(keys).toContain(body.key);
          expect(path).toBe(`${apiPath}/${ids[keys.indexOf(body.key)]}/knowledge-gaps/review`);
          fixture.submissions.push({ route, profile, body }); return;
        }
        if (request.method() === 'GET' && path === `${apiPath}/catalog`) {
          const catalog: AssistantCatalog = { runtimeEnabled: true, presets: [], accounts: [], models: [], knowledge: [], playbooks: [], templates: [], documents: [], galleries: [], tools: [], permissions: { canManage: fixture.canManage, description: 'Synthetic role' } };
          return json(route, catalog);
        }
        if (request.method() === 'GET' && path === apiPath) return json(route, { assistants: ids.map((id, index) => ({ id, draft: { ...emptyAssistantDraft(), name: `Synthetic assistant ${index + 1}` } })), runtimeEnabled: true, nextCursor: null });
        if (request.method() === 'GET' && path === `${apiPath}/diagnostics`) {
          if (fixture.failRefresh) { fixture.failedRefreshes++; return json(route, { error: 'Synthetic report unavailable' }, 500); }
          if (fixture.holdRefresh && fixture.submissions.some(submission => submission.profile === profile)) { fixture.refreshes.push(route); return; }
          return report(route);
        }
        fixture.unexpected.push(`Unexpected assistant request: ${request.method()} ${path}`);
        return json(route, { error: 'Unexpected synthetic request' }, 409);
      }
      if (request.method() === 'GET' && path === '/api/settings/business-profiles') return json(route, [
        { id: 4102, companyName: 'Synthetic workspace one', role: 'owner', isDefault: true },
        { id: 5102, companyName: 'Synthetic workspace two', role: 'owner' },
      ]);
      if (request.method() === 'GET' && shell.includes(path)) return route.fallback();
      if (request.method() === 'GET') return json(route, { data: [], items: [], total: 0 });
      fixture.unexpected.push(`Unexpected mutation blocked: ${request.method()} ${path}`);
      return json(route, { error: 'Mutation blocked by synthetic fixture' }, 409);
    });
    await provideFixture(fixture);
    expect(fixture.unexpected).toEqual([]);
  },
});
const note = (page: Page, index = 0) => page.getByLabel('Review note', { exact: true }).nth(index);
async function open(page: Page) {
  await page.goto('/dashboard/settings/outreach/operations');
  await expect(page.getByRole('heading', { name: 'Assistant operations', exact: true })).toBeVisible();
  await expect(note(page)).toBeVisible();
  await page.getByLabel('Knowledge review status').selectOption('all');
}
async function submit(page: Page, reviews: ReviewFixture) {
  await note(page).fill('Synthetic A');
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).first().click();
  await expect.poll(() => reviews.submissions.length).toBe(1);
  expect(reviews.submissions[0].body).toEqual({ key: keys[0], review: 'reviewed', note: 'Synthetic A' });
  expect(reviews.submissions[0].profile).toBe('4102');
}

for (const stage of ['POST', 'diagnostics refresh']) {
  test(`newer typing survives deferred ${stage} and can be saved without reopening`, async ({ page, reviews, audit }, info) => {
    await open(page); await submit(page, reviews);
    await expect(note(page)).toBeEditable();
    await expect(note(page)).toHaveAccessibleDescription('Saving the submitted note. You can keep editing.');
    await note(page, 1).fill('Unrelated synthetic draft');
    if (stage === 'POST') await note(page).fill('Synthetic B');
    await reviews.finishPost(0);
    await expect.poll(() => reviews.refreshes.length).toBe(1);
    if (stage === 'diagnostics refresh') await note(page).fill('Synthetic B');
    await expect(page.getByRole('button', { name: 'Saving review…' })).toBeDisabled();
    await reviews.finishRefresh();
    await expect(page.getByRole('button', { name: 'Save review note' })).toBeEnabled();
    await expect(note(page)).toHaveValue('Synthetic B');
    await expect(note(page)).toHaveAccessibleDescription('Unsaved note edits.');
    await expect(note(page, 1)).toHaveValue('Unrelated synthetic draft');
    await expect(page.getByText('Review note · Synthetic A', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect(await page.evaluate(() => ({ width: innerWidth, scale: visualViewport?.scale }))).toEqual({ width: info.project.use.viewport!.width, scale: 1 });
    if (stage === 'POST') {
      await note(page).evaluate(element => element.scrollIntoView({ block: 'center' }));
      await page.screenshot({ path: info.outputPath('retained-newer-note.png') });
    }
    await page.getByRole('button', { name: 'Save review note' }).click();
    await expect.poll(() => reviews.submissions.length).toBe(2);
    expect(reviews.submissions[1].body).toEqual({ key: keys[0], review: 'reviewed', note: 'Synthetic B' });
    await reviews.finishPost(1); await expect.poll(() => reviews.refreshes.length).toBe(1); await reviews.finishRefresh();
    await expect(page.getByRole('button', { name: 'Save review note' })).toHaveCount(0);
    await expect(note(page)).toHaveValue('Synthetic B');
    await expect(note(page, 1)).toHaveValue('Unrelated synthetic draft');
    expect(audit.consoleErrors).toEqual([]); expect(audit.blockedMutations).toEqual([]);
  });
}

test('rejected save retains latest edits and a scoped retry sends only that draft', async ({ page, reviews, audit }) => {
  await open(page); await submit(page, reviews); await note(page).fill('Synthetic B');
  await note(page, 1).fill('Unrelated synthetic draft');
  await reviews.finishPost(0, 500);
  await expect(page.getByRole('alert').filter({ hasText: /^Synthetic save rejected$/ })).toHaveText('Synthetic save rejected');
  await expect(note(page)).toHaveValue('Synthetic B'); await expect(note(page, 1)).toHaveValue('Unrelated synthetic draft');
  expect(reviews.refreshes).toHaveLength(0);
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).first().click();
  await expect.poll(() => reviews.submissions.length).toBe(2);
  expect(reviews.submissions[1].body).toEqual({ key: keys[0], review: 'reviewed', note: 'Synthetic B' });
  expect(reviews.submissions[1].profile).toBe('4102');
  await reviews.finishPost(1); await expect.poll(() => reviews.refreshes.length).toBe(1); await reviews.finishRefresh();
  await expect(page.getByRole('alert').filter({ hasText: /^Synthetic save rejected$/ })).toHaveCount(0);
  await expect(note(page)).toHaveValue('Synthetic B');
  expect(audit.consoleErrors).toEqual(['Failed to load resource: the server responded with a status of 500 (Internal Server Error)']);
});

test('filter changes hide and restore newer and unrelated drafts during a pending save', async ({ page, reviews, audit }) => {
  await open(page); await submit(page, reviews); await note(page).fill('Synthetic B'); await note(page, 1).fill('Unrelated synthetic draft');
  await page.getByLabel('Knowledge review status').selectOption('reviewed');
  await expect(note(page)).toHaveCount(0);
  await page.getByLabel('Assistant', { exact: true }).selectOption(ids[1]);
  await expect.poll(() => reviews.refreshes.length).toBe(1); await reviews.finishRefresh();
  await expect(page.getByText('No recorded knowledge gaps match this review status.')).toBeVisible();
  await reviews.finishPost(0); await expect.poll(() => reviews.refreshes.length).toBe(1); await reviews.finishRefresh();
  reviews.holdRefresh = false;
  await page.getByLabel('Assistant', { exact: true }).selectOption('all');
  await page.getByLabel('Reporting period').selectOption('7');
  await page.getByLabel('Channel', { exact: true }).selectOption('whatsapp');
  await page.getByLabel('Knowledge review status').selectOption('all');
  await expect(note(page)).toHaveValue('Synthetic B'); await expect(note(page, 1)).toHaveValue('Unrelated synthetic draft');
  expect(reviews.submissions).toHaveLength(1); expect(audit.consoleErrors).toEqual([]);
});

test('failed diagnostics retain drafts, disclose the accepted save and require report retry', async ({ page, reviews, audit }) => {
  await open(page); await submit(page, reviews); await note(page).fill('Synthetic B'); await note(page, 1).fill('Unrelated synthetic draft');
  reviews.failRefresh = true;
  await reviews.finishPost(0);
  const message = 'Review saved, but the report could not refresh. Your note is kept. Retry the report before reviewing again.';
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  expect(reviews.failedRefreshes).toBe(2);
  await expect(note(page)).toHaveValue('Synthetic B'); await expect(note(page, 1)).toHaveValue('Unrelated synthetic draft');
  await expect(page.getByRole('button', { name: 'Mark reviewed', exact: true }).first()).toBeDisabled();
  expect(reviews.submissions).toHaveLength(1);
  reviews.failRefresh = false; reviews.holdRefresh = false;
  await page.getByRole('button', { name: 'Retry report', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save review note' })).toBeEnabled();
  await expect(page.getByText(message, { exact: true })).toHaveCount(0);
  await expect(note(page)).toHaveValue('Synthetic B'); await expect(note(page, 1)).toHaveValue('Unrelated synthetic draft');
  expect(audit.consoleErrors).toEqual(Array(2).fill('Failed to load resource: the server responded with a status of 500 (Internal Server Error)'));
});

test('repeated pointer and keyboard submission remains single while POST and refresh are pending', async ({ page, reviews, audit }) => {
  await open(page); await note(page).fill('Synthetic A');
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).first().dblclick();
  await expect.poll(() => reviews.submissions.length).toBe(1);
  const busy = page.getByRole('button', { name: 'Saving review…' });
  await busy.press('Enter'); await busy.press('Space');
  await expect(page.getByRole('button', { name: 'Mark reviewed', exact: true })).toBeDisabled();
  await reviews.finishPost(0); await expect.poll(() => reviews.refreshes.length).toBe(1);
  await busy.press('Enter');
  await expect(busy).toBeDisabled(); expect(reviews.submissions).toHaveLength(1);
  await reviews.finishRefresh();
  await expect(page.getByRole('button', { name: 'Reopen question' })).toBeEnabled();
  expect(reviews.submissions).toHaveLength(1); expect(audit.consoleErrors).toEqual([]);
});

test('a workspace change isolates old completion from the new draft and save', async ({ page, reviews, audit }) => {
  await open(page); await submit(page, reviews);
  // Exercise the same subscription used by the workspace chooser, using synthetic identities only.
  await page.evaluate(() => {
    const user = JSON.parse(localStorage.getItem('user')!);
    sessionStorage.setItem(`active-business-profile:${user.id}`, '5102');
    window.dispatchEvent(new Event('business-profile-changed'));
  });
  await expect(note(page)).toHaveValue(''); await note(page).fill('New workspace draft');
  await reviews.finishPost(0);
  await expect(note(page)).toHaveValue('New workspace draft');
  await page.getByRole('button', { name: 'Mark reviewed', exact: true }).first().click();
  await expect.poll(() => reviews.submissions.length).toBe(2);
  expect(reviews.submissions[1].profile).toBe('5102');
  expect(reviews.submissions[1].body).toEqual({ key: keys[0], review: 'reviewed', note: 'New workspace draft' });
  await reviews.finishPost(1); await expect.poll(() => reviews.refreshes.length).toBe(1); await reviews.finishRefresh();
  await expect(page.getByRole('button', { name: 'Saving review…' })).toHaveCount(0);
  expect(audit.consoleErrors).toEqual([]);
});

test('a read-only workspace shows no review textarea or write action', async ({ page, reviews, audit }) => {
  reviews.canManage = false;
  await page.goto('/dashboard/settings/outreach/operations');
  await expect(page.getByRole('heading', { name: 'Synthetic assistant 1 · hours' })).toBeVisible();
  await expect(note(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark reviewed' })).toHaveCount(0);
  expect(reviews.submissions).toHaveLength(0); expect(audit.consoleErrors).toEqual([]);
});
