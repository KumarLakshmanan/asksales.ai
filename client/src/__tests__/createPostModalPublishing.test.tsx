import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CreatePostModal from '@/components/modals/CreatePostModal';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), upload: vi.fn(), toast: vi.fn(), onOpenChange: vi.fn(), onPostCreated: vi.fn(),
  accounts: [] as Array<{ platform: string; credentialId: number; accountName: string; isSelected: boolean }>,
  asset: {} as Record<string, unknown>, timezone: 'Asia/Kolkata',
}));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/useOrganicPublishingAccounts', () => ({ useOrganicPublishingAccounts: () => ({
  accounts: mocks.accounts, connectedPlatforms: mocks.accounts.map(account => account.platform),
  preferredForPlatform: (platform: string) => mocks.accounts.find(account => account.platform === platform),
  forPlatform: (platform: string) => mocks.accounts.filter(account => account.platform === platform), loading: false, error: null,
}) }));
const succeeded = { success: true, results: { facebook: { success: true, status: 'succeeded' } } };
function mount(selectedDate?: Date) { return render(<CreatePostModal open selectedDate={selectedDate} onOpenChange={mocks.onOpenChange} onPostCreated={mocks.onPostCreated} />); }
async function writePost() { fireEvent.change(await screen.findByPlaceholderText('Write your caption...'), { target: { value: 'Reviewed post copy' } }); }
async function review() { fireEvent.click(screen.getByRole('button', { name: /Continue to .*review/ })); await screen.findByText('Publish social post'); }
const publishCalls = () => mocks.post.mock.calls.filter(([url]) => String(url).endsWith('/publish'));
const createCalls = () => mocks.post.mock.calls.filter(([url]) => url === '/api/content/assets');

