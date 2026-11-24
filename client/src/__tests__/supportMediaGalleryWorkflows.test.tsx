import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MediaGalleriesPage from '@/app/dashboard/(main)/knowledge-base/media/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), postForm: vi.fn(), toast: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/components/support/SupportMediaPreview', () => ({ SupportMediaPreview: ({ alt }: { alt: string }) => <div>{alt}</div> }));
const gallery = { id: 1, title: 'Rooms', status: 'active', version_status: 'ready_for_review', rights_certified: true, asset_count: 1 };
const detail = { ...gallery, version_id: 2, assets: [{ id: 3, name: 'Villa', alt_text: 'Room photo', publication_state: 'ready_for_review', scan_results: { scannerUnavailable: true } }] };
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('user', JSON.stringify({ id: 7 }));
  sessionStorage.setItem('active-business-profile:7', '4');
  mocks.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/business-profiles')) return [{ id: 4, companyName: 'Oro' }, { id: 5, companyName: 'Other property' }];
    if (url.endsWith('/uncertain')) return [];
    if (url.endsWith('/media-galleries/1')) return detail;
    return [gallery];
  });
  mocks.post.mockResolvedValue(detail);
});
afterEach(cleanup);
describe('owner media review controls', () => {
  it('labels draft creation separately and reports review outcomes without claiming publication', async () => {
    let finish!: (value: { id: number }) => void;
    mocks.post.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mocks.postForm.mockResolvedValue({ assets: [{ publication_state: 'ready_for_review' }], outcomes: [{ index: 0, status: 'uploaded' }] });
    render(<MediaGalleriesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New gallery' }));
    fireEvent.change(screen.getByLabelText('Gallery title *'), { target: { value: 'Review room' } });
    fireEvent.change(screen.getByLabelText('Images *'), { target: { files: [new File(['fixture'], 'review.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(screen.getByRole('checkbox', { name: /I certify lawful authority/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create and scan' }));
    expect(screen.getByRole('status')).toHaveTextContent('Creating gallery draft');
    expect(screen.getByRole('button', { name: 'Close upload' })).toBeEnabled();
    await act(async () => { finish({ id: 81 }); });
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining('1 awaiting owner review') })));
  });
  it('does not close or clear a newer form when a dismissed upload completes', async () => {
    let finish!: (value: { id: number }) => void;
    mocks.post.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mocks.postForm.mockResolvedValue({ outcomes: [] });
    render(<MediaGalleriesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New gallery' }));
    fireEvent.change(screen.getByLabelText('Gallery title *'), { target: { value: 'Original upload' } });
    fireEvent.change(screen.getByLabelText('Images *'), { target: { files: [new File(['fixture'], 'old.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(screen.getByRole('checkbox', { name: /I certify lawful authority/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create and scan' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^(Cancel|Close upload)$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'New gallery' }));
    fireEvent.change(screen.getByLabelText('Gallery title *'), { target: { value: 'My newer unsaved form' } });
    await act(async () => { finish({ id: 81 }); });
    await waitFor(() => expect(mocks.postForm).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByLabelText('Gallery title *')).toHaveValue('My newer unsaved form');
  });
  it('recovers a committed parent after reload without issuing another creation', async () => {
    const key = 'reloaded-parent-fixture';
    sessionStorage.setItem('support-gallery-creation:user-7:business-4', key);
    mocks.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/business-profiles') || url.endsWith('/uncertain')) return [];
      if (url.endsWith('/81')) return { ...detail, id: 81, title: 'Recovered room', assets: [] };
      return [{ ...gallery, id: 81, title: 'Recovered room', creation_request_key: key }];
    });
    mocks.postForm.mockResolvedValue({ outcomes: [] });
    render(<MediaGalleriesPage />);
    await screen.findByRole('button', { name: 'Open Recovered room gallery' });
    expect(screen.getByRole('button', { name: 'New gallery' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Resume gallery upload' }));
    await screen.findByText('Add images to Recovered room');
    fireEvent.change(screen.getByLabelText('Images *'), { target: { files: [new File(['fixture'], 'room.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry image upload' }));
    await waitFor(() => expect(mocks.postForm).toHaveBeenCalled());
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('reuses a durable parent request identity after a creation response is lost', async () => {
    mocks.post.mockRejectedValueOnce(new Error('Response lost')).mockResolvedValue({ id: 81 });
    mocks.postForm.mockResolvedValue({ outcomes: [] });
    render(<MediaGalleriesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New gallery' }));
    fireEvent.change(screen.getByLabelText('Gallery title *'), { target: { value: 'Recovery room' } });
    fireEvent.change(screen.getByLabelText('Images *'), { target: { files: [new File(['fixture'], 'room.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(screen.getByRole('checkbox', { name: /I certify lawful authority/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create and scan' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    const key = mocks.post.mock.calls[0]?.[2]?.headers?.['Idempotency-Key'];
    expect(key).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create and scan' }));
    await waitFor(() => expect(mocks.postForm).toHaveBeenCalled());
    expect(mocks.post.mock.calls[1]?.[2]?.headers?.['Idempotency-Key']).toBe(key);
  });
  it('records an explicit review decision and reason for an unavailable scanner image', async () => {
    render(<MediaGalleriesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Rooms gallery' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.getByRole('button', { name: 'Record review' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Media review reason'), { target: { value: 'I inspected the room photo and confirmed no sensitive content.' } });
    fireEvent.change(screen.getByLabelText('Review decision'), { target: { value: 'reject' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record review' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/settings/media-galleries/1/assets/3/review', {
      decision: 'reject', reason: 'I inspected the room photo and confirmed no sensitive content.',
    }));
  });

  it('shows property, audience and channel controls in creation', async () => {
    render(<MediaGalleriesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New gallery' }));
    expect(await screen.findByRole('option', { name: 'Oro' })).toHaveValue('4');
    expect(screen.queryByRole('option', { name: 'Other property' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Media audience'), { target: { value: 'internal' } });
    expect(screen.getByLabelText('Media audience')).toHaveValue('internal');
    expect(screen.getByRole('checkbox', { name: 'Web chat' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'instagram' }));
    expect(screen.getByRole('checkbox', { name: 'instagram' })).not.toBeChecked();
  });

  it('distinguishes failed list loading from an empty gallery library and offers retry', async () => {
    mocks.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/media-galleries')) throw new Error('Temporary failure');
      return [];
    });
    render(<MediaGalleriesPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load media galleries');
    expect(screen.queryByText('No media galleries yet')).not.toBeInTheDocument();
    mocks.get.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    expect(await screen.findByText('No media galleries yet')).toBeVisible();
  });
});
