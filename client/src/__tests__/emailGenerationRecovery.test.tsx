import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EmailCreator from '@/components/content-studio/creators/EmailCreator';
import { CreatorScopeProvider } from '@/components/content-studio/CreatorScope';
import { ApiError } from '@/lib/api-client';
import { EMAIL_GENERATION_WAIT_MS } from '@/lib/emailGenerationRecovery';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), toast: vi.fn(), refresh: vi.fn(), push: vi.fn(),
  subscribe: vi.fn((_event: string, _handler: (data: { type: string }) => void) => () => {}), brand: { businessProfileId: 9, brandToolkitId: 7 },
}));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get, post: mocks.post } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-content-counts', () => ({ useRefreshContentLibrary: () => mocks.refresh }));
vi.mock('@/hooks/use-content-brand-context', () => ({ useContentBrandContext: () => mocks.brand }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: mocks.subscribe }) }));
vi.mock('@/components/MediaManager', () => ({ default: () => null }));
vi.mock('@/components/content-studio/GenerationEstimate', () => ({ GenerationEstimate: () => null }));
vi.mock('@/components/content-cards', () => ({ EmailCard: ({ title }: { title: string }) => <article>{title}</article> }));
vi.mock('@/components/content-studio/CreatorPreview', async (original) => ({
  ...await original<typeof import('@/components/content-studio/CreatorPreview')>(),
  CreatorPreview: ({ model }: { model: Record<string, unknown> }) => <output data-testid="email-preview">{JSON.stringify(model)}</output>,
}));

const success = { success: true, persisted: true, assetId: 501, subject: 'Reviewed subject', body: 'Reviewed draft body.' };
const prompt = () => screen.getByPlaceholderText(/^Enter a prompt for the email/);
const generate = () => document.querySelector<HTMLButtonElement>('button[data-creator-action]')!;
const preview = () => JSON.parse(screen.getByTestId('email-preview').textContent || '{}');
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount(threadId = 42) {
  const view = render(<CreatorScopeProvider value={{ threadId, icpId: 91 }}><EmailCreator /></CreatorScopeProvider>);
  fireEvent.click(screen.getAllByRole('tab', { name: 'Preview' })[0]);
  fireEvent.change(prompt(), { target: { value: 'Reviewed prompt' } });
  return view;
}

