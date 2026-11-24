import { captureCrmScreenshot, waitForCrmEntranceAnimations } from './fixtures/crm-screenshots';
import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';
import { DEFAULT_CRM_CONFIGURATION, type CrmConfiguration } from '../../shared/crmConfiguration';

test.setTimeout(180_000);
test.use({ actionTimeout: 45_000 });
const screenshotDirectory = process.env.CRM_QA_SCREENSHOT_DIR || 'test-results';

const initialConfiguration = (): CrmConfiguration => ({
  stages: structuredClone(DEFAULT_CRM_CONFIGURATION.stages.filter(stage => ['new', 'contacted', 'won', 'lost'].includes(stage.key))),
  preferences: { ...DEFAULT_CRM_CONFIGURATION.preferences },
});
const contact = { id: 42, firstName: 'Alex', lastName: 'Morgan', email: 'alex@example.test', company: 'Acme',
  pipelineStatus: 'contacted', status: 'contacted', currency: 'USD', dealValue: '1250', tags: [], createdAt: '2026-09-29T00:00:00Z' };

test.beforeEach(async ({ page }) => {
  page.on('dialog',dialog=>void dialog.accept());
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await installAppShellMocks(page);
  await page.route('**/api/crm/assignees',route=>route.fulfill({json:{success:true,data:[]}}));
  await page.route('**/api/crm/automations/catalog',route=>route.fulfill({json:{success:true,data:{accounts:[]}}}));
  await page.route('**/api/crm/contacts?*', route => route.fulfill({ json: { contacts: [contact], total: 1, totalPages: 1 } }));
  await page.route('**/api/crm/analytics', route => route.fulfill({ json: { success: true, data: {
    totalContacts: 1, winRate: 0, pipelineValueByCurrency: { USD: '1250' },
  } } }));
});

