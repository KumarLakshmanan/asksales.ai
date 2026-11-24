import { captureCrmScreenshot } from './fixtures/crm-screenshots';
import { expect, expectNoHorizontalOverflow, installAppShellMocks, test } from './fixtures/app';
import { DEFAULT_CRM_CONFIGURATION } from '../../shared/crmConfiguration';

test.setTimeout(180_000);
test.use({ actionTimeout: 30_000, timezoneId: 'Asia/Kolkata' });
const screenshotDirectory = process.env.CRM_QA_SCREENSHOT_DIR || 'test-results';
const contactFixture = {
  id: 42, leadId: 7, firstName: 'Priya', lastName: 'Raman', email: 'priya@harbor.example',
  phone: '+919876543210', company: 'Harbor Commerce & Logistics', role: 'Head of customer operations',
  status: 'interested', pipelineStatus: 'review', priority: 'high', source: 'website',
  currency: 'INR', dealValue: '245000', lastSentimentStatus: 'positive',
  tags: ['Enterprise', 'Q4 rollout'], notes: 'Prefers WhatsApp for quick updates.\nSend the implementation plan before Friday’s review.',
  lastActivityAt: '2026-10-02T04:30:00Z', createdAt: '2026-09-20T04:30:00Z', updatedAt: '2026-10-02T04:30:00Z',
};
const configuration = {
  ...DEFAULT_CRM_CONFIGURATION,
  stages: [DEFAULT_CRM_CONFIGURATION.stages[0],
    { key: 'review', label: 'Proposal review', type: 'active', color: '#2563eb', inFlow: true },
    { key: 'accepted', label: 'Contract accepted', type: 'won', color: '#10b981', inFlow: true },
    DEFAULT_CRM_CONFIGURATION.stages[9]],
};
const activityFixture = [
  { id: 2, type: 'meeting', subject: 'Rollout planning with the operations team', body: 'Reviewed the support handover and confirmed the first 50 seats.', createdAt: '2026-10-02T04:30:00Z' },
  { id: 1, type: 'pipeline_change', subject: 'Pipeline: Not Categorized → Proposal review', body: 'Proposal shared after the discovery call.', createdAt: '2026-10-01T08:00:00Z' },
];
type MessageFixture = { id: number; direction: string; content: string; status: string; createdAt: string;
  subject?: string; htmlContent?: string; isAiGenerated?: boolean; messageKind?: string; followUpStep?: number;
  sentAt?: string; deliveredAt?: string; readAt?: string };
const conversationFixture: { id: number; channel: string; status: string; subject: string | null;
  totalMessages: number; unreadCount: number; lastMessageAt: string; lastMessagePreview: string; messages: MessageFixture[] }[] = [
  { id: 81, channel: 'email', status: 'replied', subject: 'Your rollout plan & proposal', totalMessages: 2, unreadCount: 1,
    lastMessageAt: '2026-10-02T05:00:00Z', lastMessagePreview: 'Please send the rollout plan. We are ready to review it with the team.',
    messages: [
      { id: 202, direction: 'inbound', content: 'Please send the rollout plan. We are ready to review it with the team.',
        htmlContent: '<p>Please send the <strong>rollout plan</strong>. We are ready to review it with the team.</p><script>window.crmUnsafeHtml = true</script>',
        subject: 'Re: Your rollout plan & proposal', status: 'received', createdAt: '2026-10-02T05:00:00Z' },
      { id: 201, direction: 'outbound', content: 'Hi Priya,\nHere is the proposal for your Q4 support rollout. We can start with 50 seats and expand after the pilot.',
        subject: 'Your rollout plan & proposal', status: 'read', isAiGenerated: true, messageKind: 'follow_up', followUpStep: 1,
        sentAt: '2026-10-01T08:30:00Z', deliveredAt: '2026-10-01T08:31:00Z', readAt: '2026-10-02T04:50:00Z', createdAt: '2026-10-01T08:30:00Z' },
    ] },
  { id: 82, channel: 'whatsapp', status: 'active', subject: null, totalMessages: 1, unreadCount: 0,
    lastMessageAt: '2026-10-01T10:00:00Z', lastMessagePreview: 'Thank you. Friday morning works for our team.',
    messages: [{ id: 203, direction: 'inbound', content: 'Thank you. Friday morning works for our team.', status: 'received', createdAt: '2026-10-01T10:00:00Z' }] },
];
const sentFixture = [{ id: 91, channel: 'email', subject: 'Checking in before Friday’s review', deliveryStatus: 'delivered',
  followUpStep: 1, sentiment: 'positive', message: 'Hi Priya, please let me know if your team needs any changes to the rollout plan.',
  replyContent: 'The team is aligned. Please include the onboarding schedule.', replyReceivedAt: '2026-10-02T04:45:00Z', createdAt: '2026-10-01T07:00:00Z' }];
