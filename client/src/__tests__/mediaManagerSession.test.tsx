import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MediaManager from '@/components/MediaManager';
import { DraftLibraryCard } from '@/components/content-library/DraftLibraryCard';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), postForm: vi.fn(), put: vi.fn(), delete: vi.fn(), toast: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));

const image = '/uploads/session-original.png', video = '/uploads/session-original.mp4';
const newerImage = '/uploads/session-newer.png', staleImage = '/uploads/session-retired.png';
const draft = { id: 812, title: 'Disposable session draft', type: 'social_post', channel: 'instagram', status: 'draft',
  createdAt: '2026-10-01T00:00:00Z', content: JSON.stringify({ caption: 'Original draft text' }),
  imageUrl: image, imageUrls: [image], videoUrl: video, videoUrls: [video] };

function deferred() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  for (const method of [mocks.get, mocks.post, mocks.postForm, mocks.put, mocks.delete]) method.mockRejectedValue(new Error('Unconfigured disposable session fixture'));
  mocks.get.mockResolvedValue(draft);
});
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.restoreAllMocks(); });

function upload(input: HTMLElement, url = newerImage) {
  fireEvent.change(input, { target: { files: [new File(['disposable fixture'], `${url.split('/').pop()}`, { type: 'image/png' })] } });
}

