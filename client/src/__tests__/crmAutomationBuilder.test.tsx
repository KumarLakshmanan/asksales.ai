import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AutomationBuilder} from '@/components/crm/AutomationBuilder';
import {AutomationRuns} from '@/components/crm/AutomationRuns';
import AutomationsPage from '@/app/dashboard/(main)/crm/automations/page';
import {AUTOMATION_ACTIONS,AUTOMATION_CONDITION_FIELDS,AUTOMATION_PLACEHOLDERS,AUTOMATION_TRIGGERS,legacyAutomationDefinition,type AutomationCatalog} from '@/lib/crm-automations';

const mocks=vi.hoisted(()=>({get:vi.fn(),put:vi.fn(),post:vi.fn(),push:vi.fn(),toast:vi.fn(),handlers:{} as Record<string,()=>void>}));
vi.mock('@/lib/api',()=>({api:mocks,default:mocks}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:mocks.push})}));
vi.mock('@/hooks/use-toast',()=>({useToast:()=>({toast:mocks.toast})}));
vi.mock('@/hooks/use-crm-configuration',()=>({useCrmConfiguration:()=>({stages:[{key:'new',label:'New',type:'new',color:'#123456',inFlow:true},{key:'qualified_custom',label:'Qualified',type:'active',color:'#345678',inFlow:true}],loading:false,error:null})}));
vi.mock('@/services/WebSocketService',()=>({default:{subscribe:(type:string,handler:()=>void)=>{mocks.handlers[type]=handler;return ()=>{delete mocks.handlers[type];};}}}));
const catalog=():AutomationCatalog=>({triggers:[...AUTOMATION_TRIGGERS],actions:[...AUTOMATION_ACTIONS],fields:[...AUTOMATION_CONDITION_FIELDS],placeholders:[...AUTOMATION_PLACEHOLDERS],runtimeEnabled:true,
  accounts:[{channel:'email',id:'7',senderId:7,label:'sales@example.test',ready:true},{channel:'sms',id:'SMSAPP',label:'SMS alerts',ready:true,flowId:'flow-1'},{channel:'whatsapp',id:'wa-account',label:'WhatsApp sales',ready:true}],
  campaigns:[{id:4,name:'Launch'}],members:[{id:9,name:'Manager'}],whatsappTemplates:[{id:12,name:'approved_notice',language:'en',accountId:'wa-account',ready:true,hash:'reviewed',variables:['body:1']}]});
