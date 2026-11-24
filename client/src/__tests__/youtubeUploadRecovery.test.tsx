import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { YouTubeStudioPanel } from '@/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }));
let remote: MockInstance<typeof globalThis.fetch>;
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); localStorage.setItem('user', JSON.stringify({ id: 991 })); sessionStorage.setItem('active-business-profile:991', '99');
  mocks.get.mockImplementation((path: string) => Promise.resolve(path.includes('channel-accounts') ? [{ id: 11, accountName: 'Fixture channel', accountIdentifier: 'fixture-channel', isSelected: true }] : { ready: true }));
  mocks.post.mockImplementation((path: string) => {
    if (path.endsWith('/initiate')) return Promise.resolve({ sessionToken: 'fixture-session', expiresAt: '2099-01-01T00:00:00Z' });
    if (path.endsWith('/status')) return Promise.resolve({ complete: true, video: { id: 'MOCK_VIDEO' } });
    if (path.endsWith('/finalize')) return Promise.resolve({ videoId: 'MOCK_VIDEO', processingStatus: 'processing' });
    throw new Error(`Unexpected API ${path}`);
  });
  remote = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => remote.mockRestore());
async function selectVideo(type = 'video/mp4') {
  const button = await screen.findByRole('button', { name: 'Upload in chunks' });
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File([new Uint8Array(16)], 'fixture.mp4', { type, lastModified: 1000 })] } });
  fireEvent.change(screen.getByPlaceholderText('Video title'), { target: { value: 'Reviewed fixture' } });
  await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button);
}
describe('YouTube upload recovery with simulated providers', () => {
  it('keeps the session across a timeout and reload and checks status without reuploading', async () => {
    remote.mockRejectedValueOnce(new Error('Synthetic accepted-but-timeout'));
    const view = render(<YouTubeStudioPanel />); await selectVideo(); await screen.findByText(/Synthetic accepted-but-timeout/);
    view.unmount(); render(<YouTubeStudioPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check upload status' }));
    await screen.findByText(/Uploaded MOCK_VIDEO/);
    expect(mocks.post.mock.calls.filter(([p]) => p.endsWith('/initiate'))).toHaveLength(1);
    expect(mocks.post).toHaveBeenCalledWith('/api/youtube/manage/uploads/status', { sessionToken: 'fixture-session', contentLength: 16 });
    expect(remote).toHaveBeenCalledTimes(1);
  });
  it('starts the next chunk at the exact provider-acknowledged offset', async () => {
    remote.mockResolvedValueOnce(Response.json({ success: true, data: { complete: false, uploadedBytes: 4 } }))
      .mockResolvedValueOnce(Response.json({ success: true, data: { complete: true, videoId: 'MOCK_VIDEO' } }));
    render(<YouTubeStudioPanel />); await selectVideo(); await waitFor(() => expect(remote).toHaveBeenCalledTimes(2));
    expect(remote.mock.calls.map(([, init]) => (init?.headers as Headers).get('content-range'))).toEqual(['bytes 0-15/16', 'bytes 4-15/16']);
    await screen.findByText(/Uploaded MOCK_VIDEO/);
  });
  it('keeps a known video ID after finalization timeout and resumes without media', async () => {
    remote.mockResolvedValueOnce(Response.json({ success: true, data: { complete: true, videoId: 'MOCK_VIDEO' } }));
    let finals = 0;
    mocks.post.mockImplementation((path: string) => {
      if (path.endsWith('/initiate')) return Promise.resolve({ sessionToken: 'fixture-session', expiresAt: '2099-01-01T00:00:00Z' });
      if (path.endsWith('/finalize') && ++finals === 1) return Promise.reject(new Error('Synthetic finalize timeout'));
      if (path.endsWith('/finalize')) return Promise.resolve({ videoId: 'MOCK_VIDEO', processingStatus: 'processing' });
      throw new Error(`Unexpected API ${path}`);
    });
    const view = render(<YouTubeStudioPanel />); await selectVideo(); await screen.findByText(/Synthetic finalize timeout/);
    view.unmount(); render(<YouTubeStudioPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume upload' }));
    await screen.findByText(/Uploaded MOCK_VIDEO/); expect(remote).toHaveBeenCalledTimes(1); expect(finals).toBe(2);
    expect(mocks.post.mock.calls.filter(([p]) => p.endsWith('/initiate'))).toHaveLength(1);
  });
  it('does not advance when the provider acknowledges no further bytes', async () => {
    remote.mockResolvedValueOnce(Response.json({ success: true, data: { complete: false, uploadedBytes: 0 } }));
    render(<YouTubeStudioPanel />); await selectVideo();
    await screen.findByText(/not acknowledged further bytes/);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls.filter(([p]) => p.endsWith('/finalize'))).toHaveLength(0);
  });
  it('rejects a different selected file while retaining the same provider session', async () => {
    remote.mockRejectedValueOnce(new Error('Synthetic timeout'));
    const view = render(<YouTubeStudioPanel />); await selectVideo(); await screen.findByText(/Synthetic timeout/);
    view.unmount(); render(<YouTubeStudioPanel />);
    mocks.post.mockResolvedValue({ complete: false, uploadedBytes: 0 });
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File([new Uint8Array(16)], 'different.mp4', { type: 'video/mp4', lastModified: 1000 })] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Resume upload' }));
    await screen.findByText(/Reselect the original file/);
    expect(remote).toHaveBeenCalledTimes(1);
  });
  it('does not expose the checkpoint after switching business', async () => {
    remote.mockRejectedValueOnce(new Error('Synthetic timeout'));
    const view = render(<YouTubeStudioPanel />); await selectVideo(); await screen.findByText(/Synthetic timeout/);
    view.unmount(); sessionStorage.setItem('active-business-profile:991', '100'); render(<YouTubeStudioPanel />);
    expect(await screen.findByRole('button', { name: 'Upload in chunks' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Check upload status' })).not.toBeInTheDocument();
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it('uses the session media type when the browser omits a file MIME type', async () => {
    remote.mockResolvedValueOnce(Response.json({ success: true, data: { complete: true, videoId: 'MOCK_VIDEO' } }));
    render(<YouTubeStudioPanel />); await selectVideo(''); await screen.findByText(/Uploaded MOCK_VIDEO/);
    const initiate = mocks.post.mock.calls.find(([p]) => p.endsWith('/initiate'))!;
    expect((remote.mock.calls[0][1]?.headers as Headers).get('content-type')).toBe(initiate[1].contentType);
  });

});
