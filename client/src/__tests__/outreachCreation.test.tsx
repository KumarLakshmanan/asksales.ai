import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
vi.mock('@/hooks/use-outreach-draft-scope', () => ({ useOutreachDraftScope: () => navigation.scope }));
import { act, cleanup, fireEvent, render as testingRender, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFollowUpSaveRecoveryForTests } from '@/lib/follow-up-save-recovery';
import { resetOutreachComposerDraftsForTests } from '@/lib/outreach-composer-draft-store';
import api from "@/lib/api";
import { ApiError } from '@/lib/api-client';
import { SendOutreachWidget } from '@/components/widgets/SendOutreachWidget';
import type { WidgetState } from '@/components/widgets/types';
import { OutreachCreationPage } from "@/components/outreach/create/OutreachCreationPage";
import { CreateConversationDialog } from "@/components/crm/CreateConversationDialog";
import {
  buildOutreachTemplate,
  personalizeOutreach,
  type OutreachRecipient,
} from "../../../shared/outreachCompose";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams(), scope: 'synthetic:4102' }));
const navigate = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useSearchParams: () => navigation.params,
  useRouter: () => ({ push: navigate, replace: navigate }),
  usePathname: () => "/dashboard/outreach/create",
}));
vi.mock("@/components/outreach/TemplateSelector", () => ({ TemplateSelector: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), postForm: vi.fn(), upload: vi.fn(), put: vi.fn() },
}));

const ada: OutreachRecipient = {
  id: 1,
  name: "Ada Lovelace",
  firstName: "Ada",
  lastName: "Lovelace",
  company: "Analytical Engines",
  email: "ada@example.com",
  phone: "919876543210",
  recipient: "ada@example.com",
  eligible: true,
  reason: null,
};
const blocked: OutreachRecipient = {
  ...ada,
  id: 2,
  name: "Grace Hopper",
  email: "",
  recipient: "",
  eligible: false,
  reason: "Add a valid email address to this contact.",
};
const template = {
  id: "tpl-1",
  name: "welcome",
  language: "en_US",
  body: "Hello {{1}}, welcome to {{2}}.",
  headerType: "IMAGE",
  buttons: [
    { type: "URL", text: "View details", url: "https://example.com/{{1}}" },
  ],
};

beforeEach(() => {
  resetFollowUpSaveRecoveryForTests();
  resetOutreachComposerDraftsForTests();
  navigation.params = new URLSearchParams();
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  navigation.scope = 'synthetic:4102';
  vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    const query = new URL(url, "https://test.example").searchParams;
    if (url.endsWith('/settings/outreach/email-designs')) return { canManage: true, preferences: { outreach: 'classic', assistant: 'classic', revision: 'synthetic-designs' }, brand: { companyName: 'Synthetic business', logoUrl: null, primaryColor: '#2563eb' } } as never;
    if (url.includes('/settings/integrations/') && url.endsWith('/follow-ups'))
      return { revision: 'initial-synthetic-fence', fenced: true, enableAutoFollowUp: false, followUpSteps: [{ id: 1, delayValue: 1, delayUnit: 'days', delayHours: 24, templateId: null, templateName: '' }] } as never;
    if (url.includes("/compose/options"))
      return {
        channel: query.get("channel"),
        accounts: [
          {
            id: "sender-1",
            senderId: query.get("channel") === "sms" ? undefined : 7,
            providerAccountId: query.get("channel") === "sms" ? "ORCHID" : "account-1",
            label: query.get("channel") === "sms" ? "MSG91 - ORCHID" : "sales@example.com",
            isDefault: true,
            ready: true,
            reason: null,
            assistant: { ready: true, setupUrl: '/dashboard/settings/outreach/assistants/ready-one', assistantId: 'ready-one', assistantName: 'Reviewed assistant', accountId: 'account-1', channel: query.get('channel') || 'email' },
          },
        ],
      } as never;
    if (url.includes('/compose/import-sources')) return { campaigns: [], crmImports: [] } as never;
    if (url.includes("/compose/recipients")) {
      const channel = query.get("channel");
      const recipients = [
        channel === "email"
          ? ada
          : {
              ...ada,
              recipient: channel === "whatsapp" || channel === "sms" ? ada.phone : "123456",
              requiresTemplate: channel === "whatsapp",
            },
        blocked,
      ];
      const ids = query.get("ids")?.split(",").map(Number);
      return {
        recipients: ids
          ? recipients.filter((item) => ids.includes(item.id))
          : recipients,
        nextCursor: null,
      } as never;
    }
    if (url.includes("/compose/templates"))
      return { templates: [template] } as never;
    return [] as never;
  });
  vi.mocked(api.post).mockImplementation(async (url: string) =>
    url.endsWith("/bulk")
      ? ({
          success: true,
          total: 1,
          queued: 1,
          errors: 0,
          results: [
            { leadId: 1, messageId: 11, conversationId: 9, status: "queued" },
          ],
        } as never)
      : ((url.endsWith("/compose/contact") ? { leadId: 1 } : {}) as never),
  );
});
afterEach(cleanup);

async function composeEmail() {
  const user = userEvent.setup();
  render(<OutreachCreationPage />);
  await screen.findByLabelText("Select Ada Lovelace");
  await user.click(screen.getByLabelText("Select Ada Lovelace"));
  await user.type(screen.getByLabelText("Subject"), "Hello");
  await user.type(screen.getByLabelText("Message body"), "Hi Ada, welcome.");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Review outreach" }),
    ).toBeEnabled(),
  );
  return user;
}

