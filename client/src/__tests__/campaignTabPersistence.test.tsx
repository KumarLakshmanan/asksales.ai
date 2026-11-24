import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInlineWidgets } from '@/hooks/useInlineWidgets';
import api from '@/lib/api';

vi.mock('@/lib/api', () => ({ default: { post: vi.fn(), put: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
const tabs = ['email', 'sms', 'image'].map(type => ({ id: type, type: `content-${type}`, label: type, closeable: true }));
function pending() {
  let resolve!: (value?: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function setup() {
  const hook = renderHook(() => useInlineWidgets(214, vi.fn(), vi.fn()));
  act(() => { hook.result.current.setTabs(tabs); hook.result.current.setActiveTab('email'); hook.result.current.setTabsLoaded(true); });
  return hook;
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.put).mockResolvedValue({} as never); vi.mocked(api.post).mockResolvedValue({} as never); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('campaign tab persistence races', () => {
  it('does not revert a newer selection when the older save fails', async () => {
    const old = pending(); vi.mocked(api.put).mockReturnValueOnce(old.promise as never);
    const hook = setup();
    let first!: Promise<void>; let second!: Promise<void>;
    act(() => { first = hook.result.current.switchTab('sms'); });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    act(() => { second = hook.result.current.switchTab('image'); });
    await act(async () => { old.reject(new Error('offline')); await first; await second; });
    expect(hook.result.current.activeTab).toBe('image');
  });

  it('does not steal focus when a previous result update finishes saving', async () => {
    const old = pending(); vi.mocked(api.post).mockReturnValueOnce(old.promise as never);
    const hook = setup(); let update!: Promise<void>; let selection!: Promise<void>;
    act(() => { update = hook.result.current.addTab('content-sms', undefined, true, false, { type: 'sms', assetId: 136 }); });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    act(() => { selection = hook.result.current.switchTab('image'); });
    await act(async () => { old.resolve({}); await update; await selection; });
    expect(hook.result.current.activeTab).toBe('image');
  });

  it('does not resurrect a closed panel when its queued duplicate result resolves', async () => {
    const old = pending(); vi.mocked(api.post).mockReturnValueOnce(old.promise as never);
    const hook = setup(); let opening!: Promise<void>;
    act(() => {
      opening = hook.result.current.addTab('content-blog', undefined, true, false, { type: 'blog' });
      void hook.result.current.addTab('content-blog', undefined, true, false, { type: 'blog', assetId: 139 });
    });
    const newId = hook.result.current.tabs.at(-1)!.id;
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    let closing!: Promise<void>;
    act(() => {
      closing = hook.result.current.removeTab(newId);
    });
    await act(async () => { old.resolve({}); await opening; await closing; });
    expect(hook.result.current.tabs.some(tab => tab.type === 'content-blog')).toBe(false);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('does not consume another campaign’s pending result when an old save finishes', async () => {
    const old = pending(); const current = pending();
    vi.mocked(api.post).mockReturnValueOnce(old.promise as never).mockReturnValueOnce(current.promise as never);
    const hook = renderHook(({ threadId }) => useInlineWidgets(threadId, vi.fn(), vi.fn()), { initialProps: { threadId: 214 } });
    act(() => { hook.result.current.setTabsLoaded(true); });
    let oldOpen!: Promise<void>;
    act(() => { oldOpen = hook.result.current.addTab('content-blog', undefined, true, false, { type: 'blog', assetId: 139 }); });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    hook.rerender({ threadId: 215 });
    act(() => { hook.result.current.setTabs([]); hook.result.current.setActiveTab(''); hook.result.current.setTabData({}); });
    let currentOpen!: Promise<void>;
    act(() => {
      currentOpen = hook.result.current.addTab('content-blog', undefined, true, false, { type: 'blog', assetId: 143 });
      void hook.result.current.addTab('content-blog', undefined, false, false, { type: 'blog', assetId: 144 });
    });
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    await act(async () => { old.resolve({}); await oldOpen; current.resolve({}); await currentOpen; });
    await waitFor(() => expect(Object.values(hook.result.current.tabData).some(data => data.assetId === 144)).toBe(true));
    expect(api.post).toHaveBeenLastCalledWith('/api/chat/threads/215/tabs', expect.objectContaining({ tabData: expect.objectContaining({ assetId: 144 }) }));
  });
});
