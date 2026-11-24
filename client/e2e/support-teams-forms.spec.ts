import { expect, installAppShellMocks, test } from './fixtures/app';
import type { Locator, Page, Route } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  (page as Page & { supportTeamsErrors: string[] }).supportTeamsErrors = errors;
});
test.afterEach(async ({ page }) => {
  expect((page as Page & { supportTeamsErrors: string[] }).supportTeamsErrors).toEqual([]);
});

const defaults = { handlingMinutesPerTicket: 7, socialFallbackSlaMinutes: 45, emailFallbackSlaMinutes: 360 };
const team = { id: 1, name: 'Billing', description: 'Synthetic support team', color: '#3B82F6', icon: null, isActive: true, members: [], createdAt: '2026-10-01T00:00:00Z' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}

async function mocks(page: Page) {
  const state = {
    capacityLoadError: false,
    capacitySaveError: false,
    teamSaveError: false,
    memberSaveError: false,
    capacityReadGate: null as ReturnType<typeof deferred> | null,
    capacityGate: null as ReturnType<typeof deferred> | null,
    teamGate: null as ReturnType<typeof deferred> | null,
    memberGate: null as ReturnType<typeof deferred> | null,
    capacity: { ...defaults },
    mutations: [] as { method: string; path: string; profile: string | undefined; body: Record<string, unknown> }[],
    blocked: [] as string[],
  };
  // Every API request ends in a disposable response; no fallback can reach a backend.
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === '/api/support/teams/capacity-settings' && method === 'GET') {
      await state.capacityReadGate?.promise;
      await route.fulfill({ status: state.capacityLoadError ? 503 : 200, json: state.capacityLoadError ? { error: 'Synthetic defaults load rejected' } : request.headers()['x-business-profile-id'] === '5102' ? { ...defaults, socialFallbackSlaMinutes: 91 } : state.capacity });
    } else if (path === '/api/support/teams' && method === 'GET') {
      await route.fulfill({ json: request.headers()['x-business-profile-id'] === '5102' ? [{ ...team, name: 'New workspace' }] : [team, { ...team, id: 2, name: 'Accounts' }] });
    } else if ((path === '/api/support/teams/capacity-settings' && method === 'PUT') ||
      (path === '/api/support/teams' && method === 'POST') ||
      (path === '/api/support/teams/1' && method === 'PUT') ||
      (/^\/api\/support\/teams\/[12]\/members$/.test(path) && method === 'POST')) {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.mutations.push({ method, path, profile: request.headers()['x-business-profile-id'], body });
      const kind = path.endsWith('capacity-settings') ? 'capacity' : path.endsWith('members') ? 'member' : 'team';
      await state[`${kind}Gate`]?.promise;
      const rejected = state[`${kind}SaveError`];
      if (kind === 'capacity' && !rejected) state.capacity = body as typeof defaults;
      await route.fulfill({ status: rejected ? (kind === 'team' ? 403 : 503) : 200, json: rejected ? { error: `Synthetic ${kind} save rejected` } : kind === 'capacity' ? state.capacity : { id: 3 } });
    } else if (method !== 'GET' && method !== 'HEAD') {
      state.blocked.push(`${method} ${path}`);
      await route.fulfill({ status: 409, json: { error: 'Unexpected mutation blocked by disposable Support Teams fixture' } });
    } else {
      await route.fulfill({ json: {} });
    }
  });
  await installAppShellMocks(page);
  await page.route('**/api/settings/business-profiles', route => route.fulfill({ json: [
    { id: 4102, name: 'Regression Business', companyName: 'Regression Company', isDefault: true, role: 'owner' },
    { id: 5102, name: 'Second synthetic workspace', role: 'owner' },
  ] }));
  await page.goto('/dashboard/support/teams', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Support teams' })).toBeVisible();
  return state;
}

async function routing(page: Page) {
  await page.getByRole('button', { name: 'Routing defaults' }).click();
  const dialog = page.getByRole('dialog', { name: 'Workspace routing defaults' });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function manage(page: Page, action: string, name = 'Billing') {
  await page.getByRole('button', { name: `Manage ${name}` }).click();
  await page.getByRole('menuitem', { name: action }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}
async function fillMember(dialog: Locator) {
  await dialog.getByLabel('Name *', { exact: true }).fill('Synthetic Member');
  await dialog.getByLabel('Email *', { exact: true }).fill('member@example.test');
  await dialog.getByLabel('Password *', { exact: true }).fill('Synthetic123!QA');
}
async function viewportCheck(page: Page, dialog?: Locator) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: visualViewport?.scale, overflow: document.documentElement.scrollWidth > innerWidth + 1 }));
  expect(dimensions.scale).toBe(1);
  expect(dimensions.width).toBe(page.viewportSize()!.width);
  expect(dimensions.height).toBe(page.viewportSize()!.height);
  expect(dimensions.overflow).toBe(false);
  if (dialog) {
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(dimensions.width + 1);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(dimensions.height + 1);
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  }
}