describe("unified outreach creation", () => {
  it('opens the prepared WhatsApp review with its exact account, template and follow-up while consent and sending remain explicit',async()=>{
    const original=vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async(url,options)=>url.includes('/compose/templates') ? {templates:[{id:'approved-stay',name:'approved_stay',language:'en',body:'Approved offer'}]} as never : original(url,options));
    render(<OutreachCreationPage embedded={{standalone:true,reviewOnLoad:true,initial:{channel:'whatsapp',leadIds:[1],accountId:'sender-1',providerAccountId:'account-1',
      templateId:'approved-stay',templateValues:{},optInConfirmed:false,followUps:{whatsapp:{enabled:true,steps:[{id:'reminder',delayValue:1440,delayUnit:'minutes',templateId:'approved-stay',templateValues:{},message:'',subject:''}]}}}}}/>);
    expect(await screen.findByRole('heading',{name:'Review outreach'})).toBeInTheDocument();
    expect(screen.getByText('1 follow-ups for this outreach only.')).toBeInTheDocument();
    const send=screen.getByRole('button',{name:'Send to 1 recipient'});expect(send).toBeDisabled();
    await userEvent.setup().click(screen.getByRole('checkbox',{name:/These recipients have agreed/}));
    await waitFor(()=>expect(send).toBeEnabled());
    expect(vi.mocked(api.post).mock.calls.filter(([url])=>url.endsWith('/bulk'))).toHaveLength(0);
    expect(vi.mocked(api.get).mock.calls.some(([url])=>url.includes('/compose/templates') && url.includes('providerAccountId=account-1'))).toBe(true);
  });
  it('does not replace an unavailable saved sending account with the current default',async()=>{
    render(<OutreachCreationPage embedded={{standalone:true,reviewOnLoad:true,initial:{channel:'email',leadIds:[1],accountId:'removed-sender',providerAccountId:'old-account',subject:'Saved subject',body:'Saved message'}}}/>);
    expect(await screen.findByText('The selected sending account is unavailable. Choose a connected account before reviewing.')).toBeInTheDocument();
    expect(screen.getByLabelText('Send from')).toHaveValue('');
    expect(screen.queryByRole('button',{name:'Send to 1 recipient'})).not.toBeInTheDocument();
  });
  it('selects the full shown import in one action without a 500-recipient cutoff', async () => {
    const originalGet=vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async(url,options)=>{
      if(url.includes('/compose/recipients')) {
        const selected=new URL(url,'https://test.example').searchParams.get('ids');
        const ids=selected ? selected.split(',').map(Number) : Array.from({length:575},(_,index)=>index+1);
        return {recipients:ids.map(id=>({...ada,id,name:`Imported guest ${id}`})),nextCursor:null} as never;
      }
      return originalGet(url,options);
    });
    const originalPost=vi.mocked(api.post).getMockImplementation()!;
    vi.mocked(api.post).mockImplementation(async(url,payload,...rest)=>url.endsWith('/recipients/review') ? {recipients:(payload as {ids:number[]}).ids.map(id=>({...ada,id,name:`Imported guest ${id}`}))} as never : originalPost(url,payload,...rest));
    const user=userEvent.setup();render(<OutreachCreationPage/>);
    const button=await screen.findByRole('button',{name:'Select shown contacts (575)'});
    await waitFor(()=>expect(button).toBeEnabled());await user.click(button);
    await waitFor(()=>expect(screen.getByText('Recipients',{exact:true}).parentElement).toHaveTextContent('575 ready'),{timeout:10000});
    expect(screen.getByRole('checkbox',{name:'Select Imported guest 575'})).toBeChecked();
    expect(vi.mocked(api.post).mock.calls.filter(([url])=>url.endsWith('/bulk'))).toHaveLength(0);
  }, 20000);

  it('keeps all 575 selected recipients and refreshes readiness with one request per review', async () => {
    const ids = Array.from({length:575},(_,index)=>index+1);
    const originalGet=vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async(url,options)=>{
      if(url.includes('/compose/recipients')) {
        const selected=new URL(url,'https://test.example').searchParams.get('ids');
        if(selected) return {recipients:selected.split(',').map(Number).map(id=>({...ada,id,name:`Guest ${id}`})),nextCursor:null} as never;
      }
      return originalGet(url,options);
    });
    const originalPost=vi.mocked(api.post).getMockImplementation()!;
    vi.mocked(api.post).mockImplementation(async(url,payload,...rest)=>url.endsWith('/recipients/review') ? {recipients:(payload as {ids:number[]}).ids.map(id=>({...ada,id,name:`Guest ${id}`}))} as never : originalPost(url,payload,...rest));
    render(<OutreachCreationPage embedded={{initial:{channel:'email',leadIds:ids,subject:'Approved offer',body:'Hello guest'},onChange:vi.fn()}}/>);
    await waitFor(()=>expect(screen.getByText('Recipients',{exact:true}).parentElement).toHaveTextContent('575 ready'),{timeout:10000});
    const checks=vi.mocked(api.post).mock.calls.filter(([url])=>url.endsWith('/recipients/review'));
    expect(checks).toHaveLength(1);expect((checks[0][1] as {ids:number[]}).ids).toEqual(ids);
    expect(screen.getByRole('button',{name:'Review outreach'})).toBeEnabled();
    await userEvent.setup().click(screen.getByRole('button',{name:'Review outreach'}));
    await screen.findByRole('button',{name:'Edit outreach'});
    const reviewedChecks=vi.mocked(api.post).mock.calls.filter(([url])=>url.endsWith('/recipients/review'));
    expect(reviewedChecks).toHaveLength(2);expect((reviewedChecks[1][1] as {ids:number[]}).ids).toEqual(ids);
    expect(vi.mocked(api.post).mock.calls.filter(([url])=>url.endsWith('/bulk'))).toHaveLength(0);
  });

  it.each(['email','whatsapp'] as const)('keeps a 30,202-contact %s review bounded in the DOM while every recipient remains selected and searchable',async channel=>{
    const ids=Array.from({length:30202},(_,index)=>index+1);
    const originalGet=vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async(url,...rest)=>url.includes('/compose/templates') ? {templates:[{id:'diwali-approved',name:'diwali2026',language:'en',body:'Diwali Retreat at ORO Resorts. Starting from ₹40,000.',headerType:'IMAGE'}]} as never : originalGet(url,...rest));
    const originalPost=vi.mocked(api.post).getMockImplementation()!;
    vi.mocked(api.post).mockImplementation(async(url,payload,...rest)=>{
      if(url.endsWith('/recipients/review'))return {recipients:(payload as {ids:number[]}).ids.map(id=>({...ada,id,name:`Guest ${id}`,email:`guest${id}@example.test`,phone:String(919000000000+id),recipient:channel==='whatsapp' ? String(919000000000+id) : `guest${id}@example.test`,requiresTemplate:channel==='whatsapp'}))} as never;
      if(url.endsWith('/bulk'))return {success:true,total:ids.length,queued:ids.length,errors:0,results:ids.map(id=>({leadId:id,messageId:id,conversationId:id,status:'queued'}))} as never;
      return originalPost(url,payload,...rest);
    });
    render(<OutreachCreationPage embedded={{standalone:true,preparedOutreachId:'prepared-synthetic',initial:{channel,accountId:'sender-1',providerAccountId:'account-1',leadIds:ids,subject:'Approved offer',body:'Hello guest',templateId:'diwali-approved',templateValues:{mediaId:'synthetic-image'},whatsappMode:'template',optInConfirmed:true}}}/>);
    await waitFor(()=>expect(screen.getByText('Recipients',{exact:true}).parentElement).toHaveTextContent('30202 ready'),{timeout:10000});
    expect(screen.getAllByRole('button',{name:/^Remove .* from recipients$/})).toHaveLength(50);
    await userEvent.setup().click(screen.getByRole('button',{name:'Next selected contacts'}));
    expect(screen.getByRole('button',{name:'Remove Guest 51 from recipients'})).toBeInTheDocument();
    expect(screen.getByText('Showing 51–100 of 30202 selected contacts')).toBeInTheDocument();
    if(channel==='whatsapp') {
      expect(within(await screen.findByLabelText('Preview recipient while composing')).getAllByRole('option').length).toBeLessThanOrEqual(101);
      await userEvent.setup().type(screen.getByLabelText('Search recipient previews'),'Guest 30202');
      expect(within(screen.getByLabelText('Preview recipient while composing')).getByRole('option',{name:'Guest 30202'})).toBeInTheDocument();
    }
    await userEvent.setup().click(screen.getByRole('button',{name:'Review outreach'}));
    await screen.findByRole('button',{name:'Send to 30202 recipients'});
    expect(within(screen.getByLabelText('Preview for')).getAllByRole('option').length).toBeLessThanOrEqual(101);
    await userEvent.setup().clear(screen.getByLabelText('Search recipient previews'));
    await userEvent.setup().type(screen.getByLabelText('Search recipient previews'),'Guest 30202');
    expect(within(screen.getByLabelText('Preview for')).getByRole('option',{name:'Guest 30202'})).toBeInTheDocument();
    expect(vi.mocked(api.post).mock.calls.filter(([url])=>url.endsWith('/bulk'))).toHaveLength(0);
    await userEvent.setup().click(screen.getByRole('button',{name:'Send to 30202 recipients'}));
    await screen.findByRole('heading',{name:'Outreach queued',level:1});
    expect((vi.mocked(api.post).mock.calls.find(([url])=>url.endsWith('/bulk'))![1] as {messages:unknown[]}).messages).toHaveLength(30202);
    if(channel==='whatsapp') {
      const payload=vi.mocked(api.post).mock.calls.find(([url])=>url.endsWith('/bulk'))![1] as {messages:Array<{templateName:string;templateComponents:unknown[]}>;whatsappOptInConfirmed:boolean};
      expect(payload.whatsappOptInConfirmed).toBe(true);expect(payload.messages.every(item=>item.templateName==='diwali2026')).toBe(true);
      expect(payload.messages[0].templateComponents).toEqual([{type:'header',parameters:[{type:'image',image:{id:'synthetic-image'}}]}]);
    }
    expect(screen.getAllByRole('link',{name:'Open conversation'})).toHaveLength(50);
    await userEvent.setup().click(screen.getByRole('button',{name:'Next receipt results'}));
    expect(screen.getByText('Showing 51–100 of 30202 receipt results')).toBeInTheDocument();
    expect(screen.getByRole('link',{name:'View campaign report'})).toHaveAttribute('href','/dashboard/outreach/reports?preparedOutreachId=prepared-synthetic');
  },20000);

  it.each(['success', 'failure'])('holds an off-list selected contact 31 until its independent readiness read settles with %s', async outcome => {
    const emailContact = { ...ada, id: 31, eligible: outcome === 'success', reason: outcome === 'success' ? null : 'Email-only selected-contact issue.' };
    const visible = { ...ada, id: 2, name: 'Visible Instagram contact' };
    const currentContact = { ...ada, id: 31, recipient: 'instagram-thread-ada', eligible: outcome === 'success', reason: outcome === 'success' ? null : 'The reply window has closed for this selected contact.' };
    let releaseFirst!: () => void, releaseRetry!: () => void;
    const firstRead = new Promise<void>(resolve => { releaseFirst = resolve; });
    const retryRead = new Promise<void>(resolve => { releaseRetry = resolve; });
    let selectedChecks = 0, listChecks = 0;
    const originalGet = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (url, options) => {
      const query = new URL(url, 'https://test.example').searchParams;
      if (url.includes('/compose/recipients')) {
        if (query.get('channel') === 'email') return { recipients: [emailContact], nextCursor: null } as never;
        if (query.get('channel') === 'instagram') {
          if (!query.has('ids')) { listChecks++; return { recipients: [visible], nextCursor: null } as never; }
          expect(query.get('ids')).toBe('31');
          if (query.get('providerAccountId') === 'account-1') {
            const check = ++selectedChecks;
            if (check === 1) {
              await firstRead;
              if (outcome === 'failure') throw new Error('Selected contact check failed.');
            } else if (check === 2 && outcome === 'failure') await retryRead;
          }
          return { recipients: [currentContact] } as never;
        }
      }
      return originalGet(url, options);
    });
    const user = userEvent.setup(); render(<OutreachCreationPage />);
    try {
      await user.click(await screen.findByRole('checkbox', { name: 'Select Ada Lovelace' }));
      if (outcome === 'failure') await screen.findByText('Ada Lovelace: Email-only selected-contact issue.');
      else await waitFor(() => expect(screen.getByText('Recipients', { exact: true }).parentElement).toHaveTextContent('1 ready'));
      await user.click(screen.getByRole('button', { name: 'Instagram' }));
      await screen.findByRole('checkbox', { name: 'Select Visible Instagram contact' });
      await waitFor(() => expect(selectedChecks).toBe(1));
      await user.type(screen.getByLabelText('Message body'), 'Retained Instagram draft.');
      expect(screen.queryByRole('checkbox', { name: 'Select Ada Lovelace' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remove Ada Lovelace from recipients' })).toBeInTheDocument();
      const summary = screen.getByText('Recipients', { exact: true }).parentElement!;
      expect(summary).toHaveTextContent('1 selected');
      expect(summary).not.toHaveTextContent(/ ready| blocked/);
      expect(screen.queryAllByText(/Email-only selected-contact issue/)).toHaveLength(0);
      expect(screen.getByRole('button', { name: 'Review outreach' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: /Send to/ })).not.toBeInTheDocument();
      await act(async () => { releaseFirst(); });
      if (outcome === 'failure') {
        await screen.findByText('Selected contact check failed.');
        expect(summary).not.toHaveTextContent(/ ready| blocked/);
        expect(screen.queryAllByText(/Email-only selected-contact issue/)).toHaveLength(0);
        expect(screen.getByRole('button', { name: 'Review outreach' })).toBeDisabled();
        const previousListChecks = listChecks;
        await user.click(screen.getByRole('button', { name: 'Retry selected contacts' }));
        await waitFor(() => expect(selectedChecks).toBe(2));
        expect(listChecks).toBe(previousListChecks);
        expect(screen.getByRole('button', { name: 'Review outreach' })).toBeDisabled();
        await act(async () => { releaseRetry(); });
        await screen.findByText('Ada Lovelace: The reply window has closed for this selected contact.');
        expect(summary).toHaveTextContent('0 ready · 1 blocked');
      } else {
        await waitFor(() => expect(summary).toHaveTextContent('1 ready'));
      }
      expect(screen.getByLabelText('Message body')).toHaveTextContent('Retained Instagram draft.');
      await user.click(screen.getByRole('button', { name: 'Review outreach' }));
      expect(await screen.findByRole('button', { name: outcome === 'success' ? 'Send to 1 recipient' : 'Send to 0 recipients' }))
        .toHaveProperty('disabled', outcome === 'failure');
      expect(vi.mocked(api.post).mock.calls.filter(([url]) => url === '/api/outreach-conversations/bulk')).toHaveLength(0);
    } finally { await act(async () => { releaseFirst(); releaseRetry(); }); }
  });

  it.each(['accounts', 'recipients'])('hides stale channel readiness when %s finishes first during Email to WhatsApp switching', async first => {
    const error = 'Customer delivery is blocked because the assistant runtime is disabled.';
    const rows = (reason: string) => [
      ...Array.from({ length: 50 }, (_, index) => ({ ...ada, id: index + 1, name: `Transition contact ${index + 1}`, eligible: false, reason: error })),
      { ...blocked, id: 51, name: 'Contact needing attention', reason },
    ];
    let releaseAccounts!: () => void, releaseRecipients!: () => void;
    const accountsPending = new Promise<void>(resolve => { releaseAccounts = resolve; });
    const recipientsPending = new Promise<void>(resolve => { releaseRecipients = resolve; });
    const originalGet = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (url, options) => {
      const query = new URL(url, 'https://test.example').searchParams;
      const channel = query.get('channel');
      if (url.includes('/compose/options')) {
        if (channel === 'whatsapp') await accountsPending;
        const deliveryBlock = { ready: false, code: 'ASSISTANT_SETUP_REQUIRED', reason: 'runtime_disabled', error, setupUrl: '/dashboard/settings/outreach', accountId: '', channel };
        return { channel, deliveryBlock, accounts: channel === 'whatsapp' ? [] : [{ id: 'sender-1', senderId: 7, providerAccountId: 'account-1', label: 'sales@example.com', isDefault: true, ready: false, reason: error, assistant: deliveryBlock }] } as never;
      }
      if (url.includes('/compose/recipients')) {
        if (channel === 'whatsapp') await recipientsPending;
        const contacts = rows(channel === 'whatsapp' ? 'WhatsApp-specific readiness issue.' : 'Email-only readiness issue.');
        const ids = query.get('ids')?.split(',').map(Number);
        return { recipients: ids ? contacts.filter(item => ids.includes(item.id)) : contacts, nextCursor: null } as never;
      }
      return originalGet(url, options);
    });
    const user = userEvent.setup(); render(<OutreachCreationPage />);
    try {
      await screen.findByText('Email-only readiness issue.');
      await user.click(screen.getByRole('checkbox', { name: 'Select Contact needing attention' }));
      await user.click(screen.getByRole('button', { name: 'WhatsApp' }));
      await waitFor(() => expect(vi.mocked(api.get).mock.calls.some(([url]) => url.includes('/compose/recipients?') && url.includes('channel=whatsapp') && !url.includes('ids='))).toBe(true));
      if (first === 'accounts') {
        await act(async () => { releaseAccounts(); });
        await screen.findByText('Connect a WhatsApp account to start sending.');
        expect(screen.getAllByText(error)).toHaveLength(1);
      } else {
        await act(async () => { releaseRecipients(); });
        await waitFor(() => expect(screen.queryByText('Checking sending accounts…')).toBeInTheDocument());
        expect(screen.queryAllByText(error)).toHaveLength(0);
      }
      expect(screen.queryAllByText(/Email-only readiness issue/)).toHaveLength(0);
      expect(screen.queryByText('WhatsApp-specific readiness issue.')).not.toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Select Contact needing attention' })).toBeChecked();
      expect(screen.getByRole('button', { name: 'Review outreach' })).toBeDisabled();
      await act(async () => { releaseAccounts(); releaseRecipients(); });
      await screen.findByText('WhatsApp-specific readiness issue.');
      expect(screen.queryAllByText(/Email-only readiness issue/)).toHaveLength(0);
      expect(screen.getAllByText(error)).toHaveLength(1);
      expect(screen.getByRole('region', { name: 'Customer delivery blocked' })).toBeInTheDocument();
      expect(screen.getByText('Connect a WhatsApp account to start sending.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Review outreach' })).toBeDisabled();
      expect(vi.mocked(api.post).mock.calls.filter(([url]) => url === '/api/outreach-conversations/bulk')).toHaveLength(0);
    } finally { await act(async () => { releaseAccounts(); releaseRecipients(); }); }
  });

  it.each([
    ['whatsapp', 'WhatsApp', 'runtime_disabled', 'Customer delivery is blocked because the assistant runtime is disabled.', 'Add a WhatsApp number with its country code.'],
    ['facebook', 'Messenger', 'runtime_disabled', 'Customer delivery is blocked because the assistant runtime is disabled.', 'This contact needs to message the connected account first.'],
    ['sms', 'SMS', 'unsupported_channel', 'Customer delivery on sms requires a supported assistant account assignment. This channel is blocked until assistant binding is supported.', 'Add a valid SMS phone number with its country code.'],
  ])('consolidates the channel block for %s without a connected account and retains contact reasons', async (channel, label, reason, error, contactReason) => {
    navigation.params = new URLSearchParams(`channel=${channel}`);
    const contacts = [
      ...Array.from({ length: 50 }, (_, index) => ({ ...ada, id: index + 1, name: `Blocked contact ${index + 1}`, eligible: false, reason: error })),
      { ...blocked, id: 51, name: 'Opted-out contact', reason: 'This contact has opted out (Do Not Contact).' },
      { ...blocked, id: 52, name: 'Contact needing attention', reason: contactReason },
    ];
    const originalGet = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (url, options) => {
      if (url.includes('/compose/options')) return { channel, accounts: [], deliveryBlock: { ready: false, code: 'ASSISTANT_SETUP_REQUIRED', reason, error, setupUrl: '/dashboard/settings/outreach', accountId: '', channel } } as never;
      if (url.includes('/compose/recipients')) {
        const ids = new URL(url, 'https://test.example').searchParams.get('ids')?.split(',').map(Number);
        return { recipients: ids ? contacts.filter(contact => ids.includes(contact.id)) : contacts, nextCursor: null } as never;
      }
      return originalGet(url, options);
    });
    const user = userEvent.setup(); render(<OutreachCreationPage />);
    await screen.findByRole('checkbox', { name: 'Select Contact needing attention' });
    expect(screen.getByText(`Connect ${label === 'SMS' ? 'an' : 'a'} ${label} account to start sending.`)).toBeInTheDocument();
    expect(screen.getByText('Review is unavailable: customer delivery is blocked for this channel.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Review outreach/ })).toBeDisabled();
    const notice = screen.getByRole('region', { name: 'Customer delivery blocked' });
    expect(within(notice).getByText(error)).toBeInTheDocument();
    expect(within(notice).getByRole('link', { name: reason === 'unsupported_channel' ? 'View supported channels' : 'Set up required assistant' })).toHaveAttribute('href', '/dashboard/settings/outreach');
    expect(screen.getAllByText(error)).toHaveLength(1);
    expect(screen.getByText(contactReason)).toBeInTheDocument();
    expect(screen.getByText('This contact has opted out (Do Not Contact).')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select Blocked contact 1' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Opted-out contact' }));
    expect(screen.getByText('Opted-out contact: This contact has opted out (Do Not Contact).')).toBeInTheDocument();
    expect(screen.getAllByText(error)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Review outreach' })).toBeDisabled();
    expect(vi.mocked(api.post).mock.calls.filter(([url]) => url === '/api/outreach-conversations/bulk')).toHaveLength(0);
  });

  it.each([true, false])('honors a channel block even with account readiness %s and preserves a separate sender issue', async ready => {
    const error = 'Customer delivery is blocked because the assistant runtime is disabled.';
    const senderReason = 'Reconnect this Gmail account with sending permission.';
    const originalGet = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (url, options) => {
      const value = await originalGet(url, options) as { accounts?: Array<Record<string, unknown>> };
      if (!url.includes('/compose/options')) return value as never;
      return { ...value, deliveryBlock: { ready: false, code: 'ASSISTANT_SETUP_REQUIRED', reason: 'runtime_disabled', error, setupUrl: '/dashboard/settings/outreach', accountId: '', channel: 'email' },
        accounts: value.accounts!.map(account => ({ ...account, ready, reason: ready ? null : senderReason })) } as never;
    });
    const user = userEvent.setup(); render(<OutreachCreationPage />);
    await screen.findByRole('checkbox', { name: 'Select Ada Lovelace' });
    await user.click(screen.getByRole('checkbox', { name: 'Select Ada Lovelace' }));
    await user.type(screen.getByLabelText('Subject'), 'Retained subject');
    await user.type(screen.getByLabelText('Message body'), 'Retained draft.');
    expect(screen.getAllByText(error)).toHaveLength(1);
    if (!ready) expect(screen.getAllByText(senderReason).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Review outreach' })).toBeDisabled();
    expect(vi.mocked(api.post).mock.calls.filter(([url]) => url === '/api/outreach-conversations/bulk')).toHaveLength(0);
  });

  it('distinguishes saved email template sources and duplicate names without changing option values or copy', async () => {
    const originalGet = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.startsWith('/api/content/assets?')) return [
        { id: 110, name: 'Shared email', subject: 'Asset subject', content: 'Asset body' },
        { id: 113, name: 'Shared email', subject: 'Other asset subject', content: 'Other asset body' },
        { id: 114, name: 'Unique email', subject: 'Unique subject', content: 'Unique body' },
      ] as never;
      if (url.startsWith('/api/content/templates?')) return [{ id: 5, name: 'Shared email', subject: 'Template subject', content: 'Template body', isApproved: true }] as never;
      if (url.startsWith('/api/content/templates/predefined?')) return [{ id: 5, name: 'Shared email', subject: 'Predefined subject', content: 'Predefined body', isApproved: true }] as never;
      return originalGet(url);
    });
    render(<OutreachCreationPage />);
    await screen.findByLabelText('Select Ada Lovelace');
    await screen.findByRole('option', { name: 'Shared email · Saved content #110' });
    const picker = screen.getByLabelText('Saved template');
    expect(screen.getByRole('option', { name: 'Unique email' })).toHaveValue('0:114');
    for (const choice of [
      { label: 'Shared email · Saved content #110', value: '0:110', subject: 'Asset subject', body: 'Asset body' },
      { label: 'Shared email · Saved content #113', value: '0:113', subject: 'Other asset subject', body: 'Other asset body' },
      { label: 'Shared email · Saved template #5', value: '1:5', subject: 'Template subject', body: 'Template body' },
      { label: 'Shared email · Predefined template #5', value: '2:5', subject: 'Predefined subject', body: 'Predefined body' },
    ]) {
      expect(await screen.findByRole('option', { name: choice.label })).toHaveValue(choice.value);
      fireEvent.change(picker, { target: { value: choice.value } });
      expect(picker).toHaveValue(choice.value);
      expect(screen.getByLabelText('Subject')).toHaveValue(choice.subject);
      expect(screen.getByLabelText('Message body')).toHaveTextContent(choice.body);
    }
    expect(vi.mocked(api.post).mock.calls.map(([url]) => url)).toEqual(['/api/email-senders/sync']);
    expect(api.put).not.toHaveBeenCalled();
  });
  it('shows a workspace runtime block once for 52 recipients while preserving contact-specific reasons and the review gate', async () => {
    const runtimeError = 'Customer delivery is blocked because the assistant runtime is disabled. Enable it only after an owner reviews and publishes the assigned assistant.';
    const contacts = [
      ...Array.from({ length: 50 }, (_, index) => ({ ...ada, id: index + 1, name: `Runtime contact ${index + 1}`, eligible: false, reason: runtimeError })),
      { ...blocked, id: 51, name: 'Opted-out contact', reason: 'This contact has opted out (Do Not Contact).' },
      { ...blocked, id: 52, name: 'Missing email contact' },
    ];
    const originalGet = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (url, options) => {
      if (url.includes('/compose/recipients')) {
        const ids = new URL(url, 'https://test.example').searchParams.get('ids')?.split(',').map(Number);
        return { recipients: ids ? contacts.filter(contact => ids.includes(contact.id)) : contacts, nextCursor: null } as never;
      }
      const value = await originalGet(url, options) as { accounts?: Array<Record<string, unknown>> };
      return url.includes('/compose/options') ? { ...value, accounts: value.accounts!.map(account => ({ ...account, ready: false, reason: runtimeError, assistant: { ready: false, code: 'ASSISTANT_SETUP_REQUIRED', reason: 'runtime_disabled', error: runtimeError, setupUrl: '/dashboard/settings/outreach', accountId: 'account-1', channel: 'email' } })) } as never : value as never;
    });
    const user = userEvent.setup();
    render(<OutreachCreationPage />);
    await screen.findByRole('checkbox', { name: 'Select Missing email contact' });
    const notice = screen.getByRole('region', { name: 'Customer delivery blocked' });
    expect(within(notice).getByText(runtimeError)).toBeInTheDocument();
    expect(within(notice).getByRole('link', { name: 'Set up required assistant' })).toHaveAttribute('href', '/dashboard/settings/outreach');
    expect(screen.getAllByText(runtimeError)).toHaveLength(1);
    expect(screen.getByText('This contact has opted out (Do Not Contact).')).toBeInTheDocument();
    expect(screen.getByText(blocked.reason!)).toBeInTheDocument();
    const runtimeContact = screen.getByRole('checkbox', { name: 'Select Runtime contact 1' });
    expect(runtimeContact.closest('label')).not.toHaveTextContent('Ready to send');
    await user.click(runtimeContact);
    await user.click(screen.getByRole('checkbox', { name: 'Select Opted-out contact' }));
    await user.type(screen.getByLabelText('Subject'), 'Keep this subject');
    await user.type(screen.getByLabelText('Message body'), 'Keep this draft.');
    expect(screen.getByText('Opted-out contact: This contact has opted out (Do Not Contact).')).toBeInTheDocument();
    expect(screen.getAllByText(runtimeError)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Review outreach' })).toBeDisabled();
    expect(runtimeContact).toBeChecked();
    expect(screen.getByLabelText('Message body')).toHaveTextContent('Keep this draft.');
    expect(vi.mocked(api.post).mock.calls.filter(([url]) => url === '/api/outreach-conversations/bulk')).toHaveLength(0);
  });

  it('shows a stale runtime rejection once in review and keeps subsequent delivery blocked', async () => {
    const runtimeError = 'Customer delivery is blocked because the assistant runtime is disabled.';
    const user = await composeEmail();
    await user.click(screen.getByRole('button', { name: 'Review outreach' }));
    await screen.findByRole('button', { name: 'Send to 1 recipient' });
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(runtimeError, 409, { code: 'ASSISTANT_SETUP_REQUIRED', reason: 'runtime_disabled', error: runtimeError, setupUrl: '/dashboard/settings/outreach' }));
    await user.click(screen.getByRole('button', { name: 'Send to 1 recipient' }));
    await screen.findByRole('region', { name: 'Customer delivery blocked' });
    expect(screen.getAllByText(runtimeError)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Send to 1 recipient' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Edit outreach' }));
    expect(screen.getAllByText(runtimeError)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Review outreach' })).toBeDisabled();
    expect(screen.getByLabelText('Message body')).toHaveTextContent('Hi Ada, welcome.');
    expect(vi.mocked(api.post).mock.calls.filter(([url]) => url === '/api/outreach-conversations/bulk')).toHaveLength(1);
  });

  it('keeps editing available but blocks review for an account requiring an assistant', async () => {
    const originalGet = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (url, options) => {
      const value = await originalGet(url, options) as { accounts?: Array<Record<string, unknown>> };
      return url.includes('/compose/options') ? { ...value, accounts: value.accounts!.map(account => ({ ...account, ready: false, reason: 'Publish and assign a ready assistant.', assistant: { ready: false, code: 'ASSISTANT_SETUP_REQUIRED', error: 'Publish and assign a ready assistant.', setupUrl: '/dashboard/settings/outreach', accountId: 'account-1', channel: 'email' } })) } as never : value as never;
    });
    const user = userEvent.setup(); render(<OutreachCreationPage />);
    await screen.findByLabelText('Select Ada Lovelace');
    await user.click(screen.getByLabelText('Select Ada Lovelace'));
    await user.type(screen.getByLabelText('Subject'), 'Draft subject');
    await user.type(screen.getByLabelText('Message body'), 'Keep this draft.');
    expect(screen.getByRole('link', { name: 'Set up required assistant' })).toHaveAttribute('href', '/dashboard/settings/outreach');
    expect(screen.getByRole('button', { name: 'Review outreach' })).toBeDisabled();
    // The disabled button says why, next to it, with the one action that fixes it.
    expect(screen.getByText(/Review is unavailable: Publish and assign a ready assistant\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up the assistant' })).toHaveAttribute('href', '/dashboard/settings/outreach');
    expect(screen.getByLabelText('Message body')).toHaveTextContent('Keep this draft.');
    expect(vi.mocked(api.post).mock.calls.filter(([url]) => url === '/api/outreach-conversations/bulk')).toHaveLength(0);
  });

  it('keeps a reviewed draft and blocks repeated sends after stale assistant readiness is rejected', async () => {
    const user = await composeEmail();
    await user.click(screen.getByRole('button', { name: 'Review outreach' }));
    await screen.findByRole('button', { name: 'Send to 1 recipient' });
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError('Assistant assignment changed.', 409, { code: 'ASSISTANT_SETUP_REQUIRED', error: 'Assistant assignment changed.', setupUrl: '/dashboard/settings/outreach/assistants/ready-one', assistantId: 'ready-one' }));
    await user.click(screen.getByRole('button', { name: 'Send to 1 recipient' }));
    expect(await screen.findByRole('link', { name: 'Review assigned assistant' })).toHaveAttribute('href', '/dashboard/settings/outreach/assistants/ready-one');
    expect(screen.getByRole('button', { name: 'Send to 1 recipient' })).toBeDisabled();
    expect(vi.mocked(api.post).mock.calls.filter(([url]) => url === '/api/outreach-conversations/bulk')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Edit outreach' }));
    expect(screen.getByLabelText('Message body')).toHaveTextContent('Hi Ada, welcome.');
    expect(screen.getByRole('button', { name: 'Review outreach' })).toBeDisabled();
  });

  it("shows Unicode segment estimates for the personalized SMS before sending", async () => {
    navigation.params = new URLSearchParams("channel=sms&leadId=1");
    const user = userEvent.setup();
    render(<OutreachCreationPage />);
    await waitFor(() => expect(screen.getByLabelText("Select Ada Lovelace")).toBeChecked());
    fireEvent.change(screen.getByLabelText("Message body"), { target: { value: `Hello {{first_name}}, ${"界".repeat(51)}` } });
    expect(screen.getByLabelText("SMS draft length")).toHaveTextContent("73 characters · UCS-2 · 2 segments");
    await user.click(screen.getByRole("button", { name: "Review outreach" }));
    expect(await screen.findByLabelText("Personalized SMS length")).toHaveTextContent("62 characters · UCS-2 · 1 segment");
    expect(api.post).not.toHaveBeenCalledWith("/api/outreach-conversations/bulk", expect.anything());
  });

  it("imports an SMS library draft into the shared composer without sending it", async () => {
    navigation.params = new URLSearchParams("channel=sms&leadId=1&sourceAssetId=17");
    const get = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (url: string) => url === "/api/content/assets/17"
      ? { type: "sms", content: "Hello {{first_name}}, your proposal is ready." } as never
      : get(url));
    render(<OutreachCreationPage />);
    expect(await screen.findByDisplayValue("Hello {{first_name}}, your proposal is ready.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Subject")).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalledWith("/api/outreach-conversations/bulk", expect.anything());
  });

  it("reviews SMS text and queues it through the selected MSG91 sender", async () => {
    navigation.params = new URLSearchParams("channel=sms&leadId=1");
    const user = userEvent.setup();
    render(<OutreachCreationPage />);
    await waitFor(() => expect(screen.getByLabelText("Select Ada Lovelace")).toBeChecked());
    expect(screen.getByText("MSG91 - ORCHID")).toBeInTheDocument();
    expect(screen.queryByLabelText("Subject")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Approved template")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Message body"), "Hello Ada, welcome.");
    await user.click(screen.getByRole("button", { name: "Review outreach" }));
    expect(await screen.findByText("Hello Ada, welcome.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalledWith("/api/outreach-conversations/bulk", expect.anything());
    await user.click(screen.getByRole("button", { name: "Send to 1 recipient" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      "/api/outreach-conversations/bulk",
      expect.objectContaining({
        channel: "sms", providerAccountId: "ORCHID", creationVersion: 1,
        confirmation: { confirmed: true, channel: "sms", recipientCount: 1 },
        messages: [expect.objectContaining({ leadId: 1, message: "Hello Ada, welcome.", followUps: [] })],
      }),
    ));
  });

  it("prepares a CRM contact using the selected WhatsApp account and selects its returned lead", async () => {
    navigation.params = new URLSearchParams("channel=whatsapp&contactId=8");
    render(<OutreachCreationPage />);
    await waitFor(() =>
      expect(screen.getByLabelText("Select Ada Lovelace")).toBeChecked(),
    );
    expect(api.post).toHaveBeenCalledWith(
      "/api/outreach-conversations/compose/contact",
      {
        contactId: 8,
        channel: "whatsapp",
        providerAccountId: "account-1",
        senderId: 7,
      },
    );
  });
  it("reviews personalized content and sends through the selected account only after confirmation", async () => {
    const user = await composeEmail();
    expect(api.post).not.toHaveBeenCalledWith(
      "/api/outreach-conversations/bulk",
      expect.anything(),
    );
    await user.click(screen.getByRole("button", { name: "Review outreach" }));
    expect(await screen.findByText("Hi Ada, welcome.")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Send to 1 recipient" }),
    );
    expect(
      await screen.findByRole("link", { name: "Open conversation" }),
    ).toHaveAttribute(
      "href",
      "/dashboard/outreach/inbox?thread=conversation:9",
    );
    expect(api.post).toHaveBeenCalledWith(
      "/api/outreach-conversations/bulk",
      expect.objectContaining({
        channel: "email",
        creationVersion: 1,
        providerAccountId: "account-1",
        confirmation: { confirmed: true, channel: "email", recipientCount: 1 },
        messages: [
          expect.objectContaining({
            leadId: 1,
            senderId: 7,
            subject: "Hello",
            message: "Hi Ada, welcome.",
            followUps: [],
          }),
        ],
      }),
    );
  });

  it("keeps the draft, recipients and sending account when the user leaves for Follow-up settings and comes back", async () => {
    await composeEmail();
    await userEvent.setup().type(screen.getByLabelText("Name this outreach (optional)"), "Diwali offer");
    // Leaving the route unmounts the composer, exactly like opening /dashboard/outreach/follow-ups.
    cleanup();
    render(<OutreachCreationPage />);
    expect(await screen.findByLabelText("Subject")).toHaveValue("Hello");
    // Email uses the rich-text editor, so read its text rather than an input value.
    expect(screen.getByLabelText("Message body")).toHaveTextContent("Hi Ada, welcome.");
    expect(screen.getByLabelText("Name this outreach (optional)")).toHaveValue("Diwali offer");
    await waitFor(() => expect(screen.getByLabelText("Select Ada Lovelace")).toBeChecked());
    await waitFor(() => expect(screen.getByRole("button", { name: "Review outreach" })).toBeEnabled());
  });

  it("starts a new draft for a different recipient handoff and after the outreach is sent", async () => {
    await composeEmail();
    cleanup();
    // Opening the composer for other recipients is a new outreach, not the kept one.
    navigation.params = new URLSearchParams({ leadIds: "2" });
    render(<OutreachCreationPage />);
    expect(await screen.findByLabelText("Subject")).toHaveValue("");
    cleanup();
    navigation.params = new URLSearchParams();
    const user = await composeEmail();
    cleanup();
    render(<OutreachCreationPage />);
    expect(await screen.findByLabelText("Subject")).toHaveValue("Hello");
    await waitFor(() => expect(screen.getByRole("button", { name: "Review outreach" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Review outreach" }));
    await user.click(await screen.findByRole("button", { name: "Send to 1 recipient" }));
    await screen.findByRole("link", { name: "Open conversation" });
    cleanup();
    render(<OutreachCreationPage />);
    expect(await screen.findByLabelText("Subject")).toHaveValue("");
    expect(screen.getByLabelText("Message body")).not.toHaveTextContent("Hi Ada, welcome.");
  });

  it("makes excluded contacts visible and queues only eligible recipients", async () => {
    const user = await composeEmail();
    await user.click(screen.getByLabelText("Select Grace Hopper"));
    expect(screen.getByText("1 selected recipient is blocked and will be excluded")).toBeInTheDocument();
    expect(screen.getByText("Grace Hopper: Add a valid email address to this contact.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review outreach" }));
    expect(
      await screen.findByText("These contacts will be excluded"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Add a valid email address to this contact."),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Send to 1 recipient" }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/api/outreach-conversations/bulk",
        expect.objectContaining({
          messages: [expect.objectContaining({ leadId: 1 })],
        }),
      ),
    );
  });

  it('keeps an uncertain queue receipt visible without offering a failed-recipient resend', async () => {
    vi.mocked(api.post).mockImplementation(async (url:string) => url.endsWith('/bulk') ? ({success:true,total:1,queued:0,errors:0,uncertain:1,
      results:[{leadId:1,messageId:11,conversationId:9,status:'uncertain',error:'Queue confirmation needs review. This saved message may still send.'}]} as never) : {} as never);
    const user=await composeEmail();await user.click(screen.getByRole('button',{name:'Review outreach'}));
    await user.click(await screen.findByRole('button',{name:'Send to 1 recipient'}));
    expect(await screen.findByRole('heading',{name:'Queue confirmation needs review'})).toBeVisible();
    expect(screen.queryByText('No messages were queued',{exact:true})).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Review failed recipients'})).not.toBeInTheDocument();
    expect(screen.getByRole('link',{name:'Open conversation'})).toHaveAttribute('href','/dashboard/outreach/inbox?thread=conversation:9');
    expect(screen.getByText(/1 unconfirmed; saved messages may still send/)).toBeVisible();
  });

  it("inserts the displayed Company token at the cursor and previews its value", async () => {
    const user = await composeEmail();
    const body = screen.getByLabelText("Message body");
    await user.clear(body);
    await user.type(body, "Hi , welcome.");
    body.focus();
    const range = document.createRange();
    range.setStart(body.firstChild!, 3);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.keyUp(body);
    // jsdom does not implement the browser's editing commands.
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((_command: string, _ui: boolean, text: string) => {
      const insertion = window.getSelection()!.getRangeAt(0);
      insertion.deleteContents();
      insertion.insertNode(document.createTextNode(text));
      return true;
    }) });
    await user.click(screen.getByRole("button", { name: "Company · {{company_name}}" }));
    expect(body).toHaveTextContent("Hi {{company_name}}, welcome.");
    await user.click(screen.getByRole("button", { name: "Review outreach" }));
    expect(await screen.findByText("Hi Analytical Engines, welcome.")).toBeInTheDocument();
  });

  it("inserts a variable into the focused subject instead of the body", async () => {
    const user = await composeEmail();
    const subject = screen.getByLabelText("Subject") as HTMLInputElement;
    await user.clear(subject);
    await user.type(subject, "Hello ");
    subject.focus();
    subject.setSelectionRange(subject.value.length, subject.value.length);
    await user.click(screen.getByRole("button", { name: "First name · {{first_name}}" }));
    expect(subject).toHaveValue("Hello {{first_name}}");
    expect(screen.getByLabelText("Message body")).toHaveTextContent("Hi Ada, welcome.");
    await user.click(screen.getByRole("button", { name: "Review outreach" }));
    expect(await screen.findByText("Hello Ada")).toBeInTheDocument();
  });

  it.each([
    ["email", "Manage Gmail and sending domains", "/dashboard/integrations/email"],
    ["sms", "Manage connections", "/dashboard/integrations/msg91"],
  ])("links %s account recovery from the composer and review", async (channel, linkName, connectionPath) => {
    navigation.params = new URLSearchParams(`channel=${channel}`);
    const originalGet = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      const response = await originalGet(url);
      if (url.includes("/compose/options")) {
        const options = response as { accounts: Array<{ ready: boolean; reason: string | null }> };
        options.accounts[0].ready = false;
        options.accounts[0].reason = "Open Email integrations and reconnect this Gmail account with sending permission.";
      }
      return response;
    });
    const user = userEvent.setup();
    render(<OutreachCreationPage />);
    await screen.findByLabelText("Select Ada Lovelace");
    await user.click(screen.getByLabelText("Select Ada Lovelace"));
    expect(screen.getByText("Resolve these before sending")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: linkName })).toHaveAttribute("href", connectionPath);
    await user.click(screen.getByRole("button", { name: "Review outreach" }));
    expect(await screen.findByText("Sending account needs attention")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Manage connection$/ })).toHaveAttribute("href", connectionPath);
    expect(screen.getByRole("button", { name: "Send to 1 recipient" })).toBeDisabled();
  });

  it("retains the reviewed idempotency key while an accepted request is still processing", async () => {
    const user = await composeEmail();
    vi.mocked(api.post).mockResolvedValueOnce({
      success: true,
      total: 1,
      queued: 0,
      errors: 0,
      inProgress: true,
    } as never);
    await user.click(screen.getByRole("button", { name: "Review outreach" }));
    await user.click(
      await screen.findByRole("button", { name: "Send to 1 recipient" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Check status" }),
    );
    const calls = vi
      .mocked(api.post)
      .mock.calls.filter((call) => call[0].endsWith("/bulk"));
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual(calls[1][1]);
  });

  it("requires WhatsApp consent and complete account-scoped template values and media", async () => {
    navigation.params = new URLSearchParams("channel=whatsapp&leadId=1");
    const user = userEvent.setup();
    render(<OutreachCreationPage />);
    vi.mocked(api.upload).mockResolvedValue({ mediaId: '123456' });
    URL.createObjectURL = vi.fn(() => 'blob:test-template');
    URL.revokeObjectURL = vi.fn();
    await waitFor(() => expect(screen.getByRole('button', { name: /Choose a template/ })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /Choose a template/ }));
    await user.click(await screen.findByRole('button', { name: /welcome.*en_US/ }));
    await user.type(screen.getByLabelText("Body variable 1"), "Ada");
    await user.type(
      screen.getByLabelText("Body variable 2"),
      "Analytical Engines",
    );
    await user.upload(screen.getByLabelText('Upload template image'), new File(['png'], 'photo.png', { type: 'image/png' }));
    await screen.findByText('Ready · photo.png');
    await user.type(screen.getByLabelText("View details URL suffix"), "ada");
    await user.click(screen.getByRole('button', { name: 'Use template' }));
    await user.click(screen.getByRole("button", { name: "Review outreach" }));
    expect(screen.getByAltText('WhatsApp template header')).toHaveAttribute('src', 'blob:test-template');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:test-template');
    const send = await screen.findByRole("button", {
      name: "Send to 1 recipient",
    });
    expect(send).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Edit outreach" }));
    await user.click(
      screen.getByText(
        "These recipients have agreed to receive WhatsApp messages from this business.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Review outreach" }));
    await user.click(
      await screen.findByRole("button", { name: "Send to 1 recipient" }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/api/outreach-conversations/bulk",
        expect.objectContaining({
          channel: "whatsapp",
          providerAccountId: "account-1",
          whatsappOptInConfirmed: true,
          messages: [
            expect.objectContaining({
              templateName: "welcome",
              templateLanguage: "en_US",
              message: "Hello Ada, welcome to Analytical Engines.",
              templateComponents: expect.arrayContaining([
                expect.objectContaining({
                  type: "header",
                  parameters: [
                    {
                      type: "image",
                      image: { id: "123456" },
                    },
                  ],
                }),
              ]),
            }),
          ],
        }),
      ),
    );
  });

  it("blocks WhatsApp free-form messages when the recipient needs a template", async () => {
    navigation.params = new URLSearchParams("channel=whatsapp&leadId=1");
    const user = userEvent.setup();
    render(<OutreachCreationPage />);
    await screen.findByLabelText("Select Ada Lovelace");
    await user.click(
      screen.getByRole("button", { name: "Reply within 24 hours" }),
    );
    await user.type(screen.getByLabelText("Message body"), "Hello");
    await user.click(
      screen.getByText(
        "These recipients have agreed to receive WhatsApp messages from this business.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Review outreach" }));
    expect(
      await screen.findByRole("button", { name: "Send to 1 recipient" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/This recipient requires an approved template/),
    ).toBeInTheDocument();
  });

  it("schedules outreach with follow-ups explicitly off without changing channel settings", async () => {
    const user = await composeEmail();
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    const date = new Date(Date.now() + 2 * 86400000);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    await user.type(screen.getByLabelText("Send date and time"), local);
    expect(screen.getByRole('region', { name: 'Follow-ups for this outreach' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add follow-up' })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review outreach" }));
    expect(screen.queryByText('Follow-ups', { exact: true })).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", { name: "Schedule to 1 recipient" }),
    );
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/api/outreach-conversations/bulk",
        expect.objectContaining({
          scheduledAt: expect.any(String),
          followUpSource: 'outreach',
          messages: [
            expect.objectContaining({
              followUps: [],
            }),
          ],
        }),
      ),
    );
  });

  it.each(['email', 'whatsapp', 'instagram', 'facebook', 'sms'])('offers local follow-up settings for %s without global reads or writes', async channel => {
    navigation.params = new URLSearchParams(`channel=${channel}`);
    render(<OutreachCreationPage />);
    expect(await screen.findByRole('region', { name: 'Follow-ups for this outreach' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Manage follow-up settings' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Enable follow-ups for this outreach' }));
    expect(screen.getByLabelText('Follow-up 1 delay')).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
    expect(vi.mocked(api.get).mock.calls.some(([url]) => url.includes('/settings/integrations/'))).toBe(false);
  });

});

