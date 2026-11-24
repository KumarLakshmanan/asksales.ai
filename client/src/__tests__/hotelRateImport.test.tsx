import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RoomTypesTab } from '@/app/dashboard/(main)/hotel/components/RoomTypesTab';
const state = vi.hoisted(() => ({ upload: vi.fn(), toast: vi.fn(), refresh: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { upload: state.upload } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/contexts/PreferencesContext', () => ({ usePreferences: () => ({ formatCurrency: (amount: number) => `$${amount}` }) }));
beforeEach(() => { vi.clearAllMocks(); state.upload.mockResolvedValue({ imported: 1 }); });
afterEach(cleanup);
it('requires an explicit destination when multiple properties exist and sends its identity', async () => {
  render(<RoomTypesTab roomTypes={[]} properties={[{ id: 11, name: 'Synthetic Hotel A' }, { id: 22, name: 'Synthetic Hotel B' }]} onRefresh={state.refresh} />);
  expect(screen.getByRole('button', { name: 'Import Excel' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Import property'), { target: { value: '22' } });
  fireEvent.change(screen.getByLabelText('Rate report workbook'), { target: { files: [new File(['synthetic'], 'rates.xlsx')] } });
  await waitFor(() => expect(state.upload).toHaveBeenCalledOnce());
  expect(state.upload.mock.calls[0][1].get('hotelId')).toBe('22');
  expect(state.upload.mock.calls[0][1].get('file').name).toBe('rates.xlsx');
});

it('retains a workbook row diagnostic and refreshes only after a corrected import succeeds', async () => {
  state.upload.mockRejectedValueOnce(Object.assign(new Error('Nightly rate must be positive.'), { status: 400, data: { row: 3, field: 'Rate (Gross)' } }));
  render(<RoomTypesTab roomTypes={[]} properties={[{ id: 11, name: 'Synthetic Hotel A' }]} onRefresh={state.refresh} />);
  const input = screen.getByLabelText('Rate report workbook');
  fireEvent.change(input, { target: { files: [new File(['invalid'], 'rates-invalid.xlsx')] } });
  expect(await screen.findByRole('alert')).toHaveTextContent('rates-invalid.xlsx');
  expect(screen.getByRole('alert')).toHaveTextContent('Row 3');
  expect(screen.getByRole('alert')).toHaveTextContent('Rate (Gross)');
  expect(state.refresh).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { files: [new File(['corrected'], 'rates-corrected.xlsx')] } });
  await waitFor(() => expect(state.refresh).toHaveBeenCalledOnce());
  expect(screen.queryByRole('alert')).toBeNull();
});

it('retains an unconfirmed import outcome without claiming rollback or automatically retrying', async () => {
  state.upload.mockRejectedValueOnce(new Error('Synthetic lost acknowledgement'));
  render(<RoomTypesTab roomTypes={[]} properties={[{ id: 11, name: 'Synthetic Hotel A' }]} onRefresh={state.refresh} />);
  fireEvent.change(screen.getByLabelText('Rate report workbook'), { target: { files: [new File(['synthetic'], 'rates.xlsx')] } });
  expect(await screen.findByRole('alert')).toHaveTextContent('request may have completed');
  expect(state.upload).toHaveBeenCalledOnce(); expect(state.refresh).not.toHaveBeenCalled();
});
