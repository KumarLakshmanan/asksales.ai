import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PaymentsTab } from '@/app/dashboard/(main)/hotel/components/PaymentsTab';
const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), role: 'owner' as string }));
vi.mock('@/lib/api', () => ({ api: { get: state.get, post: state.post }, buildApiUrl: (value: string) => value }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/hooks/use-business-profiles', () => ({ useBusinessProfiles: () => ({ activeProfile: { id: 42, role: state.role }, isLoading: false }) }));
const settings = { configured: true, paymentMethodsEnabled: false, provider: 'razorpay', externalBooking: { url: 'https://booking.example.test/a', linkTitle: 'Original' }, methods: { online: { enabled: false } } };
beforeEach(() => { vi.clearAllMocks(); state.role = 'owner'; state.post.mockReset().mockResolvedValue({ success: true }); state.get.mockResolvedValue({ settings }); });
afterEach(cleanup);

it('preserves a newer draft B when submitted draft A finishes saving', async () => {
  let finish!: () => void;
  state.post.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<PaymentsTab />);
  const input = await screen.findByLabelText('Link title (optional)');
  fireEvent.change(input, { target: { value: 'Submitted A' } });
  fireEvent.click(screen.getByRole('button', { name: /Save.*Settings/i }));
  await waitFor(() => expect(state.post).toHaveBeenCalledOnce());
  fireEvent.change(input, { target: { value: 'Newer B' } });
  await act(async () => { finish(); });
  await waitFor(() => expect(screen.getByLabelText('Link title (optional)')).toHaveValue('Newer B'));
  expect(state.post.mock.calls[0][1].externalBooking.linkTitle).toBe('Submitted A');
});

it('retains the draft after an uncertain save without automatically retrying', async () => {
  state.post.mockRejectedValue(new Error('Synthetic lost acknowledgement'));
  render(<PaymentsTab />);
  fireEvent.change(await screen.findByLabelText('Link title (optional)'), { target: { value: 'Retain this draft' } });
  fireEvent.click(screen.getByRole('button', { name: /Save.*Settings/i }));
  await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Save outcome not confirmed' })));
  expect(screen.getByLabelText('Link title (optional)')).toHaveValue('Retain this draft');
  expect(state.post).toHaveBeenCalledOnce();
});

it('ignores an old save completion after the payment form unmounts', async () => {
  let finish!: () => void;
  state.post.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const view = render(<PaymentsTab />);
  await screen.findByLabelText('Link title (optional)');
  fireEvent.click(screen.getByRole('button', { name: /Save.*Settings/i }));
  await waitFor(() => expect(state.post).toHaveBeenCalledOnce());
  view.unmount(); await act(async () => { finish(); });
  expect(state.get).toHaveBeenCalledOnce();
  expect(state.toast).not.toHaveBeenCalled();
});

it.each(['https://localhost./', 'https://100.64.0.1/', 'https://192.0.2.1/', 'https://[::ffff:127.0.0.1]/'])('rejects %s locally using the existing server URL policy', async url => {
  render(<PaymentsTab />);
  fireEvent.change(await screen.findByLabelText('External booking URL'), { target: { value: url } });
  fireEvent.click(screen.getByRole('button', { name: /Save.*Settings/i }));
  expect(state.post).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Valid booking page required' }));
});

it('shows ordinary members a read-only payment form and prevents submission', async () => {
  state.role = 'member'; render(<PaymentsTab />);
  expect(await screen.findByLabelText('External booking URL')).toBeDisabled();
  const save = screen.getByRole('button', { name: /Save.*Settings/i });
  expect(save).toBeDisabled(); fireEvent.click(save);
  expect(state.post).not.toHaveBeenCalled();
  expect(screen.getByText(/business owner or billing admin/)).toBeInTheDocument();
});

it('keeps the existing billing-admin editing authority', async () => {
  state.role = 'billing_admin'; render(<PaymentsTab />);
  expect(await screen.findByLabelText('External booking URL')).toBeEnabled();
  expect(screen.getByRole('button', { name: /Save.*Settings/i })).toBeEnabled();
});