const legacy={id:3,name:'Existing rule',revision:4,isActive:true,priority:8,triggerType:'pipeline_status_change',triggerConfig:{toStatus:'qualified_custom'},action:'create_ticket',actionConfig:{subject:'Existing subject',description:'Keep this',priority:'urgent'}};
beforeEach(()=>{
  vi.clearAllMocks();mocks.handlers={};
  mocks.get.mockImplementation(async(url:string)=>url.endsWith('/catalog') ? catalog() : {...legacy,definition:legacyAutomationDefinition(legacy)});
  mocks.post.mockResolvedValue({matches:true,triggerMatches:true,conditions:[],actions:[],warnings:['Preview only.']});mocks.put.mockResolvedValue({});
  vi.stubGlobal('ResizeObserver',class {observe(){}unobserve(){}disconnect(){}});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function createBuilder(){render(<AutomationBuilder/>);await screen.findByRole('heading',{name:'New automation'});return userEvent.setup();}
async function choosePipeline(user:ReturnType<typeof userEvent.setup>){await user.type(screen.getByLabelText('Search triggers'),'pipeline');await user.click(screen.getByRole('button',{name:/Pipeline stage changes/}));}

describe('CRM automation visual builder',()=>{
  it('searches/collapses trigger cards, uses custom stages, and saves stable ordered steps paused',async()=>{
    const user=await createBuilder();await user.type(screen.getByLabelText('Automation name'),'Qualified workflow');await choosePipeline(user);
    expect(screen.queryByLabelText('Search triggers')).not.toBeInTheDocument();await user.selectOptions(screen.getByLabelText('To stage'),'qualified_custom');
    await user.click(within(screen.getByRole('navigation',{name:'Automation setup steps'})).getByRole('button',{name:/Actions/}));await user.selectOptions(screen.getByLabelText('Add action'),'update_tags');await user.type(screen.getByLabelText('Tags'),'qualified, priority');
    await user.click(within(screen.getByRole('navigation',{name:'Automation setup steps'})).getByRole('button',{name:/Actions/}));await user.selectOptions(screen.getByLabelText('Add action'),'update_pipeline_status');await user.selectOptions(screen.getByLabelText('Destination stage'),'qualified_custom');
    await user.click(screen.getByRole('button',{name:'Move action 2 up'}));await user.click(within(screen.getByRole('navigation',{name:'Automation setup steps'})).getByRole('button',{name:/Conditions/}));await user.click(screen.getByRole('button',{name:'Add condition'}));
    await user.selectOptions(screen.getByLabelText('Match conditions'),'any');await user.selectOptions(screen.getByLabelText('Condition 1 field'),'contact.pipelineStatus');
    await user.selectOptions(screen.getByLabelText('Condition 1 value'),'qualified_custom');await user.click(screen.getByRole('button',{name:'Save paused draft'}));
    await waitFor(()=>expect(mocks.post).toHaveBeenCalledWith('/api/crm/automations',expect.anything()));
    const payload=mocks.post.mock.calls.at(-1)![1];expect(payload.isActive).toBeUndefined();expect(payload.definition.actions.map((action:{type:string})=>action.type)).toEqual(['update_pipeline_status','update_tags']);
    expect(payload.definition.actions[1].config.tags).toEqual(['qualified','priority']);expect(payload.definition.conditions.match).toBe('any');expect(mocks.push).toHaveBeenCalledWith('/dashboard/crm/automations');
  });
  it('previews rendered actions without invoking Save or activation',async()=>{
    const user=await createBuilder();await user.type(screen.getByLabelText('Automation name'),'Preview');await choosePipeline(user);
    await user.click(within(screen.getByRole('navigation',{name:'Automation setup steps'})).getByRole('button',{name:/Actions/}));await user.selectOptions(screen.getByLabelText('Add action'),'send_notification');await user.selectOptions(screen.getByLabelText('Verified sender'),'7');
    await user.type(screen.getByLabelText('Email subject'),'Notice');await user.type(screen.getByLabelText('Email message'),'Hello');
    mocks.post.mockResolvedValue({matches:true,triggerMatches:true,conditions:[],actions:[{id:'preview',type:'send_notification',ready:true,recipient:'contact@example.test',rendered:{message:'Hello'}}],warnings:['Preview only.']});
    await user.click(screen.getByRole('button',{name:'Test'}));await user.click(screen.getByRole('button',{name:'Run preview'}));
    await screen.findByText('This event qualifies');expect(screen.getByText('To: contact@example.test')).toBeVisible();
    expect(mocks.post).toHaveBeenCalledTimes(1);expect(mocks.post.mock.calls[0][0]).toBe('/api/crm/automations/test');expect(mocks.put).not.toHaveBeenCalled();expect(mocks.push).not.toHaveBeenCalled();
  });
  it('disables contact actions for campaign lifecycle triggers and supports fixed notification recipients',async()=>{
    const user=await createBuilder();await user.type(screen.getByLabelText('Search triggers'),'Campaign started');await user.click(screen.getByRole('button',{name:/Campaign started/}));
    await user.click(within(screen.getByRole('navigation',{name:'Automation setup steps'})).getByRole('button',{name:/Actions/}));const actionPicker=screen.getByLabelText('Add action');expect(within(actionPicker).getByRole('option',{name:/Create support ticket/i})).toBeDisabled();
    await user.selectOptions(actionPicker,'send_notification');expect(screen.getByLabelText('Recipient')).toHaveValue('fixed');
    expect(within(screen.getByLabelText('Recipient')).getByRole('option',{name:'Triggering contact'})).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Notification channel'),'sms');await user.selectOptions(screen.getByLabelText('Sending account'),'SMSAPP');
    expect(screen.getByLabelText('Configured SMS flow / template')).toHaveValue('flow-1');await user.type(screen.getByLabelText('Recipient phone'),'9876543210');
    await user.type(screen.getByLabelText('Template message variable'),'Hello');await user.type(screen.getByLabelText('Automation name'),'Fixed SMS');await user.click(screen.getByRole('button',{name:'Save paused draft'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('international phone number');expect(mocks.post).not.toHaveBeenCalled();
  });
  it('preserves legacy ticket settings and revision during full-page editing',async()=>{
    render(<AutomationBuilder automationId={3}/>);await screen.findByRole('heading',{name:'Edit automation'});
    expect(screen.getByLabelText('Ticket subject')).toHaveValue('Existing subject');expect(screen.getByLabelText('Description')).toHaveValue('Keep this');
    expect(screen.getByLabelText('Priority',{exact:true,selector:'select'})).toHaveValue('urgent');
    fireEvent.change(screen.getByLabelText('Automation name'),{target:{value:'Edited name'}});await userEvent.click(screen.getByRole('button',{name:'Save changes'}));
    await waitFor(()=>expect(mocks.put).toHaveBeenCalled());expect(mocks.put.mock.calls[0][1]).toEqual(expect.objectContaining({revision:4,priority:8,definition:expect.objectContaining({actions:[expect.objectContaining({config:legacy.actionConfig})]})}));
  });
  it('maps approved WhatsApp template variables and preserves action IDs during reordering',async()=>{
    const user=await createBuilder();await choosePipeline(user);await user.click(within(screen.getByRole('navigation',{name:'Automation setup steps'})).getByRole('button',{name:/Actions/}));await user.selectOptions(screen.getByLabelText('Add action'),'send_notification');
    await user.selectOptions(screen.getByLabelText('Notification channel'),'whatsapp');await user.selectOptions(screen.getByLabelText('Sending account'),'wa-account');
    await user.selectOptions(screen.getByLabelText('Approved WhatsApp template'),'12:en');await user.type(screen.getByLabelText('Variable body:1'),'Alex');
    await user.click(within(screen.getByRole('navigation',{name:'Automation setup steps'})).getByRole('button',{name:/Actions/}));await user.selectOptions(screen.getByLabelText('Add action'),'update_tags');await user.type(screen.getByLabelText('Tags'),'qualified');await user.type(screen.getByLabelText('Automation name'),'WA');
    await user.click(screen.getByRole('button',{name:'Move action 2 up'}));await user.click(screen.getByRole('button',{name:'Save paused draft'}));
    await waitFor(()=>expect(mocks.post).toHaveBeenCalled());const actions=mocks.post.mock.calls[0][1].definition.actions;
    expect(new Set(actions.map((action:{id:string})=>action.id)).size).toBe(2);expect(actions[1].config).toEqual(expect.objectContaining({templateId:12,templateHash:'reviewed',language:'en',variables:{'body:1':'Alex'}}));
  });
  it('rejects malformed webhook JSON before Save',async()=>{
    const user=await createBuilder();await choosePipeline(user);await user.type(screen.getByLabelText('Automation name'),'Webhook');await user.click(within(screen.getByRole('navigation',{name:'Automation setup steps'})).getByRole('button',{name:/Actions/}));await user.selectOptions(screen.getByLabelText('Add action'),'webhook');
    await user.type(screen.getByLabelText('Webhook URL'),'https://example.test');fireEvent.change(screen.getByLabelText('JSON payload'),{target:{value:'{invalid'}});
    await user.click(screen.getByRole('button',{name:'Save paused draft'}));expect(mocks.post).not.toHaveBeenCalled();expect(screen.getByText('Correct the invalid JSON fields.')).toBeVisible();
  });
});

describe('CRM automation history and asynchronous refresh',()=>{
  it('refreshes the list when the worker publishes an automation update',async()=>{
    let count=0;mocks.get.mockImplementation(async(url:string)=>url.endsWith('/logs') ? [] : [{...legacy,definition:legacyAutomationDefinition(legacy),executionCount:count,createdAt:new Date().toISOString()}]);
    render(<AutomationsPage/>);await screen.findByText('Existing rule');expect(screen.getByText('0',{exact:true})).toBeInTheDocument();count=2;
    await act(async()=>mocks.handlers['events:crm:automation:updated']());await screen.findByText('2',{exact:true});expect(mocks.get).toHaveBeenCalledTimes(2);
  });
  it('loads paginated history and displays uncertain delivery with retained step results',async()=>{
    const run={id:11,automationId:3,automationName:'Existing rule',revision:4,eventType:'pipeline_status_change',status:'uncertain',createdAt:new Date().toISOString()};
    mocks.get.mockImplementation(async(url:string)=>url.endsWith('/runs/11') ? {...run,steps:[{id:5,position:0,actionType:'send_notification',status:'uncertain',attempts:1,providerStatus:'accepted',result:{recipient:'manager@example.test'}}]} : {runs:[run],nextCursor:10});
    render(<AutomationRuns automationId={3}/>);await screen.findByText('Run #11 · revision 4');await userEvent.click(screen.getByRole('button',{name:/Run #11/}));
    await screen.findByRole('region',{name:'Run step details'});expect(screen.getByText(/Remaining actions are held/)).toBeVisible();expect(screen.getByText(/Delivery: accepted/)).toBeVisible();
    await userEvent.click(screen.getByRole('button',{name:'Load older runs'}));await waitFor(()=>expect(mocks.get).toHaveBeenCalledWith('/api/crm/automations/3/runs?cursor=10'));
  });
  it('does not let an automatic refresh discard a slow first load of the rules or run history',async()=>{
    let finishRules!:(value:unknown)=>void;let finishRuns!:(value:unknown)=>void;
    const run={id:11,automationId:3,automationName:'Existing rule',revision:4,eventType:'pipeline_status_change',status:'completed',createdAt:new Date().toISOString()};
    mocks.get.mockImplementation((url:string)=>url==='/api/crm/automations' ? new Promise(resolve=>{finishRules=resolve;}) : url.includes('/runs') ? new Promise(resolve=>{finishRuns=resolve;}) : Promise.resolve([]));
    render(<><AutomationsPage/><AutomationRuns automationId={3}/></>);
    await waitFor(()=>expect(mocks.get).toHaveBeenCalledTimes(2));
    // A socket event while both first loads are still running must not start parallel reads.
    await act(async()=>{mocks.handlers['events:crm:automation:updated']?.();});
    expect(mocks.get).toHaveBeenCalledTimes(2);
    await act(async()=>{finishRules([]);finishRuns({runs:[run],nextCursor:null});});
    await screen.findByText('Run #11 · revision 4');
  });
});
