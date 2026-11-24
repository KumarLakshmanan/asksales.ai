import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CampaignWorkflowList, type WorkflowCampaign } from '@/components/performance-marketing/CampaignWorkflowList';
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),put:vi.fn()}));
vi.mock('@/lib/api',()=>({api:mocks}));
const campaign=(id:number,provider=true):WorkflowCampaign=>({id,name:`Campaign ${id}`,source:provider?'provider_cache':'managed',objective:'traffic',currency:'INR',adPlatform:'meta',platformCampaignId:String(id),accountRegistryId:7,campaignAiConsent:false,metrics:{spend:20,clicks:4,impressions:100},metricsUpdatedAt:'2026-09-19T00:00:00Z'});
afterEach(cleanup);
beforeEach(()=>{vi.resetAllMocks();mocks.post.mockResolvedValue({});mocks.put.mockResolvedValue({});});
describe('bulk monitoring workflows',()=>{
  it('confirms provider imports and reports partial failures without hiding successes',async()=>{
    mocks.post.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Permission expired'));
    const changed=vi.fn().mockResolvedValue(undefined);
    render(<CampaignWorkflowList automation campaigns={[campaign(1),campaign(2)]} onInspect={vi.fn()} onChanged={changed}/>);
    fireEvent.click(screen.getByLabelText('Select this page'));
    fireEvent.click(screen.getByRole('button',{name:'Import selected (2)'}));
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Confirm'}));
    await waitFor(()=>expect(changed).toHaveBeenCalledOnce());
    expect(mocks.post).toHaveBeenCalledWith('/api/campaigns/autonomous/import-provider',{platform:'meta',platformCampaignId:'1',accountId:7});
    expect(screen.getByText(/Permission expired/)).toBeInTheDocument();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
  it('preserves saved targets during consent updates',async()=>{
    mocks.get.mockResolvedValue({policy:{thresholds:{targetCpl:12,spendLimit:100}}});
    render(<CampaignWorkflowList automation campaigns={[campaign(3,false)]} onInspect={vi.fn()} onChanged={vi.fn()}/>);
    fireEvent.click(screen.getByLabelText('Select this page'));
    fireEvent.click(screen.getByRole('button',{name:'Enable pause consent (1)'}));
    fireEvent.click(screen.getByRole('button',{name:'Confirm'}));
    await waitFor(()=>expect(mocks.put).toHaveBeenCalledWith('/api/campaigns/autonomous/3/policy',{enabled:true,thresholds:{targetCpl:12,spendLimit:100}}));
  });
  it('paginates and filters campaign reviews',()=>{
    render(<CampaignWorkflowList campaigns={Array.from({length:32},(_,i)=>campaign(i))} onInspect={vi.fn()} onChanged={vi.fn()}/>);
    expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Next page'}));
    expect(screen.getByText(/Page 2 of 3/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search by campaign name'),{target:{value:'Campaign 31'}});
    expect(screen.getByText(/Page 1 of 1/)).toBeInTheDocument();
  });
});
