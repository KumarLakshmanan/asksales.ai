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
test('same-window and other-tab bell counts converge after read delete and read-all',async({page,context})=>{
  await shell(page);await page.goto('/dashboard/notifications');await expect(page.getByRole('button',{name:'Notifications (45 unread)',exact:true})).toBeVisible();
  const other=await context.newPage();await shell(other);await other.goto('/dashboard/notifications');await expect(other.getByRole('button',{name:'Notifications (45 unread)',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Mark Notice 44 as read',exact:true}).click();
  for(const p of [page,other]){await expect(p.getByRole('tab',{name:'Unread (44)',exact:true})).toBeVisible();await expect(p.getByRole('button',{name:'Notifications (44 unread)',exact:true})).toBeVisible();}
  await page.getByRole('button',{name:'Delete Notice 43',exact:true}).click();await page.getByRole('button',{name:'Delete',exact:true}).click();
  for(const p of [page,other]){await expect(p.getByRole('tab',{name:'All (44)',exact:true})).toBeVisible();await expect(p.getByRole('button',{name:'Notifications (43 unread)',exact:true})).toBeVisible();}
  await page.getByRole('button',{name:'Mark all notifications as read',exact:true}).click();for(const p of [page,other])await expect(p.getByRole('button',{name:'Notifications',exact:true})).toBeVisible();
});

test('bell distinguishes loading failed and successfully empty reads and retries',async({page})=>{
  await shell(page);let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let fail=true;
  await page.route('**/api/notifications?limit=5',async r=>{if(fail){await gate;return r.fulfill({status:503,json:{error:'Synthetic outage'}});}return r.continue();});
  await page.goto('/dashboard/notifications');await page.getByRole('button',{name:'Notifications (45 unread)',exact:true}).click();
  await expect(page.getByText('Loading notifications…',{exact:true})).toBeVisible();await expect(page.getByText('No new notifications',{exact:true})).toHaveCount(0);release();
  await expect(page.getByText('Notifications unavailable.',{exact:true})).toBeVisible();await expect(page.getByText('No new notifications',{exact:true})).toHaveCount(0);
  fail=false;await page.getByRole('button',{name:'Retry notifications',exact:true}).click();await expect(page.locator('[data-radix-popper-content-wrapper]').getByText('Notice 44',{exact:true})).toBeVisible();
  await expect(page.getByText('Notifications unavailable.',{exact:true})).toHaveCount(0);
});
test('bell labels cached rows stale on actual403 and recovers when fixture authority returns',async({page,request})=>{
  await shell(page);await page.goto('/dashboard/notifications');await page.getByRole('button',{name:'Notifications (45 unread)',exact:true}).click();
  await expect(page.locator('[data-radix-popper-content-wrapper]').getByText('Notice 44',{exact:true})).toBeVisible();await page.keyboard.press('Escape');
  await request.post(`${fixture}/__fixture/permission`,{data:{allowed:false}});const denied=page.waitForResponse(r=>r.url().endsWith('/api/notifications?limit=5')&&r.status()===403);
  await page.getByRole('button',{name:'Notifications (45 unread)',exact:true}).click();await denied;
  await expect(page.getByText('Notifications could not be refreshed. Showing stale notifications.',{exact:true})).toBeVisible();await expect(page.locator('[data-radix-popper-content-wrapper]').getByText('Notice 44',{exact:true})).toBeVisible();
  await request.post(`${fixture}/__fixture/permission`,{data:{allowed:true}});await page.getByRole('button',{name:'Retry notifications',exact:true}).click();
  await expect(page.getByText('Notifications could not be refreshed. Showing stale notifications.',{exact:true})).toHaveCount(0);await expect(page.locator('[data-radix-popper-content-wrapper]').getByText('Notice 44',{exact:true})).toBeVisible();
});

test('bell rows support Tab Enter Space Escape and normal-zoom responsive widths',async({page,request})=>{
  await shell(page);await page.goto('/dashboard/notifications');await page.getByRole('button',{name:'Hide sidebar',exact:true}).click();
  const bell=page.getByRole('button',{name:'Notifications (45 unread)',exact:true});await bell.focus();await page.keyboard.press('Space');
  await expect(page.getByRole('button',{name:'Notification: Notice 44 (unread)',exact:true})).toBeVisible();
  for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:900});await expectNoHorizontalOverflow(page);const bounds=await page.getByRole('button',{name:/^Notification: Notice 45 L/}).evaluate(e=>({right:e.getBoundingClientRect().right,width:innerWidth,scale:visualViewport?.scale,zoom:getComputedStyle(document.documentElement).zoom,overflow:e.scrollWidth>e.clientWidth+1}));expect(bounds.right).toBeLessThanOrEqual(bounds.width);expect(bounds).toMatchObject({scale:1,zoom:'1',overflow:false});}
  await page.getByRole('button',{name:'View Workspace Inbox',exact:true}).focus();await page.keyboard.press('Shift+Tab');await expect(page.getByRole('button',{name:'Notification: Notice 41 (unread)',exact:true})).toBeFocused();
  await page.keyboard.press('Escape');await expect(bell).toBeFocused();await page.keyboard.press('Space');
  await page.getByRole('button',{name:'View Workspace Inbox',exact:true}).focus();for(let i=0;i<4;i++)await page.keyboard.press('Shift+Tab');await expect(page.getByRole('button',{name:'Notification: Notice 44 (unread)',exact:true})).toBeFocused();await page.keyboard.press('Enter');await expect(page).toHaveURL(/\/dashboard\/leads$/);
  expect((await (await request.get(`${fixture}/api/notifications/unread/count`)).json()).count).toBe(44);
  await page.goto('/dashboard/notifications');const updated=page.getByRole('button',{name:'Notifications (44 unread)',exact:true});await updated.focus();await page.keyboard.press('Space');await expect(page.getByRole('button',{name:'Notification: Notice 43 (unread)',exact:true})).toBeVisible();await page.getByRole('button',{name:'View Workspace Inbox',exact:true}).focus();for(let i=0;i<3;i++)await page.keyboard.press('Shift+Tab');await expect(page.getByRole('button',{name:'Notification: Notice 43 (unread)',exact:true})).toBeFocused();await page.keyboard.press('Space');await expect(page).toHaveURL(/\/dashboard\/leads$/);expect((await (await request.get(`${fixture}/api/notifications/unread/count`)).json()).count).toBe(43);
});

