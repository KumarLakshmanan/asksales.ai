import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BookingsTab } from '@/app/dashboard/(main)/hotel/components/BookingsTab';
const state = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn(), toast: vi.fn(), refresh: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { post: state.post, put: state.put } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/contexts/PreferencesContext', () => ({ usePreferences: () => ({ preferences: { locale: 'en-US' }, formatCurrency: (amount: number) => `$${amount}` }) }));
const booking = { id: 11, guest_name: 'Synthetic Guest', check_in_date: '2030-01-01', check_out_date: '2030-01-03', nights: 2,
  number_of_guests: 1, number_of_rooms: 1, total_price: '200', currency: 'USD', status: 'confirmed', payment_status: 'paid', created_at: '2026-10-23T00:00:00Z' };
beforeEach(() => { vi.clearAllMocks(); state.refresh.mockResolvedValue(undefined); });
afterEach(cleanup);
it('offers explicit recovery for unfinished setup and refreshes its durable result', async () => {
  state.post.mockResolvedValue({ confirmationRecovery: { state: 'complete', canRetry: false } });
  render(<BookingsTab bookings={[{ ...booking, confirmation_recovery: { state: 'pending', canRetry: true, step: 'reminders' } }]} timezone="UTC" onRefresh={state.refresh} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry confirmation setup for booking 11' }));
  await waitFor(() => expect(state.post).toHaveBeenCalledWith('/api/hotel/bookings/11/recovery', {}));
  await waitFor(() => expect(state.refresh).toHaveBeenCalledOnce());
  expect(state.put).not.toHaveBeenCalled();
});
it('shows uncertain alert outcomes for review without offering blind retry', () => {
  render(<BookingsTab bookings={[{ ...booking, confirmation_recovery: { state: 'needs_review', canRetry: false, step: 'alert' } }]} timezone="UTC" onRefresh={state.refresh} />);
  expect(screen.getByText('Alert delivery needs review')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Retry confirmation setup/ })).toBeNull();
});
it('distinguishes confirmed inventory from unfinished confirmation setup', async () => {
  state.put.mockResolvedValue({ confirmationRecovery: { state: 'pending', canRetry: true, step: 'reminders' } });
  render(<BookingsTab bookings={[{ ...booking, status: 'pending_payment' }]} timezone="UTC" onRefresh={state.refresh} />);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm paid' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm paid' }));
  await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Booking confirmed; setup needs attention' })));
});
