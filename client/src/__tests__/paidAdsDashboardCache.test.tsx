import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePaidAdsDashboard } from '@/hooks/usePaidAdsDashboard';
const get=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/api',()=>({api:{get}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
function Workspace({status='all'}:{status?:string}){const query=usePaidAdsDashboard<{campaigns:{name:string;status:string}[]}>({status});return <><button onClick={()=>void query.refresh()}>Refresh</button>{query.data?.campaigns.map(c=><p key={c.name}>{c.name}</p>)}</>;}
it('shares the same reporting cache between sections and retains rows during refresh',async()=>{
  get.mockResolvedValueOnce({campaigns:[{name:'Provider active',status:'report_only'}]});
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  const first=render(<QueryClientProvider client={client}><Workspace status="active"/></QueryClientProvider>);
  expect(await screen.findByText('Provider active')).toBeInTheDocument();
  expect(get).toHaveBeenCalledWith(expect.stringContaining('status=active'));
  first.unmount();
  render(<QueryClientProvider client={client}><Workspace status="active"/></QueryClientProvider>);
  expect(screen.getByText('Provider active')).toBeInTheDocument();
  expect(get).toHaveBeenCalledOnce();
  let finish:(data:unknown)=>void=()=>{};
  get.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  fireEvent.click(screen.getByText('Refresh'));
  await waitFor(()=>expect(get).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Provider active')).toBeInTheDocument();
  finish({campaigns:[{name:'Refreshed provider',status:'report_only'}]});
  expect(await screen.findByText('Refreshed provider')).toBeInTheDocument();
  client.clear();
});

it('invalidates shared reporting after a provider mutation so the returning inventory sees fresh state',async()=>{
  const {invalidatePaidAdsReporting}=await import('@/hooks/usePaidAdsDashboard');
  get.mockResolvedValueOnce({campaigns:[{name:'Before provider pause',status:'active'}]});
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
  const first=render(<QueryClientProvider client={client}><Workspace/></QueryClientProvider>);
  expect(await screen.findByText('Before provider pause')).toBeInTheDocument();
  first.unmount();
  await invalidatePaidAdsReporting(client);
  expect(get).toHaveBeenCalledOnce();
  get.mockResolvedValueOnce({campaigns:[{name:'Provider pause confirmed',status:'paused'}]});
  render(<QueryClientProvider client={client}><Workspace/></QueryClientProvider>);
  expect(await screen.findByText('Provider pause confirmed')).toBeInTheDocument();
  expect(get).toHaveBeenCalledTimes(2);
  client.clear();
});
