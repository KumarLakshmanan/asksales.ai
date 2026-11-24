import { expect, expectNoHorizontalOverflow, test } from './fixtures/app';
import type { Page } from '@playwright/test';
import { setupScreenshot } from './fixtures/setup-screenshots';

type Profile = { id: number; name: string; companyName: string; isDefault: boolean; role: 'owner' | 'member'; canManageTeam?: boolean; archivedAt?: string };

async function mockProfiles(page: Page, profiles: Profile[], onDelete?: (id: number) => { status: number; body: unknown }) {
  const drafts = new Map<string, { data: unknown; revision: number; step: number; updatedAt: string }>();
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path.startsWith('/api/setup/drafts/')) {
      if (request.method() === 'DELETE') { drafts.delete(path); return json({ draft: null }); }
      if (request.method() === 'PUT') { const body = request.postDataJSON(); drafts.set(path, { data: body.data, step: body.step, revision: (drafts.get(path)?.revision || 0) + 1, updatedAt: new Date().toISOString() }); }
      return json({ draft: drafts.get(path) || null });
    }
    if (path === '/api/setup/website-analysis/jobs/latest') return json({ job: null });
    if (path === '/api/setup/onboarding-status') return json({ profile: {}, completedTasks: [], connectedChannels: [], connectionsAvailable: false });
    if (path === '/api/settings/business-profiles') return json(new URL(request.url()).searchParams.get('includeArchived') === '1' ? profiles : profiles.filter(profile => !profile.archivedAt));
    if (path === '/api/settings/business-profiles/22/default') {
      profiles.forEach(profile => { profile.isDefault = profile.id === 22; });
      return json({ success: true });
    }
    if (/^\/api\/settings\/business-profiles\/\d+$/.test(path)) {
      const id = Number(path.split('/').at(-1));
      if (request.method() === 'DELETE' && onDelete) {
        const result = onDelete(id);
        return json(result.body, result.status);
      }
      return json(profiles.find(profile => profile.id === id));
    }
    if (path === '/api/organizations') return json({ organizations: [{ id: 91, businessProfileId: 11, name: 'North Studio', ownerUserId: 4101, defaultForUserId: 4101, role: 'owner', canManageBilling: true }], invitations: [], selectedOrganizationId: 91 });
    if (['/api/auth/me', '/api/platform/access', '/api/settings/preferences', '/api/wallet', '/api/notifications/unread/count'].includes(path)) return route.fallback();
    if (path === '/api/chat/threads') return json({ threads: [], total: 0 });
    return json([]);
  });
}

const initialProfiles = (): Profile[] => [
  { id: 11, name: 'North Studio', companyName: 'North Studio', isDefault: true, role: 'owner', canManageTeam: true },
  { id: 22, name: 'South Works', companyName: 'South Works', isDefault: false, role: 'owner', canManageTeam: true },
  { id: 33, name: 'Shared Team', companyName: 'Shared Team', isDefault: false, role: 'member', canManageTeam: false },
];

