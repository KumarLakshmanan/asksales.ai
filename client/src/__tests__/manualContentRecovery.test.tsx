import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualContentComposer } from '@/components/content-studio/GeneratorMode';

const mocks = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn(), postForm: vi.fn(), get: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

function fill() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'My manual draft' } });
  fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'Reviewed manual content' } });
}
const props = { assetType: 'social_post', channel: 'facebook', returnHref: '/dashboard/saved-templates/social' };

describe('manual composer durable recovery', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.clearAllMocks();
    mocks.post.mockResolvedValue({ id: 701 });
    mocks.put.mockResolvedValue({ id: 701 });
    mocks.postForm.mockResolvedValue({ success: true, url: '/uploads/review.png', asset: { id: 701 } });
    mocks.get.mockResolvedValue({ id: 701 });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });

  it('locks synchronous duplicate clicks and disables editing until the receipt arrives', async () => {
    let resolve!: (value: { id: number }) => void;
    mocks.post.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const onCreated = vi.fn();
    render(<ManualContentComposer {...props} onCreated={onCreated} />); fill();
    const save = screen.getByRole('button', { name: 'Save manual draft' });
    fireEvent.click(save); fireEvent.click(save);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeDisabled();
    resolve({ id: 701 });
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(701));
    expect(screen.getByRole('button', { name: 'Draft saved' })).toBeDisabled();
  });

  it('retries a failed upload on the same draft, preserves edits, and never creates an orphan duplicate', async () => {
    mocks.postForm.mockRejectedValueOnce(Object.assign(new Error('Invalid image'), { status: 422 }));
    const onCreated = vi.fn();
    render(<ManualContentComposer {...props} mediaKind="image" onCreated={onCreated} />); fill();
    fireEvent.change(screen.getByLabelText(/Supporting media/), { target: { files: [new File(['image'], 'review.png', { type: 'image/png' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Save manual draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid image');
    expect(onCreated).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'Corrected reviewed content' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving draft' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(701));
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenCalledWith('/api/content/assets/701', expect.objectContaining({ content: expect.stringContaining('Corrected reviewed content') }));
    expect(mocks.postForm).toHaveBeenCalledTimes(2);
    expect(mocks.postForm.mock.calls[1][1].get('assetId')).toBe('701');
  });

  it('checks an uncertain upload before retrying and does not append the same media again', async () => {
    mocks.postForm.mockRejectedValueOnce(new Error('Upload response interrupted'));
    mocks.get.mockResolvedValueOnce({ id: 701 }).mockResolvedValue({ id: 701, imageUrl: '/uploads/already-saved.png' });
    const onCreated = vi.fn();
    render(<ManualContentComposer {...props} mediaKind="image" onCreated={onCreated} />); fill();
    fireEvent.change(screen.getByLabelText(/Supporting media/), { target: { files: [new File(['image'], 'review.png', { type: 'image/png' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Save manual draft' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving draft' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledExactlyOnceWith(701));
    expect(mocks.get).toHaveBeenCalledWith('/api/content/assets/701');
    expect(mocks.postForm).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('never announces success for a missing asset ID and prevents an unsafe create retry', async () => {
    mocks.post.mockResolvedValue({ success: true });
    const onCreated = vi.fn();
    render(<ManualContentComposer {...props} onCreated={onCreated} />); fill();
    fireEvent.click(screen.getByRole('button', { name: 'Save manual draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('valid saved draft ID');
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save manual draft' })).toBeDisabled();
    expect(screen.getByLabelText('Content')).toHaveValue('Reviewed manual content');
  });

  it('explains an unconfirmed save after reopening and allows a reviewed retry', async () => {
    mocks.post.mockRejectedValueOnce(Object.assign(new Error('HTTP 502'), { status: 502 }));
    const first = render(<ManualContentComposer {...props} />); fill();
    fireEvent.click(screen.getByRole('button', { name: 'Save manual draft' }));
    await screen.findByRole('alert');
    first.unmount();
    render(<ManualContentComposer {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('previous draft save could not be confirmed');
    expect(screen.getByRole('button', { name: 'Save manual draft' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'I checked the library; try saving again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save manual draft' }));
    await screen.findByRole('button', { name: 'Draft saved' });
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it('uses a separate explicit action to start another draft after successful creation', async () => {
    render(<ManualContentComposer {...props} />); fill();
    fireEvent.click(screen.getByRole('button', { name: 'Save manual draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create another draft' }));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
    expect(screen.getByLabelText('Content')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save manual draft' })).toBeDisabled();
  });

  it('restores a confirmed required-media draft and edits without uploading again', async () => {
    const mediaProps = { ...props, mediaKind: 'image' as const, requireFile: true };
    const first = render(<ManualContentComposer {...mediaProps} />); fill();
    fireEvent.change(screen.getByLabelText(/Supporting media/), { target: { files: [new File(['image'], 'review.png', { type: 'image/png', lastModified: 123 })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Save manual draft' }));
    await screen.findByRole('button', { name: 'Draft saved' });
    first.unmount();
    mocks.get.mockResolvedValue({ id: 701, imageUrl: '/uploads/review.png', metadata: { altText: 'Existing accessibility', originalFileName: 'review.png' } });
    render(<ManualContentComposer {...mediaProps} />);
    await waitFor(() => expect(screen.getByAltText('Selected upload preview')).toHaveAttribute('src', '/uploads/review.png'));
    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'Recovered draft correction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('button', { name: 'Draft saved' });
    expect(mocks.postForm).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenLastCalledWith('/api/content/assets/701', expect.objectContaining({ metadata: expect.objectContaining({ altText: 'Existing accessibility', originalFileName: 'review.png' }) }));
  });

  it('persists uncertain upload before dispatch and blocks a duplicate after refresh', async () => {
    mocks.postForm.mockImplementation(() => {
      const stored = JSON.parse(sessionStorage.getItem('asksales:manual:anonymous:social_post:facebook') || '{}');
      expect(stored.uploadReceipt.state).toBe('pending');
      return Promise.reject(new Error('Connection interrupted'));
    });
    const first = render(<ManualContentComposer {...props} mediaKind="image" />); fill();
    fireEvent.change(screen.getByLabelText(/Supporting media/), { target: { files: [new File(['image'], 'review.png', { type: 'image/png' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Save manual draft' }));
    await screen.findByRole('alert'); first.unmount();
    render(<ManualContentComposer {...props} mediaKind="image" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('previous upload is still unconfirmed'));
    expect(screen.getByRole('button', { name: 'Retry saving draft' })).toBeDisabled();
    expect(mocks.postForm).toHaveBeenCalledTimes(1);
    mocks.get.mockResolvedValue({ id: 701, imageUrl: '/uploads/finished-later.png' });
    fireEvent.click(screen.getByRole('button', { name: 'Check previous upload status' }));
    await waitFor(() => expect(screen.getByAltText('Selected upload preview')).toHaveAttribute('src', '/uploads/finished-later.png'));
    expect(mocks.postForm).toHaveBeenCalledTimes(1);
  });

  it('does not expose an earlier account draft or its pending receipt after account switch', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 1 }));
    const view = render(<ManualContentComposer {...props} />); fill();
    localStorage.setItem('user', JSON.stringify({ id: 2 }));
    view.rerender(<ManualContentComposer {...props} />);
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
    expect(screen.getByLabelText('Content')).toHaveValue('');
    expect(JSON.parse(sessionStorage.getItem('asksales:manual:user-1:business-unselected:social_post:facebook') || '{}').content).toBe('Reviewed manual content');
  });
  it('keeps a late creation receipt with its original account and never uploads into the new account', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 1 }));
    let resolve!: (value: { id: number }) => void;
    mocks.post.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<ManualContentComposer {...props} mediaKind="image" />); fill();
    fireEvent.change(screen.getByLabelText(/Supporting media/), { target: { files: [new File(['image'], 'review.png', { type: 'image/png' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Save manual draft' }));
    localStorage.setItem('user', JSON.stringify({ id: 2 }));
    view.rerender(<ManualContentComposer {...props} mediaKind="image" />);
    resolve({ id: 701 });
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('asksales:manual:user-1:business-unselected:social_post:facebook') || '{}').draftId).toBe(701));
    expect(mocks.postForm).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
    expect(JSON.parse(sessionStorage.getItem('asksales:manual:user-2:business-unselected:social_post:facebook') || '{}').draftId).toBeNull();
  });
});
