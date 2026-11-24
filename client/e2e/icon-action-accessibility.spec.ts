import type { Locator, Page } from '@playwright/test';
import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';
import { campaignRecords, campaignTargets, roomRecords, roomTargets } from './fixtures/icon-actions';

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });

async function fixtures(page: Page) {
  const state = {
    campaigns: structuredClone(campaignRecords), rooms: structuredClone(roomRecords),
    currentCampaignIds: [] as number[],
    deleted: [] as number[], saved: [] as { id: number; name: string }[], unexpectedWrites: [] as string[],
  };
  // No API request reaches an application server, including authentication and writes.
  await page.route('**/api/**', route => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method())) state.unexpectedWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.fulfill({ json: [] });
  });
  await installAppShellMocks(page);
  await page.route('**/api/chat/threads?*', route => {
    const params = new URL(route.request().url()).searchParams;
    const offset = Number(params.get('offset'));
    const limit = Number(params.get('limit'));
    const threads = state.campaigns.slice(offset, offset + limit);
    if (params.has('businessProfileId')) state.currentCampaignIds = threads.map(record => record.id);
    return route.fulfill({ json: { threads, total: state.campaigns.length } });
  });
  await page.route('**/api/chat/threads/*', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    if (route.request().method() !== 'DELETE') return route.fulfill({ status: 405 });
    state.deleted.push(id);
    state.campaigns = state.campaigns.filter(record => record.id !== id);
    return route.fulfill({ json: { success: true } });
  });
  await page.route('**/api/hotel/property', route => route.fulfill({ json: { property: { id: 1, name: 'Synthetic Hotel', currency: 'USD', timezone: 'UTC' } } }));
  await page.route('**/api/hotel/summary', route => route.fulfill({ json: { totalRoomTypes: state.rooms.length, totalBookings: 0, confirmedBookings: 0, revenueByCurrency: {} } }));
  await page.route('**/api/hotel/room-types', route => route.fulfill({ json: { roomTypes: state.rooms } }));
  await page.route('**/api/hotel/room-types/*', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1));
    if (route.request().method() !== 'PUT') return route.fulfill({ status: 405 });
    const data = route.request().postDataJSON();
    state.saved.push({ id, name: data.name });
    state.rooms = state.rooms.map(room => room.id === id ? { ...room, name: data.name } : room);
    return route.fulfill({ json: { success: true } });
  });
  return state;
}