test('failed capacity load is blocked, retry loads server values, failed save preserves draft and retry saves once', async ({ page }) => {
  const state = await mocks(page);
  // Remount under a failed settings read to reproduce the initial load case.
  state.capacityLoadError = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  let dialog = await routing(page);
  await expect(dialog.getByRole('alert')).toContainText('Synthetic defaults load rejected');
  await expect(dialog.getByRole('spinbutton')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Save defaults' })).toBeDisabled();
  await viewportCheck(page, dialog);
  state.capacityLoadError = false;
  await dialog.getByRole('button', { name: 'Retry loading defaults' }).click();
  await expect(dialog.getByLabel('Social fallback in minutes')).toHaveValue('45');
  await dialog.getByLabel('Social fallback in minutes').fill('64');
  state.capacitySaveError = true;
  await dialog.getByRole('button', { name: 'Save defaults' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Synthetic capacity save rejected');
  await expect(dialog.getByLabel('Social fallback in minutes')).toHaveValue('64');
  await viewportCheck(page, dialog);
  state.capacitySaveError = false;
  state.capacityGate = deferred();
  await dialog.getByLabel('Social fallback in minutes').press('Enter');
  await expect(dialog.getByRole('status')).toHaveText('Saving response targets…');
  await expect(dialog.getByRole('button', { name: 'Save defaults' })).toBeDisabled();
  await dialog.locator('form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(state.mutations).toHaveLength(2);
  state.capacityGate.resolve();
  await expect(dialog).toHaveCount(0);
  dialog = await routing(page);
  await expect(dialog.getByLabel('Social fallback in minutes')).toHaveValue('64');
  expect(state.mutations.every(mutation => mutation.profile === '4102')).toBe(true);
  expect(state.blocked).toEqual([]);
});

test('capacity pending load and cancelled save remain safe on reopen', async ({ page }) => {
  const state = await mocks(page);
  state.capacityReadGate = deferred();
  await page.reload({ waitUntil: 'domcontentloaded' });
  let dialog = await routing(page);
  await expect(dialog.getByRole('status')).toHaveText('Loading response targets…');
  await expect(dialog.getByRole('button', { name: 'Save defaults' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  dialog = await routing(page);
  state.capacityReadGate.resolve();
  await expect(dialog.getByLabel('Social fallback in minutes')).toHaveValue('45');
  await dialog.getByLabel('Social fallback in minutes').fill('72');
  state.capacityGate = deferred();
  await dialog.getByRole('button', { name: 'Save defaults' }).dblclick();
  await expect(dialog.getByRole('status')).toHaveText('Saving response targets…');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  dialog = await routing(page);
  await expect(dialog.getByRole('button', { name: 'Save defaults' })).toBeDisabled();
  state.capacityGate.resolve();
  await expect(dialog.getByRole('button', { name: 'Save defaults' })).toBeEnabled();
  await expect(dialog.getByLabel('Social fallback in minutes')).toHaveValue('72');
  await viewportCheck(page, dialog);
  expect(state.mutations).toHaveLength(1);
  expect(state.blocked).toEqual([]);
});

test('create and edit team reject safely, lock double-click/Enter, retry and retain a reopened session', async ({ page }) => {
  const state = await mocks(page);
  await page.getByRole('button', { name: 'Add team' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Team name *').fill('Synthetic create');
  await dialog.getByLabel('Description', { exact: true }).fill('Disposable team description');
  await dialog.getByTitle('Emerald', { exact: true }).click();
  state.teamSaveError = true;
  state.teamGate = deferred();
  await dialog.getByRole('button', { name: 'Create Team', exact: true }).dblclick();
  await expect(dialog.getByRole('status')).toHaveText('Saving team…');
  await expect(dialog.getByLabel('Team name *')).toBeDisabled();
  await dialog.locator('form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(state.mutations).toHaveLength(1);
  state.teamGate.resolve();
  await expect(dialog.getByRole('alert')).toContainText('Synthetic team save rejected');
  await expect(dialog.getByLabel('Team name *')).toHaveValue('Synthetic create');
  await expect(dialog.getByLabel('Description', { exact: true })).toHaveValue('Disposable team description');
  await viewportCheck(page, dialog);
  state.teamSaveError = false;
  await dialog.getByLabel('Team name *').press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add team' })).toBeFocused();
  expect(state.mutations[1].body).toEqual({ name: 'Synthetic create', description: 'Disposable team description', color: '#10B981' });
  dialog = await manage(page, 'Edit team');
  await dialog.getByLabel('Team name *').fill('Synthetic edit');
  state.teamGate = deferred();
  await dialog.getByRole('button', { name: 'Save Changes' }).dblclick();
  await expect(dialog.getByRole('status')).toHaveText('Saving team…');
  await viewportCheck(page, dialog);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Add team' }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Team name *')).toBeDisabled();
  state.teamGate.resolve();
  await expect(dialog.getByLabel('Team name *')).toBeEnabled();
  await expect(dialog.getByLabel('Team name *')).toHaveValue('');
  expect(state.mutations).toHaveLength(3);
  expect(state.mutations[2].path).toBe('/api/support/teams/1');
  expect(state.blocked).toEqual([]);
});

test('member rejects with notification inputs retained, retry locks keyboard submits and old completion preserves changed target', async ({ page }, testInfo) => {
  const state = await mocks(page);
  let dialog = await manage(page, 'Add member');
  await fillMember(dialog);
  await dialog.getByLabel(/WhatsApp number/).fill('+15555550123');
  await dialog.getByRole('checkbox').check();
  state.memberSaveError = true;
  state.memberGate = deferred();
  await dialog.getByRole('button', { name: 'Add Member', exact: true }).dblclick();
  await expect(dialog.getByRole('status')).toHaveText('Adding member…');
  await expect(dialog.getByLabel('Name *', { exact: true })).toBeDisabled();
  await dialog.locator('form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(state.mutations).toHaveLength(1);
  state.memberGate.resolve();
  await expect(dialog.getByRole('alert')).toContainText('Synthetic member save rejected');
  await expect(dialog.getByLabel('Password *', { exact: true })).toHaveValue('Synthetic123!QA');
  await expect(dialog.getByRole('checkbox')).toBeChecked();
  await viewportCheck(page, dialog);
  await page.screenshot({ path: testInfo.outputPath('member-save-error.png') });
  state.memberSaveError = false;
  state.memberGate = deferred();
  await dialog.getByLabel('Email *', { exact: true }).press('Enter');
  await expect(dialog.getByRole('status')).toHaveText('Adding member…');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  dialog = await manage(page, 'Add member', 'Accounts');
  await expect(dialog.getByLabel('Name *', { exact: true })).toBeDisabled();
  state.memberGate.resolve();
  await expect(dialog.getByLabel('Name *', { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('Name *', { exact: true })).toHaveValue('');
  await fillMember(dialog);
  await dialog.getByRole('button', { name: 'Add Member', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.mutations).toHaveLength(3);
  expect(state.mutations[2].path).toBe('/api/support/teams/2/members');
  expect(state.mutations[0].body.role).toBe('member');
  expect(state.mutations[0].body.whatsappConsentAcknowledged).toBe(true);
  expect(state.mutations.every(mutation => mutation.profile === '4102')).toBe(true);
  expect(state.blocked).toEqual([]);
});

test('workspace change discards old drafts and ignores the previous pending save', async ({ page }) => {
  const state = await mocks(page);
  let dialog = await routing(page);
  await dialog.getByLabel('Social fallback in minutes').fill('64');
  state.capacityGate = deferred();
  await dialog.getByRole('button', { name: 'Save defaults' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Saving response targets…');
  await page.evaluate(() => {
    sessionStorage.setItem('active-business-profile:4101', '5102');
    window.dispatchEvent(new Event('business-profile-changed'));
  });
  await expect(page.getByRole('button', { name: 'Open New workspace team roster and task list' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  dialog = await routing(page);
  await expect(dialog.getByLabel('Social fallback in minutes')).toHaveValue('91');
  state.capacityGate.resolve();
  await expect(dialog.getByLabel('Social fallback in minutes')).toHaveValue('91');
  await expect(dialog.getByRole('button', { name: 'Save defaults' })).toBeEnabled();
  await viewportCheck(page, dialog);
  expect(state.mutations).toHaveLength(1);
  expect(state.mutations[0].profile).toBe('4102');
  expect(state.blocked).toEqual([]);
});