const ticketFixture = [{ id: 501, ticketNumber: 'SUP-1051', subject: 'Add the onboarding team to the workspace',
  description: 'The customer needs workspace access for three people before the pilot begins.', status: 'waiting_on_customer', priority: 'high', category: 'onboarding',
  slaStatus: 'at_risk', hoursRemaining: 3, unreadCount: 1, totalMessages: 3, updatedAt: '2026-10-02T04:00:00Z',
  messages: [
    { id: 1, direction: 'inbound', content: 'Can you help us invite the onboarding team?', createdAt: '2026-10-01T06:00:00Z' },
    { id: 2, direction: 'outbound', content: 'Yes. Please share their work email addresses and we will add them.', createdAt: '2026-10-01T06:15:00Z' },
    { id: 3, direction: 'outbound', isInternal: true, content: 'Confirm workspace permissions with the account owner before inviting members.', createdAt: '2026-10-02T04:00:00Z',
      attachments: [{ name: 'Onboarding checklist.pdf', url: 'https://files.example/onboarding.pdf' }, { name: 'Unsafe link', url: 'javascript:alert(1)' }] },
  ] }];

const summaryFixture = {counts:{conversations:2,sentMessages:1,activities:2,tickets:1,openTickets:1,unreadConversations:1},owner:{id:4101,name:'Regression Alpha',email:'regression-alpha@example.test'},nextReminder:null,upcomingReminders:[],ticketsDue:[],unansweredConversations:[],stageEnteredAt:'2026-10-01T08:00:00Z'};
const pagination = (total:number) => ({page:1,limit:20,total,totalPages:Math.max(1,Math.ceil(total/20)),hasMore:total>20});

test.beforeEach(async ({ page }) => {
  page.on('dialog',dialog=>void dialog.accept());
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await installAppShellMocks(page);
  await page.route('**/api/crm/assignees',route=>route.fulfill({json:{success:true,data:[summaryFixture.owner]}}));
  await page.route('**/api/crm/reminders?*',route=>route.fulfill({json:{success:true,data:[]}}));
  await page.route('**/api/outreach-conversations/inbox/conversation/81',route=>route.fulfill({json:{success:true,item:{id:81,recipient:contactFixture.email,leadName:'Priya Raman',reply:{canReply:true,accountLabel:'Sales Gmail',providerAccountId:'gmail-44',senderId:44}}}}));
  await page.route('**/api/settings/outreach/assistants/conversations/*/activity?*',route=>route.fulfill({json:{items:[],context:{conversationId:81,assistantId:null,name:'Conversation activity',channel:'email',accountId:'gmail-44',revision:null,mode:'assistant',sessionStatus:'active',playbook:null,followUp:null},nextCursor:null}}));
  await page.route('**/api/crm/configuration', route => route.fulfill({ json: { success: true, data: configuration } }));
  await page.route('**/api/proposals/related?*', route => route.fulfill({ json: [{ id: 12, title: 'Q4 support rollout', status: 'draft' }] }));
});

