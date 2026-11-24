import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ChatOperationResults} from '@/components/operations/ChatOperationResults';
import {selectBusinessProfile} from '@/lib/business-profile';
import type {DashboardOperationResult} from '../../../shared/dashboardOperations';
const mocks=vi.hoisted(()=>({get:vi.fn()}));
vi.mock('@/lib/api',()=>({api:mocks}));
const id='10000000-0000-4000-8000-000000000001';
const card=(extra:Partial<DashboardOperationResult>={}):DashboardOperationResult=>({title:'Contact analysis',status:'ready',businessProfileId:7,
  metrics:[{label:'Unique contacts',value:575}],actions:[{label:'View analysis',href:`/dashboard/crm/import/analyze?operationId=${id}`}],...extra});
beforeEach(()=>{vi.resetAllMocks();localStorage.setItem('user',JSON.stringify({id:9}));sessionStorage.setItem('active-business-profile:9','7');});
afterEach(()=>{cleanup();localStorage.clear();sessionStorage.clear();});
describe('chat operation result cards',()=>{
  it('shows escaped authoritative counts and dashboard actions, omitting arbitrary and unauthenticated URLs',()=>{
    render(<ChatOperationResults results={[card({title:'<script>analysis</script>',actions:[{label:'Open',href:'/dashboard/crm/import/analyze'},{label:'External',href:'https://example.com'},{label:'API',href:'/api/private'}]})]}/>);
    expect(screen.getByRole('heading',{name:'<script>analysis</script>'})).toBeInTheDocument();
    expect(screen.getByText('575')).toBeInTheDocument();expect(screen.getAllByRole('link')).toHaveLength(1);
  });
  it('updates queued operations through the authenticated application client and stops on a ready preview',async()=>{
    mocks.get.mockResolvedValue({card:card()});
    render(<ChatOperationResults results={[card({status:'queued',operation:{id,kind:'contact_analysis'}})]}/>);
    await screen.findByText('ready');expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith(`/api/crm/contact-analysis/${id}`,expect.objectContaining({signal:expect.any(AbortSignal)}));
  });
  it('retains campaign, retry and download links with operation IDs and query parameters',()=>{
    const actions=[
      {label:'View campaign',href:`/dashboard/outreach/reports?preparedOutreachId=${id}`},
      {label:'Review retry queue',href:`/dashboard/outreach/retries?operationId=${id}`},
      {label:'Download report',href:`/dashboard/outreach/reports/exports/${id}`},
    ];
    render(<ChatOperationResults results={[card({actions:[...actions,
      {label:'Backslash',href:'/dashboard/\\example.com'},
      {label:'Whitespace',href:'/dashboard/ invalid'},
      {label:'Control',href:'/dashboard/\u0000invalid'},
    ]})]}/>);
    expect(screen.getAllByRole('link')).toHaveLength(actions.length);
    for(const action of actions)expect(screen.getByRole('link',{name:action.label})).toHaveAttribute('href',action.href);
  });
  it('clears previous business cards and rejects late progress after a business switch',async()=>{
    let resolve!:(value:unknown)=>void;mocks.get.mockReturnValue(new Promise(done=>{resolve=done;}));
    render(<ChatOperationResults results={[card({status:'queued',operation:{id,kind:'contact_analysis'}})]}/>);
    await waitFor(()=>expect(mocks.get).toHaveBeenCalledTimes(1));selectBusinessProfile(8);
    await waitFor(()=>expect(screen.queryByText('Contact analysis')).not.toBeInTheDocument());
    resolve({card:card({title:'Late old business'})});await Promise.resolve();
    expect(screen.queryByText('Late old business')).not.toBeInTheDocument();
  });
  it('keeps the saved timestamp and offers navigation when live progress cannot be fetched',async()=>{
    mocks.get.mockRejectedValue(new Error('Offline'));
    render(<ChatOperationResults results={[card({status:'queued',checkedAt:'2026-11-02T00:00:00Z',operation:{id,kind:'contact_analysis'}})]}/>);
    expect(await screen.findByText(/Live progress is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('link',{name:'View analysis'})).toHaveAttribute('href',expect.stringContaining(id));
  });
});
