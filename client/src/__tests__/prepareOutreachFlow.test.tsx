import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {PrepareOutreachForm} from '@/components/outreach/create/PrepareOutreachForm';
import {selectBusinessProfile} from '@/lib/business-profile';
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),push:vi.fn(),params:new URLSearchParams()}));
vi.mock('@/lib/api',()=>({default:mocks}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:mocks.push}),useSearchParams:()=>mocks.params}));
vi.mock('@/components/outreach/create/WhatsAppTemplateEditor',()=>({WhatsAppTemplateEditor:({prefix='message',onTemplateChange,onValuesChange}:{prefix?:string;onTemplateChange:(id:string)=>void;onValuesChange:(values:Record<string,string>)=>void})=><button onClick={()=>{onTemplateChange('approved-stay');onValuesChange({'body:1':'{{first_name}}'});}}>Choose approved template {prefix}</button>}));
const id='10000000-0000-4000-8000-000000000001',preparedId='10000000-0000-4000-8000-000000000002';
beforeEach(()=>{
  vi.resetAllMocks();localStorage.setItem('user',JSON.stringify({id:9}));sessionStorage.setItem('active-business-profile:9','7');mocks.params=new URLSearchParams({importOperationId:id});
  mocks.get.mockImplementation(async(url:string)=>url.includes('/contact-analysis/') ? {id,kind:'contact_import',status:'completed',total:575,result:{importId:7}} : url.includes('/compose/options') ? {
    channel:'whatsapp',accounts:[{id:'account-1',providerAccountId:'account-1',label:'Hotel WhatsApp',ready:true,reason:null}],
  } : {templates:[{id:'approved-stay',name:'approved_stay',language:'en',body:'Hello {{1}}'}]});
  mocks.post.mockResolvedValue({id:preparedId});
});
afterEach(()=>{cleanup();localStorage.clear();sessionStorage.clear();});
async function chooseTemplate() {
  await screen.findByText(/575 reviewed import rows/);
  await waitFor(()=>expect(screen.getByLabelText('Sending account')).toHaveValue('account-1'));
  fireEvent.click(screen.getByRole('button',{name:'Choose approved template message'}));
}
describe('imported-audience preparation before the existing send review',()=>{
  it('names every channel the way the rest of outreach does',async()=>{
    render(<PrepareOutreachForm/>);
    await screen.findByText(/575 reviewed import rows/);
    const options=Array.from((screen.getByLabelText('Channel') as HTMLSelectElement).options).map(option=>option.textContent);
    expect(options).toContain('SMS');
    expect(options).not.toContain('Sms');
  });
  it('preserves the imported audience, approved template and follow-up time in a saved preparation without sending',async()=>{
    render(<PrepareOutreachForm/>);await chooseTemplate();
    fireEvent.click(screen.getByRole('switch',{name:'Enable follow-ups for this outreach'}));
    fireEvent.change(screen.getByLabelText('Follow-up 1 delay'),{target:{value:'12'}});
    fireEvent.change(screen.getByLabelText('Follow-up 1 delay unit'),{target:{value:'hours'}});
    fireEvent.click(within(screen.getByRole('group',{name:'Follow-up 1'})).getByRole('button',{name:/Choose approved template/}));
    fireEvent.click(screen.getByRole('button',{name:'Prepare and review outreach'}));
    await waitFor(()=>expect(mocks.push).toHaveBeenCalledWith(`/dashboard/outreach/prepared/${preparedId}`));
    expect(mocks.post).toHaveBeenCalledTimes(1);expect(mocks.post).toHaveBeenCalledWith('/api/outreach/prepared',expect.objectContaining({
      audience:{importOperationId:id},providerAccountId:'account-1',channel:'whatsapp',templateId:'approved-stay',templateValues:{'body:1':'{{first_name}}'},
      followUps:[expect.objectContaining({delayMinutes:720,templateId:'approved-stay'})],requestKey:expect.any(String),
    }));
  });
  it('keeps the same preparation identity after a lost response and refuses to prepare an incomplete import',async()=>{
    mocks.post.mockRejectedValueOnce(new Error('Response lost'));
    render(<PrepareOutreachForm/>);await chooseTemplate();
    fireEvent.click(screen.getByRole('button',{name:'Prepare and review outreach'}));await screen.findByText('Response lost');
    fireEvent.click(screen.getByRole('button',{name:'Prepare and review outreach'}));await waitFor(()=>expect(mocks.push).toHaveBeenCalled());
    expect(mocks.post.mock.calls[0][1].requestKey).toBe(mocks.post.mock.calls[1][1].requestKey);
    cleanup();mocks.get.mockImplementation(async(url:string)=>url.includes('/contact-analysis/') ? {id,kind:'contact_import',status:'running',total:575} : {channel:'whatsapp',accounts:[]});
    render(<PrepareOutreachForm/>);expect(await screen.findByText(/Import is running/)).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Prepare and review outreach'})).toBeDisabled();
  });
  it('does not navigate into the old business after a late preparation response',async()=>{
    let resolve!:(value:unknown)=>void;mocks.post.mockReturnValue(new Promise(done=>{resolve=done;}));
    render(<PrepareOutreachForm/>);await chooseTemplate();fireEvent.click(screen.getByRole('button',{name:'Prepare and review outreach'}));
    await waitFor(()=>expect(mocks.post).toHaveBeenCalledTimes(1));selectBusinessProfile(8);resolve({id:preparedId});await Promise.resolve();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