describe("CRM outreach entry", () => {
  it.each([
    ["Email", "email"],
    ["WhatsApp", "whatsapp"],
    ["Instagram", "instagram"],
    ["Messenger", "facebook"],
    ["SMS", "sms"],
  ])("opens %s with an existing lead selected", async (label, channel) => {
    const user = userEvent.setup();
    const close = vi.fn();
    render(
      <CreateConversationDialog
        open
        onOpenChange={close}
        contactId={8}
        contactName="Ada"
        leadId={1}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: new RegExp(`^${label}`) }),
    );
    expect(navigate).toHaveBeenCalledWith(
      `/dashboard/outreach/create?channel=${channel}&contactId=8&leadId=1`,
    );
    expect(close).toHaveBeenCalledWith(false);
  });
  it("passes the CRM contact when it must first be synchronized to an outreach lead", async () => {
    const user = userEvent.setup();
    render(
      <CreateConversationDialog
        open
        onOpenChange={vi.fn()}
        contactId={8}
        contactName="Ada"
        leadId={null}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^Email/ }));
    expect(navigate).toHaveBeenCalledWith(
      "/dashboard/outreach/create?channel=email&contactId=8",
    );
  });
});

describe("recipient personalization", () => {
  it("escapes contact values in HTML and leaves missing values visible for review", () => {
    expect(
      personalizeOutreach(
        "<p>{{first_name}} at {{company}}</p>",
        { ...ada, firstName: "<Ada>", company: "" },
        true,
      ),
    ).toBe("<p>&lt;Ada&gt; at {{company_name}}</p>");
  });
  it("orders positional parameters numerically and keeps header and body variables separate", () => {
    const result = buildOutreachTemplate(
      {
        id: "t",
        name: "named",
        language: "en",
        headerType: "TEXT",
        header: "For {{customer}}",
        body: "{{2}} then {{1}} and {{2}}",
      },
      { "header:customer": "{{first_name}}", "body:1": "One", "body:2": "Two" },
      ada,
    );
    expect(result.missing).toEqual([]);
    expect(result.templateComponents).toEqual([
      {
        type: "header",
        parameters: [{ type: "text", text: "Ada", parameter_name: "customer" }],
      },
      {
        type: "body",
        parameters: [
          { type: "text", text: "One" },
          { type: "text", text: "Two" },
        ],
      },
    ]);
  });
});

