import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCampaignThreadStart } from '@/hooks/useCampaignThreadStart';
import { useInlineWidgets } from '@/hooks/useInlineWidgets';
import api from '@/lib/api';

vi.mock('@/lib/api', () => ({ default: { post: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(() => vi.clearAllMocks());
function setup() {
  const options = { currentThreadIdRef: { current: null as number | null }, pendingNewThreadRef: { current: false }, navigationVersionRef: { current: 1 }, businessProfileId: '9', onCreated: vi.fn() };
  const hook = renderHook(() => useCampaignThreadStart(options));
  return { ...hook, options };
}
describe('initial campaign agent action', () => {
  it('creates one durable conversation before concurrent first agent actions', async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(api.post).mockReturnValue(new Promise(res => { resolve = res; }) as never);
    const hook = setup();
    let first!: Promise<number>; let second!: Promise<number>;
    act(() => { first = hook.result.current(); second = hook.result.current(); });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/api/chat/threads', { title: 'New campaign', businessProfileId: 9 });
    await act(async () => { resolve({ id: 214 }); expect(await first).toBe(214); expect(await second).toBe(214); });
    expect(hook.options.currentThreadIdRef.current).toBe(214);
    expect(hook.options.onCreated).toHaveBeenCalledTimes(1);
  });
  it('does not adopt a new conversation after the user navigates away', async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(api.post).mockReturnValue(new Promise(res => { resolve = res; }) as never);
    const hook = setup(); const promise = hook.result.current();
    hook.options.navigationVersionRef.current++;
    resolve({ id: 214 });
    await expect(promise).rejects.toThrow('conversation changed');
    expect(hook.options.onCreated).not.toHaveBeenCalled();
  });
  it('does not create a duplicate conversation while the first chat message is starting it', async () => {
    const hook = setup(); hook.options.pendingNewThreadRef.current = true;
    await expect(hook.result.current()).rejects.toThrow('conversation is starting');
    expect(api.post).not.toHaveBeenCalled();
  });
  it('reuses the existing conversation without another creation request', async () => {
    const hook = setup(); hook.options.currentThreadIdRef.current = 214;
    expect(await hook.result.current()).toBe(214);
    expect(api.post).not.toHaveBeenCalled();
  });
  it('persists an agent panel against the newly created thread even from an older callback', async () => {
    vi.mocked(api.post).mockResolvedValue({} as never);
    const threadRef = { current: null as number | null };
    const hook = renderHook(() => useInlineWidgets(null, vi.fn(), vi.fn(), threadRef));
    act(() => { hook.result.current.setTabsLoaded(true); });
    const olderAddTab = hook.result.current.addTab;
    threadRef.current = 214;
    await act(async () => { await olderAddTab('content-studio', undefined, true); });
    expect(api.post).toHaveBeenCalledWith('/api/chat/threads/214/tabs', expect.objectContaining({ tabType: 'content-studio' }));
  });
});