test('Contact workspace shows readable histories and supports replies, activity, and ticket navigation', async ({ page, audit }) => {
  let activities = structuredClone(activityFixture);
  const conversations = structuredClone(conversationFixture);
  const replies: Record<string, unknown>[] = [];
  await page.route('**/api/crm/contacts/42**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/workspace-summary')) return route.fulfill({json:{success:true,data:summaryFixture}});
    if (path.endsWith('/activities')) {
      if (route.request().method() === 'POST') activities = [{ id: 3, ...route.request().postDataJSON(), createdAt: '2026-10-02T06:00:00Z' }, ...activities];
      return route.fulfill({ json: { success: true, data: activities, pagination:pagination(activities.length) } });
    }
    if (path.endsWith('/conversations')) return route.fulfill({ json: { success:true, conversations, sentMessages: sentFixture, pagination:pagination(conversations.length),sentPagination:pagination(sentFixture.length) } });
    if (path.endsWith('/tickets')) return route.fulfill({ json: { tickets: ticketFixture,pagination:pagination(ticketFixture.length) } });
    return route.fulfill({ json: { success: true, data: contactFixture } });
  });
  await page.route('**/api/outreach-conversations/email/81/messages', async route => {
    const body = route.request().postDataJSON();
    replies.push(body);
    conversations[0].messages.push({ id: 204, direction: 'outbound', content: body.content, subject: body.subject, status: 'sent', createdAt: '2026-10-02T05:30:00Z' });
    conversations[0].totalMessages++;
    await route.fulfill({ json: { success: true } });
  });
  await page.goto('/dashboard/crm/contacts/42');
  await expect(page.getByRole('heading', { name: 'Priya Raman', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Conversations 2', exact: true })).toBeVisible();
  const emailThread = page.getByRole('button', { name: 'Email conversation: Your rollout plan & proposal', exact: true });
  await expect(emailThread).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('article', { name: 'Outbound message', exact: true }).first()).toContainText('50 seats');
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/contact-conversations-${test.info().project.name}.png`);
  const inbound = page.getByRole('article', { name: 'Inbound message', exact: true });
  await inbound.getByRole('button', { name: 'Show full message' }).focus();
  await page.keyboard.press('Enter');
  await expect(inbound.getByRole('button', { name: 'Collapse message' })).toHaveAttribute('aria-expanded', 'true');
  await expect(inbound.locator('strong')).toHaveText('rollout plan');
  await expect(inbound.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => 'crmUnsafeHtml' in window)).toBe(false);
  await page.getByLabel('Reply via Email', { exact: true }).fill('  I’ll send the onboarding schedule today.  ');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.getByLabel('Reply via Email', { exact: true })).toHaveValue('');
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({content:'I’ll send the onboarding schedule today.',subject:'Your rollout plan & proposal',inboxContext:true,expectedRecipient:contactFixture.email,expectedProviderAccountId:'gmail-44',senderId:44,confirmation:{confirmed:true,conversationId:81,recipientConfirmed:true,accountConfirmed:true,messageConfirmed:true}});
  expect(replies[0].idempotencyKey).toEqual(expect.any(String));
  await expect(page.getByRole('article', { name: 'Outbound message', exact: true }).last()).toContainText('onboarding schedule today');

  await page.getByRole('tab', { name: /^Sent/ }).click();
  const sent = page.getByRole('button', { name: 'Email outreach: Checking in before Friday’s review', exact: true });
  await sent.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('The team is aligned. Please include the onboarding schedule.', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/contact-sent-${test.info().project.name}.png`);

  await page.getByRole('tab', { name: /^Activity/ }).click();
  await expect(page.getByRole('list', { name: 'Contact activity' }).getByRole('listitem')).toHaveCount(2);
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/contact-activity-${test.info().project.name}.png`);
  await page.getByRole('button', { name: 'Add activity', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Subject', { exact: true }).fill('Implementation plan confirmed');
  await page.getByRole('dialog').getByLabel('Details', { exact: true }).fill('Customer confirmed a 50-seat pilot.');
  await page.getByRole('dialog').getByRole('button', { name: 'Add activity', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Implementation plan confirmed', exact: true })).toBeVisible();

  await page.getByRole('tab', { name: /^Tickets/ }).click();
  const ticket = page.getByRole('button', { name: 'Ticket SUP-1051: Add the onboarding team to the workspace', exact: true });
  await expect(ticket.locator('a')).toHaveCount(0);
  await ticket.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Internal note', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open ticket', exact: true })).toHaveAttribute('href', '/dashboard/support/501');
  await expect(page.getByRole('link', { name: 'Onboarding checklist.pdf' })).toHaveAttribute('href', 'https://files.example/onboarding.pdf');
  await expect(page.getByRole('link', { name: 'Unsafe link' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/contact-tickets-${test.info().project.name}.png`);
  await page.getByText('Internal note', { exact: true }).scrollIntoViewIfNeeded();
  await captureCrmScreenshot(page, `${screenshotDirectory}/contact-ticket-messages-${test.info().project.name}.png`);
  if (test.info().project.name.startsWith('mobile')) {
    await page.getByRole('button',{name:'Contact details',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'Contact overview'})).toBeVisible();
    await captureCrmScreenshot(page, `${screenshotDirectory}/contact-overview-${test.info().project.name}.png`);
  }
  expect(audit.consoleErrors).toEqual([]);
});