test('Contacts opens the configuration wizard, saves it, and loads the saved stages again', async ({ page, audit }) => {
  let configuration = initialConfiguration();
  const writes: CrmConfiguration[] = [];
  await page.route('**/api/crm/configuration', async route => {
    if (route.request().method() === 'PUT') {
      configuration = route.request().postDataJSON();
      writes.push(configuration);
    }
    await route.fulfill({ json: { success: true, data: configuration } });
  });
  await page.goto('/dashboard/crm/contacts');
  await expect(page.getByRole('heading', { name: 'Contacts', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'CRM Configuration', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/crm\/configuration$/);
  await expect(page.getByRole('heading', { name: 'Configure Lead Stages' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-configuration-stages-${test.info().project.name}.png`);

  await page.getByLabel('Stage name 2').fill('In Progress');
  await page.getByLabel('Color for In Progress').fill('#ec4899');
  await page.getByRole('switch', { name: 'Include Lost in flow' }).click();
  await page.getByRole('button', { name: 'Move Won up', exact: true }).click();
  await expect(page.getByLabel('Stage name 2')).toHaveValue('Won');
  await page.getByRole('button', { name: 'Add Stage', exact: true }).click();
  await page.getByLabel('Stage name 5').fill('Qualified');
  await page.getByLabel('Type for Qualified').selectOption('won');
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await page.getByLabel('Date Range', { exact: true }).selectOption('90d');
  await page.getByRole('checkbox', { name: 'Email', exact: true }).check();
  await page.getByRole('checkbox', { name: 'WhatsApp', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: /All Platforms/ })).not.toBeChecked();
  await page.getByLabel('Stuck Threshold', { exact: true }).fill('14');
  await page.getByLabel('Top Flows', { exact: true }).fill('8');
  await page.getByLabel('Min Flow Count', { exact: true }).fill('4');
  await page.getByRole('heading', { name: 'Pipeline Preferences', exact: true }).scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-configuration-preferences-${test.info().project.name}.png`);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review Configuration' })).toBeVisible();
  await expect(page.getByText('Excluded from flow', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/crm-configuration-review-${test.info().project.name}.png`);
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/crm\/contacts$/);
  expect(writes).toHaveLength(1);
  expect(writes[0].preferences).toEqual({ dateRange: '90d', platform: ['email', 'whatsapp'], stuckThreshold: 14, topFlows: 8, minFlowCount: 4 });
  expect(writes[0].stages.map(stage => stage.key).slice(0, 4)).toEqual(['new', 'won', 'contacted', 'lost']);
  expect(writes[0].stages[2]).toMatchObject({ label: 'In Progress', color: '#ec4899' });
  await expect(page.getByText('In Progress', { exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByRole('button', { name: 'CRM Configuration', exact: true }).click();
  await expect(page.getByLabel('Stage name 3')).toHaveValue('In Progress');
  await expect(page.getByRole('switch', { name: 'Include Lost in flow' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Email', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'WhatsApp', exact: true })).toBeChecked();
  expect(audit.consoleErrors).toEqual([]);
});

test('Load failures, invalid inputs and rejected saves retain a recoverable configuration draft', async ({ page }) => {
  let loadFails = true;
  let writes = 0;
  await page.route('**/api/crm/configuration', async route => {
    if (route.request().method() === 'PUT') {
      writes++;
      return route.fulfill({ status: 409, json: { error: 'Ongoing is used by contacts. Reassign them first.' } });
    }
    return route.fulfill({ status: loadFails ? 500 : 200, json: loadFails ? { error: 'Configuration temporarily unavailable.' } : { success: true, data: initialConfiguration() } });
  });
  await page.goto('/dashboard/crm/configuration');
  await expect(page.getByText('CRM configuration could not be loaded')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).not.toBeVisible();
  loadFails = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByRole('button', { name: 'Add Stage', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Stage 5 needs a name of 1 to 80 characters.')).toBeVisible();
  await page.getByLabel('Stage name 5').fill('Qualified');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByLabel('Min Flow Count', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText('Minimum flow count must be a whole number from 1 to 1,000.')).toBeVisible();
  await page.getByLabel('Min Flow Count', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await expect(page.getByText('Configuration was not saved')).toBeVisible();
  await expect(page.getByText('Qualified', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Edit stages', exact: true }).click();
  await expect(page.getByLabel('Stage name 5')).toHaveValue('Qualified');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/crm\/contacts$/);
  expect(writes).toBe(1);
});

test('Stage order can be changed with the keyboard and by dragging while the entry stage remains first', async ({ page, audit }) => {
  await page.route('**/api/crm/configuration', route => route.fulfill({ json: { success: true, data: initialConfiguration() } }));
  await page.goto('/dashboard/crm/configuration');
  await expect(page.getByRole('heading', { name: 'Configure Lead Stages' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reorder Not Categorized' })).toBeDisabled();
  await waitForCrmEntranceAnimations(page);
  const handle = page.getByRole('button', { name: 'Reorder Ongoing', exact: true });
  await handle.focus();
  await handle.press('Space');
  await expect(handle).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
  await handle.press('ArrowDown');
  await expect(page.locator('[data-stage-key="contacted"]')).toHaveAttribute('style', /translate3d\(0px, [1-9]/, { timeout: 15_000 });
  const dragOverAnnouncement = page.getByText('Draggable item contacted was moved over droppable area won.', { exact: true });
  await expect(dragOverAnnouncement).toBeAttached({ timeout: 15_000 });
  await handle.press('Space');
  await expect(page.getByLabel('Stage name 1')).toHaveValue('Not Categorized');
  await expect(page.getByLabel('Stage name 2')).toHaveValue('Won', { timeout: 15_000 });
  const target = page.getByRole('button', { name: 'Reorder Won', exact: true });
  await target.scrollIntoViewIfNeeded();
  await handle.scrollIntoViewIfNeeded();
  const sourceBox = await handle.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 10 });
  await expect(dragOverAnnouncement).toBeAttached({ timeout: 15_000 });
  await page.mouse.up();
  await expect(page.getByLabel('Stage name 1')).toHaveValue('Not Categorized');
  await expect(page.getByLabel('Stage name 2')).toHaveValue('Ongoing', { timeout: 15_000 });
  expect(audit.consoleErrors).toEqual([]);
});
