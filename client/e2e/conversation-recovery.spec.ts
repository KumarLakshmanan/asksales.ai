import {test,expect,expectNoHorizontalOverflow} from './fixtures/app';
import {runtime,emit,type Fixture} from './fixtures/conversation-runtime';

test('widget history can be retried with the keyboard without reloading or authorizing an action',async({page},testInfo)=>{
  const state:Fixture={turns:[],stops:[],messages:[{id:101,role:'assistant',agentType:'content',content:'Synthetic review prepared',createdAt:'2026-10-23T12:00:00Z',metadata:{isToolResult:true,toolName:'generate_image',widgetMessageId:101,success:true,toolOutput:{awaitingSubmission:true}}}]};
  await runtime(page,state);
  let reads=0;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/widgets?*',async route=>{
    reads++;
    if(reads===1)return route.fulfill({status:503,json:{error:'Synthetic unavailable history'}});
    await gate;
    return route.fulfill({json:{widgets:[{id:1,threadId:42,messageId:101,toolName:'generate_image',widgetType:'image_generation',status:'active',formValues:{prompt:'Harmless synthetic review'},agentType:'content',createdAt:'2026-10-23T12:00:00Z',updatedAt:'2026-10-23T12:00:00Z'}]}});
  });
  await page.goto('/dashboard/conversations/42');
  await expect(page.getByRole('alert').filter({hasText:'Reviews could not be loaded'})).toBeVisible();
  await expect(page.getByText('Review the fields above before you authorize this action.')).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('review-history-error.png'),fullPage:true});
  const retry=page.getByRole('button',{name:'Retry reviews',exact:true});await retry.focus();await page.keyboard.press('Enter');
  await expect(page.getByRole('button',{name:'Loading reviews…'})).toBeDisabled();
  expect(reads).toBe(2);release();
  await expect(page.getByRole('alert').filter({hasText:'Reviews could not be loaded'})).toHaveCount(0);
  await expect(page.getByText('Review the fields above before you authorize this action.')).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/conversations\/42$/);
  expect(await page.evaluate(()=>window.visualViewport?.scale)).toBe(1);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({path:testInfo.outputPath('review-restored-by-keyboard.png'),fullPage:true});
});

test('realtime receipts and an unfinished stream survive an older history read',async({page},testInfo)=>{
  const state:Fixture={turns:[],stops:[],messages:[]};await runtime(page,state);
  let requested=false;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/chat/threads/42/messages',async route=>{requested=true;await gate;return route.fulfill({json:{messages:[],hasMore:false,nextCursor:null}});},{times:1});
  await page.goto('/dashboard/conversations/42');await expect.poll(()=>requested).toBe(true);
  await expect(page.getByRole('heading',{name:'Disposable conversation',exact:true})).toBeVisible();
  const message={id:501,role:'assistant',content:'Realtime receipt while loading',agentType:'orchestrator',metadata:{responseId:'live-durable'},createdAt:new Date().toISOString()};
  await emit(page,'chat_message',{thread_id:42,message:{...message,timestamp:Date.now()}},'live-501');
  const chunk={thread_id:42,responseId:'live-stream',role:'assistant',agentType:'orchestrator',timestamp:Date.now()};
  await emit(page,'chat_response_chunk',{...chunk,sequence:1,chunk:'Live stream',done:false},'stream-1');
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));release();
  await expect(page.getByText('What would you like to work on today?',{exact:true})).toBeVisible();
  await expect(page.getByText(message.content,{exact:true})).toHaveCount(1,{timeout:5000});
  await expect(page.getByText('Live stream',{exact:true})).toHaveCount(1);
  await emit(page,'chat_response_chunk',{...chunk,sequence:2,chunk:' extended',done:true},'stream-2');
  await expect(page.getByText('Live stream extended',{exact:true})).toHaveCount(1);
  await emit(page,'chat_message',{thread_id:42,message:{...message,timestamp:Date.now()}},'duplicate-501');
  await expect(page.getByText(message.content,{exact:true})).toHaveCount(1);
  state.messages=[message,{...message,id:502,content:'Live stream extended',metadata:{responseId:'live-stream'}}];
  await page.reload();await expect(page.getByText(message.content,{exact:true})).toHaveCount(1);await expect(page.getByText('Live stream extended',{exact:true})).toHaveCount(1);
  await expectNoHorizontalOverflow(page);await page.screenshot({path:testInfo.outputPath('history-and-realtime-converged.png'),fullPage:true});
});

test('compact tool controls expose their confirmation status to assistive technology',async({page})=>{
  const state:Fixture={turns:[],stops:[],messages:[{id:101,role:'assistant',agentType:'content',content:'Synthetic review',createdAt:'2026-10-23T12:00:00Z',metadata:{isToolResult:true,toolName:'generate_image',success:true,toolOutput:{awaitingSubmission:true}}}]};
  await runtime(page,state);await page.goto('/dashboard/conversations/42');
  await expect(page.getByRole('button',{name:/Generate Image.*awaiting confirmation/i})).toBeVisible({timeout:5000});
  await expectNoHorizontalOverflow(page);
});
