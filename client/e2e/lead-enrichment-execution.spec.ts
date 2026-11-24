import {readFileSync} from 'node:fs';
import {test,expect,installAppShellMocks,expectNoHorizontalOverflow} from './fixtures/app';

test('queued lead uses one reserved attempt and restores keyboard focus in the production UI',async({page},info)=>{
 test.skip(process.env.LEAD_BROWSER_LOCAL_QA!=='1','Requires the paired synthetic registered-worker fixture');
 const fixture=JSON.parse(readFileSync('/tmp/lead-discovery-browser-fixture.json','utf8'));
 const target=fixture.browserLeadNames[info.project.name.includes('mobile')?'mobile':'desktop'];
 const headers={Authorization:`Bearer ${fixture.token}`,'X-Business-Profile-Id':String(fixture.businessProfileId)};
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
 const dialog=page.getByRole('dialog',{name:'New Enrichment',exact:true});await expect(dialog.getByRole('textbox',{name:'Handle / URL',exact:true})).toBeVisible();
 await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(opener).toBeFocused();
 await opener.click();await page.getByRole('tab',{name:'From Lead'}).click();
 const search=page.getByRole('textbox',{name:'Search leads by name or email',exact:true});await search.fill(target);
 const before=await (await page.request.get('http://127.0.0.1:58080/api/wallet',{headers})).json();
 const responsePromise=page.waitForResponse(response=>response.request().method()==='POST'&&/\/api\/leads\/\d+\/deep-enrich$/.test(response.url()));
 await page.getByRole('button',{name:new RegExp(target)}).click();const response=await responsePromise;expect(response.status()).toBe(200);
 expect(response.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
 const created=await response.json();expect(created.runId).toBeGreaterThan(0);expect(typeof created.jobId).toBe('string');
 await expect.poll(async()=>{const data=await(await page.request.get(`http://127.0.0.1:58080/api/enrichments/${created.runId}`,{headers})).json();return data.data.status;}).toBe('completed');
 await expect(page.getByText('Enrichment complete',{exact:true})).toBeVisible();
 const detail=await(await page.request.get(`http://127.0.0.1:58080/api/enrichments/${created.runId}`,{headers})).json();
 expect(detail.data.billingStatus).toBe('settled');expect(detail.data).not.toHaveProperty('executionResult');
 const after=await(await page.request.get('http://127.0.0.1:58080/api/wallet',{headers})).json();expect(after.balance).toBe(before.balance-5);
 await page.reload();await page.getByRole('button',{name:new RegExp(target)}).click();await expect(page.getByText('Enrichment complete',{exact:true})).toBeVisible();
 await expectNoHorizontalOverflow(page);expect(await page.evaluate(()=>visualViewport?.scale)).toBe(1);
 await page.screenshot({path:info.outputPath('queued-enrichment-complete.png'),fullPage:true});
 await info.attach('queued-result',{body:JSON.stringify({runId:created.runId,jobId:created.jobId,balanceBefore:before.balance,balanceAfter:after.balance}),contentType:'application/json'});
});
