import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LeadsPage from '@/app/dashboard/(main)/leads/page';
import CRMContactsPage from '@/app/dashboard/(main)/crm/contacts/page';
import { api } from '@/lib/api';
import userEvent from '@testing-library/user-event';

const { push, toast } = vi.hoisted(() => ({ push: vi.fn(), toast: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 7, businessProfileId: 4 } }) }));
vi.mock('@/services/WebSocketService', () => ({ default: { subscribe: vi.fn(() => vi.fn()) } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/api', () => {
  const mockedApi = { get: vi.fn(), post: vi.fn() };
  return { api: mockedApi, default: mockedApi };
});

describe('lead and contact actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.get).mockImplementation((url: string) => Promise.resolve(
      url === '/api/leads/stats' ? { success: false } : { data: [], total: 0, totalPages: 0 },
    ) as never);
  });

  it('shows both create actions on the Leads page and creates a CRM contact in place', async () => {
    vi.mocked(api.post).mockResolvedValue({ id: 12 } as never);
    render(<LeadsPage />);

    expect(screen.getByRole('button', { name: 'Add Lead' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add Contact' }));
    expect(screen.getByRole('dialog', { name: 'Add Contact' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: ' Ada ' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' ada@example.com ' } });
    fireEvent.click(screen.getByRole('dialog').querySelector('button[type="submit"]')!);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/crm/contacts', expect.objectContaining({
      firstName: 'Ada', email: 'ada@example.com',
    })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
  });

  it('shows both actions on CRM Contacts and opens Add Lead with a contact return path', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => Promise.resolve(
      url === '/api/crm/analytics'
        ? { totalContacts: 0, winRate: 0, pipelineValue: 0, pipelineValueByCurrency: {}, statusDistribution: {} }
        : { contacts: [], total: 0, totalPages: 1 },
    ) as never);
    render(<CRMContactsPage />);

    expect(screen.getByRole('button', { name: 'Add Contact' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^More actions$/ }));
    await user.click(await screen.findByRole('menuitem', { name: /^Add Lead$/ }));
    expect(push).toHaveBeenCalledWith('/dashboard/leads/new?returnTo=/dashboard/crm/contacts');
    const navigation = screen.getByRole('navigation', { name: 'CRM workspace' });
    expect(navigation).toHaveTextContent('Leads');
    expect(navigation).toHaveTextContent('Contacts');
    expect(screen.getByRole('link', { name: /^Contacts$/ })).toHaveAttribute('aria-current', 'page');
  });

  it('opens the reviewed email composer from selected Leads without sending immediately', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => Promise.resolve(
      url === '/api/leads/stats' ? { success: false } : {
        data: [{ id: 42, name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Engines', source: 'manual' }],
        total: 1, totalPages: 1,
      },
    ) as never);
    render(<LeadsPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select lead Ada Lovelace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review Outreach' }));
    expect(push).toHaveBeenCalledWith('/dashboard/outreach/create?channel=email&leadIds=42');
    expect(api.post).not.toHaveBeenCalledWith('/api/outreach-conversations/bulk', expect.anything());
  });
});
