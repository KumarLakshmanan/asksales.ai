import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), push: vi.fn(), params: new URLSearchParams('platform=facebook&account=26'), ready: true, succeeded: false }));
vi.mock('next/navigation', () => ({ useSearchParams: () => mocks.params, useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('recharts', () => ({ Area: () => null, AreaChart: () => null, CartesianGrid: () => null, ResponsiveContainer: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null }));

import SocialInsightsPage from '@/app/dashboard/(main)/marketing/analytics/page';

const dashboard = {
  sync: { status: 'failed', error_code: 'SOCIAL_ANALYTICS_PERMISSION_REQUIRED' },
  summary: {}, trends: [], recommendation: { recommendation: null, citations: [] }, bestTime: null,
  freshness: { latestSnapshotAt: null, snapshotCount: 0, evidenceSourceCount: 0 },
};

describe('Social Insights reconnect recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.ready = true; mocks.succeeded = false;
    mocks.params = new URLSearchParams('platform=facebook&account=26');
    localStorage.clear();
    window.history.replaceState(null, '', '/dashboard/marketing/analytics?platform=facebook&account=26');
    mocks.get.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/channel-accounts/')) return [{ id: 26, accountIdentifier: 'page-owned', accountName: 'My Page', isSelected: true, analyticsReady: mocks.ready, analyticsReadinessMessage: 'Grant analytics access.' }];
      if (url.startsWith('/api/social-analytics/dashboard')) return mocks.succeeded ? { ...dashboard, sync: { status: 'succeeded', last_succeeded_at: '2026-09-09T07:52:19Z' } } : dashboard;
      return [];
    });
    mocks.post.mockResolvedValue({ inserted: 0, duplicates: 0 });
  });

  it('allows a freshly authorized account to retry despite an earlier permission failure', async () => {
    render(<SocialInsightsPage/>);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Sync now' })[0]).toBeEnabled());
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringContaining('/api/social-analytics/dashboard?')));
    fireEvent.click(screen.getAllByRole('button', { name: 'Sync now' })[0]);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/social-analytics/sync', expect.objectContaining({ platform: 'facebook', credentialId: 26 })));
    expect(window.location.search).toContain('platform=facebook');
  });

  it('distinguishes an empty successful sync from an account that has never synced', async () => {
    mocks.succeeded = true;
    render(<SocialInsightsPage/>);
    expect(await screen.findByText('Connected — no measurements in this range')).toBeInTheDocument();
    expect(screen.getByText('No measurements in this date range')).toBeInTheDocument();
    expect(screen.queryByText('Sync your first social measurement')).not.toBeInTheDocument();
  });

  it('directs an account without current insights permission to reconnect', async () => {
    mocks.ready = false;
    render(<SocialInsightsPage/>);
    expect(await screen.findByText('Analytics permission required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/integrations/facebook');
  });
  it('has one Social Insights view regardless of the old saved mode', async () => {
    localStorage.setItem('performance_marketing_view', 'advanced');
    render(<SocialInsightsPage/>);
    await screen.findByText('Social Insights');
    expect(screen.queryByRole('switch', {name:'Advanced view'})).not.toBeInTheDocument();
    expect(screen.queryByText('Standard')).not.toBeInTheDocument();
    expect(screen.queryByText('Advanced')).not.toBeInTheDocument();
  });

  it('offers setup and preserves the direct Facebook connection when no accounts exist', async () => {
    mocks.get.mockImplementation(async (url: string) => url.startsWith('/api/channel-accounts/') ? [] : []);
    render(<SocialInsightsPage />);
    expect(await screen.findByRole('heading', { name: 'Connect your social accounts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Facebook Page' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Youtube' })).not.toBeInTheDocument();
    expect(screen.queryByText('No accounts connected')).not.toBeInTheDocument();
  });

  it('shows captured post history by default beyond the account metrics period', async () => {
    render(<SocialInsightsPage />);
    const postsTab = await screen.findByRole('tab', { name: 'Posts & comments' });
    fireEvent.mouseDown(postsTab, { button: 0 });
    fireEvent.click(postsTab);
    expect(await screen.findByText(/Showing all captured posts/)).toBeInTheDocument();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/social-analytics\/content\?.*startDate=1970-01-01/)));
    fireEvent.click(screen.getByRole('button', { name: 'Use selected period' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/social-analytics\/content\?.*startDate=2026-/)));
  });

  it('clears a recovered dashboard error when the next request succeeds', async () => {
    const original = mocks.get.getMockImplementation()!;
    let failed = false;
    mocks.get.mockImplementation(async (url:string) => {
      if (url.startsWith('/api/social-analytics/dashboard') && !failed) { failed = true; throw new Error('502 Bad Gateway'); }
      return original(url);
    });
    render(<SocialInsightsPage/>);
    await screen.findByText('502 Bad Gateway');
    fireEvent.change(screen.getByLabelText('End date'), {target:{value:'2026-09-07'}});
    await waitFor(() => expect(screen.queryByText('502 Bad Gateway')).not.toBeInTheDocument());
  });

  it('follows a queued sync through completion', async () => {
    const original = mocks.get.getMockImplementation()!;
    mocks.post.mockResolvedValue({queued:true,jobId:'sync-123'});
    mocks.get.mockImplementation(async (url:string) => url.includes('/sync-jobs/') ? {state:'completed',result:{status:200,body:{content:{count:5,complete:true}}}} : original(url));
    render(<SocialInsightsPage/>);
    await waitFor(() => expect(screen.getAllByRole('button',{name:'Sync now'})[0]).toBeEnabled());
    fireEvent.click(screen.getAllByRole('button',{name:'Sync now'})[0]);
    expect(await screen.findByText(/5 published items refreshed/)).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith('/api/social-analytics/sync-jobs/sync-123');
  });

  it('persists an explicitly selected Facebook account',async()=>{
    mocks.get.mockImplementation(async(url:string)=>{
      if(url==='/api/channel-accounts/facebook_api')return [
        {id:26,accountIdentifier:'page-owned',accountName:'My Page',isSelected:true,analyticsReady:true},
        {id:27,accountIdentifier:'page-second',accountName:'Second Page',isSelected:false,analyticsReady:true},
      ];
      if(url.startsWith('/api/channel-accounts/'))return [];
      if(url.startsWith('/api/social-analytics/dashboard'))return dashboard;
      return [];
    });
    render(<SocialInsightsPage/>);
    fireEvent.click(await screen.findByRole('button',{name:/Second Page/}));
    await waitFor(()=>expect(mocks.post).toHaveBeenCalledWith('/api/channel-accounts/facebook_api/select',{credentialId:27}));
    expect(window.location.search).toContain('account=27');
  });

  it('loads account-scoped listening independently without requesting reports',async()=>{
    const original=mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation(async(url:string)=>{
      if(url.startsWith('/api/social-analytics/listening'))return {items:[{id:'mention-1',platform:'facebook',body:'Scoped Page mention',occurred_at:'2026-09-05T00:00:00Z',sentiment:'unknown',source:'official_api'}],total:1,nextOffset:null,summary:{unknown:1}};
      if(url==='/api/social-analytics/reports')throw new Error('Reports unavailable');
      return original(url);
    });
    render(<SocialInsightsPage/>);
    const listeningTab=await screen.findByRole('tab',{name:'Listening'});
    fireEvent.mouseDown(listeningTab,{button:0});
    fireEvent.click(listeningTab);
    await waitFor(()=>expect(listeningTab).toHaveAttribute('data-state','active'));
    expect(await screen.findByText('Scoped Page mention')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/social-analytics\/listening\?.*credentialId=26/));
    expect(mocks.get).not.toHaveBeenCalledWith('/api/social-analytics/reports');
  });

  it('uses an accessible date select and exactly seven completed UTC days',async()=>{
    render(<SocialInsightsPage/>);
    const preset=await screen.findByRole('combobox',{name:'Social date preset'});
    expect(preset.tagName).toBe('SELECT');
    fireEvent.change(preset,{target:{value:'7'}});
    const start=(screen.getByLabelText('Start date') as HTMLInputElement).value;
    const end=(screen.getByLabelText('End date') as HTMLInputElement).value;
    expect((Date.parse(end)-Date.parse(start))/86400000+1).toBe(7);
    expect(end).toBe(new Date(Date.now()-86400000).toISOString().slice(0,10));
  });

});
