import {test,expect,expectNoHorizontalOverflow} from './fixtures/app';
import {createHmac} from 'node:crypto';
test.use({video:'off',launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}});
const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
const jwt=()=>{const s=`${encode({alg:'HS256',typ:'JWT'})}.${encode({userId:2,email:'member@example.test',role:'user',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})}`;return `${s}.${createHmac('sha256','paid-ads-synthetic-only').update(s).digest('base64url')}`;};

test('research retry recovers a lost response through real API, scoped SQL and Redis',async({page,context},info)=>{
 await context.addCookies([{name:'asksales_session',value:jwt(),domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Lax'}]);
 await page.addInitScript(()=>{localStorage.setItem('user',JSON.stringify({id:2}));sessionStorage.setItem('active-business-profile:2','11');});
 const writes:any[]=[];const replies:any[]=[];const errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname;
  if(!['localhost','127.0.0.1'].includes(url.hostname))return route.abort();
  if(path.startsWith('/api/campaigns/creative-intelligence')){
   const response=await route.fetch({url:`http://127.0.0.1:3298${path}${url.search}`,headers:{...req.headers(),'x-business-profile-id':'11',authorization:`Bearer ${jwt()}`}});
   if(req.method()==='POST'){
    writes.push(req.postDataJSON());replies.push({status:response.status(),body:await response.json()});
    // The server commits, then the UI sees an unknown transport result. Retry
    // must reuse that same row/request, not create a second job.
    if(writes.length===1)return route.fulfill({status:503,json:{error:'Synthetic lost response. Retry the saved research request.'}});
   }
   return route.fulfill({response});
  }
  if(path==='/api/auth/me')return route.fulfill({json:{user:{id:2,name:'Synthetic member',email:'member@example.test',workspaceRole:'member',isSetupComplete:true,isApproved:true,hasBusinessProfile:true,hasBrandToolkit:true}}});
  if(path==='/api/settings/business-profiles')return route.fulfill({json:[{id:11,userId:1,name:'North',companyName:'North',isDefault:true,role:'member'}]});
  if(path==='/api/campaigns/accounts')return route.fulfill({json:{accounts:[]}});
  if(path==='/api/campaigns/analytics/dashboard')return route.fulfill({json:{currency:'USD',availableCurrencies:['USD'],campaigns:[],dailyTrends:[]}});
  if(path.startsWith('/api/')&&!['GET','HEAD'].includes(req.method()))return route.fulfill({status:409,json:{error:'Unrelated mutation blocked'}});
  return route.fallback();
 });
 await page.goto('/dashboard/ads?tab=recommendations');
 await page.getByLabel('Competitor name').fill('Synthetic competitor');
 await page.getByLabel('Observed ad copy').fill('Observed workflow demo. No measured claims.');
 await page.getByRole('button',{name:'Save research',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'Synthetic lost response'})).toBeVisible();
 await expect(page.getByLabel('Observed ad copy')).toHaveValue('Observed workflow demo. No measured claims.');
 await page.getByRole('button',{name:'Save research',exact:true}).click();
 await expect.poll(()=>replies.length).toBe(2);
 expect(replies.map(value=>value.status)).toEqual([202,202]);expect(replies[1].body.id).toBe(replies[0].body.id);expect(writes[1].requestId).toBe(writes[0].requestId);
 await expect(page.getByText(new RegExp(`Research #${replies[0].body.id}: queued`))).toBeVisible();
 expect(errors).toEqual([]);expect(await page.evaluate(()=>window.visualViewport?.scale||1)).toBeCloseTo(1,2);await expectNoHorizontalOverflow(page);
 await page.screenshot({path:info.outputPath('research-accepted.png'),fullPage:true});
 await info.attach('actual-api-retry',{body:JSON.stringify({writes,replies,errors},null,2),contentType:'application/json'});
});

const detail=(name:string)=>({campaign:{id:'campaign-7',name,objective:'traffic',currency:'USD',provider_status:'PAUSED',ad_platform:'meta'},settings:{mode:'off',analyticsSyncMinutes:15,policyVersion:'ads-pause-v1'},policy:{enabled:false,reportOnly:true,policyVersion:'ads-pause-v1',thresholds:{}},units:[],evaluations:[],recommendations:[],actions:[],performanceTrace:[],historicalBaselines:[],providerAggregate:{spend:12,clicks:3,impressions:100},monitoring:{state:'report_only',canImport:false}});
test('production detail ignores late account evidence and legacy navigation retains context',async({page},info)=>{
 let release!:()=>void;const old=new Promise<void>(r=>{release=r;});let oldStarted=false;
 await page.route('**/api/campaigns/analytics/provider/meta/campaign-7*',async route=>{
  const url=new URL(route.request().url());
  if(url.searchParams.get('account')==='11'){oldStarted=true;await old;return route.fulfill({json:detail('Old account evidence')});}
  return route.fulfill({json:detail('Current account evidence')});
 });
 await page.goto('/dashboard/ads/campaigns/provider/meta/campaign-7?account=11&period=7d');
 await expect.poll(()=>oldStarted).toBe(true);
 await page.evaluate(()=>window.history.pushState(null,'','/dashboard/ads/campaigns/provider/meta/campaign-7?account=12&period=30d'));
 await expect(page.getByRole('heading',{name:'Current account evidence'})).toBeVisible();
 release();await page.waitForResponse(response=>response.url().includes('account=11')&&response.url().includes('/analytics/provider/'));
 await expect(page.getByRole('heading',{name:'Current account evidence'})).toBeVisible();await expect(page.getByRole('heading',{name:'Old account evidence'})).toHaveCount(0);
 await expectNoHorizontalOverflow(page);await page.screenshot({path:info.outputPath('current-account-evidence.png'),fullPage:true});
 await page.goto('/dashboard/marketing/campaigns?account=12&period=7d&platform=meta');
 await expect(page).toHaveURL(/\/dashboard\/ads\?/);const target=new URL(page.url());expect(target.searchParams.get('account')).toBe('12');expect(target.searchParams.get('period')).toBe('7d');expect(target.searchParams.get('tab')).toBe('campaigns');
});

test('production brief warns before reload and supports explicit discard',async({page},info)=>{
 await page.goto('/dashboard/ads/create?platform=google');
 const name=page.getByLabel('Campaign name',{exact:true});await name.focus();await expect(name).toBeFocused();await page.keyboard.press('Tab');await expect(page.getByRole('combobox',{name:'Platform',exact:true})).toBeFocused();
 await name.fill('Synthetic unsaved brief');
 page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('link',{name:'Back to campaigns'}).click();await expect(name).toHaveValue('Synthetic unsaved brief');
 page.once('dialog',dialog=>dialog.accept());await page.reload();await expect(name).toHaveValue('');await expect(page.getByRole('combobox',{name:'Platform',exact:true})).toHaveValue('google');
 await expect(page.getByText(/Reloading or leaving this page discards/)).toBeVisible();expect(await page.evaluate(()=>window.visualViewport?.scale||1)).toBeCloseTo(1,2);await expectNoHorizontalOverflow(page);await page.screenshot({path:info.outputPath('brief-discard-notice.png'),fullPage:true});
});
