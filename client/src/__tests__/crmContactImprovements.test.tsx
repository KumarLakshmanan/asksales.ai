import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactEditForm } from '@/components/crm/ContactEditForm';
import { ConversationThread } from '@/components/crm/workspace/ConversationThread';
import { useContactWorkspace } from '@/hooks/use-contact-workspace';
import { ApiError } from '@/lib/api';
import { DEFAULT_CRM_CONFIGURATION } from '@/lib/crm-configuration';
import { EMPTY_HISTORY_FILTERS, type Contact, type CrmHistoryTab, type OutreachConversation } from '@/lib/crm-workspace';

const mocks=vi.hoisted(()=>({get:vi.fn(),put:vi.fn(),patch:vi.fn(),post:vi.fn(),toast:vi.fn(),profileId:11,listeners:new Set<()=>void>()}));
vi.mock('@/lib/api',async importOriginal=>({...await importOriginal<typeof import('@/lib/api')>(),api:mocks}));
vi.mock('@/hooks/use-toast',()=>({useToast:()=>({toast:mocks.toast})}));
vi.mock('@/hooks/use-crm-configuration',()=>({useCrmConfiguration:()=>({stages:DEFAULT_CRM_CONFIGURATION.stages,loading:false,error:null,reload:vi.fn()})}));
vi.mock('@/hooks/use-crm-automation-refresh',()=>({useCrmAutomationRefresh:()=>undefined}));
vi.mock('@/components/support/ConversationEventTimeline',()=>({ConversationEventTimeline:()=>null}));
vi.mock('@/contexts/AuthContext',()=>({useAuth:()=>({user:{id:7,businessProfileId:11}})}));
vi.mock('@/lib/business-profile',()=>({selectedBusinessProfileId:()=>mocks.profileId,subscribeBusinessProfile:(listener:()=>void)=>{mocks.listeners.add(listener);return()=>mocks.listeners.delete(listener);}}));

const contact:Contact={id:42,leadId:7,firstName:'Priya',lastName:'Raman',email:'priya@example.test',phone:'+919876543210',company:'Harbor',role:'Operations',status:'interested',pipelineStatus:'interested',lastSentimentStatus:null,priority:'high',source:'manual',dealValue:'1000',currency:'INR',sentimentScore:null,fitScore:null,totalOutreachSent:1,tags:['Enterprise'],notes:'Friday review',lastActivityAt:null,createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-02T00:00:00Z',assignedTo:7};
const clients:QueryClient[]=[];
function mount(ui:React.ReactNode){const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});clients.push(client);return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();sessionStorage.clear();mocks.profileId=11;mocks.listeners.clear();mocks.get.mockResolvedValue([{id:7,name:'Lakshman',email:'owner@example.test'}]);mocks.put.mockResolvedValue(contact);vi.spyOn(window,'confirm').mockReturnValue(true);});
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.clear());vi.restoreAllMocks();});

