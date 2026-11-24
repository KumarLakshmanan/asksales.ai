import { test, expect, expectNoHorizontalOverflow } from './fixtures/app';
import { emptyAssistantDraft, type AssistantCatalog } from '../../shared/outreachAssistants';

const id='c1a11111-1111-4111-8111-111111111111';
const draft={...emptyAssistantDraft(),name:'QA guest support',agentType:'general_service',replyModel:{provider:'openai',model:'qa-model'},bindings:[{channel:'whatsapp' as const,surface:'private' as const,accountId:'qa-line'}]};
const assistant={id,businessProfileId:4102,state:'live',draft,draftVersion:2,publishedRevision:1,published:draft,enabledBindings:draft.bindings,readiness:{ready:true,checks:[]},updatedAt:'2026-10-03T00:00:00Z'};
const catalog:AssistantCatalog={runtimeEnabled:true,presets:[{agentType:'general_service',name:'General service',description:'QA',instructions:'',tools:[],policies:{}}],accounts:[{...draft.bindings[0],label:'QA receiving line',connected:true,assignedAssistantId:id}],models:[{provider:'openai',model:'qa-model',label:'QA model',controls:[]}],knowledge:[],playbooks:[],templates:[],documents:[],galleries:[],tools:[],permissions:{canManage:true,description:'Owner controls'}};

test.beforeEach(async({page})=>{
  catalog.knowledge=Array.from({length:80},(_,index)=>({id:index+1,name:`QA source ${index+1}`,channels:['whatsapp'],status:'available'}));
  let reviewed=false;
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    const json=async(body:unknown)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    if(path.startsWith('/api/settings/outreach/assistants')) {
      expect(request.headers()['x-business-profile-id']).toBe('4102');
      if(path.endsWith('/catalog'))return json(catalog);
      if(path.endsWith('/diagnostics'))return json({days:30,assignments:[{...catalog.accounts[0],assistantId:id,assistantName:draft.name,revision:1,state:'live',runtimeEnabled:true,checks:[{key:'account',label:'Connected account',ok:true,detail:'Verified QA identity'}]}],metrics:[{assistantId:id,name:draft.name,channel:'whatsapp',accountId:'qa-line',day:'2026-10-03',replies:2,failures:1,handoffs:0,averageDurationMs:200,averageConfidence:.9}],usage:[{assistantId:id,revision:1,provider:'openai',model:'qa-model',calls:3,totalTokens:400,cost:null,currency:null,source:'reply_audit'}],knowledgeGaps:[{key:'a'.repeat(40),assistantId:id,assistantName:draft.name,intent:'hours',count:2,latestAt:'2026-10-03T00:00:00Z',conversationIds:[8],conversations:[{id:8,channel:'whatsapp'}],dailyCounts:[{day:'2026-10-03',count:2}],questionSamples:['What are the verified hours?'],reason:'Assigned knowledge contains conflicting information.',review:reviewed?'reviewed':'open',note:null}]});
      if(path.endsWith('/knowledge-gaps/review')){reviewed=true;return json({review:'reviewed'});}
      if(path.endsWith('/scenarios'))return json({items:[]});
      if(path.endsWith('/history'))return json({history:[],nextCursor:null});
      if(path.endsWith('/revisions'))return json({items:[{revision:1,current:true,publishedAt:'2026-10-03T00:00:00Z',configuration:draft}],nextCursor:null});
      if(path===`/api/settings/outreach/assistants/${id}`)return json(assistant);
      if(path==='/api/settings/outreach/assistants')return json({assistants:[assistant],runtimeEnabled:true,nextCursor:null});
      throw new Error(`Unexpected assistant effect: ${request.method()} ${path}`);
    }
    if(['/api/auth/me','/api/platform/access','/api/settings/business-profiles','/api/settings/preferences','/api/organizations','/api/crm/configuration','/api/wallet','/api/notifications/unread/count'].includes(path)||path==='/api/chat/threads')return route.fallback();
    if(request.method()!=='GET')throw new Error(`Blocked unexpected mutation: ${request.method()} ${path}`);
    return json({data:[],items:[],total:0});
  });
});

test('account health and knowledge review are usable without sending',async({page,audit},info)=>{
  await page.goto('/dashboard/settings/outreach/operations');
  await expect(page.getByRole('heading',{name:'Assistant operations',exact:true})).toBeVisible();
  await expect(page.getByText('QA receiving line', {exact:true}).first()).toBeVisible();
  await expect(page.getByText('Not recorded',{exact:true})).toBeVisible();
  await page.getByText('Redacted question examples',{exact:true}).click();
  await expect(page.getByText('What are the verified hours?',{exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Conversation 8'})).toHaveAttribute('href',/thread=conversation%3A8/);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({path:info.outputPath('operations.png'),fullPage:true});
  await page.getByRole('button',{name:'Mark reviewed',exact:true}).click();
  await expect(page.getByText('No recorded knowledge gaps match this review status.')).toBeVisible();
  await page.getByLabel('Knowledge review status').selectOption('reviewed');
  await expect(page.getByRole('button',{name:'Reopen question',exact:true})).toBeVisible();
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

test('editor guidance, scenario controls and unsaved guard work on small screens',async({page,audit},info)=>{
  await page.goto(`/dashboard/settings/outreach/assistants/${id}`);
  await expect(page.getByRole('heading',{name:draft.name,exact:true})).toBeVisible();
  await page.locator('[data-assistant-tab="ai"]').click();
  await page.getByText('Saved scenarios & revision comparison',{exact:true}).click();
  await page.getByLabel('Customer messages (one per line)').fill('I need a room\nActually three adults');
  await page.getByLabel('Scenario name',{exact:true}).fill('Correction test');
  await expect(page.getByRole('button',{name:'Compare draft & published',exact:true})).toBeEnabled();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({path:info.outputPath('scenarios.png'),fullPage:true});
  await page.locator('[data-assistant-tab="knowledge"]').click();
  await page.getByRole('radio',{name:'Select resources',exact:true}).check();
  await expect(page.getByRole('checkbox')).toHaveCount(25);
  await page.getByRole('button',{name:'Next resources',exact:true}).click();
  await expect(page.getByText('QA source 26',{exact:true})).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(25);
  await expectNoHorizontalOverflow(page);
  await page.locator('[data-assistant-tab="basic"]').click();
  const name=page.getByLabel('Assistant name',{exact:true});
  await name.fill('Unsaved QA name');
  page.once('dialog',dialog=>dialog.dismiss());
  await page.getByRole('link',{name:'Assistants',exact:true}).first().click();
  await expect(name).toHaveValue('Unsaved QA name');
  expect(audit.consoleErrors).toEqual([]);
});