test('old Business Profile page opens the sidebar chooser', async ({ page }, testInfo) => {
  await mockProfiles(page, initialProfiles());
  await page.goto('/dashboard/settings/company');
  await expect(page).toHaveURL(/\/dashboard\/home$/);
  const chooser = page.getByRole('dialog', { name: 'Choose a business profile' });
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole('button', { name: 'Add business profile' })).toBeVisible();
  await expect(chooser.getByRole('button', { name: 'Edit North Studio' })).toBeVisible();
  await expect(chooser.getByRole('button', { name: 'Manage staff' })).toBeVisible();
  await expect(chooser.getByRole('button', { name: 'Your invitations' })).toBeVisible();
  await expect(chooser.getByTestId('business-profile-33').getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expect(chooser.getByTestId('business-profile-33').getByRole('button', { name: 'Edit Shared Team' })).toHaveCount(0);
  await setupScreenshot(page, testInfo, '36-owner-member-workspace-chooser');
  await chooser.getByRole('button', { name: 'Close business chooser' }).click();
  if (testInfo.project.name === 'mobile-chromium') await page.getByRole('button', { name: 'Show sidebar' }).click();
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(navigation.getByText('Business Profile', { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test('saved add links open onboarding while edit links open the profile form', async ({ page }) => {
  await mockProfiles(page, initialProfiles());
  await page.goto('/dashboard/settings/company/new');
  await expect(page).toHaveURL(/\/setup\/business-profile\/new$/);
  await expect(page.getByRole('heading', { name: 'Start with your website' })).toBeVisible();
  await page.goto('/dashboard/business-profiles/new');
  await expect(page).toHaveURL(/\/setup\/business-profile\/new$/);
  await page.goto('/dashboard/settings/company/11');
  await expect(page).toHaveURL(/\/dashboard\/business-profiles\/11$/);
  await expect(page.getByRole('heading', { name: 'Business Profile', exact: true })).toBeVisible();
  await page.goto('/dashboard/business-profiles');
  await expect(page).toHaveURL(/\/dashboard\/home$/);
  await expect(page.getByRole('dialog', { name: 'Choose a business profile' })).toBeVisible();
});

test('the chooser retains default and delete actions for owners', async ({ page }, testInfo) => {
  const profiles = initialProfiles();
  let deleteAttempts = 0;
  await mockProfiles(page, profiles, id => {
    deleteAttempts += 1;
    if (deleteAttempts === 1) return { status: 409, body: { error: 'This business still contains records.' } };
    profiles.splice(profiles.findIndex(profile => profile.id === id), 1);
    return { status: 200, body: { success: true } };
  });
  await page.goto('/dashboard/settings/company');
  const chooser = page.getByRole('dialog', { name: 'Choose a business profile' });
  await chooser.getByTestId('business-profile-22').getByRole('button', { name: 'Make default' }).click();
  await expect(chooser.getByTestId('business-profile-22')).toContainText('Default');
  await chooser.getByTestId('business-profile-11').getByRole('button', { name: 'Delete' }).click();
  const confirmation = chooser.getByRole('group', { name: 'Delete North Studio' });
  await confirmation.getByRole('button', { name: 'Delete profile' }).click();
  await expect(chooser.getByRole('alert')).toContainText('This business still contains records.');
  await expect(chooser.getByTestId('business-profile-11')).toBeVisible();
  await Promise.all([page.waitForEvent('domcontentloaded'), confirmation.getByRole('button', { name: 'Delete profile' }).click()]);
  await expect(page).toHaveURL(/\/dashboard\/home$/);
  await expect.poll(async () => {
    try { return await page.evaluate(() => sessionStorage.getItem('active-business-profile:4101')); }
    catch { return null; }
  }).toBe('22');
  if (testInfo.project.name === 'mobile-chromium') await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Switch business profile. Current: South Works' })).toBeVisible();
});

test('deleting the last profile returns to business setup', async ({ page }) => {
  const profiles = [initialProfiles()[0]];
  await mockProfiles(page, profiles, id => {
    profiles.splice(profiles.findIndex(profile => profile.id === id), 1);
    return { status: 200, body: { success: true } };
  });
  await page.goto('/dashboard/settings/company');
  const chooser = page.getByRole('dialog', { name: 'Choose a business profile' });
  await chooser.getByTestId('business-profile-11').getByRole('button', { name: 'Delete' }).click();
  await chooser.getByRole('group', { name: 'Delete North Studio' }).getByRole('button', { name: 'Delete profile' }).click();
  await expect(page).toHaveURL(/\/setup\/business-profile$/);
  await expect(page.getByRole('heading', { name: 'Start with your website' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('active-business-profile:4101'))).toBeNull();
});

test('deleting another active or archived profile updates the open chooser immediately', async ({ page }) => {
  const profiles = [...initialProfiles(), {id:44,name:'Archived Studio',companyName:'Archived Studio',role:'owner' as const,isDefault:false,archivedAt:'2026-10-01'}];
  await mockProfiles(page, profiles, id => {
    profiles.splice(profiles.findIndex(profile => profile.id === id),1);
    return {status:200,body:{success:true}};
  });
  await page.goto('/dashboard/settings/company');
  const chooser = page.getByRole('dialog', {name:'Choose a business profile'});
  await chooser.getByTestId('business-profile-22').getByRole('button', {name:'Delete'}).click();
  await chooser.getByRole('group', {name:'Delete South Works'}).getByRole('button', {name:'Delete profile'}).click();
  await expect(chooser.getByTestId('business-profile-22')).toHaveCount(0);
  await chooser.getByLabel('Show archived').check();
  await chooser.getByRole('button', {name:'Favorite Archived Studio'}).click();
  await chooser.getByTestId('business-profile-44').getByRole('button', {name:'Delete'}).click();
  await chooser.getByRole('group', {name:'Delete Archived Studio'}).getByRole('button', {name:'Delete profile'}).click();
  await expect(chooser.getByTestId('business-profile-44')).toHaveCount(0);
  await expect(chooser.getByTestId('business-profile-11')).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('active-business-profile:4101'))).toBe('11');
  await expectNoHorizontalOverflow(page);
});
