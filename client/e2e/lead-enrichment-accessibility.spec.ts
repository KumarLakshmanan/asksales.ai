import {readFileSync} from 'node:fs';
import {test,expect,installAppShellMocks,expectNoHorizontalOverflow} from './fixtures/app';

test('enrichment inputs have names and Escape restores the opener at normal zoom',async({page},info)=>{
 test.skip(process.env.LEAD_DISCOVERY_LOCAL_QA!=='1','Requires the guarded local enrichment browser backend');
 const fixture=JSON.parse(readFileSync('/tmp/lead-discovery-browser-fixture.json','utf8'));
 await installAppShellMocks(page);
 await page.addInitScript(value=>{localStorage.setItem('token',value.token);localStorage.setItem('user',JSON.stringify({id:value.userId}));sessionStorage.setItem(`active-business-profile:${value.userId}`,String(value.businessProfileId));},fixture);
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());
  if(/^\/api\/(?:auth\/me|platform\/access|settings\/business-profiles|wallet|leads|enrichments)(?:\/|$)/.test(url.pathname)){const response=await route.fetch({url:`http://127.0.0.1:58080${url.pathname}${url.search}`});return route.fulfill({response});}
  if(/^\/api\/(?:chat\/threads|settings\/preferences|organizations|crm\/configuration|notifications\/unread\/count)$/.test(url.pathname))return route.fallback();
  return route.fulfill({json:{}});
 });
 await page.goto('/dashboard/enrichment');await expect(page.getByRole('button',{name:/Synthetic saved discovery/})).toBeVisible();
 const opener=page.getByRole('button',{name:/^New enrichment$/i}).filter({visible:true}).first();await opener.focus();await page.keyboard.press('Enter');
 const dialog=page.getByRole('dialog',{name:'New Enrichment',exact:true});
 await expect(dialog.getByRole('textbox',{name:'Handle / URL',exact:true})).toBeVisible();
 await page.getByRole('tab',{name:'From Lead'}).click();
 await expect(dialog.getByRole('textbox',{name:'Search leads by name or email',exact:true})).toBeVisible();
 await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(opener).toBeFocused();
 await expectNoHorizontalOverflow(page);expect(await page.evaluate(()=>visualViewport?.scale)).toBe(1);
 await page.screenshot({path:info.outputPath('dialog-focus-restored.png'),fullPage:true});
});
