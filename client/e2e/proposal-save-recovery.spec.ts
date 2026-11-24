import type { Page, Route } from '@playwright/test';
import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });

const record = (id = 601, revision = 7, title = 'Fixture implementation') => ({
  id, revision, title, status: 'draft', draftKey: `fixture-${id}`, proposalNumber: `P-${id}`,
  recipientName: 'Fixture Customer', recipientEmail: 'customer@example.test', currency: 'USD',
  coverNote: 'Confirmed implementation scope.', termsAndConditions: 'Payment due in 14 days.',
  signatureRequired: false, showTermsAndConditions: true, discountType: null, discountValue: 0, taxRate: 0,
  total: '900', subtotal: '900', validUntil: null, metadata: {},
  lineItems: [{ name: 'Implementation', quantity: 1, unitPrice: 900 }],
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
});
const json = (route: Route, data: unknown, status = 200) => route.fulfill({status,json:status===200?{success:true,data}:data});
type Write = { route: Route; method: string; path: string; body: Record<string, unknown> };
async function fixture(page: Page) {
  const state = { writes: [] as Write[], blocked: [] as string[], reads: [] as string[], pendingRecordReads: [] as Route[], holdNextRecordRead: false, failRead: '', hold: true, current: record() as Record<string, unknown> };
  await page.route('**/api/**', async route => {
    const request=route.request(), path=new URL(request.url()).pathname, method=request.method();
    // Every API request terminates in local fixtures or the synthetic app-shell
    // fixture. No proposal, delivery approval, send, provider job or other write
    // is allowed to reach any backend.
    if(!['GET','HEAD'].includes(method)) {
      if((method==='PUT' && /^\/api\/proposals\/(601|602)$/.test(path)) || (method==='POST' && path==='/api/proposals')) {
        const write={route,method,path,body:request.postDataJSON()};state.writes.push(write);
        if(!state.hold)await confirm(state,write);
        return;
      }
      state.blocked.push(`${method} ${path}`);
      return json(route,{error:'Blocked synthetic-only proposal regression write.'},409);
    }
    state.reads.push(path);
    if(path===state.failRead)return json(route,{error:'Synthetic proposal/source read unavailable.'},503);
    if(path==='/api/proposals/601' || path==='/api/proposals/602') {
      if(state.holdNextRecordRead){state.holdNextRecordRead=false;state.pendingRecordReads.push(route);return;}
      return json(route,state.current);
    }
    if(path==='/api/proposals/resolve-source')return json(route,{refs:{contactId:12},recipientName:'Fixture Customer',recipientEmail:'customer@example.test'});
    if(path==='/api/proposals/sources')return json(route,{contacts:[],conversations:[],tickets:[]});
    if(path==='/api/proposals/brand')return json(route,{companyName:'Fixture Business'});
    if(path==='/api/proposals/onboarding-resources')return json(route,{teams:[],members:[]});
    if(path.startsWith('/api/proposals/'))return json(route,[]);
    if(['/api/auth/me','/api/platform/access','/api/settings/preferences','/api/settings/outreach/assistants/catalog','/api/organizations','/api/settings/business-profiles','/api/crm/configuration','/api/wallet','/api/notifications/unread/count'].includes(path))return route.fallback();
    return json(route,[]);
  });
  return state;
}
async function confirm(state: Awaited<ReturnType<typeof fixture>>, write: Write) {
  const revision=write.method==='POST'?1:Number(write.body.expectedRevision)+1;
  state.current={...record(write.method==='POST'?602:601,revision),...write.body,id:write.method==='POST'?602:Number(write.path.split('/').at(-1)),revision};
  await json(write.route,state.current);
}
const browserCopy = (page: Page, suffix = ':601') => page.evaluate(suffix => {
  const key=Object.keys(localStorage).find(key=>key.startsWith('proposal-draft:v4:') && key.endsWith(suffix));
  return key?JSON.parse(localStorage.getItem(key)!):null;
},suffix);
async function sendStep(page: Page) {await page.getByRole('navigation',{name:'Proposal creation steps'}).getByRole('button',{name:/Send/}).click();}
async function normalViewport(page: Page) {
  expect(await page.evaluate(()=>({width:innerWidth,height:innerHeight,scale:visualViewport?.scale}))).toEqual({...page.viewportSize(),scale:1});
  await expectNoHorizontalOverflow(page);
}

