import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BlogPage from '@/app/dashboard/(main)/saved-templates/blog/page';
import { selectBusinessProfile } from '@/lib/business-profile';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), toast: vi.fn(), push: vi.fn() }));
const templates = ['Alpha', 'Beta'].map((name, index) => ({
  id: index + 1, name, type: 'blog', content: JSON.stringify({ title: `${name} title`, body: `${name} body` }),
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', isPredefined: false,
}));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-paginated-content-templates', () => ({ usePaginatedContentTemplates: () => ({ templates, search: '', isLoading: false }) }));
vi.mock('@/components/content-library/TemplatePreviewCard', () => ({
  TemplatePreviewCard: ({ title, onEdit }: { title: string; onEdit: () => void }) => <button onClick={onEdit}>Edit {title}</button>,
}));

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  return { ...render(<QueryClientProvider client={client}><BlogPage /></QueryClientProvider>), invalidate };
}
function open(name: string) { fireEvent.click(screen.getByRole('button', { name: `Edit ${name}` })); }
function content() { return screen.getByPlaceholderText('Write your blog post content here...'); }
function title() { return screen.getByPlaceholderText('Blog post headline'); }
const fields = ['Template Name', 'Post Title', 'Content', 'Category (optional)', 'Tags (comma separated)', 'Description (optional)'];
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } }); }
// A busy kit Button stays focusable (aria-disabled) instead of using the native disabled attribute.
function expectBlocked(element: HTMLElement) { expect((element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true').toBe(true); }
function expectAvailable(element: HTMLElement) { expect(element).toBeEnabled(); expect(element).not.toHaveAttribute('aria-disabled', 'true'); }
async function finish(request: ReturnType<typeof deferred>, outcome: 'success' | 'error', value: unknown = {}) {
  await act(async () => {
    if (outcome === 'success') request.resolve(value); else request.reject(new Error('Synthetic unavailable'));
    await request.promise.catch(() => undefined);
  });
}
function fillCreate() {
  fireEvent.click(screen.getByRole('button', { name: 'Build reusable template' }));
  fireEvent.change(screen.getByPlaceholderText('e.g. Product Launch Announcement'), { target: { value: 'New Alpha' } });
  fireEvent.change(content(), { target: { value: 'Alpha body' } });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.get.mockResolvedValue([]);
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('user', JSON.stringify({ id: 4101 }));
  sessionStorage.setItem('active-business-profile:4101', '4102');
});
afterEach(cleanup);

describe('saved Blog editor deferred response ownership', () => {
  it.each(['create', 'update'] as const)('%s success after Cancel/Escape cannot close or clear a newer record', async kind => {
    const request = deferred();
    mocks[kind === 'create' ? 'post' : 'put'].mockReturnValue(request.promise);
    const view = mount();
    if (kind === 'create') fillCreate(); else open('Alpha');
    fireEvent.click(screen.getByRole('button', { name: kind === 'create' ? 'Create' : 'Update' }));
    await waitFor(() => expect(mocks[kind === 'create' ? 'post' : 'put']).toHaveBeenCalledTimes(1));
    if (kind === 'create') fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    else await userEvent.setup().keyboard('{Escape}');
    open('Beta');
    fireEvent.change(content(), { target: { value: 'New Beta draft' } });
    await act(async () => { request.resolve({ id: 1 }); await request.promise; });
    await waitFor(() => expect(view.invalidate).toHaveBeenCalledTimes(3));
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(content()).toHaveValue('New Beta draft');
    expect(title()).toHaveValue('Beta title');
  });

  it('generation after Cancel/open Beta cannot overwrite the newer title or content', async () => {
    const request = deferred(); mocks.post.mockReturnValue(request.promise);
    mount(); open('Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'AI Generate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); open('Beta');
    fireEvent.change(content(), { target: { value: 'New Beta draft' } });
    await act(async () => { request.resolve({ title: 'Old generated title', content: 'Old generated body' }); await request.promise; });
    expect(title()).toHaveValue('Beta title'); expect(content()).toHaveValue('New Beta draft');
  });

  it('generation cannot overwrite typing in the same editor session', async () => {
    const request = deferred(); mocks.post.mockReturnValue(request.promise);
    mount(); open('Alpha'); fireEvent.click(screen.getByRole('button', { name: 'AI Generate' }));
    fireEvent.change(content(), { target: { value: 'New manual draft' } });
    await act(async () => { request.resolve({ title: 'Old generated title', content: 'Old generated body' }); await request.promise; });
    expect(title()).toHaveValue('Alpha title'); expect(content()).toHaveValue('New manual draft');
  });

  it.each(['create', 'update'] as const)('%s error after reopening suppresses the old error and releases only its pending save', async kind => {
    const first = deferred(), current = deferred();
    const api = mocks[kind === 'create' ? 'post' : 'put'];
    api.mockReturnValueOnce(first.promise);
    mocks.put.mockReturnValueOnce(current.promise);
    mount(); if (kind === 'create') fillCreate(); else open('Alpha');
    fireEvent.click(screen.getByRole('button', { name: kind === 'create' ? 'Create' : 'Update' }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); open('Beta'); change('Content', 'New Beta draft');
    expectBlocked(screen.getByRole('button', { name: 'Update' }));
    await finish(first, 'error');
    await waitFor(() => expectAvailable(screen.getByRole('button', { name: 'Update' })));
    expect(content()).toHaveValue('New Beta draft'); expect(mocks.toast).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(mocks.put).toHaveBeenLastCalledWith('/api/content/templates/2', expect.objectContaining({ content: JSON.stringify({ title: 'Beta title', body: 'New Beta draft' }) })));
    await finish(current, 'success');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocks.toast).toHaveBeenLastCalledWith({ title: 'Blog post updated' });
  });

  it.each(['create', 'update'] as const)('%s failure preserves all fields and permits a payload-identical retry', async kind => {
    const first = deferred(), retry = deferred();
    const api = mocks[kind === 'create' ? 'post' : 'put'];
    api.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    const view = mount();
    if (kind === 'create') fillCreate(); else open('Alpha');
    const values = ['Owned name', 'Owned title', 'Owned body', 'Marketing', 'launch, news, ,', 'Owned description'];
    fields.forEach((field, index) => change(field, values[index]));
    const button = screen.getByRole('button', { name: kind === 'create' ? 'Create' : 'Update' });
    // Two handlers in one React batch exercise the synchronous lock before
    // the disabled UI has rendered, rather than relying on a disabled button.
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expectBlocked(button);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await finish(first, 'error');
    await waitFor(() => expectAvailable(button));
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive', description: 'Synthetic unavailable' }));
    fields.forEach((field, index) => expect(screen.getByLabelText(field, { exact: true })).toHaveValue(values[index]));
    expect(view.invalidate).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    const payload = { name: 'Owned name', type: 'blog', content: JSON.stringify({ title: 'Owned title', body: 'Owned body' }), category: 'Marketing', tags: ['launch', 'news'], description: 'Owned description' };
    expect(api).toHaveBeenNthCalledWith(1, kind === 'create' ? '/api/content/templates' : '/api/content/templates/1', payload);
    expect(api.mock.calls[1]).toEqual(api.mock.calls[0]);
    await finish(retry, 'success');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(view.invalidate).toHaveBeenCalledTimes(3);
    expect(mocks.toast).toHaveBeenLastCalledWith({ title: kind === 'create' ? 'Blog post created' : 'Blog post updated' });
    fireEvent.click(screen.getByRole('button', { name: 'Build reusable template' }));
    fields.forEach(field => expect(screen.getByLabelText(field, { exact: true })).toHaveValue(''));
  });

  for (const operation of ['save', 'generation'] as const) {
    for (const outcome of ['success', 'error'] as const) {
      it.each(fields)(`${operation} ${outcome} after editing %s preserves the newer draft`, async field => {
        const request = deferred();
        mocks[operation === 'save' ? 'put' : 'post'].mockReturnValue(request.promise);
        mount(); open('Alpha');
        fireEvent.click(screen.getByRole('button', { name: operation === 'save' ? 'Update' : 'AI Generate' }));
        await waitFor(() => expect(mocks[operation === 'save' ? 'put' : 'post']).toHaveBeenCalledTimes(1));
        change(field, 'New manual value');
        await finish(request, outcome, { title: 'Stale title', body: 'Stale body' });
        if (operation === 'save') await waitFor(() => expectAvailable(screen.getByRole('button', { name: 'Update' })));
        expect(screen.getByRole('dialog')).toBeVisible();
        expect(screen.getByLabelText(field, { exact: true })).toHaveValue('New manual value');
        expect(title()).toHaveValue(field === 'Post Title' ? 'New manual value' : 'Alpha title');
        expect(content()).toHaveValue(field === 'Content' ? 'New manual value' : 'Alpha body');
        expect(mocks.toast).not.toHaveBeenCalled();
        expectAvailable(screen.getByRole('button', { name: 'AI Generate' }));
      });
    }
  }

  it.each(['success', 'error'] as const)('old generation %s/finally cannot release a newer generation', async outcome => {
    const old = deferred(), current = deferred();
    mocks.post.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    mount(); open('Alpha'); fireEvent.click(screen.getByRole('button', { name: 'AI Generate' }));
    await userEvent.setup().keyboard('{Escape}'); open('Beta');
    fireEvent.click(screen.getByRole('button', { name: 'AI Generate' }));
    expectBlocked(screen.getByRole('button', { name: 'AI Generate' }));
    await finish(old, outcome, { title: 'Old title', content: 'Old body' });
    expectBlocked(screen.getByRole('button', { name: 'AI Generate' }));
    expect(title()).toHaveValue('Beta title'); expect(content()).toHaveValue('Beta body');
    expect(mocks.toast).not.toHaveBeenCalled();
    await finish(current, 'success', { title: 'Current generated title', body: 'Current generated body' });
    expect(title()).toHaveValue('Current generated title'); expect(content()).toHaveValue('Current generated body');
    expectAvailable(screen.getByRole('button', { name: 'AI Generate' }));
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenNthCalledWith(2, '/api/content/studio/blog-post', { prompt: 'Beta title', persist: false });
  });

  it('abandoned generation cannot regain ownership after a failed save in the same unchanged draft', async () => {
    const old = deferred(), current = deferred(), save = deferred();
    mocks.post.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise); mocks.put.mockReturnValue(save.promise);
    mount(); open('Alpha'); fireEvent.click(screen.getByRole('button', { name: 'AI Generate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    await finish(save, 'error');
    await waitFor(() => expectAvailable(screen.getByRole('button', { name: 'AI Generate' })));
    mocks.toast.mockClear(); fireEvent.click(screen.getByRole('button', { name: 'AI Generate' }));
    await finish(old, 'success', { title: 'Abandoned', content: 'Abandoned' });
    expect(title()).toHaveValue('Alpha title'); expect(content()).toHaveValue('Alpha body');
    expectBlocked(screen.getByRole('button', { name: 'AI Generate' }));
    expect(mocks.toast).not.toHaveBeenCalled();
    await finish(current, 'success', { content: 'New generated body' });
    expect(title()).toHaveValue('Alpha title'); expect(content()).toHaveValue('New generated body');
  });

  it('current generation errors retain the draft, release pending state and allow retry without duplicate requests', async () => {
    const first = deferred(); mocks.post.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ title: 'Retry title', content: 'Retry body' });
    mount(); open('Alpha');
    const button = screen.getByRole('button', { name: 'AI Generate' });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await finish(first, 'error');
    expect(title()).toHaveValue('Alpha title'); expect(content()).toHaveValue('Alpha body');
    expectAvailable(button);
    expect(mocks.toast).toHaveBeenLastCalledWith({ title: 'AI generation failed', variant: 'destructive' });
    fireEvent.click(button);
    await waitFor(() => expect(content()).toHaveValue('Retry body'));
    expect(title()).toHaveValue('Retry title'); expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  for (const operation of ['create', 'update', 'generation'] as const) {
    for (const outcome of ['success', 'error'] as const) {
      it.each(['workspace', 'account', 'unmount'] as const)(`${operation} ${outcome} is fenced after %s changes`, async scope => {
        const request = deferred(); const api = mocks[operation === 'update' ? 'put' : 'post'];
        api.mockReturnValue(request.promise); const view = mount();
        if (operation === 'create') fillCreate(); else open('Alpha');
        fireEvent.click(screen.getByRole('button', { name: operation === 'generation' ? 'AI Generate' : operation === 'create' ? 'Create' : 'Update' }));
        await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
        if (scope === 'workspace') act(() => selectBusinessProfile(4103));
        else if (scope === 'account') act(() => {
          localStorage.setItem('user', JSON.stringify({ id: 4201 }));
          window.dispatchEvent(new StorageEvent('storage', { key: 'user' }));
        }); else view.unmount();
        if (scope !== 'unmount') {
          expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
          open('Beta'); change('Content', 'New scoped draft');
        }
        await finish(request, outcome, { title: 'Old scoped title', body: 'Old scoped body' });
        expect(mocks.toast).not.toHaveBeenCalled(); expect(view.invalidate).not.toHaveBeenCalled();
        if (scope !== 'unmount') {
          if (operation !== 'generation') await waitFor(() => expectAvailable(screen.getByRole('button', { name: 'Update' })));
          expect(content()).toHaveValue('New scoped draft'); expect(title()).toHaveValue('Beta title');
        }
      });
    }
  }

  it('associates each visible label with one unique field in the owned dialog and retains keyboard Cancel', async () => {
    mount(); open('Alpha');
    const dialog = screen.getByRole('dialog'); const ids = new Set<string>();
    for (const field of fields) {
      const input = within(dialog).getByLabelText(field, { exact: true });
      expect(input.id).not.toBe(''); ids.add(input.id);
      expect(dialog.querySelector(`label[for="${input.id}"]`)).toHaveTextContent(field);
      expect(document.querySelectorAll(`[id="${input.id}"]`)).toHaveLength(1);
    }
    expect(ids.size).toBe(6);
    const cancel = screen.getByRole('button', { name: 'Cancel' }); cancel.focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    open('Alpha'); expect(content()).toHaveValue('Alpha body');
  });
});
