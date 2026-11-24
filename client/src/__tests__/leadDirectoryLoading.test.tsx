import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import LeadsPage from '@/app/dashboard/(main)/leads/page';
import { api } from '@/lib/api';
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() }, default: { get: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

describe('lead directory loading', () => {
  it('labels filters and gives score-only empty results a working clear action', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => Promise.resolve(url === '/api/leads/stats' ? { success: false } : { data: [], total: 0, totalPages: 0 }) as never);
    render(<LeadsPage />);
    await screen.findByText('No leads yet');
    expect(screen.getByRole('searchbox', { name: 'Search leads' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Filter leads' }));
    for (const name of ['Status', 'Source', 'Score range', 'Sort by']) expect(screen.getByRole('combobox', { name })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Score range'), { target: { value: '80-100' } });
    expect(await screen.findByText('No leads match your filters')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear Filters' }));
    expect(screen.getByRole('searchbox', { name: 'Search leads' })).toHaveFocus();
    expect(await screen.findByText('No leads yet')).toBeVisible();
  });
  it('retains the inline edit after failure and saves the trimmed name on retry', async () => {
    const lead = { id: 1, name: 'Synthetic lead', company: 'Fixture Co', email: 'fixture@example.test', source: 'manual', score: 0, createdAt: '2026-10-01T00:00:00Z' };
    vi.mocked(api.get).mockImplementation((url: string) => Promise.resolve(url === '/api/leads/stats' ? { success: false } : { data: [lead], total: 1, totalPages: 1 }) as never);
    vi.mocked(api.put).mockRejectedValueOnce(new Error('Rejected')).mockResolvedValueOnce({});
    render(<LeadsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit lead' }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: '  Revised fixture  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(screen.getByPlaceholderText('Name')).toHaveValue('  Revised fixture  ');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('Name')).toBeNull());
    expect(api.put).toHaveBeenLastCalledWith('/api/leads/1', expect.objectContaining({ name: 'Revised fixture' }));
  });
  it('does not overwrite filtered results with a slower earlier request', async () => {
    let finishOld: (value: unknown) => void = () => {};
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/api/leads/stats') return Promise.resolve({ success: false }) as never;
      if (!url.includes('search=')) return new Promise(resolve => { finishOld = resolve; }) as never;
      return Promise.resolve({ data: [], total: 0, totalPages: 0 }) as never;
    });
    render(<LeadsPage />);
    fireEvent.change(screen.getByPlaceholderText('Search Leads by name, company and roles...'), { target: { value: 'new-filter' } });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('search=new-filter')));
    await screen.findByText('No leads match your filters');
    await act(async () => finishOld({ data: [{ id: 999, name: 'Obsolete result', email: 'old@company.test' }], total: 1, totalPages: 1 }));
    expect(screen.queryByText('Obsolete result')).not.toBeInTheDocument();
    expect(screen.getByText('No leads match your filters')).toBeInTheDocument();
  });
  it('treats malformed responses as recoverable errors', async () => {
    vi.mocked(api.get).mockResolvedValue({ invalid: true } as never);
    render(<LeadsPage />);
    expect(await screen.findByText('The server returned an invalid lead list. Please retry.')).toBeInTheDocument();
    expect(screen.queryByText('No leads yet')).not.toBeInTheDocument();
  });
});