describe('Calendar creation shares the saved-content publishing review', () => {
  beforeEach(() => {
    vi.clearAllMocks(); sessionStorage.clear(); HTMLElement.prototype.scrollIntoView = vi.fn();
    mocks.accounts = [{ platform: 'facebook', credentialId: 5, accountName: 'Test Page', isSelected: true }];
    mocks.asset = {}; mocks.timezone = 'Asia/Kolkata';
    mocks.get.mockImplementation(async (path: string) => path.includes('preferences') ? { timezone: mocks.timezone } : path === '/api/content/assets/41' ? { id: 41, ...mocks.asset } : []);
    mocks.post.mockImplementation(async (url: string, payload: Record<string, unknown>) => { if (url === '/api/content/assets') { mocks.asset = payload; return { id: 41 }; } return succeeded; });
    mocks.put.mockImplementation(async (_url: string, payload: Record<string, unknown>) => { mocks.asset = { ...mocks.asset, ...payload }; return { id: 41 }; });
    URL.createObjectURL = vi.fn((file: Blob | MediaSource) => 'blob:' + (file as File).name); URL.revokeObjectURL = vi.fn();
  });

  it('saves once and requires a separate platform preview before any external publish', async () => {
    mount(); await writePost(); await review();
    expect(createCalls()).toHaveLength(1); expect(publishCalls()).toHaveLength(0);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish post' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Publish post' }));
    await screen.findByText('Post published');
    expect(publishCalls()[0][1]).toMatchObject({ targets: [{ platform: 'facebook', postType: 'text', caption: 'Reviewed post copy' }] });
    expect(mocks.onPostCreated).toHaveBeenCalledTimes(1);
  });

  it('retries the same saved asset and idempotency key after a lost response', async () => {
    mount(); await writePost(); await review();
    mocks.post.mockRejectedValueOnce(new Error('Response interrupted')).mockResolvedValueOnce(succeeded);
    const publish = await screen.findByRole('button', { name: 'Publish post' });
    await waitFor(() => expect(publish).toBeEnabled()); fireEvent.click(publish);
    expect(await screen.findByRole('alert')).toHaveTextContent('Response interrupted');
    fireEvent.click(publish); await screen.findByText('Post published');
    expect(createCalls()).toHaveLength(1); expect(publishCalls()).toHaveLength(2);
    expect(publishCalls()[1]).toEqual(publishCalls()[0]);
  });

  it('retains the selected date and schedules in the account timezone', async () => {
    mount(new Date(2030, 0, 15)); await writePost();
    fireEvent.change(screen.getByLabelText('Scheduled publish time'), { target: { value: '09:30' } });
    await review();
    expect(await screen.findByLabelText('Scheduled date and time')).toHaveValue('2030-01-15T09:30');
    mocks.post.mockResolvedValueOnce({ success: true, scheduled: true, results: { facebook: { success: true, status: 'pending' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule post' }));
    await screen.findByText('Post scheduled');
    expect(publishCalls()[0][1]).toMatchObject({ scheduledFor: '2030-01-15T04:00:00.000Z', timezone: 'Asia/Kolkata' });
  });

  it('blocks a nonexistent DST wall time at final review', async () => {
    mocks.timezone = 'America/New_York'; mount(new Date(2030, 2, 10)); await writePost();
    fireEvent.change(screen.getByLabelText('Scheduled publish time'), { target: { value: '02:30' } }); await review();
    expect(await screen.findByText(/does not exist because the clocks change/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Schedule post' })).toBeDisabled(); expect(publishCalls()).toHaveLength(0);
  });

  it('guards rapid repeated clicks while the draft is being created', async () => {
    let finish!: (value: { id: number }) => void;
    mocks.post.mockImplementation((_url: string, payload: Record<string, unknown>) => { mocks.asset = payload; return new Promise(resolve => { finish = resolve; }); });
    mount(); await writePost(); const button = screen.getByRole('button', { name: 'Continue to publishing review' });
    fireEvent.click(button); fireEvent.click(button); expect(createCalls()).toHaveLength(1);
    await act(async () => { finish({ id: 41 }); }); expect(publishCalls()).toHaveLength(0);
  });

  it('fails closed on an unconfirmed draft receipt', async () => {
    mocks.post.mockResolvedValueOnce({ success: true }); mount(); await writePost(); await review().catch(() => {});
    expect(await screen.findByRole('alert')).toHaveTextContent('draft save could not be confirmed');
    expect(screen.getByRole('button', { name: 'Continue to publishing review' })).toBeDisabled();
    expect(createCalls()).toHaveLength(1); expect(publishCalls()).toHaveLength(0);
  });

  it('reuses the saved draft and successful files after an upload interruption', async () => {
    mocks.accounts = [{ platform: 'instagram', credentialId: 6, accountName: 'Test Instagram', isSelected: true }];
    mocks.upload.mockResolvedValueOnce({ success: true, url: '/uploads/first.jpg' }).mockRejectedValueOnce(new Error('Upload interrupted')).mockResolvedValueOnce({ success: true, url: '/uploads/second.jpg' });
    mount(); await writePost();
    fireEvent.change(document.querySelector('input[type="file"][accept="image/*"]')!, { target: { files: [new File(['a'], 'a.jpg', { type: 'image/jpeg' }), new File(['b'], 'b.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to publishing review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('media could not be uploaded');
    fireEvent.click(screen.getByRole('button', { name: 'Continue to review saved draft' }));
    await screen.findByText('Publish social post'); expect(createCalls()).toHaveLength(1);
    expect(mocks.upload.mock.calls.map(([, data]) => ((data as FormData).get('file') as File).name)).toEqual(['a.jpg', 'b.jpg', 'b.jpg']);
    expect(publishCalls()).toHaveLength(0);
  });

  it('accepts an explicitly selected video URL without relying on its extension', async () => {
    mount(); await writePost(); fireEvent.click(screen.getByLabelText('Media URL type'));
    fireEvent.click(await screen.findByRole('option', { name: 'Video' }));
    fireEvent.change(screen.getByLabelText('Media URL'), { target: { value: 'https://cdn.example.com/signed/123?token=test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add media' })); await review();
    expect(createCalls()[0][1]).toMatchObject({ videoUrl: 'https://cdn.example.com/signed/123?token=test', imageUrls: [] });
  });
});