describe('contact editing reliability',()=>{
  it('saves profile, stage, ownership and normalized tags in one request',async()=>{
    const saved=vi.fn();const user=userEvent.setup();mount(<ContactEditForm contact={contact} scope="7:11:42" onSaved={saved} onCancel={vi.fn()} />);
    await screen.findByRole('option',{name:'Lakshman'});
    await user.clear(screen.getByLabelText('Company'));await user.type(screen.getByLabelText('Company'),'  Harbor Commerce  ');
    await user.clear(screen.getByLabelText('Deal Value (INR)'));
    await user.clear(screen.getByLabelText('Tags (comma separated)'));await user.type(screen.getByLabelText('Tags (comma separated)'),'Enterprise, Q4, Enterprise');
    await user.selectOptions(screen.getByLabelText('Assigned owner'),'unassigned');
    await user.click(screen.getByRole('button',{name:'Save changes'}));
    await waitFor(()=>expect(saved).toHaveBeenCalledWith(contact));
    expect(mocks.put).toHaveBeenCalledTimes(1);expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.put).toHaveBeenCalledWith('/api/crm/contacts/42',expect.objectContaining({company:'Harbor Commerce',dealValue:null,pipelineStatus:'interested',assignedTo:null,tags:['Enterprise','Q4'],expectedUpdatedAt:contact.updatedAt}));
  });
  it('shows actionable inline errors without sending an invalid amount',async()=>{
    mount(<ContactEditForm contact={contact} scope="7:11:42" onSaved={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Deal Value (INR)'),{target:{value:'-10'}});fireEvent.click(screen.getByRole('button',{name:'Save changes'}));
    expect(await screen.findByText('Enter a non-negative amount with at most two decimal places.')).toBeVisible();expect(mocks.put).not.toHaveBeenCalled();
  });
  it('keeps the original revision even when background data changes during an edit',async()=>{
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});clients.push(client);
    const ui=(value:Contact)=><QueryClientProvider client={client}><ContactEditForm contact={value} scope="7:11:42" onSaved={vi.fn()} onCancel={vi.fn()} /></QueryClientProvider>;
    const view=render(ui(contact));fireEvent.change(screen.getByLabelText('Company'),{target:{value:'My draft'}});
    view.rerender(ui({...contact,company:'Someone else’s change',updatedAt:'2026-10-03T00:00:00Z'}));
    expect(screen.getByLabelText('Company')).toHaveValue('My draft');fireEvent.click(screen.getByRole('button',{name:'Save changes'}));
    await waitFor(()=>expect(mocks.put).toHaveBeenCalled());expect(mocks.put.mock.calls[0][1].expectedUpdatedAt).toBe(contact.updatedAt);
  });
  it('retains a conflicting draft and asks for a review before another save',async()=>{
    mocks.put.mockRejectedValue(new ApiError('Contact changed',409));mount(<ContactEditForm contact={contact} scope="7:11:42" onSaved={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Company'),{target:{value:'Keep my draft'}});fireEvent.click(screen.getByRole('button',{name:'Save changes'}));
    expect(await screen.findByText('Review the latest changes')).toBeVisible();expect(screen.getByLabelText('Company')).toHaveValue('Keep my draft');expect(screen.getByRole('button',{name:'Save changes'})).toBeDisabled();expect(screen.getByRole('link',{name:'Open latest contact'})).toHaveAttribute('target','_blank');
  });
});

function WorkspaceProbe({tab='conversations'}:{tab?:CrmHistoryTab}){const value=useContactWorkspace(42,tab,EMPTY_HISTORY_FILTERS);return <div><p>{value.contact.isPending ? 'Loading profile' : value.contact.data?.company}</p><p>{value.result?.pagination?.total ?? 'No history totals'}</p></div>;}
describe('contact query scope and progressive loading',()=>{
  it('shows the contact without waiting for slow history or summary requests',async()=>{
    mocks.get.mockImplementation((url:string)=>url==='/api/crm/contacts/42' ? Promise.resolve(contact) : new Promise(()=>undefined));
    mount(<WorkspaceProbe />);expect(await screen.findByText('Harbor')).toBeVisible();
    expect(mocks.get.mock.calls.map(call=>call[0]).some(url=>url.includes('/activities')||url.includes('/tickets'))).toBe(false);
  });
  it('fetches another history only when that section is opened',async()=>{
    mocks.get.mockImplementation((url:string)=>Promise.resolve(url==='/api/crm/contacts/42' ? contact : url.includes('/activities') ? {data:[],pagination:{page:1,limit:20,total:51,totalPages:3}} : {conversations:[],sentMessages:[]}));
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});clients.push(client);
    const ui=(tab:CrmHistoryTab)=><QueryClientProvider client={client}><WorkspaceProbe tab={tab} /></QueryClientProvider>;
    const view=render(ui('conversations'));await screen.findByText('Harbor');expect(mocks.get.mock.calls.some(call=>call[0].includes('/activities'))).toBe(false);
    view.rerender(ui('activity'));expect(await screen.findByText('51')).toBeVisible();expect(mocks.get.mock.calls.some(call=>call[0].includes('/tickets'))).toBe(false);
  });
  it('cancels the previous business request and ignores its late result',async()=>{
    let resolveOld!:(value:Contact)=>void;let oldSignal:AbortSignal|undefined;
    mocks.get.mockImplementation((url:string,options?:{signal?:AbortSignal})=>{
      if(url!=='/api/crm/contacts/42')return Promise.resolve({conversations:[],sentMessages:[]});
      if(mocks.profileId===11){oldSignal=options?.signal;return new Promise<Contact>(resolve=>{resolveOld=resolve;});}
      return Promise.resolve({...contact,company:'New business'});
    });mount(<WorkspaceProbe />);await waitFor(()=>expect(resolveOld).toBeDefined());
    act(()=>{mocks.profileId=12;mocks.listeners.forEach(listener=>listener());});expect(await screen.findByText('New business')).toBeVisible();expect(oldSignal?.aborted).toBe(true);
    await act(async()=>resolveOld(contact));expect(screen.queryByText('Harbor')).not.toBeInTheDocument();
  });
});

