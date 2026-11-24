import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBusinessProfiles } from '@/hooks/use-business-profiles';
import { businessProfileHeaders, selectBusinessProfile, selectedBusinessProfileId } from '@/lib/business-profile';
import { conversationAttempt, readConversationAttempt } from '@/lib/conversation-attempt';
import { publishingIdempotencyKey } from '@/lib/socialPublishing';

const { get, post, open, auth } = vi.hoisted(() => ({ get:vi.fn(), post:vi.fn(), open:vi.fn(), auth: { user: { id:11 } as { id:number } | null, isLoading:false, error:null as string | null } }));
vi.mock('@/lib/api', () => ({ default:{ get,post } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/lib/business-profile', async original => ({ ...await original<typeof import('@/lib/business-profile')>(), openBusinessDashboard:open }));
const profiles = [{ id:1,companyName:'North',isDefault:true },{ id:2,companyName:'South',isDefault:false }];
function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: { children: React.ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; };
}
function setup() {
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  return { client, ...renderHook(() => useBusinessProfiles(), {wrapper:wrapper(client)}) };
}

describe('business workspace switching', () => {
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
    auth.user = {id:11}; auth.isLoading = false; auth.error = null;
    localStorage.setItem('user',JSON.stringify({id:11}));
    get.mockImplementation(async (url:string) => url.endsWith('/business-profiles') ? profiles : profiles.find(p=>url.endsWith(`/${p.id}`)));
    post.mockResolvedValue({});
  });
  it('initializes the tab from the default without changing account settings', async () => {
    const {result} = setup();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(selectedBusinessProfileId()).toBe(1);
    expect(post).not.toHaveBeenCalled();
  });
  it('does not select cached profiles after the stored account disappears before an effect', () => {
    localStorage.removeItem('user');
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    client.setQueryData(['business-profiles',11],profiles);
    const {result} = renderHook(() => useBusinessProfiles(), {wrapper:wrapper(client)});
    expect(result.current.activeProfile).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('active-business-profile:11')).toBeNull();
  });
  it.each(['loading','failed'] as const)('withholds cached profiles while session verification is %s', state => {
    auth.isLoading = state === 'loading'; auth.error = state === 'failed' ? 'Session check unavailable' : null;
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    client.setQueryData(['business-profiles',11],profiles);
    const {result} = renderHook(() => useBusinessProfiles(), {wrapper:wrapper(client)});
    expect(result.current.activeProfile).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(selectedBusinessProfileId()).toBeNull();
  });
  it('does not select archived workspaces even if a cached list includes them', async () => {
    get.mockResolvedValueOnce([{ id: 3, companyName: 'Archived', isDefault: true, archivedAt: '2026-10-01' }, ...profiles]);
    const {result} = setup();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.profiles.map(profile => profile.id)).toEqual([1, 2]);
    expect(selectedBusinessProfileId()).toBe(1);
    await expect(result.current.switchProfile(3)).rejects.toThrow('no longer available');
    expect(open).not.toHaveBeenCalled();
  });
  it('verifies the selection, discards old queries and opens a fresh workspace', async () => {
    const {result,client} = setup();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    client.setQueryData(['campaigns'],{business:'North'});
    sessionStorage.setItem('outreach_selected_leads','[99]');
    await act(async () => { await result.current.switchProfile(2); });
    expect(get).toHaveBeenCalledWith('/api/settings/business-profiles/2');
    expect(selectedBusinessProfileId()).toBe(2);
    expect(businessProfileHeaders()).toEqual({'X-Business-Profile-Id':'2'});
    expect(client.getQueryData(['campaigns'])).toBeUndefined();
    expect(sessionStorage.getItem('outreach_selected_leads')).toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
  });
  it('keeps selection and cached work when verification fails', async () => {
    const {result,client} = setup();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    client.setQueryData(['campaigns'],{business:'North'});
    get.mockRejectedValueOnce(new Error('Business unavailable'));
    await act(async () => { await expect(result.current.switchProfile(2)).rejects.toThrow('Business unavailable'); });
    expect(selectedBusinessProfileId()).toBe(1);
    expect(client.getQueryData(['campaigns'])).toEqual({business:'North'});
    expect(open).not.toHaveBeenCalled();
  });
  it('preserves selection when a workspace was archived after the list loaded', async () => {
    const {result,client} = setup();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    client.setQueryData(['campaigns'], {business:'North'});
    get.mockResolvedValueOnce({...profiles[1], archivedAt:'2026-10-01'});
    await act(async () => { await expect(result.current.switchProfile(2)).rejects.toThrow('was archived'); });
    expect(selectedBusinessProfileId()).toBe(1);
    expect(client.getQueryData(['campaigns'])).toEqual({business:'North'});
    expect(open).not.toHaveBeenCalled();
  });
  it('does not apply an old account switch after another account replaces it during verification', async () => {
    const {result,client} = setup();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    client.setQueryData(['new-account-work'],{business:'Keep this'});
    let finishVerification!: (value: unknown) => void;
    get.mockImplementationOnce(() => new Promise(resolve => { finishVerification = resolve; }));
    const pending = result.current.switchProfile(2);
    const rejected = expect(pending).rejects.toThrow('Verify your session');
    localStorage.setItem('user',JSON.stringify({id:22}));
    await act(async () => { finishVerification(profiles[1]); await rejected; });
    expect(sessionStorage.getItem('active-business-profile:22')).toBeNull();
    expect(client.getQueryData(['new-account-work'])).toEqual({business:'Keep this'});
    expect(open).not.toHaveBeenCalled();
  });
  it('restores conversation drafts and publish receipts only in their owning business', () => {
    selectBusinessProfile(1);
    const first = conversationAttempt('new','Hello');
    const publish = publishingIdempotencyKey('new',{caption:'Hello'});
    selectBusinessProfile(2);
    expect(readConversationAttempt('new')).toBeNull();
    expect(conversationAttempt('new','Hello').requestId).not.toBe(first.requestId);
    expect(publishingIdempotencyKey('new',{caption:'Hello'})).not.toBe(publish);
    selectBusinessProfile(1);
    expect(readConversationAttempt('new')?.requestId).toBe(first.requestId);
    expect(publishingIdempotencyKey('new',{caption:'Hello'})).toBe(publish);
    localStorage.setItem('user',JSON.stringify({id:22}));
    expect(selectedBusinessProfileId()).toBeNull();
  });
});
