import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KnowledgeReviewDialog } from '@/components/knowledge/KnowledgeReviewDialog';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: api }));
vi.mock('@/lib/business-profile', () => ({ selectedBusinessProfileId: () => 42 }));
afterEach(cleanup);
const metadata = { title: 'Business overview', sourceUrl: null, businessProfileId: null,
  audience: 'customer', accessScope: 'tenant', usageScopes: ['support_answer', 'outreach_reply'], allowedChannels: [], locale: null };
const entry = { id: 48, title: 'Business overview' };
const version = { id: 47, version_no: 1, status: 'ready_for_review', current_published_version_id: null,
  normalized_content: 'We build software for businesses.', lexical_index_status: 'completed', vector_index_status: 'completed',
  audience: 'customer', usage_scopes: metadata.usageScopes, diagnostics: { publicationMetadata: metadata } };
const conflict = () => new Error('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION');
const withConflicts = (ids: number[]) => ({ versions: [{ ...version, diagnostics: { ...version.diagnostics, conflictVersionIds: ids } }] });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const props = () => ({ entry, profiles: [], onClose: vi.fn(), onChanged: vi.fn() });
const publish = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Publish v1' }));
};
beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockResolvedValue({ versions: [version] });
  api.post.mockRejectedValue(conflict());
  api.put.mockResolvedValue({});
});

describe('rejected knowledge publication review', () => {
  it('refreshes persisted conflict IDs and explains the rejection without retrying publication', async () => {
    const callbacks = props();
    api.get.mockResolvedValueOnce({ versions: [version] }).mockResolvedValueOnce(withConflicts([21, 32]));
    render(<KnowledgeReviewDialog {...callbacks} />);
    await publish();
    expect(await screen.findByText('Conflicts with versions: 21, 32')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Publication paused because conflicting knowledge requires review.');
    expect(screen.queryByText('KNOWLEDGE_CONFLICT_REQUIRES_SUPERSESSION')).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/knowledge-base/48/versions/47/publish', { authority: 'owner_authored', allowLexicalOnly: false });
    expect(api.put).not.toHaveBeenCalled();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
  });

  it('offers a details-only retry and retains scope edits made after the rejection', async () => {
    api.get.mockResolvedValueOnce({ versions: [version] }).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(withConflicts([21]));
    render(<KnowledgeReviewDialog {...props()} />);
    await publish();
    const retry = await screen.findByRole('button', { name: 'Retry conflict details' });
    expect(screen.getByText('Conflict details could not be refreshed. Your draft is retained.')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Access'), { target: { value: 'staff_only' } });
    fireEvent.click(retry);
    expect(await screen.findByText('Conflicts with versions: 21')).toBeVisible();
    expect(screen.getByLabelText('Access')).toHaveValue('staff_only');
    expect(screen.getByLabelText('Audience')).toHaveValue('internal');
    expect(screen.getByText('Unsaved scope changes')).toBeVisible();
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.put).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Retry conflict details' })).not.toBeInTheDocument();
  });

  it('shows new conflict IDs even when the initial version had no diagnostics', async () => {
    api.get.mockResolvedValueOnce({ versions: [{ ...version, diagnostics: undefined }] }).mockResolvedValueOnce(withConflicts([21]));
    render(<KnowledgeReviewDialog {...props()} />);
    await publish();
    expect(await screen.findByText('Conflicts with versions: 21')).toBeVisible();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('saves the reviewed scope before the single publication attempt and retains it on rejection', async () => {
    api.get.mockResolvedValueOnce({ versions: [version] }).mockResolvedValueOnce(withConflicts([21]));
    render(<KnowledgeReviewDialog {...props()} />);
    await screen.findByText(version.normalized_content);
    fireEvent.click(screen.getByRole('checkbox', { name: 'outreach reply' }));
    await publish();
    await screen.findByText('Conflicts with versions: 21');
    expect(api.put).toHaveBeenCalledExactlyOnceWith('/api/knowledge-base/48/versions/47/scope', { metadata: { ...metadata, usageScopes: ['support_answer'] } });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.put.mock.invocationCallOrder[0]).toBeLessThan(api.post.mock.invocationCallOrder[0]);
    expect(screen.getByRole('checkbox', { name: 'outreach reply' })).not.toBeChecked();
  });

  it('does not refresh another entry or display a late rejection after the entry changes', async () => {
    const pending = deferred<object>();
    api.post.mockReturnValueOnce(pending.promise);
    const callbacks = props();
    const view = render(<KnowledgeReviewDialog {...callbacks} />);
    await publish();
    api.get.mockResolvedValueOnce({ versions: [{ ...version, id: 60, normalized_content: 'Another business source.' }] });
    view.rerender(<KnowledgeReviewDialog {...callbacks} entry={{ id: 50, title: 'Another source' }} />);
    await screen.findByText('Another business source.');
    await act(async () => { pending.reject(conflict()); });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Publication paused/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Conflicts with versions/)).not.toBeInTheDocument();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Publish v1' })).toBeEnabled();
  });

  it('ignores conflict details that arrive after switching entries', async () => {
    const pending = deferred<ReturnType<typeof withConflicts>>();
    api.get.mockResolvedValueOnce({ versions: [version] }).mockReturnValueOnce(pending.promise);
    const callbacks = props();
    const view = render(<KnowledgeReviewDialog {...callbacks} />);
    await publish();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    api.get.mockResolvedValueOnce({ versions: [{ ...version, id: 60, normalized_content: 'Another business source.' }] });
    view.rerender(<KnowledgeReviewDialog {...callbacks} entry={{ id: 50, title: 'Another source' }} />);
    await screen.findByText('Another business source.');
    await act(async () => { pending.resolve(withConflicts([21, 32])); });
    expect(screen.queryByText(/Conflicts with versions/)).not.toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('does not start publication after a pending scope save completes on an unmounted review', async () => {
    const pending = deferred<object>();
    api.put.mockReturnValueOnce(pending.promise);
    const view = render(<KnowledgeReviewDialog {...props()} />);
    await screen.findByText(version.normalized_content);
    fireEvent.change(screen.getByLabelText('Access'), { target: { value: 'staff_only' } });
    await publish();
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => { pending.resolve({}); });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('keeps other publication failures separate and does not refetch conflict diagnostics', async () => {
    api.post.mockRejectedValueOnce(new Error('KNOWLEDGE_PRIVACY_REVIEW_REQUIRED'));
    render(<KnowledgeReviewDialog {...props()} />);
    await publish();
    expect(await screen.findByRole('alert')).toHaveTextContent('KNOWLEDGE_PRIVACY_REVIEW_REQUIRED');
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Conflicts with versions/)).not.toBeInTheDocument();
  });

  it('keeps successful publication refresh and callbacks intact', async () => {
    api.post.mockResolvedValueOnce({});
    const callbacks = props();
    render(<KnowledgeReviewDialog {...callbacks} />);
    await publish();
    await waitFor(() => expect(callbacks.onChanged).toHaveBeenCalledTimes(1));
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