test('Contact editing preserves the draft on failure, discards safely, and saves profile and stage changes', async ({ page, audit }) => {
  let contact = { ...contactFixture };
  let failSave = true;
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/crm/contacts/42**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/workspace-summary')) return route.fulfill({json:{success:true,data:summaryFixture}});
    if (path.endsWith('/activities')) return route.fulfill({ json: { success: true, data: [] } });
    if (path.endsWith('/conversations')) return route.fulfill({ json: { conversations: [], sentMessages: [] } });
    if (path.endsWith('/tickets')) return route.fulfill({ json: { tickets: [] } });
    if (request.method() !== 'GET') {
      if (failSave) return route.fulfill({ status: 500, json: { error: 'Contact update temporarily unavailable.' } });
      const body = request.postDataJSON();
      writes.push({ method: request.method(), body });
      contact = { ...contact, ...body };
    }
    return route.fulfill({ json: { success: true, data: contact } });
  });
  await page.goto('/dashboard/crm/contacts/42');
  await page.getByRole('button', { name: 'Edit contact', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Company', { exact: true }).fill('Discarded company');
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Edit contact', exact: true }).click();
  await expect(dialog.getByLabel('Company', { exact: true })).toHaveValue(contactFixture.company);
  await dialog.getByLabel('Company', { exact: true }).fill('Harbor Commerce');
  await dialog.getByLabel('Deal Value (INR)', { exact: true }).fill('');
  await dialog.getByLabel('Pipeline Status', { exact: true }).click();
  await page.getByRole('option', { name: 'Contract accepted', exact: true }).click();
  await dialog.getByLabel('First Name', { exact: true }).scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page, `${screenshotDirectory}/contact-edit-${test.info().project.name}.png`);
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Contact update temporarily unavailable.', { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Company', { exact: true })).toHaveValue('Harbor Commerce');
  failSave = false;
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Contract accepted', { exact: true }).first()).toBeVisible();
  expect(writes.map(write => write.method)).toEqual(['PUT']);
  expect(writes[0].body).toMatchObject({ company: 'Harbor Commerce', dealValue: null });
  expect(writes[0].body).toMatchObject({pipelineStatus:'accepted',expectedUpdatedAt:contactFixture.updatedAt});
  expect(writes[0].body).not.toHaveProperty('status');
  expect(audit.consoleErrors.filter(error => !error.includes('500'))).toEqual([]);
});

