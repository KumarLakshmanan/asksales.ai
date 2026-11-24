import React, { type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import KnowledgeBasePage from '@/app/dashboard/(main)/knowledge-base/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn(), toast: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/components/knowledge/KnowledgeReviewDialog', () => ({ KnowledgeReviewDialog: () => null, KnowledgeRetrievalTester: () => null }));
// Drive the page's actual filter state with a native select in jsdom. The
// corresponding browser cases exercise the real Radix filter and dialogs.
vi.mock('@/components/ui/select', () => ({
  Select: ({ children, value, onValueChange }: { children: ReactNode; value: string; onValueChange: (value: string) => void }) => {
    const trigger = React.Children.toArray(children).find(child =>
      React.isValidElement<{ 'aria-label'?: string }>(child) && child.props['aria-label']);
    const label = React.isValidElement<{ 'aria-label'?: string }>(trigger) ? trigger.props['aria-label'] : undefined;
    return <select aria-label={label} value={value} onChange={event => onValueChange(event.target.value)}>{children}</select>;
  },
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => <option value={value}>{children}</option>,
}));

const listPath = '/api/knowledge-base';
const scopedPath = `${listPath}?businessProfileId=4102`;
const entry = { id: 501, title: 'Synthetic file', type: 'file', fileName: '501.txt',
  processingStatus: 'completed', content: '', createdAt: '', updatedAt: '' };
const rows = (title: string) => [{ ...entry, title }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.setItem('user', JSON.stringify({ id: 4101 }));
  sessionStorage.setItem('active-business-profile:4101', '4102');
  mocks.get.mockImplementation(async (path: string) => path === '/api/settings/business-profiles' ?
    [{ id: 4102, companyName: 'Regression Company' }] : path.startsWith(listPath) ? rows('Synthetic file') : []);
});
afterEach(() => {
  cleanup();
  localStorage.removeItem('user');
  sessionStorage.removeItem('active-business-profile:4101');
});
async function renderPage() {
  const result = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <KnowledgeBasePage />
  </QueryClientProvider>);
  await screen.findByText('Synthetic file');
  await screen.findByRole('combobox', { name: 'Business profile filter' });
  await screen.findByRole('option', { name: 'Regression Company' });
  return result;
}
function changeFilter(value: string) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Business profile filter' }), { target: { value } });
}
async function startMutation(kind: 'delete' | 'reprocess') {
  const pending = deferred<{ processingStatus: string }>();
  if (kind === 'delete') {
    mocks.delete.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Synthetic file' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }));
    expect(mocks.delete).toHaveBeenCalledWith('/api/knowledge-base/501');
  } else {
    mocks.post.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild index for Synthetic file' }));
    expect(mocks.post).toHaveBeenCalledWith('/api/knowledge-base/501/reprocess', {});
  }
  return pending;
}
function listReads() {
  return mocks.get.mock.calls.filter(([path]) => path.startsWith(listPath)).map(([path]) => path);
}

describe('Knowledge mutation completion ownership', () => {
  for (const kind of ['delete', 'reprocess'] as const) {
    it(`${kind} refreshes the active filter after a delayed mutation and overlapping read`, async () => {
      await renderPage();
      const mutation = await startMutation(kind);
      mocks.get.mockImplementation(async (path: string) => rows(path === scopedPath ? 'Current filtered entry' : 'Wrong old-filter entry'));
      changeFilter('4102');
      await screen.findByText('Current filtered entry');
      const oldRefresh = deferred<ReturnType<typeof rows>>();
      mocks.get.mockReturnValueOnce(oldRefresh.promise);
      fireEvent.click(screen.getByRole('button', { name: /^Refresh$/ }));
      mocks.get.mockImplementation(async (path: string) => rows(path === scopedPath ? 'Current mutation refresh' : 'Wrong old-filter entry'));
      await act(async () => mutation.resolve({ processingStatus: 'completed' }));
      expect(listReads().at(-1)).toBe(scopedPath);
      await screen.findByText('Current mutation refresh');
      await act(async () => oldRefresh.resolve(rows('Obsolete overlapping read')));
      expect(screen.getByText('Current mutation refresh')).toBeVisible();
      expect(screen.queryByText('Obsolete overlapping read')).toBeNull();
      expect(screen.queryByText('Wrong old-filter entry')).toBeNull();
    });

    for (const outcome of ['success', 'error'] as const) {
      it(`${kind} ${outcome} after unmount initiates no read or feedback`, async () => {
        const page = await renderPage();
        const mutation = await startMutation(kind);
        const before = listReads();
        page.unmount();
        await act(async () => outcome === 'success' ? mutation.resolve({ processingStatus: 'completed' }) :
          mutation.reject(new Error('Synthetic mutation failure after unmount')));
        expect(listReads()).toEqual(before);
        expect(mocks.toast).not.toHaveBeenCalled();
      });
    }

    it(`${kind} refresh completion loses ownership when its filter changes again`, async () => {
      await renderPage();
      const mutation = await startMutation(kind);
      const callbackRead = deferred<ReturnType<typeof rows>>();
      mocks.get.mockReturnValueOnce(callbackRead.promise);
      await act(async () => mutation.resolve({ processingStatus: 'completed' }));
      expect(listReads().at(-1)).toBe(listPath);
      mocks.get.mockImplementation(async () => rows('Newest filter entry'));
      changeFilter('4102');
      await screen.findByText('Newest filter entry');
      await act(async () => callbackRead.resolve(rows('Obsolete mutation refresh')));
      expect(screen.getByText('Newest filter entry')).toBeVisible();
      expect(screen.queryByText('Obsolete mutation refresh')).toBeNull();
    });

    it(`${kind} uses the current filter after repeated scope changes`, async () => {
      await renderPage();
      const mutation = await startMutation(kind);
      for (const filter of ['4102', 'none', 'all', '4102']) {
        changeFilter(filter);
        await waitFor(() => expect(listReads().at(-1)).toBe(filter === 'all' ? listPath : `${listPath}?businessProfileId=${filter}`));
      }
      await act(async () => mutation.resolve({ processingStatus: 'completed' }));
      expect(listReads().at(-1)).toBe(scopedPath);
      expect(mocks.toast).toHaveBeenCalledTimes(1);
    });
  }
});