test('personal preference drafts survive cancelled bell navigation and release after Save',async({page,request})=>{
  await shell(page);await page.goto('/dashboard/settings?tab=notifications');const lead=page.getByRole('switch',{name:'Lead Alerts',exact:true});await expect(lead).toBeChecked();await lead.click();
  await page.getByRole('button',{name:'Notifications (45 unread)',exact:true}).click();const cancelled=page.waitForEvent('dialog');const click=page.getByRole('button',{name:'View Workspace Inbox',exact:true}).click();const dialog=await cancelled;expect(dialog.message()).toContain('unsaved notification preferences');await dialog.dismiss();await click;await expect(page).toHaveURL(/\/dashboard\/settings\?tab=notifications$/);await expect(lead).not.toBeChecked();
  expect((await (await request.get(`${fixture}/api/settings/profile/notification-preferences`)).json()).leadAlerts).toBe(true);
  await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.getByRole('button',{name:'Save',exact:true})).toBeDisabled();await page.getByRole('button',{name:'Notifications (45 unread)',exact:true}).click();await page.getByRole('button',{name:'View Workspace Inbox',exact:true}).click();await expect(page).toHaveURL(/\/dashboard\/notifications$/);
  expect((await (await request.get(`${fixture}/api/settings/profile/notification-preferences`)).json()).leadAlerts).toBe(false);
});

test('committed settings save with lost response recovers by idempotent retry and reload',async({page,request})=>{
  await shell(page);await page.goto('/dashboard/settings?tab=notifications');const lead=page.getByRole('switch',{name:'Lead Alerts',exact:true});await expect(lead).toBeChecked();await lead.click();let lose=true;
  await page.route('**/api/settings/profile/notification-preferences',async r=>{if(r.request().method()==='PUT'&&lose){lose=false;expect((await r.fetch()).status()).toBe(200);return r.abort('failed');}return r.continue();});
  await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.getByText('Failed to save preferences',{exact:true})).toBeVisible();
  expect((await (await request.get(`${fixture}/api/settings/profile/notification-preferences`)).json()).leadAlerts).toBe(false);await expect(lead).not.toBeChecked();
  await page.getByRole('button',{name:'Save',exact:true}).click();await expect(page.getByRole('button',{name:'Save',exact:true})).toBeDisabled();await page.reload();await expect(lead).not.toBeChecked();
});
test('committed delete with lost response reconciles after reload',async({page,request})=>{
  await shell(page);await page.goto('/dashboard/notifications');await expect(page.getByRole('tab',{name:'All (45)',exact:true})).toBeVisible();
  await page.route('**/api/notifications/44',async r=>{if(r.request().method()==='DELETE'){expect((await r.fetch()).status()).toBe(200);return r.abort('failed');}return r.continue();});
  await page.getByRole('button',{name:'Delete Notice 44',exact:true}).click();await page.getByRole('button',{name:'Delete',exact:true}).click();
  await expect(page.getByText('Unable to delete notification',{exact:true})).toBeVisible();await expect(page.getByRole('tab',{name:'All (44)',exact:true})).toBeVisible();expect((await (await request.get(`${fixture}/api/notifications?limit=5`)).json()).items.some((i:{id:number})=>i.id===44)).toBe(false);
  await page.reload();await expect(page.getByRole('tab',{name:'All (44)',exact:true})).toBeVisible();await expect(page.getByText('Notice 44',{exact:true})).toHaveCount(0);
});