test('Contact histories recover from load failures without presenting false empty states', async ({ page }) => {
  let failHistory = true;
  await page.route('**/api/crm/contacts/42**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/workspace-summary')) return route.fulfill({json:{success:true,data:summaryFixture}});
    if (/\/(activities|conversations|tickets)$/.test(path)) {
      if (failHistory) return route.fulfill({ status: 503, json: { error: 'History unavailable' } });
      const data = path.endsWith('/activities') ? activityFixture : path.endsWith('/tickets') ? { tickets: ticketFixture,pagination:pagination(ticketFixture.length) } : { conversations: conversationFixture, sentMessages: sentFixture };
      return route.fulfill({ json: { success: true, data } });
    }
    return route.fulfill({ json: { success: true, data: contactFixture } });
  });
  await page.goto('/dashboard/crm/contacts/42');
  await expect(page.getByText('History unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('No conversations yet', { exact: true })).toHaveCount(0);
  failHistory = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Email conversation: Your rollout plan & proposal' })).toBeVisible();
  await page.getByRole('tab', { name: /^Activity/ }).click();
  await expect(page.getByRole('heading', { name: 'Rollout planning with the operations team' })).toBeVisible();
  await page.getByRole('tab', { name: /^Tickets/ }).click();
  await expect(page.getByRole('button', { name: 'Ticket SUP-1051: Add the onboarding team to the workspace' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('Contact history filters, stable older-message cursors, timeline links and held drafts work together', async ({page,audit})=>{
  const queries:URLSearchParams[]=[];
  const cursors:string[]=[];
  const conversation={...conversationFixture[0],providerAccountId:'gmail-44',providerAccountName:'Sales Gmail',totalMessages:41,messagesHasMore:true};
  await page.route('**/api/crm/contacts/42**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/workspace-summary'))return route.fulfill({json:{success:true,data:summaryFixture}});
    if(url.pathname.endsWith('/messages')){
      cursors.push(url.searchParams.get('beforeMessageId') || '');
      const more=cursors.length===1;
      return route.fulfill({json:{success:true,data:[{id:more ? 150 : 100,conversationId:81,direction:'inbound',content:more ? 'Older discovery notes' : 'First introduction',status:'received',createdAt:more ? '2026-09-28T08:00:00Z' : '2026-09-20T08:00:00Z'}],pagination:{page:1,limit:20,total:41,totalPages:3,hasMore:more}}});
    }
    if(url.pathname.endsWith('/conversations')){
      queries.push(url.searchParams);
      return route.fulfill({json:{success:true,conversations:[conversation],sentMessages:[],pagination:pagination(1),sentPagination:pagination(0)}});
    }
    if(url.pathname.endsWith('/timeline'))return route.fulfill({json:{success:true,data:[{id:'automation:51',kind:'automation',type:'automation',subject:'Follow-up automation',body:'Customer context was checked before the run.',createdAt:'2026-10-02T05:00:00Z',actor:{id:4101,name:'Regression Alpha'},related:{url:'/dashboard/crm/automations/1/runs?run=51',label:'Review run'}}],pagination:pagination(1)}});
    return route.fulfill({json:{success:true,data:contactFixture}});
  });
  await page.route('**/api/outreach-conversations/email/81/messages',route=>route.fulfill({json:{success:true,manualReviewRequired:true}}));
  await page.goto('/dashboard/crm/contacts/42');
  await expect(page.getByText('1 unread conversations',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Load older messages',exact:true}).click();
  await expect(page.getByText('Older discovery notes',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Load older messages',exact:true}).click();
  await expect(page.getByText('First introduction',{exact:true})).toBeVisible();
  expect(cursors).toEqual(['201','150']);
  await expect(page.getByRole('button',{name:'Load older messages',exact:true})).toHaveCount(0);
  await page.getByLabel('Reply via Email',{exact:true}).fill('Draft for this sending account');
  await page.getByRole('tab',{name:'Timeline',exact:true}).click();
  await expect(page).toHaveURL(/tab=timeline/);
  await expect(page.getByRole('link',{name:'Review run',exact:true})).toHaveAttribute('href','/dashboard/crm/automations/1/runs?run=51');
  await expect(page.getByRole('list',{name:'Combined contact timeline'})).toContainText('Regression Alpha');
  await captureCrmScreenshot(page,`${screenshotDirectory}/contact-timeline-${test.info().project.name}.png`);
  await page.getByRole('tab',{name:/^Conversations/}).click();
  await expect(page.getByLabel('Reply via Email',{exact:true})).toHaveValue('Draft for this sending account');
  await page.getByLabel('History channel',{exact:true}).selectOption('email');
  await page.getByRole('checkbox',{name:'Unread only',exact:true}).check();
  await page.getByLabel('History from date',{exact:true}).fill('2026-10-01');
  await page.getByLabel('History to date',{exact:true}).fill('2026-10-02');
  await page.getByRole('searchbox',{name:'Search contact history'}).fill('rollout');
  await expect.poll(()=>queries.some(query=>query.get('search')==='rollout' && query.get('channel')==='email' && query.get('unread')==='true' && query.get('from')==='2026-09-30T18:30:00.000Z' && query.get('to')==='2026-10-02T18:30:00.000Z')).toBe(true);
  await page.getByRole('button',{name:'Reply',exact:true}).click();
  await expect(page.getByText('Delivery needs review. Check the message in the inbox before sending again.',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Reply via Email',{exact:true})).toHaveValue('Draft for this sending account');
  await expect(page.getByRole('button',{name:'Reply',exact:true})).toBeDisabled();
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page,`${screenshotDirectory}/contact-held-reply-${test.info().project.name}.png`);
  expect(audit.consoleErrors).toEqual([]);
});

test('Contact follow-ups, contextual ticket notes and the full editor preserve the reviewed contact',async({page,audit})=>{
  let contact={...contactFixture};
  const contactWrites:Record<string,unknown>[]=[];
  const reminderWrites:Record<string,unknown>[]=[];
  const ticketWrites:Record<string,unknown>[]=[];
  const reminders:Record<string,unknown>[]=[];
  await page.route('**/api/crm/contacts/42**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/workspace-summary'))return route.fulfill({json:{success:true,data:summaryFixture}});
    if(path.endsWith('/conversations'))return route.fulfill({json:{success:true,conversations:[],sentMessages:[],pagination:pagination(0)}});
    if(path.endsWith('/tickets'))return route.fulfill({json:{success:true,tickets:ticketFixture,pagination:pagination(1)}});
    if(route.request().method()==='PUT'){const body=route.request().postDataJSON();contactWrites.push(body);contact={...contact,...body};}
    return route.fulfill({json:{success:true,data:contact}});
  });
  await page.route('**/api/crm/reminders**',route=>{
    if(route.request().method()==='POST'){const body=route.request().postDataJSON();reminderWrites.push(body);reminders.push({id:91,status:'pending',createdAt:new Date().toISOString(),contactName:'Priya Raman',assignedName:'Regression Alpha',metadata:{notifyContact:body.notifyContact},...body});return route.fulfill({json:{success:true,data:reminders[0]}});}
    return route.fulfill({json:{success:true,data:reminders}});
  });
  await page.route('**/api/support/501**',route=>{ticketWrites.push(route.request().postDataJSON());return route.fulfill({json:{success:true}});});
  await page.goto('/dashboard/crm/contacts/42?tab=tickets');
  await page.getByRole('button',{name:'Follow up',exact:true}).click();
  const reminderDialog=page.getByRole('dialog',{name:'Add Reminder',exact:true});
  await reminderDialog.getByLabel('Title *',{exact:true}).fill('Review onboarding plan');
  await reminderDialog.getByLabel('Due Date *',{exact:true}).fill('2027-01-15T10:30');
  await reminderDialog.getByLabel('Assigned to',{exact:true}).selectOption('4101');
  await expect(reminderDialog.getByRole('switch',{name:'Email Priya Raman',exact:true})).not.toBeChecked();
  await reminderDialog.getByRole('button',{name:'Add Reminder',exact:true}).click();
  await expect(reminderDialog).not.toBeVisible();
  expect(reminderWrites).toHaveLength(1);expect(reminderWrites[0]).toMatchObject({contactId:42,assignedTo:4101,notifyContact:false,dueDate:'2027-01-15T05:00:00.000Z'});
  await page.getByRole('button',{name:'Ticket SUP-1051: Add the onboarding team to the workspace',exact:true}).click();
  await page.getByRole('button',{name:'Add internal note',exact:true}).click();
  await page.getByLabel('Internal note · visible to your team',{exact:true}).fill('Coordinate with the workspace owner.');
  await page.getByRole('button',{name:'Add note',exact:true}).click();
  await expect(page.getByText('Internal note added',{exact:true})).toBeVisible();
  expect(ticketWrites[0]).toEqual({content:'Coordinate with the workspace owner.',isInternal:true});
  await page.getByLabel('Ticket status',{exact:true}).selectOption('resolved');
  await page.getByRole('button',{name:'Save status',exact:true}).click();
  await expect(page.getByText('Ticket status updated',{exact:true})).toBeVisible();
  expect(ticketWrites[1]).toEqual({status:'resolved'});
  await page.goto('/dashboard/crm/contacts/42/edit');
  await expect(page.getByRole('heading',{name:'Edit Priya Raman',exact:true})).toBeVisible();
  await page.getByLabel('Company',{exact:true}).fill('Harbor Growth');
  await page.getByLabel('Assigned owner',{exact:true}).selectOption('4101');
  await expectNoHorizontalOverflow(page);
  await captureCrmScreenshot(page,`${screenshotDirectory}/contact-full-editor-${test.info().project.name}.png`);
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page).toHaveURL(/\/dashboard\/crm\/contacts\/42$/);
  await expect(page.getByText('Harbor Growth',{exact:true}).first()).toBeVisible();
  expect(contactWrites).toHaveLength(1);expect(contactWrites[0]).toMatchObject({company:'Harbor Growth',assignedTo:4101,expectedUpdatedAt:contactFixture.updatedAt,pipelineStatus:'review'});
  expect(audit.consoleErrors).toEqual([]);
});
