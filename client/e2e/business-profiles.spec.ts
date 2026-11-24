import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import type { Page } from '@playwright/test';
import { setupScreenshot } from './fixtures/setup-screenshots';

async function businessFixture(page: Page) {
  const drafts = new Map<string, { data: unknown; revision: number; step: number; updatedAt: string }>();
  const profiles = [
    {id:11,name:'North Studio',companyName:'North Studio',isDefault:true,isApproved:true,role:'owner',canManageTeam:true,canManageBilling:true},
    {id:22,name:'South Works',companyName:'South Works',isDefault:false,isApproved:true,role:'owner',canManageTeam:true,canManageBilling:true},
  ];
  const scopedRequests: Array<{path:string;business:string|undefined;organization?:string}> = [];
  await page.route('**/api/**', async route => {
    const request=route.request(), path=new URL(request.url()).pathname;
    const reply=(json:unknown)=>route.fulfill({json});
    if (path.startsWith('/api/setup/drafts/')) {
      if (request.method() === 'DELETE') { drafts.delete(path); return reply({ draft: null }); }
      if (request.method() === 'PUT') { const body = request.postDataJSON(); drafts.set(path, { data: body.data, step: body.step, revision: (drafts.get(path)?.revision || 0) + 1, updatedAt: new Date().toISOString() }); }
      return reply({ draft: drafts.get(path) || null });
    }
    if (path === '/api/setup/website-analysis/jobs/latest') return reply({ job: null });
    if (path === '/api/setup/onboarding-status') return reply({ profile: {}, completedTasks: [], connectedChannels: [], connectionsAvailable: false });
    if (path==='/api/organizations') return reply({
      organizations:[{id:91,businessProfileId:Number(request.headers()['x-business-profile-id']) || 11,name:'Regression business',ownerUserId:4101,defaultForUserId:4101,role:'owner',canManageBilling:true}],
      invitations:[],selectedOrganizationId:91,
    });
    if (path==='/api/settings/business-profiles/invitations') return reply({invitations:[]});
    if (path==='/api/settings/business-profiles') {
      if(request.method()==='POST') {
        scopedRequests.push({path,business:request.headers()['x-business-profile-id'],organization:request.headers()['x-billing-organization-id']});
        const body=request.postDataJSON(); const profile={...body,id:33,isDefault:false,role:'owner',canManageTeam:true,canManageBilling:true}; profiles.push(profile); return reply(profile);
      }
      return reply(profiles);
    }
    if (/^\/api\/settings\/business-profiles\/\d+$/.test(path)) return reply(profiles.find(p=>p.id===Number(path.split('/').at(-1))));
    if (['/api/auth/me','/api/platform/access','/api/settings/preferences','/api/wallet','/api/notifications/unread/count'].includes(path)) return route.fallback();
    if (path==='/api/chat/threads') {
      const business=request.headers()['x-business-profile-id'];
      scopedRequests.push({path,business});
      return reply({threads:[{id:business==='22'?202:101,title:business==='22'?'South campaign':'North campaign',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}],total:1});
    }
    if (path==='/api/dashboard/stats') return reply({totalLeads:0,totalCampaigns:0,totalMessages:0,totalConversions:0,totalCredits:1000});
    if (path.includes('suggestions')) return reply({suggestions:[]});
    if (path.includes('business-categories')) return reply([]);
    if (path==='/api/content/brand-toolkits') {
      if (request.method()==='POST') { scopedRequests.push({path,business:request.headers()['x-business-profile-id']}); return reply({id:44,...request.postDataJSON()}); }
      return reply([]);
    }
    if (path==='/api/setup/analyze-website') {
      scopedRequests.push({ path, business:request.headers()['x-business-profile-id'] });
      return reply({ success:true, data:{ companyName:'West Labs', description:'Independent business' }, kbEntryId:303 });
    }
    return reply([]);
  });
  return scopedRequests;
}

