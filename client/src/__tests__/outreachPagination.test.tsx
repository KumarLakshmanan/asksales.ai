import { act, render, renderHook, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import api from '@/lib/api';
import { useOutreachPage } from '@/components/outreach/useOutreachPage';
import { ConversationLoadMore } from '@/components/outreach/ConversationLoadMore';

vi.mock('@/lib/api', () => ({ default: { get: vi.fn() }, ApiError: class extends Error {} }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
const rows = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: start+i, leadName: `Customer ${start+i}` }));
const page = (start: number, count: number, hasMore = true) => ({ conversations: rows(start,count), unreadCount: 3, pagination: { hasMore } });
beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('conversation pagination', () => {
  it.each(['whatsapp','instagram','facebook','email','sms','linkedin','twitter'] as const)('loads beyond 50 on %s and stops at the end', async channel => {
    vi.mocked(api.get).mockResolvedValueOnce(page(1,50)).mockResolvedValueOnce(page(51,50)).mockResolvedValueOnce(page(101,7,false));
    const { result } = renderHook(() => useOutreachPage({ channel, autoLoad:false }));
    await act(() => result.current.loadConversations());
    expect(result.current.conversations).toHaveLength(50);
    await act(() => result.current.loadMoreConversations());
    await act(() => result.current.loadMoreConversations());
    expect(result.current.conversations).toHaveLength(107);
    expect(result.current.hasMoreConversations).toBe(false);
    await act(() => result.current.loadMoreConversations());
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(api.get).toHaveBeenLastCalledWith(`/api/outreach-conversations/${channel}?limit=50&offset=100`);
  });

  it('locks concurrent scroll calls, deduplicates overlap and preserves selection', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api.get).mockResolvedValueOnce(page(1,50)).mockImplementationOnce(() => new Promise(resolve => { finish=resolve; }));
    const { result } = renderHook(() => useOutreachPage({ channel:'whatsapp', autoLoad:false }));
    await act(() => result.current.loadConversations());
    act(() => result.current.setSelectedConversation(result.current.conversations[10]));
    let pending!: Promise<void>;
    act(() => { pending=result.current.loadMoreConversations(); void result.current.loadMoreConversations(); });
    expect(api.get).toHaveBeenCalledTimes(2);
    await act(async () => { finish(page(50,50)); await pending; });
    expect(result.current.conversations).toHaveLength(99);
    expect(result.current.selectedConversation?.id).toBe(11);
    vi.mocked(api.get).mockResolvedValueOnce(page(100,1,false));
    await act(() => result.current.loadMoreConversations());
    expect(api.get).toHaveBeenLastCalledWith('/api/outreach-conversations/whatsapp?limit=50&offset=100');
  });

  it('retains rows and retries the same offset after a failed page', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(page(1,50)).mockRejectedValueOnce(new Error('Temporary network issue')).mockResolvedValueOnce(page(51,1,false));
    const { result } = renderHook(() => useOutreachPage({ channel:'whatsapp', autoLoad:false }));
    await act(() => result.current.loadConversations());
    await act(() => result.current.loadMoreConversations());
    expect(result.current.conversations).toHaveLength(50);
    expect(result.current.loadMoreError).toBe('Temporary network issue');
    expect(result.current.conversationsError).toBeNull();
    await act(() => result.current.loadMoreConversations());
    expect(result.current.conversations).toHaveLength(51);
    expect(result.current.loadMoreError).toBeNull();
  });

  it('discards an older page response after a refresh and searches appended rows', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api.get).mockResolvedValueOnce(page(1,50)).mockImplementationOnce(() => new Promise(resolve => { finish=resolve; })).mockResolvedValueOnce(page(200,4,false));
    const { result } = renderHook(() => useOutreachPage({ channel:'whatsapp', autoLoad:false }));
    await act(() => result.current.loadConversations());
    let pending!: Promise<void>;
    act(() => { pending=result.current.loadMoreConversations(); });
    await act(() => result.current.loadConversations());
    await act(async () => { finish(page(51,50)); await pending; });
    expect(result.current.conversations.map(row=>row.id)).toEqual([200,201,202,203]);
    act(() => result.current.setSearchQuery('202'));
    expect(result.current.filteredConversations.map(row=>row.id)).toEqual([202]);
  });

  it('observes the actual scroll viewport and offers a manual retry without retry loops', async () => {
    let intersect!: IntersectionObserverCallback;
    const observe=vi.fn(), disconnect=vi.fn(), options=vi.fn();
    vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback, opts: unknown) {intersect=callback;options(opts);} observe=observe;disconnect=disconnect; });
    const load=vi.fn();
    const { rerender }=render(<div data-radix-scroll-area-viewport=""><ConversationLoadMore hasMore onLoadMore={load}/></div>);
    expect(options.mock.calls[0][0].root).toBe(screen.getByRole('button').parentElement?.parentElement);
    act(() => intersect([{isIntersecting:true}] as IntersectionObserverEntry[], {} as IntersectionObserver));
    expect(load).toHaveBeenCalledTimes(1);
    rerender(<div data-radix-scroll-area-viewport=""><ConversationLoadMore hasMore error="Offline" onLoadMore={load}/></div>);
    expect(disconnect).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Retry loading conversations'}));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('reloads a changed channel and ignores the previous channel’s pending page', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.endsWith('/unread')) return Promise.resolve({});
      if (url.includes('offset=50')) return new Promise(resolve => { finish=resolve; });
      return Promise.resolve(url.includes('/instagram?') ? page(200,4,false) : page(1,50));
    });
    const { result, rerender } = renderHook(({ channel }) => useOutreachPage({ channel }), {
      initialProps: { channel: 'whatsapp' as 'whatsapp' | 'instagram' },
    });
    await waitFor(() => expect(result.current.conversations).toHaveLength(50));
    let pending!: Promise<void>;
    act(() => { pending=result.current.loadMoreConversations(); });
    rerender({ channel:'instagram' });
    await waitFor(() => expect(result.current.conversations.map(row => row.id)).toEqual([200,201,202,203]));
    await act(async () => { finish(page(51,50)); await pending; });
    expect(result.current.conversations.map(row => row.id)).toEqual([200,201,202,203]);
    expect(result.current.loadingMore).toBe(false);
  });
});
