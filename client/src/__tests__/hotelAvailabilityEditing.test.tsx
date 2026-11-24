import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AvailabilityTab } from '@/app/dashboard/(main)/hotel/components/AvailabilityTab';

const state = vi.hoisted(() => ({ post: vi.fn(), invalidate: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { post: state.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/contexts/PreferencesContext', () => ({ usePreferences: () => ({
  preferences: { locale: 'en-US' }, formatCurrency: (amount: number) => `$${amount}`,
}) }));
vi.mock('@/hooks/use-hotel-data', () => ({ useHotelAvailability: () => ({
  data: { availability: [{ id: 1, room_type_id: 11, room_type: 'Synthetic Room', date: new Date().toISOString().slice(0, 10),
    available_count: 4, total_count: 5, reserved_count: 1, price_per_night: '100' }] },
  invalidate: state.invalidate, isLoading: false, isError: false,
}) }));
beforeEach(() => { vi.clearAllMocks(); state.post.mockResolvedValue({}); state.invalidate.mockResolvedValue(undefined); });
afterEach(cleanup);

it('preserves total rooms when editing only price with an outstanding reservation', async () => {
  render(<AvailabilityTab roomTypes={[{ id: 11, name: 'Synthetic Room', capacity: 2, base_price: '100', min_price: '80', max_discount_pct: '20' }]} currency="USD" timezone="UTC" />);
  fireEvent.click(screen.getByText('4/5'));
  fireEvent.change(screen.getByPlaceholderText('Price'), { target: { value: '125' } });
  const buttons = screen.getByPlaceholderText('Count').closest('td')!.querySelectorAll('button');
  fireEvent.click(buttons[0]);
  await waitFor(() => expect(state.post).toHaveBeenCalledWith('/api/hotel/availability', expect.objectContaining({
    roomTypeId: 11, availableCount: 5, pricePerNight: 125,
  })));
});

it('offers a named keyboard editor and restores focus after cancelling', async () => {
  render(<AvailabilityTab roomTypes={[{ id: 11, name: 'Synthetic Room', capacity: 2, base_price: '100', min_price: '80', max_discount_pct: '20' }]} currency="USD" timezone="UTC" />);
  const edit = screen.getAllByRole('button', { name: /Edit availability for Synthetic Room/ })[0];
  edit.focus();
  fireEvent.click(edit);
  expect(screen.getByRole('spinbutton', { name: /Total rooms for Synthetic Room/ })).toHaveFocus();
  fireEvent.keyDown(screen.getByPlaceholderText('Count'), { key: 'Escape' });
  await waitFor(() => expect(screen.getAllByRole('button', { name: /Edit availability for Synthetic Room/ })[0]).toHaveFocus());
  expect(state.post).not.toHaveBeenCalled();
});