async function tabTo(page: Page, target: Locator) {
  for (let steps = 0; steps < 100; steps++) {
    if (await target.evaluate(element => document.activeElement === element)) break;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
  await expect(target).toBeVisible();
  await expect(target).not.toHaveCSS('box-shadow', 'none');
  const bounds = await target.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

async function evidence(page: Page, name: string, state: unknown) {
  await expectNoHorizontalOverflow(page);
  await test.info().attach(`${name}-accessibility`, { body: await page.locator('#main-content').ariaSnapshot(), contentType: 'text/yaml' });
  await test.info().attach(`${name}-fixture-requests`, { body: JSON.stringify(state, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
}

for (const mode of ['grid', 'list'] as const) {
  test(`AS018 campaign ${mode}: contextual names, keyboard safeguards, cancellation and synthetic confirmation`, async ({ page, audit }) => {
    const state = await fixtures(page);
    await page.goto('/dashboard/chats');
    const main = page.locator('#main-content');
    const search = main.getByPlaceholder('Filter this page by campaign title...');
    await expect(search).toBeVisible();
    if (mode === 'list') await main.getByRole('button', { name: 'List view', exact: true }).click();
    const current = state.currentCampaignIds.map(id => campaignTargets[campaignRecords.findIndex(record => record.id === id)]);
    await expect(main.getByRole('button', { name: /^Delete campaign / })).toHaveCount(current.length);
    for (const target of current) {
      const action = main.getByRole('button', { name: `Delete campaign ${target}`, exact: true });
      await expect(action).toHaveCount(1);
      await expect(action).toHaveAttribute('type', 'button');
      await expect(action).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(action.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    }
    const trigger = main.getByRole('button', { name: `Delete campaign ${campaignTargets[0]}`, exact: true });
    const title = main.getByText(campaignRecords[0].icp!.campaignName, { exact: true });
    await expect(title).toHaveCSS('text-overflow', 'ellipsis');
    expect(await title.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await trigger.locator(mode === 'grid' ? 'xpath=ancestor::*[contains(@class,"shadcn-card")]' : 'xpath=ancestor::tr').hover();
    await expect(trigger).toHaveCSS('opacity', '1');
    await search.focus();
    await tabTo(page, trigger);
    await expect(trigger).toHaveCSS('opacity', '1');
    for (const key of ['Enter', 'Space']) {
      await trigger.press(key);
      const dialog = page.getByRole('alertdialog', { name: 'Delete Campaign', exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAccessibleDescription(`Are you sure you want to delete ${campaignTargets[0]}? This action cannot be undone.`);
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
      if (key === 'Enter') await test.info().attach(`campaign-${mode}-dialog`, { body: await dialog.ariaSnapshot(), contentType: 'text/yaml' });
      expect(state.deleted).toEqual([]);
      await expect(page).toHaveURL(/\/dashboard\/chats$/);
      if (key === 'Enter') await page.keyboard.press('Escape');
      else await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(state.deleted).toEqual([]);
    }
    await evidence(page, `campaign-${mode}-cancelled`, { deleted: state.deleted, unexpectedWrites: state.unexpectedWrites });
    await search.fill('Duplicate synthetic campaign');
    await expect(main.getByRole('button', { name: /^Delete campaign / })).toHaveCount(2);
    const duplicate = main.getByRole('button', { name: `Delete campaign ${campaignTargets[2]}`, exact: true });
    await duplicate.focus();
    await duplicate.press('Enter');
    await expect(page.getByRole('alertdialog')).toHaveAccessibleDescription(`Are you sure you want to delete ${campaignTargets[2]}? This action cannot be undone.`);
    await page.keyboard.press('Escape');
    await expect(duplicate).toBeFocused();
    await search.fill('');
    await main.getByRole('button', { name: 'Next', exact: true }).click();
    const next = main.getByRole('button', { name: `Delete campaign ${campaignTargets.at(-1)}`, exact: true });
    await expect(next).toBeVisible();
    await next.focus();
    await next.press('Space');
    await expect(page.getByRole('alertdialog')).toHaveAccessibleDescription(`Are you sure you want to delete ${campaignTargets.at(-1)}? This action cannot be undone.`);
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    expect(state.deleted).toEqual([]);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => state.deleted).toEqual([911]);
    await expect(main.getByRole('button', { name: `Delete campaign ${campaignTargets.at(-1)}`, exact: true })).toHaveCount(0);
    await expect(main.getByRole('button', { name: `Delete campaign ${campaignTargets[0]}`, exact: true })).toBeVisible();
    expect(state.saved).toEqual([]);
    expect(state.unexpectedWrites).toEqual([]);
    expect(audit.blockedMutations).toEqual([]);
    expect(audit.consoleErrors).toEqual([]);
    await evidence(page, `campaign-${mode}-mock-confirmed`, { deleted: state.deleted, saved: state.saved, unexpectedWrites: state.unexpectedWrites });
  });
}

test('AS018 hotel: all states named, keyboard cancellation/focus, filter/tab reset and mocked validated Save', async ({ page, audit }) => {
  const state = await fixtures(page);
  await page.goto('/dashboard/hotel?tab=rooms');
  const main = page.locator('#main-content');
  const search = main.getByPlaceholder('Search room types...');
  await expect(search).toBeVisible();
  await expect(main.getByRole('button', { name: /^Edit room type / })).toHaveCount(roomRecords.length);
  const longHeading = main.getByRole('heading', { name: roomRecords[0].name, exact: true });
  await expect(longHeading).toHaveCSS('text-overflow', 'ellipsis');
  expect(await longHeading.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  for (const [index, target] of roomTargets.entries()) {
    const edit = main.getByRole('button', { name: `Edit room type ${target}`, exact: true });
    await expect(edit).toHaveCount(1);
    await expect(edit).toHaveAttribute('type', 'button');
    await expect(edit.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    await edit.locator('xpath=ancestor::*[contains(@class,"shadcn-card")]').hover();
    await expect(edit.locator('..')).toHaveCSS('opacity', '1');
    await search.focus();
    await tabTo(page, edit);
    await expect(edit.locator('..')).toHaveCSS('opacity', '1');
    await edit.press(index % 2 === 0 ? 'Enter' : 'Space');
    const save = main.getByRole('button', { name: `Save changes to room type ${target}`, exact: true });
    const card = save.locator('xpath=ancestor::*[contains(@class,"shadcn-card")]');
    await expect(card.getByRole('textbox')).toBeFocused();
    await card.getByRole('textbox').fill('Unsaved synthetic room');
    const cancel = main.getByRole('button', { name: `Cancel editing room type ${target}`, exact: true });
    for (const control of [save, cancel]) {
      await expect(control).toHaveAttribute('type', 'button');
      await expect(control.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    }
    await tabTo(page, cancel);
    await cancel.press('Space');
    await expect(edit).toBeFocused();
    await expect(main.getByRole('heading', { name: roomRecords[index].name.trim() || `Room type ${roomRecords[index].id}`, exact: true })).toHaveCount(index === 1 || index === 2 ? 2 : 1);
    await expect(main.getByRole('textbox')).toHaveCount(1); // Only the page search remains.
    expect(state.rooms).toEqual(roomRecords);
    expect(state.saved).toEqual([]);
  }
  await evidence(page, 'room-cancelled', { saved: state.saved, deleted: state.deleted, unexpectedWrites: state.unexpectedWrites });
  const edit = main.getByRole('button', { name: `Edit room type ${roomTargets[1]}`, exact: true });
  await edit.click();
  let save = main.getByRole('button', { name: `Save changes to room type ${roomTargets[1]}`, exact: true });
  let card = save.locator('xpath=ancestor::*[contains(@class,"shadcn-card")]');
  await card.getByRole('textbox').fill('Unsaved hidden draft');
  await search.fill('Synthetic room with');
  await expect(main.getByRole('button', { name: /^Save changes to room type / })).toHaveCount(0);
  await search.fill('');
  for (let cycle = 0; cycle < 2; cycle++) {
    await edit.click();
    save = main.getByRole('button', { name: `Save changes to room type ${roomTargets[1]}`, exact: true });
    card = save.locator('xpath=ancestor::*[contains(@class,"shadcn-card")]');
    await expect(card.getByRole('textbox')).toHaveValue(roomRecords[1].name);
    await main.getByRole('button', { name: `Cancel editing room type ${roomTargets[1]}`, exact: true }).press('Enter');
    await expect(edit).toBeFocused();
  }
  await edit.click();
  await main.getByRole('button', { name: `Save changes to room type ${roomTargets[1]}`, exact: true }).locator('xpath=ancestor::*[contains(@class,"shadcn-card")]').getByRole('textbox').fill('Unsaved tab draft');
  await main.getByRole('tab', { name: 'Hotel Profile', exact: true }).click();
  await expect(main.getByRole('button', { name: 'Save Settings', exact: true })).toBeVisible();
  await main.getByRole('tab', { name: 'Room Types', exact: true }).click();
  await expect(edit).toBeVisible();
  await edit.click();
  await expect(main.getByRole('button', { name: `Save changes to room type ${roomTargets[1]}`, exact: true }).locator('xpath=ancestor::*[contains(@class,"shadcn-card")]').getByRole('textbox')).toHaveValue(roomRecords[1].name);
  await main.getByRole('button', { name: `Cancel editing room type ${roomTargets[1]}`, exact: true }).click();
  expect(state.saved).toEqual([]);
  const selectedTarget = roomTargets[2];
  await main.getByRole('button', { name: `Edit room type ${selectedTarget}`, exact: true }).click();
  save = main.getByRole('button', { name: `Save changes to room type ${selectedTarget}`, exact: true });
  card = save.locator('xpath=ancestor::*[contains(@class,"shadcn-card")]');
  await card.getByRole('textbox').fill('');
  await save.click();
  await expect(save).toBeEnabled();
  await expect(page.getByText('Check the room name, capacity, prices, and discount', { exact: true })).toBeVisible();
  expect(state.saved).toEqual([]);
  await card.getByRole('textbox').fill('Saved synthetic room');
  await save.click();
  await expect.poll(() => state.saved).toEqual([{ id: 803, name: 'Saved synthetic room' }]);
  await expect(main.getByRole('button', { name: 'Edit room type Saved synthetic room (ID 803)', exact: true })).toBeVisible();
  expect(state.rooms.filter(room => room.id !== 803)).toEqual(roomRecords.filter(room => room.id !== 803));
  expect(state.deleted).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
  await evidence(page, 'room-mock-saved', { saved: state.saved, deleted: state.deleted, unexpectedWrites: state.unexpectedWrites });
});