describe('MediaManager session ownership', () => {
  it.each(['upload', 'image-generation', 'video-generation', 'delete'] as const)('same draft reopen retains newer media, text and selection after retired %s succeeds', async operation => {
    const oldRequest = deferred();
    if (operation === 'upload') mocks.postForm.mockReturnValueOnce(oldRequest.promise);
    else if (operation === 'delete') mocks.put.mockReturnValueOnce(oldRequest.promise);
    else mocks.post.mockReturnValueOnce(oldRequest.promise);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    clients.push(client);
    const invalidations = vi.spyOn(client, 'invalidateQueries');
    render(<QueryClientProvider client={client}><DraftLibraryCard asset={draft} kind="social" /></QueryClientProvider>);
    const user = userEvent.setup();
    async function open() {
      await user.click(await screen.findByRole('button', { name: 'Edit Disposable session draft' }));
      return within(await screen.findByRole('dialog', { name: 'Edit social draft' }));
    }
    let editor = await open();
    if (operation === 'upload') upload(editor.getByLabelText('Upload image or video'), staleImage);
    else if (operation === 'delete') await user.click(editor.getByRole('button', { name: 'Delete media' }));
    else {
      await user.click(editor.getByRole('button', { name: 'Generate' }));
      if (operation === 'video-generation') await user.click(editor.getByRole('tab', { name: 'Video' }));
      await user.click(editor.getByRole('button', { name: operation === 'video-generation' ? 'Generate Video' : 'Generate Image' }));
    }
    await user.click(editor.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    editor = await open();
    await user.clear(editor.getByLabelText('Message')); await user.type(editor.getByLabelText('Message'), 'Keep newer unsaved text');
    mocks.postForm.mockResolvedValueOnce({ success: true, url: newerImage });
    upload(editor.getByLabelText('Upload image or video'));
    await waitFor(() => expect(editor.getByRole('button', { name: 'Show image 2' })).toHaveAttribute('aria-pressed', 'true'));
    const callbackEffects = invalidations.mock.calls.length, toastCount = mocks.toast.mock.calls.length;
    await act(async () => oldRequest.resolve({ success: true, url: staleImage, persisted: true, assetId: 812, imageUrl: staleImage, videoUrl: '/uploads/session-retired.mp4' }));
    expect(editor.queryByRole('img', { name: 'Image 2' })).toHaveAttribute('src', `/api${newerImage}`);
    expect(invalidations).toHaveBeenCalledTimes(callbackEffects);
    expect(mocks.toast).toHaveBeenCalledTimes(toastCount);
    expect(editor.getByRole('button', { name: 'Show image 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(editor.getByLabelText('Message')).toHaveValue('Keep newer unsaved text');
    expect(editor.getByRole('button', { name: 'Show video 1' })).toBeInTheDocument();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it.each(['upload', 'generation', 'delete', 'magic'] as const)('retired %s failures have no callback or notification after unmount', async operation => {
    const oldRequest = deferred(), onMediaChange = vi.fn();
    const { unmount } = render(<MediaManager images={[image]} videos={[video]} assetId="812" onMediaChange={onMediaChange} />);
    const user = userEvent.setup();
    if (operation === 'upload') { mocks.postForm.mockReturnValue(oldRequest.promise); upload(screen.getByLabelText('Upload image or video')); }
    else if (operation === 'delete') { mocks.put.mockReturnValue(oldRequest.promise); await user.click(screen.getByRole('button', { name: 'Delete media' })); }
    else {
      mocks.post.mockReturnValue(oldRequest.promise); await user.click(screen.getByRole('button', { name: 'Generate' }));
      await user.click(screen.getByRole('button', { name: operation === 'magic' ? 'Magic: enhance image prompt' : 'Generate Image' }));
    }
    unmount(); await act(async () => oldRequest.reject(new Error('Disposable retired failure')));
    expect(onMediaChange).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('asset round trips retire old requests without unlocking a newer request for the same ID', async () => {
    const oldRequest = deferred(), currentRequest = deferred(), onMediaChange = vi.fn();
    mocks.postForm.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(currentRequest.promise);
    const props = { images: [image], videos: [video], onMediaChange };
    const { rerender } = render(<StrictMode><MediaManager {...props} assetId="812" /></StrictMode>);
    upload(screen.getByLabelText('Upload image or video'), staleImage);
    rerender(<StrictMode><MediaManager {...props} assetId="999" /></StrictMode>);
    rerender(<StrictMode><MediaManager {...props} assetId="812" /></StrictMode>);
    upload(screen.getByLabelText('Upload image or video'));
    expect(mocks.postForm).toHaveBeenCalledTimes(2);
    await act(async () => oldRequest.resolve({ success: true, url: staleImage }));
    expect(onMediaChange).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Upload' })).toHaveAttribute('aria-disabled', 'true');
    await act(async () => currentRequest.resolve({ success: true, url: newerImage }));
    expect(onMediaChange).toHaveBeenCalledExactlyOnceWith([image, newerImage], [video]);
    expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();
  });

  it.each(['image', 'video'] as const)('retired %s generation cannot release a newer generation lock for the same ID', async kind => {
    const oldRequest = deferred(), currentRequest = deferred(), onMediaChange = vi.fn();
    mocks.post.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(currentRequest.promise);
    const props = { images: [image], videos: [video], onMediaChange };
    const { rerender } = render(<StrictMode><MediaManager {...props} assetId="812" /></StrictMode>);
    const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Generate' }));
    if (kind === 'video') await user.click(screen.getByRole('tab', { name: 'Video' }));
    const name = kind === 'image' ? 'Generate Image' : 'Generate Video';
    await user.click(screen.getByRole('button', { name }));
    rerender(<StrictMode><MediaManager {...props} assetId="999" /></StrictMode>);
    rerender(<StrictMode><MediaManager {...props} assetId="812" /></StrictMode>);
    await user.click(screen.getByRole('button', { name }));
    expect(mocks.post).toHaveBeenCalledTimes(2);
    await act(async () => oldRequest.resolve({ success: true, persisted: true, assetId: 812, imageUrl: staleImage, videoUrl: '/uploads/session-retired.mp4' }));
    expect(onMediaChange).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled();
    const busyName = kind === 'image' ? 'Generating Image...' : 'Generating Video (this may take a few minutes)...';
    expect(screen.getByRole('button', { name: busyName })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: busyName }));
    expect(mocks.post).toHaveBeenCalledTimes(2);
    await act(async () => currentRequest.resolve({ success: true, persisted: true, assetId: 812, imageUrl: newerImage, videoUrl: '/uploads/session-newer.mp4' }));
    expect(onMediaChange).toHaveBeenCalledExactlyOnceWith(kind === 'image' ? [image, newerImage] : [image], kind === 'video' ? [video, '/uploads/session-newer.mp4'] : [video]);
  });

  it.each(['upload', 'image-generation', 'video-generation', 'delete', 'magic'] as const)('mounted A→B→A rejects the original A %s success', async operation => {
    const oldRequest = deferred(), onMediaChange = vi.fn();
    const props = { images: [image], videos: [video], onMediaChange };
    const { rerender } = render(<MediaManager {...props} assetId="812" />);
    const user = userEvent.setup();
    if (operation === 'upload') { mocks.postForm.mockReturnValue(oldRequest.promise); upload(screen.getByLabelText('Upload image or video')); }
    else if (operation === 'delete') { mocks.put.mockReturnValue(oldRequest.promise); await user.click(screen.getByRole('button', { name: 'Delete media' })); }
    else {
      mocks.post.mockReturnValue(oldRequest.promise); await user.click(screen.getByRole('button', { name: 'Generate' }));
      if (operation === 'video-generation') await user.click(screen.getByRole('tab', { name: 'Video' }));
      await user.click(screen.getByRole('button', { name: operation === 'magic' ? 'Magic: enhance image prompt' : operation === 'video-generation' ? 'Generate Video' : 'Generate Image' }));
    }
    rerender(<MediaManager {...props} assetId="999" />);
    rerender(<MediaManager {...props} images={[image, newerImage]} assetId="812" />);
    await user.click(screen.getByRole('button', { name: 'Show image 2' }));
    await act(async () => oldRequest.resolve({ success: true, url: staleImage, imageUrl: staleImage, videoUrl: '/uploads/session-retired.mp4', assetId: 812, persisted: true, enhancedPrompt: 'Retired prompt' }));
    expect(onMediaChange).not.toHaveBeenCalled(); expect(mocks.toast).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Show image 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('img', { name: 'Image 2' })).toHaveAttribute('src', `/api${newerImage}`);
    if (operation !== 'upload' && operation !== 'delete') expect(screen.getByRole('textbox', { name: 'Prompt' })).not.toHaveValue('Retired prompt');
  });

  it('retires reference file reads across an asset round trip', async () => {
    const readers: FileReader[] = [];
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) { readers.push(this); });
    const props = { images: [image], videos: [video], onMediaChange: vi.fn() };
    const { rerender } = render(<MediaManager {...props} assetId="812" />);
    const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Generate' }));
    await user.upload(screen.getByLabelText('Reference Images'), new File(['disposable'], 'reference.png', { type: 'image/png' }));
    rerender(<MediaManager {...props} assetId="999" />); rerender(<MediaManager {...props} assetId="812" />);
    await act(async () => {
      Object.defineProperty(readers[0], 'result', { value: 'data:image/png;base64,ZGlzcG9zYWJsZQ==' });
      readers[0].dispatchEvent(new ProgressEvent('load'));
      readers[0].dispatchEvent(new ProgressEvent('error'));
    });
    expect(screen.queryByRole('button', { name: 'Remove reference image 1' })).not.toBeInTheDocument();
    expect(mocks.toast).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
  });
});