test('opens the full-page workspace chooser from the sidebar and keeps navigation scoped', async ({ page, audit }, testInfo) => {
  const requests=await businessFixture(page);
  await page.goto('/dashboard/select-profile');
  await expect(page.getByRole('heading',{name:'Select business profile'})).toBeVisible();
  await setupScreenshot(page, testInfo, '27-profile-selection');
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button',{name:/South Works/}).click();
  await expect(page).toHaveURL(/\/dashboard\/home$/);
  const header=page.locator('header');
  const sidebar=page.locator('aside[data-sidebar-state]');
  await expect(header.getByRole('button',{name:/Switch business profile/})).toHaveCount(0);
  await expect(header.getByRole('link',{name:'Available credits: 10,000'})).toBeVisible();
  await expect(header.getByRole('button',{name:'Account menu'})).toBeVisible();
  await expect(header.getByText('Regression Alpha')).toHaveCount(0);
  await setupScreenshot(page, testInfo, '28-dashboard-header');
  if (testInfo.project.name==='mobile-chromium') await page.getByRole('button',{name:'Show sidebar'}).click();
  await expect.poll(async () => sidebar.evaluate(element => {
    const box=element.getBoundingClientRect();
    return box.top===0 && Math.abs(box.height-window.innerHeight)<1;
  })).toBe(true);
  if (testInfo.project.name==='desktop-chromium') {
    await expect.poll(async () => header.evaluate(element => Math.round(element.getBoundingClientRect().left))).toBe(256);
    const searchWidth=await header.getByRole('button',{name:/Find a page/}).evaluate(element => element.getBoundingClientRect().width);
    expect(searchWidth).toBeLessThanOrEqual(300);
  }
  await expect.poll(()=>requests.some(r=>r.business==='22')).toBe(true);
  await expect(page.getByText('North campaign',{exact:true})).toHaveCount(0);
  await sidebar.getByRole('button',{name:'Switch business profile. Current: South Works'}).click();
  const chooser=page.getByRole('dialog',{name:'Choose a business profile'});
  await expect(chooser).toBeVisible();
  await setupScreenshot(page, testInfo, '29-sidebar-workspace-chooser');
  await expect.poll(async () => chooser.evaluate(element => {
    const box=element.getBoundingClientRect();
    return box.top===0 && box.left===0 && Math.abs(box.width-window.innerWidth)<1 && Math.abs(box.height-window.innerHeight)<1;
  })).toBe(true);
  await expect(chooser.getByRole('button',{name:'Edit South Works'})).toBeVisible();
  await expect(chooser.getByRole('button',{name:'Add business profile'})).toBeVisible();
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    chooser.getByRole('button',{name:'Open North Studio business profile'}).click(),
  ]);
  await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem('active-business-profile:4101'))).toBe('11');
  await expect(page.getByText('South campaign',{exact:true})).toHaveCount(0);
  if (testInfo.project.name==='mobile-chromium') await page.getByRole('button',{name:'Show sidebar'}).click();
  await sidebar.getByRole('button',{name:'Switch business profile. Current: North Studio'}).click();
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.getByRole('dialog',{name:'Choose a business profile'}).getByRole('button',{name:'Open South Works business profile'}).click(),
  ]);
  await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem('active-business-profile:4101'))).toBe('22');
  await expectNoHorizontalOverflow(page);
  expect(audit.consoleErrors).toEqual([]);
  await setupScreenshot(page, testInfo, '30-switched-workspace');
});

test('creates another business through onboarding and opens its workspace', async ({ page, audit }, testInfo) => {
  const requests = await businessFixture(page);
  await page.goto('/dashboard/select-profile');
  await page.getByRole('link',{name:'Add business profile'}).click();
  await expect(page).toHaveURL(/\/setup\/business-profile\/new$/);
  await expect(page.getByRole('heading',{name:'Start with your website'})).toBeVisible();
  await page.getByRole('button',{name:'Enter details manually'}).click();
  await page.getByRole('button',{name:'Business / Organization',exact:true}).click();
  await page.getByLabel('Workspace name *').fill('West Labs');
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByLabel('Short description *').fill('We make independent products for creators.');
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Sales & leads',exact:true}).click();
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Create workspace',exact:true}).click();
  await expect(page).toHaveURL(/\/setup\/brand-toolkit\/33$/);
  await expect(page.getByLabel('Brand name *')).toHaveValue('West Labs');
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Professional',exact:true}).click();
  for (let step=2; step<7; step++) await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Finish setup',exact:true}).click();
  await expect(page).toHaveURL(/\/dashboard\/home$/);
  await expect.poll(()=>requests.some(r=>r.path==='/api/settings/business-profiles' && r.organization===undefined)).toBe(true);
  expect(requests.some(r=>r.path==='/api/setup/analyze-website')).toBe(false);
  if (testInfo.project.name==='mobile-chromium') await page.getByRole('button',{name:'Show sidebar'}).click();
  await expect(page.locator('aside[data-sidebar-state]').getByRole('button',{name:'Switch business profile. Current: West Labs'})).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/home$/);
  expect(await page.evaluate(()=>sessionStorage.getItem('active-business-profile:4101'))).toBe('33');
  await expectNoHorizontalOverflow(page);
  expect(audit.consoleErrors).toEqual([]);
});