describe('email generation request and recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    mocks.brand.businessProfileId = 9;
    mocks.get.mockResolvedValue([]);
    mocks.post.mockReset();
  });
  afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

  it('dispatches once for two clicks in the same render and sends reviewed context/CTA', async () => {
    const pending = deferred<typeof success>();
    mocks.post.mockReturnValue(pending.promise);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Additional Settings' }));
    fireEvent.change(screen.getByPlaceholderText('E.g., Schedule a demo, Start free trial'), { target: { value: 'Read the notes.' } });
    const button = generate();
    act(() => { button.click(); button.click(); });
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/api/content/studio/email', expect.objectContaining({ threadId: 42, icpId: 91, businessProfileId: 9, brandToolkitId: 7, cta: 'Read the notes.' }), { signal: expect.any(AbortSignal) });
    await act(async () => { pending.resolve(success); });
    expect(preview()).toMatchObject({ status: 'ready', subject: success.subject, body: success.body });
    expect(generate()).toBeEnabled();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    new ApiError('fixture-upstream-secret', 503, { code: 'AI_PROVIDER_NOT_CONFIGURED' }),
    new ApiError('fixture-upstream-secret', 503, { code: 'AI_PROVIDER_CREDITS' }),
    new ApiError('fixture-upstream-secret', 504, { code: 'AI_PROVIDER_TIMEOUT' }),
    new ApiError('fixture-upstream-secret', 403),
    new ApiError('fixture-upstream-secret', 402),
    new ApiError('fixture-upstream-secret', 422),
    new Error('fixture-upstream-secret'),
  ])('preserves the previous draft and prompt on sanitized failure %#', async error => {
    mocks.post.mockResolvedValueOnce(success).mockRejectedValueOnce(error);
    mount();
    fireEvent.click(generate());
    await waitFor(() => expect(preview().status).toBe('ready'));
    fireEvent.change(prompt(), { target: { value: 'Next reviewed request' } });
    fireEvent.click(generate());
    await waitFor(() => expect(preview().error).toBeTruthy());
    expect(preview()).toMatchObject({ status: 'ready', subject: success.subject, body: success.body });
    expect(prompt()).toHaveValue('Next reviewed request');
    expect(generate()).toBeEnabled();
    expect(JSON.stringify(preview())).not.toContain('fixture-upstream-secret');
    expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('fixture-upstream-secret');
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...success, assetId: undefined }, { ...success, persisted: false },
    { ...success, subject: '' }, { ...success, body: '' },
    { ...success, content: '{"unexpected":"payload"}' },
    { success: false, error: 'fixture-upstream-secret', ...{ assetId: 501 } },
  ])('never shows an unconfirmed or invalid response as a successful draft %#', async response => {
    mocks.post.mockResolvedValue(response);
    mount();
    fireEvent.click(generate());
    await waitFor(() => expect(preview().status).toBe('failed'));
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(generate()).toBeEnabled();
    expect(preview().body).toBe('');
    expect(JSON.stringify(preview())).not.toContain('fixture-upstream-secret');
  });

  it('aborts waiting and ignores a late completion after another generation succeeds', async () => {
    const old = deferred<typeof success>();
    mocks.post.mockResolvedValueOnce(success).mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ...success, assetId: 502, subject: 'New result' });
    mount();
    fireEvent.click(generate());
    await waitFor(() => expect(preview().status).toBe('ready'));
    fireEvent.click(generate());
    const signal = mocks.post.mock.calls[1][2].signal as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(signal.aborted).toBe(true);
    expect(preview()).toMatchObject({ status: 'ready', body: success.body, error: expect.stringContaining('may still finish') });
    fireEvent.click(generate());
    await waitFor(() => expect(preview().subject).toBe('New result'));
    const toastCount = mocks.toast.mock.calls.length;
    await act(async () => { old.resolve({ ...success, subject: 'Stale result' }); });
    expect(preview().subject).toBe('New result');
    expect(mocks.toast).toHaveBeenCalledTimes(toastCount);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it('releases the loader on timeout and ignores a late result without erasing the prompt', async () => {
    const pending = deferred<typeof success>();
    mocks.post.mockReturnValue(pending.promise);
    mount();
    await act(async () => {});
    vi.useFakeTimers();
    fireEvent.click(generate());
    const signal = mocks.post.mock.calls[0][2].signal as AbortSignal;
    act(() => { vi.advanceTimersByTime(EMAIL_GENERATION_WAIT_MS); });
    expect(signal.aborted).toBe(true);
    expect(generate()).toBeEnabled();
    expect(preview().error).toContain('taking longer than expected');
    expect(prompt()).toHaveValue('Reviewed prompt');
    await act(async () => { pending.resolve(success); });
    expect(preview().status).toBe('failed');
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it.each(['success', 'error'])('ignores stale %s after unmount', async outcome => {
    const pending = deferred<typeof success>();
    mocks.post.mockReturnValue(pending.promise);
    const view = mount();
    fireEvent.click(generate());
    const signal = mocks.post.mock.calls[0][2].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { if (outcome === 'success') pending.resolve(success); else pending.reject(new Error('Fixture stale failure')); });
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('invalidates completion as soon as navigation is requested', async () => {
    const pending = deferred<typeof success>();
    mocks.post.mockReturnValue(pending.promise);
    mount();
    fireEvent.click(generate());
    fireEvent.click(screen.getByRole('button', { name: 'Email templates' }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/saved-templates/email');
    expect(mocks.post.mock.calls[0][2].signal.aborted).toBe(true);
    await act(async () => { pending.resolve(success); });
    expect(preview().status).toBe('empty');
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it.each(['thread', 'business'])('ignores old completion when the selected %s changes', async scope => {
    const pending = deferred<typeof success>();
    mocks.post.mockReturnValue(pending.promise);
    const view = mount();
    fireEvent.click(generate());
    if (scope === 'business') mocks.brand.businessProfileId = 10;
    view.rerender(<CreatorScopeProvider value={{ threadId: scope === 'thread' ? 43 : 42, icpId: 91 }}><EmailCreator /></CreatorScopeProvider>);
    expect(mocks.post.mock.calls[0][2].signal.aborted).toBe(true);
    await act(async () => { pending.resolve(success); });
    expect(preview().status).toBe('empty');
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('ignores an old library read after a newer refresh completes', async () => {
    const old = deferred<unknown[]>();
    mocks.get.mockReturnValueOnce(old.promise).mockResolvedValueOnce([{ id: 502, type: 'email_template', title: 'New library result', content: JSON.stringify(success), createdAt: '2026-10-13T00:00:00Z' }]);
    mount();
    const oldSignal = mocks.get.mock.calls[0][1].signal as AbortSignal;
    fireEvent.click(screen.getAllByRole('tab', { name: /^Recent/ })[0]);
    act(() => { mocks.subscribe.mock.calls[0][1]({ type: 'email_template' }); });
    await screen.findByText('New library result');
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { old.resolve([]); });
    expect(screen.getByText('New library result')).toBeInTheDocument();
  });
});