test('deferred autosave A → edit B → delivery review waits for B and never sends', async ({page,audit},testInfo) => {
  const state=await fixture(page);
  await page.goto('/dashboard/proposals/601/edit');
  const title=page.getByPlaceholder('Website launch for Acme');
  await title.fill('Fixture revision A');
  await expect.poll(()=>state.writes.length).toBe(1); // Real 1.2s autosave, mocked PUT only.
  expect(state.writes[0].body).toMatchObject({title:'Fixture revision A',expectedRevision:7});
  await title.fill('Fixture revision B');await sendStep(page);
  await page.getByRole('button',{name:'Open delivery review',exact:true}).click();
  await confirm(state,state.writes[0]);
  await expect.poll(()=>state.writes.length).toBe(2);
  expect(state.writes[1].body).toMatchObject({title:'Fixture revision B',expectedRevision:8});
  await expect(page).toHaveURL(/\/601\/edit$/);
  await expect.poll(()=>browserCopy(page)).toMatchObject({draft:{title:'Fixture revision B'},revision:8});
  await expect(page.getByRole('button',{name:'Open delivery review',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Cancel delivery review',exact:true})).toBeVisible();
  await normalViewport(page);
  await page.screenshot({path:testInfo.outputPath('latest-B-pending.png'),fullPage:true});
  await confirm(state,state.writes[1]);
  await expect(page).toHaveURL(/\/601\?send=1&channel=email$/);
  await expect(page.locator('main > header').getByRole('heading',{name:'Fixture revision B',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Delivery review',exact:true})).toBeVisible();
  expect(await browserCopy(page)).toBeNull();
  expect(state.writes.map(write=>`${write.method} ${write.path}`)).toEqual(['PUT /api/proposals/601','PUT /api/proposals/601']);
  expect(state.blocked).toEqual([]);expect(audit.consoleErrors).toEqual([]);
});

test('rejected latest save retains B through reload, explicit restore and retry', async ({page},testInfo) => {
  const state=await fixture(page);
  await page.goto('/dashboard/proposals/601/edit');
  await page.getByPlaceholder('Website launch for Acme').fill('Fixture revision A');
  await expect.poll(()=>state.writes.length).toBe(1);
  await page.getByPlaceholder('Website launch for Acme').fill('Fixture revision B');await sendStep(page);
  await page.getByRole('button',{name:'Open delivery review',exact:true}).click();
  await confirm(state,state.writes[0]);await expect.poll(()=>state.writes.length).toBe(2);
  await json(state.writes[1].route,{error:'Synthetic latest save rejected.'},503);
  await expect(page.locator('[data-creator-composer]').getByRole('alert')).toContainText('Synthetic latest save rejected.');
  await expect(page).toHaveURL(/\/601\/edit$/);
  await expect.poll(()=>browserCopy(page)).toMatchObject({draft:{title:'Fixture revision B'},revision:8});
  await normalViewport(page);
  await page.screenshot({path:testInfo.outputPath('latest-B-rejected.png'),fullPage:true});
  await page.reload();
  await expect(page.getByRole('button',{name:'Restore draft',exact:true})).toBeVisible();
  expect(await browserCopy(page)).toMatchObject({draft:{title:'Fixture revision B'},revision:8});
  await page.getByRole('button',{name:'Restore draft',exact:true}).click();
  await expect(page.getByPlaceholder('Website launch for Acme')).toHaveValue('Fixture revision B');
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await expect.poll(()=>state.writes.length).toBe(3);
  expect(state.writes[2].body).toMatchObject({title:'Fixture revision B',expectedRevision:8});
  await confirm(state,state.writes[2]);
  await expect(page.getByText('Saved · Draft #601', {exact:true})).toBeVisible();
  expect(state.blocked).toEqual([]);
});

test('a late Restore read cannot replace or autosave edits after Use current version', async ({page,audit},testInfo) => {
  const state=await fixture(page);
  const stored={version:1,id:601,revision:7,savedAt:'2026-10-10T00:00:00Z',draft:{...record(),title:'Fixture old recovery',validUntil:'',generatedSections:[],commercial:{},requirements:{},assumptions:[],templateValues:{},approvalRequired:true,autoOnboard:true,onboardingPlan:{teamId:null,assignedMemberId:null,dueDate:null,checklist:[]}}};
  await page.addInitScript(stored=>{
    localStorage.setItem('user',JSON.stringify({id:4101}));
    sessionStorage.setItem('active-business-profile:4101','4102');
    localStorage.setItem('proposal-draft:v4:user-4101:business-4102:601',JSON.stringify(stored));
  },stored);
  await page.goto('/dashboard/proposals/601/edit');
  await expect(page.getByRole('button',{name:'Restore draft',exact:true})).toBeVisible();
  state.holdNextRecordRead=true;
  await page.getByRole('button',{name:'Restore draft',exact:true}).click();
  await expect.poll(()=>state.pendingRecordReads.length).toBe(1);
  await page.getByRole('button',{name:'Use current version',exact:true}).click();
  const title=page.getByPlaceholder('Website launch for Acme');
  await title.fill('Fixture latest chosen draft');
  const latestCopy=await browserCopy(page);
  await json(state.pendingRecordReads[0],record());
  await expect(title).toHaveValue('Fixture latest chosen draft');
  await expect(page.getByRole('button',{name:'Restore draft',exact:true})).toHaveCount(0);
  expect(await browserCopy(page)).toEqual(latestCopy);
  await expect(page).toHaveURL(/\/601\/edit$/);
  await expect.poll(()=>state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({method:'PUT',path:'/api/proposals/601',body:{title:'Fixture latest chosen draft',expectedRevision:7}});
  await normalViewport(page);
  await page.screenshot({path:testInfo.outputPath('restore-choice-retired.png'),fullPage:true});
  await confirm(state,state.writes[0]);
  await expect(page.getByText('Saved · Draft #601',{exact:true})).toBeVisible();
  expect(await browserCopy(page)).toMatchObject({draft:{title:'Fixture latest chosen draft'},revision:8});
  expect(state.writes).toHaveLength(1);expect(state.blocked).toEqual([]);expect(audit.consoleErrors).toEqual([]);
});

test('deferred new proposal POST A → edit B → delivery review waits for all saves', async ({page,audit}) => {
  const state=await fixture(page);
  await page.route('**/api/proposals/templates',route=>json(route,[{id:1,name:'Fixture complete template',coverNote:'Confirmed implementation scope.',termsAndConditions:'Payment due in 14 days.',templateContent:{sections:[]},lineItems:[{name:'Implementation',quantity:1,unitPrice:900}]}]));
  await page.goto('/dashboard/proposals/new?contactId=12&templateId=1');
  const title=page.getByPlaceholder('Website launch for Acme');
  await title.fill('Fixture new A');
  await expect.poll(()=>state.writes.length).toBe(1);
  expect(state.writes[0].method).toBe('POST');
  await title.fill('Fixture new B');await sendStep(page);
  await page.getByRole('button',{name:'Open delivery review',exact:true}).click();
  await confirm(state,state.writes[0]);await expect.poll(()=>state.writes.length).toBe(2);
  expect(state.writes[1]).toMatchObject({method:'PUT',path:'/api/proposals/602',body:{title:'Fixture new A',expectedRevision:1}});
  await confirm(state,state.writes[1]);await expect.poll(()=>state.writes.length).toBe(3);
  expect(state.writes[2]).toMatchObject({method:'PUT',path:'/api/proposals/602',body:{title:'Fixture new B',expectedRevision:2}});
  await expect(page).toHaveURL(/\/new\?contactId=12&templateId=1$/);
  expect(await browserCopy(page,':new')).toMatchObject({draft:{title:'Fixture new B'},id:602,revision:2});
  await confirm(state,state.writes[2]);
  await expect(page).toHaveURL(/\/602\?send=1&channel=email$/);
  await expect(page.locator('main > header').getByRole('heading',{name:'Fixture new B',exact:true})).toBeVisible();
  expect(await browserCopy(page,':new')).toBeNull();
  expect(state.blocked).toEqual([]);expect(audit.consoleErrors).toEqual([]);
});

for(const kind of ['proposal','source'] as const) {
  test(`initial ${kind} read Retry preserves recovery without writes at normal desktop/tablet/narrow widths`, async ({page},testInfo) => {
    const state=await fixture(page);state.failRead=kind==='proposal'?'/api/proposals/601':'/api/proposals/resolve-source';
    await page.addInitScript(kind=>{
      localStorage.setItem('user',JSON.stringify({id:4101}));
      sessionStorage.setItem('active-business-profile:4101','4102');
      localStorage.setItem(`proposal-draft:v4:user-4101:business-4102:${kind==='proposal'?601:'new'}`,JSON.stringify({version:1,draft:{draftKey:'recoverable-fixture',title:'Fixture recoverable edits'},savedAt:'2026-10-10T00:00:00Z'}));
    },kind);
    await page.goto(kind==='proposal'?'/dashboard/proposals/601/edit':'/dashboard/proposals/new?contactId=12');
    const retry=page.getByRole('button',{name:'Retry loading proposal',exact:true});
    await expect(retry).toBeVisible();await expect(page.getByPlaceholder('Website launch for Acme')).toHaveCount(0);
    for(const viewport of [page.viewportSize()!,{width:768,height:1024},{width:320,height:740}]) {
      await page.setViewportSize(viewport);await normalViewport(page);await expect(retry).toBeVisible();
      await page.screenshot({path:testInfo.outputPath(`${kind}-retry-${viewport.width}.png`),fullPage:true});
    }
    const suffix=kind==='proposal'?':601':':new';
    expect(await browserCopy(page,suffix)).toMatchObject({draft:{title:'Fixture recoverable edits'}});
    state.failRead='';await retry.click();
    await expect(page.getByRole('button',{name:'Restore draft',exact:true})).toBeVisible();
    expect(await browserCopy(page,suffix)).toMatchObject({draft:{title:'Fixture recoverable edits'}});
    expect(state.writes).toEqual([]);expect(state.blocked).toEqual([]);
  });
}
