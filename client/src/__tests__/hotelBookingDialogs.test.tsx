import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BookingsTab } from '@/app/dashboard/(main)/hotel/components/BookingsTab';
vi.mock('@/lib/api', () => ({ api: { put: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/contexts/PreferencesContext', () => ({ usePreferences: () => ({ preferences: { locale: 'en-US' }, formatCurrency: (amount: number) => `$${amount}` }) }));
afterEach(cleanup);
it.each(['View booking 11', 'Confirm paid', 'Cancel'])('returns keyboard focus to %s after Escape', async (action) => {
  render(<BookingsTab bookings={[{ id: 11, guest_name: 'Synthetic Guest', check_in_date: '2030-01-01', check_out_date: '2030-01-03', nights: 2,
    number_of_guests: 1, number_of_rooms: 1, total_price: '200', currency: 'USD', status: 'pending_payment', payment_status: 'pending', created_at: '2026-10-23T00:00:00Z' }]} timezone="UTC" onRefresh={() => {}} />);
  const opener = screen.getByRole('button', { name: action });
  opener.focus(); fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await waitFor(() => expect(opener).toHaveFocus());
});
