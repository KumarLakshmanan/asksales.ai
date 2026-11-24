import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LeadsPage from '@/app/dashboard/(main)/leads/page';
import { api } from '@/lib/api';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
const fixtures = Array.from({ length: 31 }, (_, index) => ({ id: index + 1, name: `QA Lead ${index + 1}`,
  email: `qa${index + 1}@example.test`, status: 'replied', source: 'inbound_email', score: 80, createdAt: '2026-10-27T12:00:00Z' }));
const csv = '"id","name"\r\n"31","QA Lead 31"';
let totalOverride: number | null = null;

async function ready(name = 'Export all (31)') {
  const button = await screen.findByRole('button', { name });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

describe('lead export scope controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    totalOverride = null;
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/api/leads/stats') return Promise.resolve({ success: false }) as never;
      if (url.startsWith('/api/leads/export')) return Promise.resolve(csv) as never;
      const query = new URL(url, 'http://localhost').searchParams;
      const filtered = fixtures.filter(lead => !query.get('search') || lead.name === query.get('search'));
      const page = Number(query.get('page'));
      const size = Number(query.get('pageSize'));
      const total = totalOverride ?? filtered.length;
      return Promise.resolve({ data: filtered.slice((page - 1) * size, page * size), total, totalPages: Math.ceil(total / size) }) as never;
    });
    vi.mocked(api.post).mockResolvedValue(csv);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:fixture') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  it('names the full directory and requests all pages without pagination', async () => {
    render(<LeadsPage />);
    fireEvent.click(await ready());
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
    expect(api.get).toHaveBeenCalledWith('/api/leads/export?format=csv&sortBy=created_at_desc');
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByText(/Exports the full lead directory for this business/)).toBeVisible();
  });

  it('exports the one searched lead and blocks export while search is unsettled', async () => {
    render(<LeadsPage />);
    await ready();
    fireEvent.change(screen.getByLabelText('Search leads'), { target: { value: 'QA Lead 31' } });
    expect(screen.getByRole('button', { name: 'Export all (31)' })).toBeDisabled();
    fireEvent.click(await ready('Export filtered (1)'));
    expect(api.get).toHaveBeenCalledWith('/api/leads/export?format=csv&search=QA+Lead+31&sortBy=created_at_desc');
    expect(screen.getByText(/Exports all matching leads across every page/)).toBeVisible();
  });

  it('gives the checked lead priority over the filtered result', async () => {
    render(<LeadsPage />);
    await ready();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select lead QA Lead 1' }));
    fireEvent.change(screen.getByLabelText('Search leads'), { target: { value: 'QA Lead 31' } });
    fireEvent.click(await ready('Export selected (1)'));
    expect(api.post).toHaveBeenCalledWith('/api/leads/export?format=csv&sortBy=created_at_desc', { ids: [1] });
    expect(screen.getByText(/Exports checked leads, including selections on other pages/)).toBeVisible();
  });

  it('keeps selected leads on multiple pages and includes both IDs', async () => {
    render(<LeadsPage />);
    await ready();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select lead QA Lead 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await screen.findByRole('checkbox', { name: 'Select lead QA Lead 16' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select lead QA Lead 16' }));
    fireEvent.click(await ready('Export selected (2)'));
    expect(api.post).toHaveBeenCalledWith(expect.any(String), { ids: [1, 16] });
  });

  it('uses every active filter and sorting for full filtered export beyond one page', async () => {
    render(<LeadsPage />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Filter leads' }));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'replied' } });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'email' } });
    fireEvent.change(screen.getByLabelText('Score range'), { target: { value: '80-100' } });
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'score_desc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Last 7 Days' }));
    fireEvent.click(await ready('Export filtered (31)'));
    const exportUrl = vi.mocked(api.get).mock.calls.map(([url]) => url).find(url => url.startsWith('/api/leads/export'))!;
    const query = new URL(exportUrl, 'http://localhost').searchParams;
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
    expect(Object.fromEntries(query)).toEqual({ format: 'csv', status: 'replied', source: 'email', scoreRange: '80-100', sortBy: 'score_desc', timeFilter: 'last7days' });
  });

  it('blocks export after a failed directory load', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('Directory unavailable'));
    render(<LeadsPage />);
    await screen.findByText('Directory unavailable');
    expect(screen.getByRole('button', { name: 'Export all (0)' })).toBeDisabled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('keeps selection after export failure and allows an explicit retry', async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Some selected leads are unavailable in this business.'));
    render(<LeadsPage />);
    await ready();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select lead QA Lead 1' }));
    fireEvent.click(await ready('Export selected (1)'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Export failed', description: 'Some selected leads are unavailable in this business.' })));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    fireEvent.click(await ready('Export selected (1)'));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
  });

  it('blocks the full directory above the row bound while permitting a checked subset', async () => {
    totalOverride = 10001;
    render(<LeadsPage />);
    const button = await screen.findByRole('button', { name: 'Export all (10,001)' });
    expect(button).toBeDisabled();
    expect(screen.getByText(/Select fewer leads or narrow your filters/)).toBeVisible();
    // A checked subset remains available even when the full directory is large.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select lead QA Lead 1' }));
    expect(await ready('Export selected (1)')).toBeEnabled();
  });
});
