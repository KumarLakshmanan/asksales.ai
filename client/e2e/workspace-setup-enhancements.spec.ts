import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { onboardingFixture } from './fixtures/workspace-setup';
import { setupScreenshot } from './fixtures/setup-screenshots';

test('recovers an unfinished setup when its workspace is unavailable', async ({ page }, info) => {
  const fixture = await onboardingFixture(page);
  fixture.drafts.set('workspace:new', { data: { profileId: 999, phase: 'profile', data: { name: 'Archived project' }, step: 2 }, step: 2, revision: 2, updatedAt: new Date().toISOString() });
  await page.route('**/api/settings/business-profiles/999', route => route.fulfill({ status: 404, json: { error: 'This workspace is unavailable.' } }));
  await page.goto('/setup/business-profile/new');
  await expect(page.getByRole('heading', { name: 'We couldn’t load your saved profile' })).toBeVisible();
  await setupScreenshot(page, info, '43-unavailable-workspace-draft-recovery');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Discard unfinished setup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Start with your website' })).toBeVisible();
  expect(fixture.requests.filter(request => request.path === '/api/settings/business-profiles' && request.method === 'POST')).toHaveLength(0);
});

test('resumes an account draft after browser storage is cleared and makes essentials editable', async ({ page }, info) => {
  const fixture = await onboardingFixture(page);
  fixture.drafts.set('workspace:new', { data: { profileId: 26, phase: 'profile', step: 3, data: { workspaceType: 'creator', name: 'Northstar Studio', country: 'India', timezone: 'Asia/Kolkata', companySize: '', description: 'We help small brands grow.', industry: 'Education', website: '', customerType: '', targetRegions: [], email: '', phone: '', applicationUses: ['content_social'], setupGoal: 'Make one useful post', currentTools: '', preferredChannels: [] }, requestKey: 'qa-draft-resume-key' }, step: 3, revision: 4, updatedAt: new Date().toISOString() });
  await page.goto('/setup/business-profile/new');
  await expect(page.getByRole('heading', { name: 'What will you use AskSales for?' })).toBeVisible();
  await expect(page.getByLabel('First goal (optional)')).toHaveValue('Make one useful post');
  await page.getByLabel('First goal (optional)').fill('Share a weekly tutorial');
  await expect.poll(() => (fixture.drafts.get('workspace:new')?.data as { data?: { setupGoal?: string } })?.data?.setupGoal).toBe('Share a weekly tutorial');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.getByLabel('First goal (optional)')).toHaveValue('Share a weekly tutorial');
  await setupScreenshot(page, info, '37-account-draft-resume');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Skip for now', exact: true }).click();
  await expect(page).toHaveURL(/\/setup\/brand-toolkit\/26$/);
  await expect(page.getByLabel(/brand name \*/i)).toBeEnabled();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Friendly', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Review essentials', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review your toolkit' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit voice', exact: true }).click();
  await page.getByRole('button', { name: 'Professional', exact: true }).click();
  await page.getByRole('button', { name: 'Back to review', exact: true }).click();
  await page.getByRole('button', { name: 'Email', exact: true }).click();
  await expectNoHorizontalOverflow(page);
  await setupScreenshot(page, info, '38-essential-review-email-preview');
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/home$/);
  expect(fixture.drafts.has('workspace:new')).toBe(false);
  const toolkitSave = fixture.requests.find(request => request.path === '/api/content/brand-toolkits' && request.method === 'POST');
  const savedDraft = fixture.requests.find(request => request.path.includes('/api/setup/drafts/brand%3A26') && request.method === 'PUT');
  expect(toolkitSave?.body?.idempotencyKey).toBe((savedDraft?.body?.data as { setupRequestKey?: string })?.setupRequestKey);
  expect(toolkitSave?.body?.idempotencyKey).toBeTruthy();
  await setupScreenshot(page, info, '39-dashboard-next-steps');
});

test('reanalysis preserves current details until the reviewed changes are applied', async ({ page }, info) => {
  await onboardingFixture(page);
  await page.goto('/setup/business-profile/new');
  await page.getByLabel('Website URL').fill('https://creator.example');
  await page.getByRole('button', { name: 'Analyze website', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your website results' })).toBeVisible();
  await page.route('**/api/setup/website-analysis/jobs', route => route.fulfill({ json: { job: { id: 'fresh-reviewed-job', url: 'https://creator.example', status: 'completed', stage: 'complete', updatedAt: new Date().toISOString(), result: { data: { companyName: 'Creator Academy', description: 'New tutorials for a growing community.' }, analysisSummary: { pages: 2, knowledgeSaved: false, warnings: [] } } } } }));
  await page.getByRole('button', { name: 'Analyze again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review the refreshed details' })).toBeVisible();
  await expect(page.getByText('Creator Studio', { exact: true })).toBeVisible();
  await setupScreenshot(page, info, '40-review-reanalysis-changes');
  await page.getByRole('button', { name: 'Apply refreshed details', exact: true }).click();
  await page.getByRole('button', { name: 'Review extracted details', exact: true }).click();
  await expect(page.getByLabel('Workspace name *')).toHaveValue('Creator Academy');
});

test('searches, favorites, archives and restores a business with its records retained', async ({ page }, info) => {
  const fixture = await onboardingFixture(page, { profiles: [
    { id: 26, name: 'Northstar Studio', companyName: 'Northstar Studio', role: 'owner', isDefault: true, description: 'We help brands grow.', workspaceType: 'business', applicationUses: ['content_social'], version: 1, brandToolkitCompleted: true },
    { id: 42, name: 'Creator Academy', companyName: 'Creator Academy', role: 'owner', isDefault: false, description: 'Practical tutorials.', workspaceType: 'creator', version: 1, brandToolkitCompleted: false },
  ] });
  await page.goto('/dashboard/home?workspace=choose');
  await expect(page.getByRole('heading', { name: 'Choose a business profile' })).toBeVisible();
  await page.getByRole('button', { name: 'Favorite Creator Academy', exact: true }).click();
  await page.getByLabel('Search business profiles').fill('academy');
  await expect(page.getByRole('button', { name: 'Open Northstar Studio business profile', exact: true })).toHaveCount(0);
  await page.getByLabel('Sort business profiles').selectOption('name');
  await setupScreenshot(page, info, '41-search-business-profiles');
  await page.getByTestId('business-profile-42').getByRole('button', { name: 'Archive', exact: true }).click();
  await page.getByRole('button', { name: 'Archive profile', exact: true }).click();
  await expect.poll(() => fixture.profiles[1].archivedAt).toBeTruthy();
  await page.getByLabel('Show archived', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
  await setupScreenshot(page, info, '42-archived-business-profile');
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect.poll(() => fixture.profiles[1].archivedAt).toBeNull();
  await expectNoHorizontalOverflow(page);
});
