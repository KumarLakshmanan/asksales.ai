import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MediaManager from '@/components/MediaManager';

const mocks = vi.hoisted(() => ({ post: vi.fn(), postForm: vi.fn(), put: vi.fn(), toast: vi.fn(), change: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

const image = '/uploads/fixture-image.png';
const video = '/uploads/fixture-video.mp4';
const addedImage = '/uploads/fixture-new.png';
const addedVideo = '/uploads/fixture-new.mp4';
const receipt = (url = addedImage) => ({ success: true, persisted: true, assetId: 812, imageUrl: url });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function Harness({ initialImages = [image], initialVideos = [video] }: { initialImages?: string[]; initialVideos?: string[] }) {
  const [media, setMedia] = useState({ images: initialImages, videos: initialVideos });
  return <MediaManager {...media} assetId="db-812" threadId={171} onMediaChange={(images, videos) => {
    mocks.change(images, videos);
    setMedia({ images, videos });
  }} />;
}

function upload(container: HTMLElement, kind: 'image' | 'video' = 'image') {
  const input = container.querySelector('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File(['disposable fixture'], `fixture.${kind === 'image' ? 'png' : 'mp4'}`, { type: `${kind}/${kind === 'image' ? 'png' : 'mp4'}` })] } });
}

function preview(container: HTMLElement) {
  return container.querySelector('.relative.w-full img, .relative.w-full video');
}

async function generate(kind: 'image' | 'video' = 'image') {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Generate' }));
  if (kind === 'video') await user.click(screen.getByRole('tab', { name: 'Video' }));
  await user.click(screen.getByRole('button', { name: kind === 'image' ? 'Generate Image' : 'Generate Video' }));
}

describe('MediaManager uses confirmed media identities and current controlled state', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    for (const method of [mocks.post, mocks.postForm, mocks.put]) method.mockRejectedValue(new Error('Unconfigured disposable API fixture'));
  });

  it.each(['upload', 'generate'] as const)('selects the new image before existing videos after %s', async (method) => {
    mocks.postForm.mockResolvedValue({ success: true, url: addedImage });
    mocks.post.mockResolvedValue(receipt());
    const { container } = render(<Harness />);
    if (method === 'upload') upload(container);
    else await generate();
    await waitFor(() => expect(mocks.change).toHaveBeenCalledWith([image, addedImage], [video]));
    expect(preview(container)).toHaveAttribute('src', `/api${addedImage}`);
    expect(preview(container)?.tagName).toBe('IMG');
  });

  it.each(['upload-first', 'generate-first'] as const)('retains both concurrent responses in completion order: %s', async (order) => {
    const uploaded = deferred<{ success: boolean; url: string }>();
    const generated = deferred<ReturnType<typeof receipt>>();
    mocks.postForm.mockReturnValue(uploaded.promise);
    mocks.post.mockReturnValue(generated.promise);
    const { container } = render(<Harness />);
    upload(container, 'video');
    await generate();
    await act(async () => {
      if (order === 'upload-first') uploaded.resolve({ success: true, url: addedVideo });
      else generated.resolve(receipt());
    });
    await act(async () => {
      if (order === 'upload-first') generated.resolve(receipt());
      else uploaded.resolve({ success: true, url: addedVideo });
    });
    expect(mocks.change).toHaveBeenLastCalledWith([image, addedImage], [video, addedVideo]);
    expect(preview(container)).toHaveAttribute('src', `/api${order === 'upload-first' ? addedImage : addedVideo}`);
  });

  it('associates visible generation labels with their actual controls', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBe(screen.getByLabelText('Prompt', { exact: true }));
    expect(screen.getByRole('combobox', { name: 'Aspect Ratio' })).toBe(screen.getByLabelText('Aspect Ratio', { exact: true }));
    await user.click(screen.getByRole('tab', { name: 'Video' }));
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBe(screen.getByLabelText('Prompt', { exact: true }));
    expect(screen.getByRole('combobox', { name: 'Duration (seconds)' })).toBe(screen.getByLabelText('Duration (seconds)', { exact: true }));
    expect(screen.getByRole('combobox', { name: 'Aspect Ratio' })).toBe(screen.getByLabelText('Aspect Ratio', { exact: true }));
  });

  it.each(['upload', 'generate'] as const)('selects a returned video by identity after %s', async (method) => {
    mocks.postForm.mockResolvedValue({ success: true, url: addedVideo });
    mocks.post.mockResolvedValue({ success: true, persisted: true, assetId: 812, videoUrl: addedVideo });
    const { container } = render(<Harness />);
    if (method === 'upload') upload(container, 'video');
    else await generate('video');
    await waitFor(() => expect(mocks.change).toHaveBeenCalledWith([image], [video, addedVideo]));
    expect(preview(container)).toHaveAttribute('src', `/api${addedVideo}`);
    expect(screen.getByRole('button', { name: 'Show video 2' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('merges responses resolved in the same React batch even before parent updates', async () => {
    const uploaded = deferred<{ success: boolean; url: string }>();
    const generated = deferred<ReturnType<typeof receipt>>();
    mocks.postForm.mockReturnValue(uploaded.promise);
    mocks.post.mockReturnValue(generated.promise);
    const { container, rerender } = render(<MediaManager images={[image]} videos={[video]} assetId="812" onMediaChange={mocks.change} />);
    upload(container, 'video'); await generate();
    await act(async () => {
      uploaded.resolve({ success: true, url: addedVideo });
      generated.resolve(receipt());
    });
    expect(mocks.change).toHaveBeenLastCalledWith([image, addedImage], [video, addedVideo]);
    // A render from a delayed controlled parent must not erase confirmations.
    rerender(<MediaManager images={[image]} videos={[video]} assetId="812" onMediaChange={mocks.change} />);
    expect(preview(container)).toHaveAttribute('src', `/api${addedImage}`);
    expect(screen.getByRole('button', { name: 'Show video 2' })).toBeInTheDocument();
  });

  it.each(['upload-first', 'generate-first'] as const)('retains concurrent additions of the same media type: %s', async order => {
    const uploaded = deferred<{ success: boolean; url: string }>();
    const generated = deferred<ReturnType<typeof receipt>>();
    mocks.postForm.mockReturnValue(uploaded.promise); mocks.post.mockReturnValue(generated.promise);
    const otherImage = '/uploads/fixture-other.png';
    const { container } = render(<Harness />);
    upload(container); await generate();
    await act(async () => {
      if (order === 'upload-first') uploaded.resolve({ success: true, url: otherImage });
      else generated.resolve(receipt());
    });
    await act(async () => {
      if (order === 'upload-first') generated.resolve(receipt());
      else uploaded.resolve({ success: true, url: otherImage });
    });
    expect(mocks.change).toHaveBeenLastCalledWith([image, ...(order === 'upload-first' ? [otherImage, addedImage] : [addedImage, otherImage])], [video]);
    expect(preview(container)).toHaveAttribute('src', `/api${order === 'upload-first' ? addedImage : otherImage}`);
  });

  it('selects a returned image separately from a video with the same URL', async () => {
    mocks.post.mockResolvedValue(receipt(video));
    const { container } = render(<Harness />); await generate();
    await waitFor(() => expect(mocks.change).toHaveBeenCalledWith([image, video], [video]));
    expect(preview(container)?.tagName).toBe('IMG');
    expect(screen.getByRole('button', { name: 'Show image 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Show video 1' })).toHaveAttribute('aria-pressed', 'false');
  });

  it.each(['image', 'video'] as const)('selects the first uploaded %s from an empty carousel', async kind => {
    mocks.postForm.mockResolvedValue({ success: true, url: kind === 'image' ? addedImage : addedVideo });
    const { container } = render(<Harness initialImages={[]} initialVideos={[]} />); upload(container, kind);
    await waitFor(() => expect(preview(container)).toHaveAttribute('src', `/api${kind === 'image' ? addedImage : addedVideo}`));
    expect(screen.queryByText('No media attached')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next media' })).not.toBeInTheDocument();
  });

  it('uses current parent media and callback after props change during generation', async () => {
    const generated = deferred<ReturnType<typeof receipt>>();
    mocks.post.mockReturnValue(generated.promise);
    const oldChange = vi.fn(), latestChange = vi.fn();
    const { container, rerender } = render(<MediaManager images={[image]} videos={[video]} assetId="812" onMediaChange={oldChange} />);
    await generate();
    rerender(<MediaManager images={[]} videos={[video, addedVideo]} assetId="812" onMediaChange={latestChange} />);
    await act(async () => generated.resolve(receipt()));
    expect(latestChange).toHaveBeenCalledExactlyOnceWith([addedImage], [video, addedVideo]);
    expect(oldChange).not.toHaveBeenCalled();
    expect(preview(container)).toHaveAttribute('src', `/api${addedImage}`);
  });

  it('preserves selected identity and focused thumbnail through insertions, reorder and removals before it', async () => {
    const props = { assetId: '812', onMediaChange: mocks.change };
    const { container, rerender } = render(<MediaManager {...props} images={[image, addedImage]} videos={[video, addedVideo]} />);
    const user = userEvent.setup();
    const thumbnail = screen.getByRole('button', { name: 'Show video 2' });
    thumbnail.focus(); await user.keyboard('{Enter}');
    rerender(<MediaManager {...props} images={[addedImage, '/uploads/fixture-extra.png', image]} videos={[addedVideo, video]} />);
    expect(preview(container)).toHaveAttribute('src', `/api${addedVideo}`);
    expect(screen.getByRole('button', { name: 'Show video 1' })).toHaveFocus();
    rerender(<MediaManager {...props} images={[]} videos={[addedVideo, video]} />);
    expect(preview(container)).toHaveAttribute('src', `/api${addedVideo}`);
    expect(screen.getByRole('button', { name: 'Show video 1' })).toHaveAttribute('aria-pressed', 'true');
    rerender(<MediaManager {...props} images={[]} videos={[video]} />);
    expect(preview(container)).toHaveAttribute('src', `/api${video}`);
    rerender(<MediaManager {...props} images={[]} videos={[]} />);
    expect(screen.getByText('No media attached')).toBeInTheDocument();
  });

  it('removes the requested identity while preserving a different selection made during the request', async () => {
    const deleted = deferred<object>(); mocks.put.mockReturnValue(deleted.promise);
    const { container } = render(<Harness initialImages={[image, addedImage]} initialVideos={[video, addedVideo]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete media' }));
    expect(mocks.put).toHaveBeenCalledWith('/api/content/assets/812', {
      imageUrl: addedImage, imageUrls: [addedImage], videoUrl: video, videoUrls: [video, addedVideo],
    });
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Show video 1' }));
    await act(async () => deleted.resolve({}));
    expect(mocks.change).toHaveBeenLastCalledWith([addedImage], [video, addedVideo]);
    expect(preview(container)).toHaveAttribute('src', `/api${video}`);
  });

  it('chooses the next item, then previous item, then empty state on successful removals', async () => {
    mocks.put.mockResolvedValue({});
    const { container } = render(<Harness initialImages={[image, addedImage]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show image 2' }));
    await user.click(screen.getByRole('button', { name: 'Delete media' }));
    await waitFor(() => expect(preview(container)).toHaveAttribute('src', `/api${video}`));
    await user.click(screen.getByRole('button', { name: 'Delete media' }));
    await waitFor(() => expect(preview(container)).toHaveAttribute('src', `/api${image}`));
    await user.click(screen.getByRole('button', { name: 'Delete media' }));
    await waitFor(() => expect(screen.getByText('No media attached')).toBeInTheDocument());
    expect(mocks.put).toHaveBeenLastCalledWith('/api/content/assets/812', { imageUrl: null, imageUrls: null, videoUrl: null, videoUrls: null });
    expect(mocks.change).toHaveBeenLastCalledWith([], []);
  });

  it.each(['upload', 'generate'] as const)('does not duplicate an existing returned URL and selects that image after %s', async (method) => {
    mocks.postForm.mockResolvedValue({ success: true, url: image });
    mocks.post.mockResolvedValue(receipt(image));
    const { container } = render(<Harness initialImages={[image, addedImage]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show video 1' }));
    if (method === 'upload') upload(container);
    else await generate();
    await waitFor(() => expect(mocks.change).toHaveBeenCalledWith([image, addedImage], [video]));
    expect(preview(container)).toHaveAttribute('src', `/api${image}`);
    expect(screen.getByRole('button', { name: 'Show image 1' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('distinguishes duplicate URLs within and across media types', async () => {
    mocks.put.mockResolvedValue({});
    const { container } = render(<Harness initialImages={[image, image]} initialVideos={[image]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show image 2' }));
    expect(screen.getByRole('button', { name: 'Show image 1' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Show image 2' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Show video 1' }));
    expect(preview(container)?.tagName).toBe('VIDEO');
    await user.click(screen.getByRole('button', { name: 'Delete media' }));
    await waitFor(() => expect(mocks.change).toHaveBeenLastCalledWith([image, image], []));
    expect(preview(container)?.tagName).toBe('IMG');
  });

  it.each(['rejected', 'unsuccessful', 'missing-url'] as const)('retains selection and data after %s upload', async failure => {
    if (failure !== 'rejected') mocks.postForm.mockResolvedValue(failure === 'unsuccessful' ? { success: false, url: addedImage } : { success: true });
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Show video 1' })); upload(container);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error' })));
    expect(mocks.change).not.toHaveBeenCalled();
    expect(preview(container)).toHaveAttribute('src', `/api${video}`);
    expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();
  });

  it.each(['rejected', 'unsuccessful', 'missing-url', 'unconfirmed', 'wrong-parent'] as const)('retains the generation draft, selection and data after %s generation', async failure => {
    if (failure !== 'rejected') mocks.post.mockResolvedValue({ ...receipt(), ...(failure === 'unsuccessful' ? { success: false } : failure === 'missing-url' ? { imageUrl: undefined } : failure === 'unconfirmed' ? { persisted: false } : { assetId: 999 }) });
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Show video 1' })); await generate();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error' })));
    expect(mocks.change).not.toHaveBeenCalled();
    expect(preview(container)).toHaveAttribute('src', `/api${video}`);
    expect(screen.getByRole('textbox', { name: 'Prompt' })).not.toHaveValue('');
    expect(screen.getByRole('button', { name: 'Generate Image' })).toBeEnabled();
  });

  it('retains selection and arrays after failed deletion', async () => {
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Show video 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete media' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'Failed to delete media' })));
    expect(mocks.change).not.toHaveBeenCalled();
    expect(preview(container)).toHaveAttribute('src', `/api${video}`);
  });

  it('does not select queued video generations without a saved video URL', async () => {
    mocks.post.mockResolvedValue({ success: true, persisted: true, assetId: 812, operationName: 'operations/disposable' });
    const { container } = render(<Harness />); await generate('video');
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Video generation queued' })));
    expect(mocks.change).not.toHaveBeenCalled();
    expect(preview(container)).toHaveAttribute('src', `/api${image}`);
  });

  it.each(['upload', 'generate'] as const)('ignores %s responses after the parent asset changes', async method => {
    const response = deferred<ReturnType<typeof receipt> & { url: string }>();
    mocks.post.mockReturnValue(response.promise); mocks.postForm.mockReturnValue(response.promise);
    const { container, rerender } = render(<MediaManager images={[image]} videos={[video]} assetId="812" onMediaChange={mocks.change} />);
    if (method === 'upload') upload(container);
    else await generate();
    rerender(<MediaManager images={[addedImage]} videos={[]} assetId="999" onMediaChange={mocks.change} />);
    await act(async () => response.resolve({ ...receipt(), url: addedImage }));
    expect(mocks.change).not.toHaveBeenCalled();
    expect(preview(container)).toHaveAttribute('src', `/api${addedImage}`);
  });

  it('blocks replacement deletes during attachment requests and repeated upload events', async () => {
    const response = deferred<{ success: boolean; url: string }>(); mocks.postForm.mockReturnValue(response.promise);
    const { container } = render(<Harness />);
    upload(container); upload(container);
    fireEvent.click(screen.getByRole('button', { name: 'Delete media' }));
    expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.postForm).toHaveBeenCalledTimes(1);
    await act(async () => response.resolve({ success: true, url: addedImage }));
    expect(screen.getByRole('button', { name: 'Delete media' })).toBeEnabled();
  });

  it.each(['image', 'video'] as const)('provides keyboard-operable %s reference removal with focus recovery', async kind => {
    render(<Harness />); const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    if (kind === 'video') await user.click(screen.getByRole('tab', { name: 'Video' }));
    const file = new File(['disposable reference'], 'reference.png', { type: 'image/png' });
    const input = screen.getByLabelText(kind === 'image' ? 'Reference Images' : 'Reference Image (optional — for image-to-video)', { exact: true });
    await user.upload(input, kind === 'image' ? [file, file] : file);
    const remove = await screen.findByRole('button', { name: kind === 'image' ? 'Remove reference image 2' : 'Remove video reference image' });
    remove.focus(); await user.keyboard(' ');
    expect(remove).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: kind === 'image' ? 'Add reference images' : 'Add Reference Image' })).toHaveFocus();
    if (kind === 'image') expect(screen.getByRole('button', { name: 'Remove reference image 1' })).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled(); expect(mocks.postForm).not.toHaveBeenCalled();
  });

  it('names every interactive control and prevents media buttons submitting the enclosing draft form', async () => {
    const submit = vi.fn(e => e.preventDefault());
    const { container } = render(<form onSubmit={submit}><Harness /></form>);
    const user = userEvent.setup();
    screen.getByRole('button', { name: 'Show video 1' }).focus(); await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Show video 1' })).toHaveAttribute('aria-pressed', 'true');
    screen.getByRole('button', { name: 'Show image 1' }).focus(); await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Show image 1' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Generate' }));
    for (const button of screen.getAllByRole('button')) { expect(button).toHaveAccessibleName(); expect(button).toHaveAttribute('type', 'button'); }
    expect(screen.getByLabelText('Upload image or video')).toHaveAttribute('type', 'file');
    expect(submit).not.toHaveBeenCalled(); expect(preview(container)?.tagName).toBe('IMG');
  });

  it('uses distinct label IDs for multiple MediaManagers on the same page', () => {
    const { container } = render(<><Harness /><Harness /></>);
    for (const button of screen.getAllByRole('button', { name: 'Generate' })) fireEvent.click(button);
    const prompts = screen.getAllByLabelText('Prompt', { exact: true });
    expect(prompts).toHaveLength(2); expect(prompts[0].id).not.toBe(prompts[1].id);
    const ids = [...container.querySelectorAll('[id]')].map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
