import { test, expect } from '@playwright/test';
import { installAppShellMocks, expectNoHorizontalOverflow } from './fixtures/app';
const fixture='http://127.0.0.1:4319';
async function shell(page: import('@playwright/test').Page) {
  await page.context().addCookies([{name:'asksales_session',value:'fixture-session',domain:'127.0.0.1',path:'/',httpOnly:true,secure:false,sameSite:'Lax'}]);
  await page.addInitScript(()=>{
    localStorage.setItem('token','fixture-token');localStorage.setItem('user',JSON.stringify({id:9,email:'notification@example.test',name:'Notification Fixture'}));
    sessionStorage.setItem('active-business-profile:9','101');
  });
  await page.route('**/api/**',async route=>{
    if(new URL(route.request().url()).pathname.startsWith('/api/notifications') || new URL(route.request().url()).pathname==='/api/settings/profile/notification-preferences') return route.continue();
    return route.fulfill({json:{}});
  });
  await installAppShellMocks(page);
  await page.unroute('**/api/notifications/unread/count');
  await page.route('**/api/auth/me',route=>route.fulfill({json:{user:{id:9,email:'notification@example.test',name:'Notification Fixture',isSetupComplete:true,isApproved:true,hasBusinessProfile:true,hasBrandToolkit:true}}}));
  await page.route('**/api/settings/business-profiles',route=>route.fulfill({json:[{id:101,userId:9,name:'Notification Fixture',companyName:'Notification Fixture',isDefault:true,role:'owner'}]}));
}
test.beforeEach(async({request})=>{expect((await request.post(`${fixture}/__fixture/reset`)).ok()).toBe(true);});
test('normal-zoom widths, cursor loading, keyboard filters, delete cancel, failure/retry and reload',async({page})=>{
  await shell(page);await page.goto('/dashboard/notifications');
  await expect(page.getByRole('heading',{name:'Notifications',exact:true})).toBeVisible();
  await expect(page.getByRole('tab',{name:'All (45)',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Hide sidebar',exact:true}).click();
  for(const width of [320,390,768,1440]) {
    await page.setViewportSize({width,height:900});
    await expectNoHorizontalOverflow(page);
    await page.screenshot({path:`qa/notifications-audit/second-pass-fixes/evidence/browser-${width}.png`,fullPage:true});
    const title=page.getByText(/^Notice 45 L/,{exact:false});
    expect(await title.evaluate(element=>element.scrollWidth<=element.clientWidth+1 && element.getBoundingClientRect().right<=window.innerWidth)).toBe(true);
  }
  await page.getByRole('tab',{name:'All (45)',exact:true}).focus();await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab',{name:'Unread (45)',exact:true})).toHaveAttribute('aria-selected','true');
  await page.getByRole('button',{name:/Load more/}).click();
  await expect(page.getByText('Notice 6',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Delete Notice 6',exact:true}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByText('Notice 6',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Delete Notice 6',exact:true}).click();await page.getByRole('button',{name:'Delete',exact:true}).click();
  await expect(page.getByRole('tab',{name:'Unread (44)',exact:true})).toBeVisible();
  await expect(page.getByRole('tab',{name:'All (44)',exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('tab',{name:'All (44)',exact:true})).toBeVisible();
  let failed=false;
  await page.route('**/api/notifications?*',async route=>{if(!failed){failed=true;return route.fulfill({status:503,json:{error:'Synthetic failure'}});}return route.continue();});
  await page.getByRole('tab',{name:'Info',exact:true}).click();await page.getByRole('button',{name:'Try again'}).click();
  await expect(page.getByText('Notice 43',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Open Notice 43',exact:true}).click();await expect(page).toHaveURL(/\/dashboard\/leads$/);
});
test('two tabs receive real EventBus delivery, synchronize mutations and recover after socket reconnect',async({page,context,request})=>{
  await shell(page);await page.goto('/dashboard/notifications');await expect(page.getByRole('tab',{name:'All (45)',exact:true})).toBeVisible();
  const second=await context.newPage();await shell(second);await second.goto('/dashboard/notifications');await expect(second.getByRole('tab',{name:'All (45)',exact:true})).toBeVisible();
  await request.post(`${fixture}/__fixture/notify`,{data:{title:'Live two-tab notice'}});
  await expect(page.getByText('Live two-tab notice',{exact:true})).toBeVisible();await expect(second.getByText('Live two-tab notice',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Mark Live two-tab notice as read',exact:true}).click();
  await expect(second.getByRole('tab',{name:'Unread (45)',exact:true})).toBeVisible();
  await page.close();await request.post(`${fixture}/__fixture/notify`,{data:{title:'Remaining tab notice'}});
  await expect(second.getByText('Remaining tab notice',{exact:true})).toBeVisible();
  await context.setOffline(true);await context.setOffline(false);await second.reload();
  await expect(second.getByText('Remaining tab notice',{exact:true})).toBeVisible();
  await request.post(`${fixture}/__fixture/access`,{data:{allowed:false}});
  await request.post(`${fixture}/__fixture/notify`,{data:{title:'Revoked delivery'}});
  await second.reload();await expect(second.getByText('Revoked delivery',{exact:true})).not.toBeVisible();
  await expect(second.getByRole('heading',{name:'Notifications unavailable'})).toBeVisible();
});


test('stale settings tabs save changed notification fields only and preserve failed drafts',async({page,context,request})=>{
  await shell(page);await page.goto('/dashboard/settings?tab=notifications');
  const second=await context.newPage();await shell(second);await second.goto('/dashboard/settings?tab=notifications');
  for(const tab of [page,second]) {
    await expect(tab.getByRole('switch',{name:'Lead Alerts',exact:true})).toBeChecked();
    await expect(tab.getByRole('switch',{name:'Campaign Status',exact:true})).toBeChecked();
  }
  const firstSave=page.waitForResponse(response=>response.url().endsWith('/api/settings/profile/notification-preferences')&&response.request().method()==='PUT');
  await page.getByRole('switch',{name:'Lead Alerts',exact:true}).click();
  await page.getByRole('button',{name:'Save',exact:true}).click();expect((await firstSave).status()).toBe(200);
  // The second tab retains its original lead switch; only its campaign change is intended.
  await expect(second.getByRole('switch',{name:'Lead Alerts',exact:true})).toBeChecked();
  await second.getByRole('switch',{name:'Campaign Status',exact:true}).click();
  let reject=true;
  await second.route('**/api/settings/profile/notification-preferences',async route=>{
    if(route.request().method()==='PUT'&&reject){reject=false;return route.fulfill({status:503,json:{error:'Synthetic preference failure'}});}
    return route.continue();
  });
  const failed=second.waitForResponse(response=>response.url().endsWith('/api/settings/profile/notification-preferences')&&response.request().method()==='PUT');
  await second.getByRole('button',{name:'Save',exact:true}).click();expect((await failed).status()).toBe(503);
  await expect(second.getByRole('switch',{name:'Campaign Status',exact:true})).not.toBeChecked();
  const retry=second.waitForResponse(response=>response.url().endsWith('/api/settings/profile/notification-preferences')&&response.request().method()==='PUT');
  await second.getByRole('button',{name:'Save',exact:true}).click();const saved=await retry;expect(saved.status()).toBe(200);
  const stored=await (await request.get(`${fixture}/api/settings/profile/notification-preferences`)).json();
  expect(stored).toMatchObject({leadAlerts:false,campaignUpdates:false,emailNotifications:true,weeklyReports:false});
  expect(saved.request().postDataJSON()).toEqual({campaignUpdates:false});
  await expect(second.getByRole('switch',{name:'Lead Alerts',exact:true})).not.toBeChecked();
  await expect(second.getByRole('button',{name:'Save',exact:true})).toBeDisabled();
  await second.reload();await expect(second.getByRole('switch',{name:'Lead Alerts',exact:true})).not.toBeChecked();
  await expect(second.getByRole('switch',{name:'Campaign Status',exact:true})).not.toBeChecked();
});
