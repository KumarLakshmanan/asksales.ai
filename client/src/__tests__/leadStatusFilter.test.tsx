import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LeadsPage from '@/app/dashboard/(main)/leads/page';
import { api } from '@/lib/api';
import { LEAD_STATUSES } from '../../../shared/leadStatus';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

// Include every state accepted by lead CRUD and the state written by inbound email.
const statuses: readonly string[] = LEAD_STATUSES;
const fixtures = statuses.map((status, index) => ({
  id: index + 1, name: `Lead ${status}`, email: `${status}@example.test`,
  leadStatus: status, status: 'new', source: 'inbound_email',
  createdAt: '2026-10-09T12:00:00Z', score: 0, repliedEmails: 1,
}));
fixtures.push(...Array.from({ length: 12 }, (_, index) => ({ ...fixtures[0], id: 100 + index, name: `Legacy ${index}`, leadStatus: 'interested' })));

function openFilters() {
  fireEvent.click(screen.getByRole('button', { name: 'Filter leads' }));
  return screen.getByDisplayValue('All Statuses');
}

describe('lead status filter coverage', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/api/leads/stats') return Promise.resolve({ success: false }) as never;
      const params = new URL(url, 'http://localhost').searchParams;
      const filtered = fixtures.filter(lead =>
        (!params.get('status') || lead.leadStatus === params.get('status')) &&
        (!params.get('search') || lead.name.includes(params.get('search')!)) &&
        (!params.get('source') || params.get('source') === 'email'),
      );
      const page = Number(params.get('page'));
      const pageSize = Number(params.get('pageSize'));
      return Promise.resolve({ data: filtered.slice((page - 1) * pageSize, page * pageSize),
        total: filtered.length, totalPages: Math.ceil(filtered.length / pageSize), statuses: ['interested', 'awaiting_review'],
      }) as never;
    });
  });

  it.each(statuses)('offers and requests the displayed %s status, independently of engagement', async status => {
    render(<LeadsPage />);
    await screen.findAllByText(`Lead ${status}`);
    const select = openFilters();
    expect(within(select).getByRole('option', { name: status[0].toUpperCase() + status.slice(1) })).toHaveValue(status);
    fireEvent.change(select, { target: { value: status } });
    await waitFor(() => expect(screen.getByText('All Leads (1)')).toBeInTheDocument());
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining(`status=${status}`));
    expect(screen.getAllByText(`Lead ${status}`).length).toBeGreaterThan(0);
    expect(screen.queryByText(`Lead ${status === 'new' ? 'converted' : 'new'}`)).not.toBeInTheDocument();
  });

  it('offers a matching option for every rendered table status', async () => {
    render(<LeadsPage />);
    await screen.findAllByText('Lead new');
    const select = openFilters();
    const table = screen.getByRole('table');
    const statusColumn = within(table).getAllByRole('columnheader').findIndex(header => header.textContent === 'Status');
    expect(statusColumn).toBeGreaterThan(-1);
    for (const row of within(table).getAllByRole('row').slice(1)) {
      const label = within(row).getAllByRole('cell')[statusColumn].textContent!;
      expect(within(select).getByRole('option', { name: label })).toBeInTheDocument();
    }
  });

  it('keeps tenant legacy statuses available beyond the current page and after filtering', async () => {
    render(<LeadsPage />);
    await screen.findAllByText('Lead new');
    const select = openFilters();
    expect(within(select).getByRole('option', { name: 'Interested' })).toHaveValue('interested');
    // This state is absent from the loaded page and comes only from API metadata.
    expect(within(select).getByRole('option', { name: 'Awaiting Review' })).toHaveValue('awaiting_review');
    fireEvent.change(select, { target: { value: 'interested' } });
    await screen.findAllByText('Legacy 0');
    expect(select).toHaveValue('interested');
    expect(within(select).getByRole('option', { name: 'Replied' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search leads'), { target: { value: 'Missing' } });
    // The page waits 300 ms before searching; allow for slow CI/full-suite runs.
    await screen.findByText('No leads match your filters', {}, { timeout: 5000 });
    expect(select).toHaveValue('interested');
    expect(within(select).getByRole('option', { name: 'Interested' })).toBeInTheDocument();
  });

  it('combines status with Email and search, resets pagination, and clears All Statuses only', async () => {
    render(<LeadsPage />);
    await screen.findAllByText('Lead new');
    fireEvent.change(screen.getByLabelText('Rows per page:'), { target: { value: '10' } });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('pageSize=10')));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Page 2' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('page=2&')));
    const statusSelect = openFilters();
    fireEvent.change(screen.getByDisplayValue('All Sources'), { target: { value: 'email' } });
    fireEvent.change(statusSelect, { target: { value: 'replied' } });
    fireEvent.change(screen.getByPlaceholderText('Search Leads by name, company and roles...'), { target: { value: 'Lead' } });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('page=1&pageSize=10&search=Lead&status=replied&source=email')));
    await screen.findAllByText('Lead replied');
    expect(screen.queryByText('Lead new')).not.toBeInTheDocument();
    fireEvent.change(statusSelect, { target: { value: '' } });
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/api/leads?page=1&pageSize=10&search=Lead&source=email&sortBy=created_at_desc'));
    expect(statusSelect).toHaveValue('');
    await screen.findAllByText('Lead new');
    expect(screen.getByText(`All Leads (${statuses.length})`)).toBeInTheDocument();
  });
});