it('never rehydrates a retained private message query into a different business or account', async () => {
  navigation.params = new URLSearchParams('channel=email&message=Private+synthetic+handoff');
  const view = render(<OutreachCreationPage />);
  expect(await screen.findByRole('textbox', { name: 'Message body' })).toHaveTextContent('Private synthetic handoff');
  navigation.scope = 'synthetic:4103'; view.rerender(<OutreachCreationPage />);
  expect(screen.getByRole('textbox', { name: 'Message body' })).toBeEmptyDOMElement();
  navigation.scope = 'another-account:4103'; view.rerender(<OutreachCreationPage />);
  expect(screen.getByRole('textbox', { name: 'Message body' })).toBeEmptyDOMElement();
  navigation.scope = 'synthetic:4102'; view.rerender(<OutreachCreationPage />);
  expect(screen.getByRole('textbox', { name: 'Message body' })).toBeEmptyDOMElement();
});

describe('outreach-only follow-up review', () => {
  it('reviews personalized timings and sends only the current outreach steps', async () => {
    const user = await composeEmail();
    await user.click(screen.getByRole('switch', { name: 'Enable follow-ups for this outreach' }));
    fireEvent.change(screen.getByLabelText('Follow-up 1 delay'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('Follow-up 1 message'), { target: { value: 'Checking in, {{first_name}}' } });
    await user.click(screen.getByRole('button', { name: 'Review outreach' }));
    expect(await screen.findByText('Checking in, Ada')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit outreach' }));
    fireEvent.change(screen.getByLabelText('Follow-up 1 delay'), { target: { value: '120' } });
    expect(screen.queryByRole('button', { name: 'Send to 1 recipient' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review outreach' }));
    await user.click(await screen.findByRole('button', { name: 'Send to 1 recipient' }));
    const payload = vi.mocked(api.post).mock.calls.find(([url]) => url === '/api/outreach-conversations/bulk')?.[1] as any;
    expect(payload.followUpSource).toBe('outreach');
    expect(payload.useSavedFollowUpSettings).toBeUndefined();
    expect(payload.messages[0].followUps).toEqual([{ delayMinutes: 120, message: 'Checking in, Ada' }]);
    expect(api.put).not.toHaveBeenCalled();
  });
  it('keeps sequences separate across channels and starts a fresh outreach with follow-ups off', async () => {
    const user = await composeEmail();
    await user.click(screen.getByRole('switch', { name: 'Enable follow-ups for this outreach' }));
    fireEvent.change(screen.getByLabelText('Follow-up 1 message'), { target: { value: 'Email-only follow-up' } });
    await user.click(screen.getByRole('button', { name: /^SMS/ }));
    expect(screen.getByRole('switch', { name: 'Enable follow-ups for this outreach' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: /^Email$/ }));
    expect(screen.getByLabelText('Follow-up 1 message')).toHaveValue('Email-only follow-up');
    // Coming back to the composer keeps this unsent outreach, including its own follow-ups.
    cleanup(); render(<OutreachCreationPage />);
    expect(screen.getByRole('switch', { name: 'Enable follow-ups for this outreach' })).toBeChecked();
    expect(screen.getByLabelText('Follow-up 1 message')).toHaveValue('Email-only follow-up');
    // A different business starts a fresh outreach with follow-ups off.
    cleanup(); navigation.scope = 'synthetic:4103'; render(<OutreachCreationPage />);
    expect(screen.getByRole('switch', { name: 'Enable follow-ups for this outreach' })).not.toBeChecked();
    expect(api.put).not.toHaveBeenCalled();
  });
  it('uses the full composer in the campaign card and exposes only a reviewed batch to confirmation', async () => {
    const user = userEvent.setup();
    const onFormChange = vi.fn();
    const widget = { id: 44, threadId: 22, widgetType: 'send_outreach', toolName: 'send_outreach_messages', status: 'active', formValues: { channel: 'email', lead_ids: [1], subject: 'Hello', body: 'Hello {{first_name}}' } } as unknown as WidgetState;
    const view = render(<SendOutreachWidget widget={widget} onFormChange={onFormChange} onClose={vi.fn()} onSubmit={vi.fn()} />);
    await screen.findByLabelText('Send from');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review outreach' })).toBeEnabled());
    await user.click(screen.getByRole('switch', { name: 'Enable follow-ups for this outreach' }));
    fireEvent.change(screen.getByLabelText('Follow-up 1 message'), { target: { value: 'Campaign check-in for {{first_name}}' } });
    fireEvent.change(screen.getByLabelText('Follow-up 1 delay'), { target: { value: '90' } });
    expect(onFormChange.mock.lastCall?.[0]).toMatchObject({ _review_validation_error: expect.any(String) });
    await user.click(screen.getByRole('button', { name: 'Review outreach' }));
    await waitFor(() => expect(onFormChange.mock.lastCall?.[0]).toMatchObject({ outreach_review: { followUpSource: 'outreach', messages: [expect.objectContaining({ followUps: [{ delayMinutes: 90, message: 'Campaign check-in for Ada' }] })] } }));
    expect(screen.queryByRole('button', { name: 'Send to 1 recipient' })).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalledWith('/api/outreach-conversations/bulk', expect.anything());
    const saved = onFormChange.mock.lastCall?.[0];
    view.unmount();
    render(<SendOutreachWidget widget={{ ...widget, formValues: saved }} onFormChange={onFormChange} onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Follow-up 1 delay')).toHaveValue(90);
    expect(screen.getByLabelText('Follow-up 1 message')).toHaveValue('Campaign check-in for {{first_name}}');
    expect(onFormChange.mock.lastCall?.[0].outreach_review).toBeUndefined();
    expect(api.put).not.toHaveBeenCalled();
  });
});

describe('follow-up setup does not silently block review', () => {
  it('explains an unsaved campaign sequence and holds Save until every step has an approved template', async () => {
    const originalGet = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (url: string, ...args: unknown[]) => {
      if (url.endsWith('/manual-follow-ups/campaign-options')) return { campaigns: [{ kind: 'chat_thread', id: 44, name: 'HR campaign' }] } as never;
      if (url.includes('/manual-follow-ups?')) throw new ApiError('Save and review a manual sequence for this campaign and channel first.', 404, { code: 'CAMPAIGN_SEQUENCE_REQUIRED' });
      if (url.startsWith('/api/content/templates?')) return [{ id: 22, name: 'HR follow-up', isApproved: true }] as never;
      return originalGet(url, ...args as never[]);
    });
    const user = await composeEmail();
    await user.click(screen.getByRole('checkbox', { name: 'Use a campaign manual sequence' }));
    expect(screen.getByText(/campaign sequence replaces the follow-ups set for this\s+outreach/)).toBeInTheDocument();
    expect(screen.getByText(/Review is unavailable: choose a campaign for the manual sequence/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Manual follow-up campaign'), 'chat_thread:44');
    expect(await screen.findByText('This campaign has no saved sequence yet. Save it to continue to review.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save campaign sequence' })).toBeDisabled();
    expect(screen.getByText('Add at least one step, or set this campaign to Off, before saving.')).toBeInTheDocument();
    expect(screen.getByText(/Review is unavailable: save the campaign sequence first/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add manual step' }));
    expect(screen.getByText('Choose an approved template for every step before saving.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save campaign sequence' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Step 1 template'), '22');
    expect(screen.getByRole('button', { name: 'Save campaign sequence' })).toBeEnabled();
    expect(api.put).not.toHaveBeenCalled();
  });
});

describe('campaign-owned manual batch review',()=>{
  it('reviews personalized saved manual steps and submits the immutable campaign receipt',async()=>{
    const originalGet=vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async(url:string,...args:unknown[])=>{
      if(url.endsWith('/manual-follow-ups/campaign-options'))return {campaigns:[{kind:'chat_thread',id:44,name:'HR campaign'}]} as never;
      if(url.includes('/manual-follow-ups?'))return {campaign:{kind:'chat_thread',id:44},channel:'email',version:3,mode:'manual',steps:[{delayMinutes:60,templateId:22,templateName:'HR follow-up',templateVersion:4}]} as never;
      return originalGet(url,...args as never[]);
    });
    const originalPost=vi.mocked(api.post).getMockImplementation()!;
    vi.mocked(api.post).mockImplementation(async(url:string,body:unknown,...args:unknown[])=>url.endsWith('/manual-follow-ups/preview')?{reviewId:'reviewed-HR-sequence',sequence:{campaign:{kind:'chat_thread',id:44},channel:'email',version:3,mode:'manual',steps:[{delayMinutes:60,templateId:22,templateName:'HR follow-up',templateVersion:4}]},recipients:{'1':{recipient:ada.recipient,steps:[{delayMinutes:60,message:'HR campaign follow-up for Ada',sourceTemplateId:22,sourceTemplateVersion:4}]}}} as never:originalPost(url,body,...args as never[]));
    const user=await composeEmail();
    await user.click(screen.getByRole('checkbox',{name:'Use a campaign manual sequence'}));
    await user.selectOptions(screen.getByLabelText('Manual follow-up campaign'),'chat_thread:44');
    await screen.findByText('Saved campaign revision 3');
    await user.click(screen.getByRole('button',{name:'Review outreach'}));
    expect(await screen.findByText('HR campaign follow-up for Ada')).toBeInTheDocument();
    expect(screen.getByText(/template revision 4/)).toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'Send to 1 recipient'}));
    await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/api/outreach-conversations/bulk',expect.objectContaining({campaignManualReviewId:'reviewed-HR-sequence'})));
    const payload=vi.mocked(api.post).mock.calls.find(([url])=>url==='/api/outreach-conversations/bulk')?.[1] as Record<string,unknown>;
    expect(payload.useSavedFollowUpSettings).toBeUndefined();
  });
});

describe('recipient import filters', () => {
  const sources = {
    campaigns: [{ id: 22, name: 'Hotel campaign', historicalCount: 2, uploads: [{ id: 7, fileName: 'hotels.csv', createdAt: '2026-10-20T00:00:00Z', count: 1 }] }],
    crmImports: [{ id: 9, fileName: 'crm.csv', createdAt: '2026-10-21T00:00:00Z', count: 1, status: 'completed' }],
  };
  it.each(['email', 'whatsapp', 'sms', 'instagram', 'facebook'])('filters campaign and CRM imports for %s without losing selected contacts', async channel => {
    navigation.params = new URLSearchParams({ channel });
    const originalGet = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (url, ...args) => {
      if (url.includes('/compose/import-sources')) return sources as never;
      return originalGet(url, ...args);
    });
    const user = userEvent.setup();
    render(<OutreachCreationPage />);
    await user.click(await screen.findByLabelText('Select Ada Lovelace'));
    await user.selectOptions(screen.getByLabelText('Contact source'), 'campaign');
    await screen.findByLabelText('Campaign');
    await user.selectOptions(screen.getByLabelText('Campaign'), '22');
    await user.selectOptions(screen.getByLabelText('Campaign upload'), '7');
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.some(([url]) => {
      const query = new URL(url, 'https://test.example').searchParams;
      return url.includes('/compose/recipients') && query.get('channel') === channel && query.get('importSource') === 'campaign' && query.get('campaignId') === '22' && query.get('importId') === '7';
    })).toBe(true));
    expect(screen.getByLabelText('Remove Ada Lovelace from recipients')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Campaign upload'), 'legacy');
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.some(([url]) => url.includes('importSource=campaign_legacy'))).toBe(true));
    await user.selectOptions(screen.getByLabelText('Contact source'), 'crm');
    await user.selectOptions(await screen.findByLabelText('CRM import'), '9');
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.some(([url]) => url.includes('importSource=crm') && url.includes('importId=9'))).toBe(true));
    expect(screen.getByLabelText('Remove Ada Lovelace from recipients')).toBeInTheDocument();
    const selectedChecks = vi.mocked(api.get).mock.calls.map(([url]) => url).filter(url => url.includes('/compose/recipients') && url.includes('ids='));
    expect(selectedChecks.length).toBeGreaterThan(0);
    expect(selectedChecks.every(url => !url.includes('importSource='))).toBe(true);
  });

  it('offers a retry when import sources cannot be loaded', async () => {
    const originalGet = vi.mocked(api.get).getMockImplementation()!;
    let attempts = 0;
    vi.mocked(api.get).mockImplementation(async (url, ...args) => {
      if (url.includes('/compose/import-sources')) {
        if (++attempts === 1) throw new Error('Could not load imports');
        return sources as never;
      }
      return originalGet(url, ...args);
    });
    const user = userEvent.setup();
    render(<OutreachCreationPage />);
    await user.selectOptions(screen.getByLabelText('Contact source'), 'crm');
    await screen.findByText('Could not load imports');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: /crm.csv/ })).toBeInTheDocument();
  });

  it('does not show the previous audience while the new filter is loading', async () => {
    const originalGet = vi.mocked(api.get).getMockImplementation()!;
    let resolveFiltered!: (value: unknown) => void;
    const pending = new Promise(resolve => { resolveFiltered = resolve; });
    vi.mocked(api.get).mockImplementation(async (url, ...args) => {
      if (url.includes('/compose/import-sources')) return sources as never;
      if (url.includes('/compose/recipients') && url.includes('importSource=crm')) return await pending as never;
      return originalGet(url, ...args);
    });
    const user = userEvent.setup();
    render(<OutreachCreationPage />);
    await user.click(await screen.findByLabelText('Select Ada Lovelace'));
    await user.selectOptions(screen.getByLabelText('Contact source'), 'crm');
    await waitFor(() => expect(screen.queryByLabelText('Select Ada Lovelace')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Remove Ada Lovelace from recipients')).toBeInTheDocument();
    resolveFiltered({ recipients: [blocked], nextCursor: null });
    expect(await screen.findByLabelText('Select Grace Hopper')).toBeInTheDocument();
  });

  it('preserves a campaign handoff and lets the user switch to CRM imports', async () => {
    navigation.params = new URLSearchParams({ threadId: '22' });
    const originalGet = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (url, ...args) => url.includes('/compose/import-sources') ? sources as never : originalGet(url, ...args));
    const user = userEvent.setup();
    render(<OutreachCreationPage />);
    await screen.findByLabelText('Select Ada Lovelace');
    expect(screen.getByLabelText('Contact source')).toHaveValue('current');
    expect(vi.mocked(api.get).mock.calls.some(([url]) => url.includes('/compose/recipients') && url.includes('threadId=22'))).toBe(true);
    await user.selectOptions(screen.getByLabelText('Contact source'), 'crm');
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.some(([url]) => url.includes('/compose/recipients') && url.includes('importSource=crm') && !url.includes('threadId='))).toBe(true));
  });
});

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return testingRender(ui, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}

it('restores the reviewed email design when reopening a campaign composer draft', async () => {
  const onChange = vi.fn();
  render(<OutreachCreationPage embedded={{ initial: { channel: 'email', emailDesignId: 'midnight' }, onChange }} />);
  expect(await screen.findByRole('button', { name: /Email design.*Midnight/ })).toBeInTheDocument();
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ emailDesignId: 'midnight' }), null));
});

it('explains an empty current-campaign filter while retaining explicitly selected CRM recipients', async () => {
  navigation.params = new URLSearchParams({ threadId: '22', leadIds: '1' });
  const original = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (url, ...args) => {
    if (url.includes('/compose/recipients') && url.includes('threadId=22')) return { recipients: [], nextCursor: null } as never;
    return original(url, ...args);
  });
  render(<OutreachCreationPage />);
  expect(await screen.findByText('No contacts match these filters.')).toBeInTheDocument();
  expect(screen.queryByText('No contacts yet. Add or import contacts in CRM.')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Remove Ada Lovelace from recipients' })).toBeInTheDocument();
});
