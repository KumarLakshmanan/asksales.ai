import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LeadSettings from '@/app/dashboard/(main)/settings/leads/page';
const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
const sources = ['linkedin', 'google', 'justdial', 'yelp', 'instagram', 'facebook', 'twitter'];
beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue({ leadSources: sources }); mocks.put.mockResolvedValue({}); });
describe('saved discovery source review', () => {
  it('exposes every saved source and retains the changed selection after a rejected save', async () => {
    mocks.put.mockRejectedValueOnce(new Error('Try again'));
    render(<LeadSettings />);
    expect(await screen.findByText('6 fallback sources selected')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Yelp is not supported' })).toBeDisabled();
    const source = screen.getByRole('checkbox', { name: 'Select LinkedIn as a fallback source' });
    expect(source).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save defaults' })).toBeDisabled();
    fireEvent.click(source);
    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Save Error' })));
    expect(source).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save defaults' })).toBeDisabled());
    expect(mocks.put).toHaveBeenLastCalledWith('/api/settings/leads', { leadSources: sources.filter(source => !['yelp', 'linkedin'].includes(source)) });
  });
  it('blocks saving malformed saved settings and recovers through retry', async () => {
    mocks.get.mockResolvedValueOnce({});
    render(<LeadSettings />);
    expect(await screen.findByText('Lead settings unavailable')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save defaults' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    expect(await screen.findByText('6 fallback sources selected')).toBeVisible();
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
