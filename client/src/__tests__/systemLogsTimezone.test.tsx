import React from 'react';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { get, toast } = vi.hoisted(() => ({ get: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ default: { get } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/contexts/AdminAuthContext', () => ({ useAdminAuth: () => ({ admin: { role: 'admin' } }) }));
import Page from '@/app/admin/dashboard/system-logs/page';
afterEach(cleanup);
describe('log filter time instants', () => {
  it('sends explicit instants for the device-local range instead of offset-free wall clock values', async () => {
    get.mockResolvedValue({ success: true, data: [], total: 0, totalPages: 0, stats: {} });
    const { container } = render(<Page />); await screen.findByText('No logs found');
    const inputs = container.querySelectorAll('input[type="datetime-local"]');
    fireEvent.change(inputs[0], { target: { value: '2026-10-23T10:00' } });
    fireEvent.change(inputs[1], { target: { value: '2026-10-23T10:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply Filters' }));
    await waitFor(() => expect(get.mock.calls.some(([url]) => String(url).includes('from='))).toBe(true));
    const call = get.mock.calls.findLast(([url]) => String(url).includes('from='));
    const query = new URL(String(call?.[0]), 'http://local.test').searchParams;
    expect(query.get('from')).toBe(new Date('2026-10-23T10:00').toISOString());
    expect(query.get('to')).toBe(new Date('2026-10-23T10:30').toISOString());
  });
});
