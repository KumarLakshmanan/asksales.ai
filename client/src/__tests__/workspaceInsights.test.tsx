import React from 'react';
import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import InsightsPage from '@/app/dashboard/(main)/insights/page';
import { makeDemoInsights } from '@/app/dashboard/(main)/insights/demo';

const mocks=vi.hoisted(()=>({get:vi.fn()}));
vi.mock('@/hooks/use-billing-api',()=>({useBillingApi:()=>({get:mocks.get})}));
vi.mock('@/hooks/use-billing-organizations',()=>({useBillingOrganizations:()=>({billingScopeKey:'business:11:org:23',businessProfileId:11})}));
vi.mock('recharts',()=>({
  ResponsiveContainer:({children}:{children:React.ReactNode})=><div>{children}</div>,
  AreaChart:({children}:{children:React.ReactNode})=><div>{children}</div>,
  BarChart:({children}:{children:React.ReactNode})=><div>{children}</div>,
  Area:()=>null,Bar:()=>null,CartesianGrid:()=>null,Tooltip:()=>null,XAxis:()=>null,YAxis:()=>null,
}));

function show(){const client=new QueryClient({defaultOptions:{queries:{retry:false,retryDelay:0}}});
  return render(<QueryClientProvider client={client}><InsightsPage/></QueryClientProvider>);}
beforeEach(()=>{vi.clearAllMocks();const fixture=makeDemoInsights();
  mocks.get.mockImplementation((path:string)=>Promise.resolve(path==='/api/insights/details'
    ?{items:[{id:'9',occurredAt:'2026-09-15T12:00:00.000Z',title:'deduction',kind:'deduction',channel:'whatsapp',credits:'3.00',inr:'0.30'}],nextCursor:null}
    :fixture));});
afterEach(cleanup);

