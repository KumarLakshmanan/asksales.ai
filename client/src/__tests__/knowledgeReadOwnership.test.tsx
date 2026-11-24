import React from 'react';
import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import KnowledgeBasePage from '@/app/dashboard/(main)/knowledge-base/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), toast: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/components/knowledge/KnowledgeReviewDialog', () => ({ KnowledgeReviewDialog: () => null, KnowledgeRetrievalTester: () => null }));

const entries = [501, 502].map((id, i) => ({ id, title: `Synthetic ${i ? 'B' : 'A'}`, type: 'file',
  fileName: `${id}.txt`, processingStatus: 'completed', content: '', createdAt: '', updatedAt: '' }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (path: string) => path === '/api/knowledge-base' ? entries : []);
});
afterEach(cleanup);
async function renderPage() {
  const result = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <KnowledgeBasePage />
  </QueryClientProvider>);
  await screen.findByText('Synthetic A');
  return result;
}

describe('Knowledge read ownership', () => {
  it('replaces a historical Published badge with its live privacy block and active embedding counts', async () => {
    const readiness = { status: 'privacy_blocked', versionId: 21, versionNo: 2, isLive: true,
      privacyClassification: 'personal', chunkCount: 13, embeddedChunkCount: 13,
      activeIndexId: 2, embeddingModel: 'test-model', lexicalIndexStatus: 'completed', semanticIndexStatus: 'completed' };
    mocks.get.mockImplementation(async (path: string) => path === '/api/knowledge-base' ?
      [{...entries[0],knowledgeStatus:'published',knowledgeVersionId:21,knowledgeVersionNo:2,currentPublishedVersionId:21,readiness}] : []);
    await renderPage();
    expect(screen.getAllByText('Blocked by privacy review')).toHaveLength(2);
    expect(screen.queryByText('Published evidence')).toBeNull();
    expect(screen.getByText(/13\/13 chunks embedded in active index 2/)).toBeVisible();
    mocks.get.mockResolvedValueOnce({readiness,extractedText:'Current source',embeddingsGenerated:true,
      chunks:[{index:0,text:'Current source',charStart:0,charEnd:14,tokenEstimate:3,hasEmbedding:true}]});
    fireEvent.click(screen.getByRole('button', {name:'View extracted text for Synthetic A'}));
    expect(await screen.findByText('Embedded')).toBeVisible();
    expect(screen.queryByText('No Embedding')).toBeNull();
  });
  it('labels obsolete legacy embedding flags as unknown in the preview', async () => {
    await renderPage();
    mocks.get.mockResolvedValueOnce({extractedText:'Legacy text',extractionSource:'legacy_preview',embeddingsGenerated:false,
      chunks:[{index:0,text:'Legacy text',charStart:0,charEnd:11,tokenEstimate:3,hasEmbedding:null}]});
    fireEvent.click(screen.getByRole('button', {name:'View extracted text for Synthetic A'}));
    expect(await screen.findByText('Unknown')).toBeVisible();
    expect(screen.getByText('Current embedding status unknown')).toBeVisible();
    expect(screen.queryByText('No active embedding')).toBeNull();
  });
  it('keeps the newest refresh through an older success', async () => {
    await renderPage();
    const old = deferred<typeof entries>();
    const current = deferred<typeof entries>();
    mocks.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/ }));
    await act(async () => current.resolve([{ ...entries[1], title: 'Current read' }]));
    expect(screen.getByText('Current read')).toBeVisible();
    await act(async () => old.resolve([{ ...entries[0], title: 'Obsolete read' }]));
    expect(screen.getByText('Current read')).toBeVisible();
    expect(screen.queryByText('Obsolete read')).toBeNull();
  });

  it('does not report an obsolete refresh error', async () => {
    await renderPage();
    const old = deferred<typeof entries>();
    const current = deferred<typeof entries>();
    mocks.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/ }));
    await act(async () => current.resolve(entries));
    const logged = vi.spyOn(console, 'error');
    try {
      await act(async () => old.reject(new Error('Obsolete synthetic failure')));
      expect(logged).not.toHaveBeenCalled();
      expect(screen.getByText('Synthetic B')).toBeVisible();
    } finally { logged.mockRestore(); }
  });

  for (const outcome of ['success', 'error'] as const) {
    it(`ignores a dismissed preview's ${outcome} after another preview opens`, async () => {
      await renderPage();
      const old = deferred<{ extractedText: string; chunks: never[] }>();
      mocks.get.mockImplementation((path: string) => path.endsWith('/501/extracted-text') ? old.promise :
        Promise.resolve({ extractedText: 'Current B text', chunks: [] }));
      fireEvent.click(screen.getByRole('button', { name: 'View extracted text for Synthetic A' }));
      await screen.findByRole('dialog');
      fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      fireEvent.click(screen.getByRole('button', { name: 'View extracted text for Synthetic B' }));
      await screen.findByText('Current B text');
      await act(async () => outcome === 'success' ? old.resolve({ extractedText: 'Obsolete A text', chunks: [] }) :
        old.reject(new Error('Obsolete A failure')));
      expect(screen.getByRole('dialog')).toHaveTextContent('Current B text');
      expect(screen.queryByText('Obsolete A text')).toBeNull();
      expect(mocks.toast).not.toHaveBeenCalled();
    });
  }

  it('keeps the current preview error visible as feedback and permits retry', async () => {
    await renderPage();
    mocks.get.mockRejectedValueOnce(new Error('Current synthetic failure'));
    fireEvent.click(screen.getByRole('button', { name: 'View extracted text for Synthetic A' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: 'Error',
      description: 'Failed to load extracted text', variant: 'destructive' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    mocks.get.mockResolvedValueOnce({ extractedText: 'Recovered A text', chunks: [] });
    fireEvent.click(screen.getByRole('button', { name: 'View extracted text for Synthetic A' }));
    await screen.findByText('Recovered A text');
  });
});