describe('reply drafts and delivery outcomes',()=>{
  const conversation={id:81,channel:'email',status:'replied',subject:'Rollout',leadName:'Priya',leadEmail:contact.email,totalMessages:0,unreadCount:0,messages:[],providerAccountId:'gmail-44'} as unknown as OutreachConversation;
  it('keeps a rejected reply editable, blocks resending, and links to assistant setup',async()=>{
    mocks.get.mockResolvedValue({item:{id:81,recipient:contact.email,reply:{canReply:true,accountLabel:'Sales Gmail',providerAccountId:'gmail-44',senderId:44}}});
    mocks.post.mockRejectedValue(new ApiError('Assistant required.',409,{code:'ASSISTANT_SETUP_REQUIRED',error:'Assistant required.',setupUrl:'/dashboard/settings/outreach'}));
    mount(<ConversationThread conversation={conversation} contactId={42} scope="7:11:42" canReply initiallyOpen />);
    await screen.findByText(/From Sales Gmail/);fireEvent.change(screen.getByLabelText('Reply via Email'),{target:{value:'Keep this reply'}});fireEvent.click(screen.getByRole('button',{name:'Reply'}));
    expect(await screen.findByRole('link',{name:'Set up required assistant'})).toHaveAttribute('href','/dashboard/settings/outreach');
    expect(screen.getByRole('button',{name:'Reply'})).toBeDisabled();expect(screen.getByLabelText('Reply via Email')).toBeEnabled();expect(screen.getByLabelText('Reply via Email')).toHaveValue('Keep this reply');
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it('binds sending to the reviewed account and retains an in-progress draft',async()=>{
    mocks.get.mockResolvedValue({item:{id:81,recipient:contact.email,reply:{canReply:true,accountLabel:'Sales Gmail',providerAccountId:'gmail-44',senderId:44}}});
    mocks.post.mockResolvedValue({success:true,inProgress:true});mount(<ConversationThread conversation={conversation} contactId={42} scope="7:11:42" canReply initiallyOpen onReplySent={vi.fn()} />);
    await screen.findByText(/From Sales Gmail/);fireEvent.change(screen.getByLabelText('Reply via Email'),{target:{value:'Keep this reply'}});fireEvent.click(screen.getByRole('button',{name:'Reply'}));
    expect(await screen.findByText(/This reply is still being sent/)).toBeVisible();expect(screen.getByLabelText('Reply via Email')).toHaveValue('Keep this reply');expect(screen.getByRole('button',{name:'Reply'})).toBeDisabled();expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({title:'Reply sent successfully'}));
    expect(mocks.post).toHaveBeenCalledWith('/api/outreach-conversations/email/81/messages',expect.objectContaining({inboxContext:true,expectedProviderAccountId:'gmail-44',expectedRecipient:contact.email,senderId:44,idempotencyKey:expect.any(String)}));
    const draft=JSON.parse(sessionStorage.getItem('crm-reply:7:11:42:email:gmail-44:81')!);expect(draft).toMatchObject({content:'Keep this reply',held:true});
  });
});
