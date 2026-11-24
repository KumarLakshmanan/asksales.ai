import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CRMTab from '@/components/tabs/CRMTab';
import SupportTab from '@/components/tabs/SupportTab';
import ProposalsTab from '@/components/tabs/ProposalsTab';
import { proposalContextQuery, readProposalContext } from '@/lib/proposalContextHandoff';
import { crmContactQuery } from '@/lib/crmContactQuery';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), push: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-crm-configuration', () => ({ useCrmConfiguration: () => ({ stages: [{ key: 'qualified', label: 'Ready for review', type: 'active', color: '#123456', order: 1, inFlow: true }], error: null, reload: vi.fn() }) }));
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  mocks.post.mockResolvedValue({ id: 77, ticketNumber: 'TKT-77' });
  mocks.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/crm/contacts')) return { contacts: [{ id: 8, firstName: 'Ada', lastName: null, company: 'Example', pipelineStatus: 'qualified', status: 'contacted', currency: 'USD' }], total: 41, totalPages: 3 };
    if (url.startsWith('/api/support?')) return { tickets: [], total: 0, totalPages: 1 };
    if (url === '/api/support/teams') return [];
    if (url === '/api/proposals/templates') return [{ id: 22, name: 'Review template', templateType: 'document' }];
    return { proposals: [] };
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('campaign workspaces use canonical creation flows', () => {
  it('uses configured CRM stages and server pagination, then links shared contact creation', async () => {
    render(<CRMTab threadId="12" />);
    expect(await screen.findByText('Ready for review')).toBeVisible();
    expect(screen.getByText('41 profiles in this campaign')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/crm/contacts?page=2&limit=20&threadId=12'));
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Grace' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'grace@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add Contact$/ }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/crm/contacts', expect.objectContaining({ firstName: 'Grace', email: 'grace@example.com', chatThreadId: 12 })));
    await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeVisible());
  });
  it('closes an in-progress contact form when switching campaigns', async () => {
    const view=render(<CRMTab threadId="12" />);
    await screen.findByText('Ready for review');
    fireEvent.click(screen.getByRole('button', {name:/^Add$/}));
    fireEvent.change(screen.getByLabelText('First name'), {target:{value:'Old campaign'}});
    view.rerender(<CRMTab threadId="13" />);
    await waitFor(() => expect(screen.queryByLabelText('First name')).not.toBeInTheDocument());
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('lists campaign tickets and creates a linked ticket through the full routing form', async () => {
    render(<SupportTab threadId="12" />);
    await screen.findByText('No tickets yet');
    expect(mocks.get).toHaveBeenCalledWith('/api/support?page=1&limit=20&chatThreadId=12');
    fireEvent.click(screen.getAllByRole('button', { name: 'New Ticket' })[0]);
    expect(screen.getByRole('combobox', { name: 'Assign new ticket to support team' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Review delivery' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Customer context' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and open' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/support', expect.objectContaining({ chatThreadId: 12, subject: 'Review delivery', description: 'Customer context' })));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/dashboard/support/77'));
  });
  it('hands proposal title, requirements, template and campaign to the editor without generating', async () => {
    render(<ProposalsTab threadId="12" />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/proposals/templates'));
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g., Growth Expansion Proposal'), { target: { value: 'Launch scope' } });
    fireEvent.change(screen.getByPlaceholderText('Describe requirements, objectives, or constraints...'), { target: { value: 'Reviewed customer scope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open proposal editor' }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    const destination = new URL(mocks.push.mock.calls[0][0], 'http://localhost');
    expect(destination.pathname).toBe('/dashboard/proposals/new');
    expect(Object.fromEntries(destination.searchParams)).toEqual({ title: 'Launch scope', context: 'Reviewed customer scope', templateId: '22', chatThreadId: '12' });
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('preserves long proposal requirements in the same browser and account scope', () => {
    localStorage.setItem('user', JSON.stringify({id:9}));
    const context='Customer requirements '.repeat(300);
    const query=proposalContextQuery(context);
    expect(query.context).toBeUndefined();
    expect(query.contextKey).toBeTruthy();
    const params=new URLSearchParams({contextKey:query.contextKey!});
    expect(readProposalContext(params)).toBe(context);
    localStorage.setItem('user', JSON.stringify({id:10}));
    expect(() => readProposalContext(params)).toThrow('unavailable');
  });
  it('shares configured stage filtering with global CRM', () => {
    expect(crmContactQuery({ page: 3, limit: 20, search: ' Ada ', pipelineStatus: 'qualified', threadId: '12' })).toBe('/api/crm/contacts?page=3&limit=20&search=Ada&pipelineStatus=qualified&threadId=12');
  });
});