describe('workspace insights dashboard',()=>{
  it('hides a retained successful snapshot when Refresh reaches the rollout gate',async()=>{
    show();expect(await screen.findByText('2,415')).toBeVisible();
    mocks.get.mockRejectedValue({status:503,data:{code:'INSIGHTS_ROLLOUT_PENDING'}});
    fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
    expect(await screen.findByText('Insights is not available for this workspace yet.')).toBeVisible();
    expect(screen.queryByText('2,415')).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing the last successful snapshot/)).not.toBeInTheDocument();
  });
  it('retries a failed detail read without closing the dialog or losing its filters',async()=>{
    const fixture=makeDemoInsights();let detailFails=true;
    mocks.get.mockImplementation((path:string)=>path==='/api/insights/details'
      ?detailFails?Promise.reject(new Error('Synthetic detail failure')):Promise.resolve({items:[],nextCursor:null})
      :Promise.resolve(fixture));
    show();
    fireEvent.click(await screen.findByRole('button',{name:'Details for Credits consumed'}));
    expect(await screen.findByText('Could not load records.')).toBeVisible();
    detailFails=false;
    fireEvent.click(await screen.findByRole('button',{name:'Retry records'}));
    expect(await screen.findByText('No matching records.')).toBeVisible();
    expect(screen.getByRole('dialog')).toBeVisible();
    const reads=mocks.get.mock.calls.filter(([path])=>path==='/api/insights/details');
    expect(reads).toHaveLength(2);
    expect(reads[1][1]).toEqual(expect.objectContaining({params:expect.objectContaining({kind:'charges',channel:'all',days:'30'})}));
  });
  it('names detail controls with their panel context',async()=>{
    show();
    expect(await screen.findByRole('button',{name:'Details for Credits consumed'})).toBeVisible();
    expect(screen.getByRole('button',{name:'Details for Cost by process'})).toBeVisible();
    expect(screen.getByRole('button',{name:'Details for New contacts'})).toBeVisible();
  });
  it('renders API process options and preserves the chosen process in summary and details requests',async()=>{
    const fixture=makeDemoInsights();fixture.filters.processes=['customer_chat','routing'];
    mocks.get.mockImplementation((path:string)=>Promise.resolve(path==='/api/insights/details'?{items:[],nextCursor:null}:fixture));
    show();
    const select=await screen.findByRole('combobox',{name:'Filter by process'});
    expect(await within(select).findByRole('option',{name:'customer chat'})).toHaveValue('customer_chat');
    expect(within(select).getByRole('option',{name:'All processes'})).toHaveValue('');
    fireEvent.change(select,{target:{value:'customer_chat'}});
    await waitFor(()=>expect(mocks.get).toHaveBeenCalledWith('/api/insights',expect.objectContaining({params:expect.objectContaining({process:'customer_chat'})})));
    fireEvent.click((await screen.findAllByRole('button',{name:/^Details for /}))[0]);
    await waitFor(()=>expect(mocks.get).toHaveBeenCalledWith('/api/insights/details',expect.objectContaining({params:expect.objectContaining({process:'customer_chat',kind:'charges'})})));
  });

  it('keeps the last successful snapshot visible and labels it stale after a failed Refresh', async()=>{
    show();
    expect(await screen.findByText('2,415')).toBeVisible();
    mocks.get.mockRejectedValue(new Error('Synthetic refresh outage.'));
    fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic refresh outage.');
    expect(screen.getByText('2,415')).toBeVisible();
    expect(screen.getByText(/Showing the last successful snapshot/)).toBeVisible();
    expect(screen.getByText(/Last updated/)).toBeVisible();
  });
  it.each([401,403])('hides a previous snapshot when Refresh returns access denial %s', async(status)=>{
    show();
    expect(await screen.findByText('2,415')).toBeVisible();
    mocks.get.mockRejectedValue(Object.assign(new Error('Access denied.'),{status}));
    fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Access denied.');
    expect(screen.queryByText('2,415')).not.toBeInTheDocument();
  });
  it('aborts a superseded filter request and keeps the current cached query',async()=>{
    show();
    expect(await screen.findByText('2,415')).toBeVisible();
    let aborted=false;
    mocks.get.mockImplementation((_path:string,options:{signal:AbortSignal})=>new Promise((_resolve,reject)=>{
      options.signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('Aborted','AbortError'));});
    }));
    fireEvent.click(screen.getByRole('button',{name:'WhatsApp'}));
    await waitFor(()=>expect(mocks.get).toHaveBeenLastCalledWith('/api/insights',expect.objectContaining({params:expect.objectContaining({channel:'whatsapp'})})));
    fireEvent.click(screen.getByRole('button',{name:'All platforms'}));
    expect(await screen.findByText('2,415')).toBeVisible();
    expect(aborted).toBe(true);
  });
  it('keeps the query contract and filters when a failed initial request is refreshed', async () => {
    mocks.get.mockRejectedValue(new Error('Unable to load Insights.'));
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load Insights.');
    mocks.get.mockResolvedValue(makeDemoInsights());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('2,415')).toBeVisible();
    expect(mocks.get).toHaveBeenLastCalledWith('/api/insights', expect.objectContaining({ params: expect.objectContaining({ days: '30', channel: 'all', refresh: '1' }), signal: expect.any(AbortSignal) }));
    expect(mocks.get.mock.calls.at(-1)?.[1].params.from).toBeUndefined();
  });
  it('renders costs, outcome evidence, responsive cards, filters and a charge drill-down',async()=>{
    const view=show();
    expect(await screen.findByText('2,415')).toBeInTheDocument();
    expect(screen.getByText('INR 1,86,000')).toBeInTheDocument();
    expect(screen.getByText(/Observed activity between first and last message/)).toBeInTheDocument();
    expect(view.container.querySelector('.lg\\:grid-cols-3')).not.toBeNull();
    expect(view.container.querySelector('[title^="Mon 9:00"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'WhatsApp'}));
    await waitFor(()=>expect(mocks.get).toHaveBeenCalledWith('/api/insights',expect.objectContaining({params:expect.objectContaining({channel:'whatsapp'})})));
    fireEvent.click((await screen.findAllByRole('button',{name:/^Details for /}))[0]);
    expect(await screen.findByText('3.00 credits')).toBeInTheDocument();
  });

  it('labels demo fixtures and displays incomplete currency coverage',async()=>{
    const fixture=makeDemoInsights();fixture.costs.status='partial';fixture.costs.notes=['Older charges have no conversion rate.'];
    mocks.get.mockResolvedValue(fixture);
    show();
    expect(await screen.findAllByText('Older charges have no conversion rate.')).not.toHaveLength(0);
    fireEvent.click(screen.getByRole('button',{name:'Demo data'}));
    expect(screen.getByText(/Illustrative demo data/)).toBeInTheDocument();
  });

  it('hides restricted sections and bypasses the summary cache on Refresh',async()=>{
    const fixture=makeDemoInsights();
    fixture.performance.status='restricted';fixture.performance.notes=['AI usage permission is required.'];
    fixture.sales.moneyCoverage.status='restricted';fixture.sales.moneyCoverage.notes=['Billing permission is required for sales amounts.'];
    mocks.get.mockResolvedValue(fixture);
    show();
    expect(await screen.findByText('AI usage permission is required.')).toBeInTheDocument();
    expect(screen.getAllByText('Billing permission is required for sales amounts.')).not.toHaveLength(0);
    fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
    await waitFor(()=>expect(mocks.get).toHaveBeenCalledWith('/api/insights',expect.objectContaining({params:expect.objectContaining({refresh:'1'})})));
  });

  it('explains the pricing and ledger gate while rollout is pending',async()=>{
    mocks.get.mockRejectedValue({data:{code:'INSIGHTS_ROLLOUT_PENDING'}});
    show();
    expect(await screen.findByText('Insights is not available for this workspace yet.')).toBeInTheDocument();
  });
});
