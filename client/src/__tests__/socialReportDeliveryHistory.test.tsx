import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
const api=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),patch:vi.fn(),delete:vi.fn()}));
vi.mock('@/lib/api',()=>({api}));
import {SocialReportsPanel} from '@/components/social-insights/SocialReportsPanel';
const report={id:'11111111-1111-4111-8111-111111111111',name:'Fixture report',filters:{platform:'instagram',accountIdentifier:'account-a'}};
const props={platform:'instagram',accountIdentifier:'account-a',accountName:'Account A',startDate:'2026-10-01',endDate:'2026-10-22',timezone:'UTC',revision:0};
beforeEach(()=>{vi.clearAllMocks();window.history.replaceState(null,'','/');api.post.mockResolvedValue({payload:{snapshots:[],citations:[]}});api.get.mockImplementation(async()=>[report]);});
it('shows history failure inside the preview and retries only the history read',async()=>{
 let fail=true;
 api.get.mockImplementation(async(url:string)=>{
  if(!url.endsWith('/deliveries'))return [report];
  if(fail)throw new Error('History is unavailable');
  return [{id:'delivery',status:'sent',attempted_at:'2026-10-23T09:00:00Z'}];
 });
 render(<SocialReportsPanel {...props}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Preview'}));
 const dialog=within(await screen.findByRole('dialog'));
 expect(await dialog.findByRole('alert')).toHaveTextContent('History is unavailable');
 expect(dialog.queryByText('No scheduled deliveries yet.')).not.toBeInTheDocument();
 fail=false;fireEvent.click(dialog.getByRole('button',{name:'Retry delivery history'}));
 expect(await dialog.findByText(/sent/)).toBeInTheDocument();
 expect(dialog.queryByRole('alert')).not.toBeInTheDocument();expect(api.post).toHaveBeenCalledTimes(1);
 expect(api.get.mock.calls.filter(([url])=>String(url).endsWith('/deliveries'))).toHaveLength(2);
});
it('does not claim empty history while loading, then shows an attested empty result',async()=>{
 let finish:(value:unknown)=>void=()=>{};
 const pending=new Promise(resolve=>finish=resolve);
 api.get.mockImplementation((url:string)=>url.endsWith('/deliveries')?pending:Promise.resolve([report]));
 render(<SocialReportsPanel {...props}/>);fireEvent.click(await screen.findByRole('button',{name:'Preview'}));
 const dialog=within(await screen.findByRole('dialog'));
 expect(await dialog.findByRole('status')).toHaveTextContent('Loading delivery history');
 expect(dialog.queryByText('No scheduled deliveries yet.')).not.toBeInTheDocument();
 await act(async()=>finish([]));expect(await dialog.findByText('No scheduled deliveries yet.')).toBeInTheDocument();
});
it('ignores a history failure completed after the preview was dismissed',async()=>{
 let fail:(error:Error)=>void=()=>{};
 const pending=new Promise((_resolve,reject)=>fail=reject);
 api.get.mockImplementation((url:string)=>url.endsWith('/deliveries')?pending:Promise.resolve([report]));
 render(<SocialReportsPanel {...props}/>);fireEvent.click(await screen.findByRole('button',{name:'Preview'}));
 const dialog=await screen.findByRole('dialog');fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));
 await act(async()=>fail(new Error('Late history failure')));
 await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
 expect(screen.queryByText('Late history failure')).not.toBeInTheDocument();
 api.get.mockImplementation(async(url:string)=>url.endsWith('/deliveries')?[]:[report]);
 fireEvent.click(screen.getByRole('button',{name:'Preview'}));
 expect(await within(await screen.findByRole('dialog')).findByText('No scheduled deliveries yet.')).toBeInTheDocument();
});
