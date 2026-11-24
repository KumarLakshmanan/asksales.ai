import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CRMContactsPage from '@/app/dashboard/(main)/crm/contacts/page';
import CRMPipelinePage from '@/app/dashboard/(main)/crm/pipeline/page';
import CRMReportsPage from '@/app/dashboard/(main)/crm/reports/page';
import CRMWorkPage from '@/app/dashboard/(main)/crm/work/page';
import { DEFAULT_CRM_CONFIGURATION } from '@/lib/crm-configuration';

vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn(), push: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks, default: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 7, businessProfileId: 9 } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-crm-automation-refresh', () => ({ useCrmAutomationRefresh: () => {} }));
vi.mock('@/components/crm/CreateContactDialog', () => ({ CreateContactDialog: () => null }));
vi.mock('@/components/crm/CreateConversationDialog', () => ({ CreateConversationDialog: () => null }));
vi.mock('@/components/crm/ContactReminders', () => ({ ContactReminderDialog: () => null }));
const contact = { id: 1, leadId: 10, firstName: 'Mina', lastName: 'Khan', email: 'mina@example.test', phone: null, company: 'Northstar', pipelineStatus: 'new', dealValue: '100.00', currency: 'USD', tags: [], priority: 'high', assignedTo: 7, updatedAt: '2026-09-01T09:00:00.000Z', lastSentimentStatus: null };
const stages = DEFAULT_CRM_CONFIGURATION.stages.filter(stage => ['new', 'contacted', 'won', 'lost'].includes(stage.key));
const configuration = { stages, preferences: { ...DEFAULT_CRM_CONFIGURATION.preferences, platform: ['email'] } };
const analytics = { stages: stages.map(stage => ({ ...stage, count: stage.key === 'new' ? 21 : 0, stuckCount: 0, dealValueByCurrency: stage.key === 'new' ? { USD: '2100.00' } : {} })), totalContacts: 21, winRate: 0, pipelineValueByCurrency: { USD: '2100.00' }, totalPipelineValueByCurrency: { USD: '2100.00' }, preferences: configuration.preferences, flows: [], stuckContacts: 0, channels: [], stageDurations: [], filters: { platforms: ['email'], dateRange: '30d' } };
function dispatchGet(path: string) {
  const url = new URL(path, 'https://example.test');
  if (url.pathname === '/api/crm/configuration') return Promise.resolve(configuration);
  if (url.pathname === '/api/crm/assignees') return Promise.resolve({ data: [{ id: 7, name: 'Asha', email: 'asha@example.test' }] });
  if (url.pathname === '/api/crm/analytics' || url.pathname === '/api/crm/pipeline/analytics') return Promise.resolve(analytics);
  if (url.pathname === '/api/crm/pipeline/summary') return Promise.resolve({ stages: analytics.stages });
  if (url.pathname === '/api/crm/reports') return Promise.resolve({ data: analytics });
  if (url.pathname === '/api/crm/work') return Promise.resolve({ items: [{ id: 'reminder:8', entityId: 8, type: 'reminder', title: 'Follow up with Mina', description: 'Review proposal', contactId: 1, contactName: 'Mina Khan', ownerUserId: 7, dueAt: '2026-01-01T09:00:00Z', priority: 'high', status: 'pending', url: '/dashboard/crm/reminders?reminderId=8' }], counts: { reminder: 1, conversation: 0, stuck_contact: 0, ticket: 0 }, total: 1, totalPages: 1, page: 1, limit: 20 });
  if (url.pathname === '/api/crm/contacts') {
    const stage = url.searchParams.get('pipelineStatus');
    const page = Number(url.searchParams.get('page') || 1);
    return Promise.resolve({ contacts: stage && stage !== 'new' ? [] : page > 1 ? [{ ...contact, id: 2, firstName: 'Joel', lastName: 'Rivera' }] : [contact], total: stage && stage !== 'new' ? 0 : 21, totalPages: stage && stage !== 'new' ? 1 : 2, page, dealValueByCurrency: { USD: '2100.00' } });
  }
  return Promise.reject(new Error(`Unexpected API request ${path}`));
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, '', '/dashboard/crm/contacts');
  mocks.get.mockImplementation(dispatchGet); mocks.put.mockResolvedValue(contact); mocks.post.mockResolvedValue({ data: { updatedCount: 1 } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('CRM collections UI', () => {
  it.each([
    'dateRange=7d',
    'platforms=email',
    'dateRange=custom&from=2026-10-01&to=2026-10-07&platforms=email&platforms=sms',
  ])('clears report URL filters (%s), preserves unrelated state, and stays cleared after reload', async reportQuery => {
    const state = { __NA: true, fixtureState: 'preserved' };
    window.history.replaceState(state, '', `/dashboard/crm/contacts?${reportQuery}&search=Mina&priority=high&sortBy=name&sortOrder=asc&view=one&view=two#contact-list`);
    mocks.get.mockImplementation((path: string) => {
      const url = new URL(path, 'https://example.test');
      if (url.pathname !== '/api/crm/contacts') return dispatchGet(path);
      const reportFiltered = url.searchParams.has('dateRange') || url.searchParams.has('platforms');
      return Promise.resolve({ contacts: [contact], total: reportFiltered ? 5 : 749, totalPages: 1 });
    });
    const user = userEvent.setup();
    const page = render(<CRMContactsPage />);
    await screen.findByText('1 of 5 contacts');
    const currentHistoryState = window.history.state;
    await user.click(screen.getByRole('button', { name: 'Clear report filters' }));
    await screen.findByText('1 of 749 contacts');
    const url = new URL(window.location.href);
    for (const key of ['dateRange', 'from', 'to', 'platforms']) expect(url.searchParams.has(key)).toBe(false);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ search: 'Mina', priority: 'high', sortBy: 'name', sortOrder: 'asc' });
    expect(url.searchParams.getAll('view')).toEqual(['one', 'two']);
    expect(url.pathname).toBe('/dashboard/crm/contacts');
    expect(url.hash).toBe('#contact-list');
    expect(window.history.state).toEqual(currentHistoryState);
    expect(window.history.state).toMatchObject(state);
    expect(screen.queryByRole('button', { name: 'Clear report filters' })).not.toBeInTheDocument();
    // A fresh mount reads the surviving URL, as a browser reload would.
    page.unmount();
    mocks.get.mockClear();
    render(<CRMContactsPage />);
    await screen.findByText('1 of 749 contacts');
    await waitFor(() => {
      const request = mocks.get.mock.calls.filter(([path]) => path.startsWith('/api/crm/contacts?')).at(-1)![0];
      const params = new URL(request, 'https://example.test').searchParams;
      for (const key of ['dateRange', 'from', 'to', 'platforms']) expect(params.has(key)).toBe(false);
      expect(Object.fromEntries(params)).toMatchObject({ search: 'Mina', priority: 'high', sortBy: 'name', sortOrder: 'asc', page: '1' });
    });
    expect(screen.queryByRole('button', { name: 'Clear report filters' })).not.toBeInTheDocument();
    for (const mutation of [mocks.post, mocks.put, mocks.patch, mocks.delete]) expect(mutation).not.toHaveBeenCalled();
  });

  it('clears a report-only query without leaving a query delimiter or removing the fragment', async () => {
    window.history.replaceState(null, '', '/dashboard/crm/contacts?dateRange=7d#contact-list');
    const user = userEvent.setup(); render(<CRMContactsPage />);
    await user.click(await screen.findByRole('button', { name: 'Clear report filters' }));
    expect(window.location.pathname).toBe('/dashboard/crm/contacts');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#contact-list');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear report filters' })).not.toBeInTheDocument());
  });

  it('leaves report filters and URL intact when a dirty contact edit is kept', async () => {
    window.history.replaceState({ fixtureState: 'preserved' }, '', '/dashboard/crm/contacts?dateRange=7d&platforms=email#contact-list');
    const user = userEvent.setup(); render(<CRMContactsPage />);
    await user.click(await screen.findByRole('button', { name: 'Edit Mina Khan' }));
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Unsaved company' } });
    const beforeUrl = window.location.href;
    const beforeState = window.history.state;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: 'Clear report filters' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(window.location.href).toBe(beforeUrl);
    expect(window.history.state).toEqual(beforeState);
    expect(screen.getByLabelText('Company')).toHaveValue('Unsaved company');
    expect(screen.getByRole('button', { name: 'Clear report filters' })).toBeVisible();
    confirm.mockRestore();
  });

  it('saves inline fields and stage in one request and preserves a failed draft', async () => {
    const user = userEvent.setup(); render(<CRMContactsPage />);
    await screen.findByRole('link', { name: 'Mina Khan' });
    await user.click(screen.getByRole('button', { name: 'Edit Mina Khan' }));
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Northstar Labs' } });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Pipeline stage' }), 'contacted');
    mocks.put.mockRejectedValueOnce(new Error('Another person updated this contact.'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('Company')).toHaveValue('Northstar Labs');
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.put).toHaveBeenCalledWith('/api/crm/contacts/1', { company: 'Northstar Labs', dealValue: '100.00', pipelineStatus: 'contacted', expectedUpdatedAt: contact.updatedAt });
  });
  it('updates only checked records and clears selection after a server-backed filter change', async () => {
    const user = userEvent.setup(); render(<CRMContactsPage />);
    await screen.findByRole('checkbox', { name: 'Select Mina Khan' });
    await user.click(screen.getByRole('checkbox', { name: 'Select Mina Khan' }));
    fireEvent.change(screen.getByLabelText('Add tags'), { target: { value: 'customer, follow-up' } });
    await user.selectOptions(screen.getByLabelText('Assign to'), '7');
    await user.click(screen.getByRole('button', { name: 'Apply to selected' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/crm/contacts/bulk', { contactIds: [1], addTags: ['customer', 'follow-up'], ownerUserId: 7 }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Update selected contacts' })).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Advanced filters' }));
    await user.selectOptions(screen.getByLabelText('Priority'), 'high');
    await waitFor(() => expect(mocks.get.mock.calls.some(([path]) => path.includes('/api/crm/contacts?') && path.includes('priority=high'))).toBe(true));
  });
  it('keeps exact bulk recovery links after successful saves and clearing selection',async()=>{
    mocks.post.mockResolvedValue({data:{updatedCount:1,automationReviewRequired:true,contacts:[{id:1,automationReviewRequired:true,automationTransitionId:73}]}});
    const user=userEvent.setup();render(<CRMContactsPage />);
    await user.click(await screen.findByRole('checkbox',{name:'Select Mina Khan'}));
    fireEvent.change(screen.getByLabelText('Add tags'),{target:{value:'reviewed'}});
    await user.click(screen.getByRole('button',{name:'Apply to selected'}));
    const link=await screen.findByRole('link',{name:'Review contact #1 · transition #73'});
    expect(link).toHaveAttribute('href','/dashboard/crm/contacts/1?tab=activity#automation-transition-73');
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({title:'Contact saved; automation needs attention'}));
  });
  it('stores named views in the signed-in account and selected business namespace', async () => {
    const user = userEvent.setup(); render(<CRMContactsPage />);
    await screen.findByRole('link', { name: 'Mina Khan' });
    await user.click(screen.getByRole('button', { name: 'Advanced filters' }));
    await user.selectOptions(screen.getByLabelText('Follow-up'), 'overdue');
    await user.click(screen.getByRole('button', { name: 'Save view' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('View name'), { target: { value: 'Overdue contacts' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('crm-contact-views:7:9') || '[]')[0]).toMatchObject({ name: 'Overdue contacts', filters: { followup: 'overdue' } }));
    expect(localStorage.getItem('crm-contact-views:7:10')).toBeNull();
  });
  it('keeps every advanced filter visible as a removable chip when collapsed', async () => {
    const user = userEvent.setup(); render(<CRMContactsPage />);
    await screen.findByRole('link', { name: 'Mina Khan' });
    expect(screen.getByLabelText('Priority')).not.toBeVisible();
    const toggle = screen.getByRole('button', { name: 'Advanced filters' });
    toggle.focus(); await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.selectOptions(screen.getByLabelText('Priority'), 'high');
    await user.selectOptions(screen.getByLabelText('Assigned to'), '7');
    await user.selectOptions(screen.getByLabelText('Follow-up'), 'overdue');
    await user.selectOptions(screen.getByLabelText('Sort contacts'), 'name');
    await user.selectOptions(screen.getByLabelText('Sort direction'), 'asc');
    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'customer' } });
    await waitFor(() => expect(mocks.get.mock.calls.some(([path]) => path.includes('tag=customer') && path.includes('priority=high') && path.includes('ownerUserId=7') && path.includes('followup=overdue') && path.includes('sortBy=name') && path.includes('sortOrder=asc'))).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Advanced filters (6)' }));
    expect(screen.getByLabelText('Priority')).not.toBeVisible();
    for (const label of ['priority', 'assigned to', 'follow-up', 'tag', 'sort', 'order']) {
      expect(screen.getByRole('button', { name: `Remove ${label} filter` })).toBeVisible();
    }
    await user.click(screen.getByRole('button', { name: 'Remove priority filter' }));
    expect(screen.getByRole('button', { name: 'Advanced filters (5)' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByLabelText('Priority')).toHaveValue('all');
    expect(screen.getByLabelText('Assigned to')).toHaveValue('7');
  });
  it('loads bounded stage pages and full totals, then requests another page on demand', async () => {
    const user = userEvent.setup(); render(<CRMPipelinePage />);
    const stage = await screen.findByRole('region', { name: 'Not Categorized stage' });
    await within(stage).findByText('Mina Khan');
    expect(mocks.get.mock.calls.filter(([path]) => path.startsWith('/api/crm/contacts?')).every(([path]) => new URL(path, 'https://example.test').searchParams.get('limit') === '20')).toBe(true);
    expect(mocks.get.mock.calls.some(([path]) => path.includes('/api/crm/contacts?') && !new URL(path, 'https://example.test').searchParams.has('pipelineStatus'))).toBe(false);
    expect(mocks.get.mock.calls.filter(([path]) => path.startsWith('/api/crm/contacts?')).map(([path]) => new URL(path, 'https://example.test').searchParams.get('pipelineStatus'))).toEqual(['new']);
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Ongoing stage' })).getByText('No contacts in this stage')).toBeVisible());
    await user.click(within(stage).getByRole('button', { name: 'Load more · 1 of 21' }));
    await within(stage).findByText('Joel Rivera');
    expect(mocks.get.mock.calls.some(([path]) => path.includes('page=2') && path.includes('pipelineStatus=new'))).toBe(true);
  });
  it('replaces a failed stage loader with a working retry while empty stages stay usable', async () => {
    mocks.get.mockImplementation((path: string) => path.startsWith('/api/crm/contacts?') ? Promise.reject(new Error('The request took too long. Please try again.')) : dispatchGet(path));
    render(<CRMPipelinePage />);
    const stage = await screen.findByRole('region', { name: 'Not Categorized stage' });
    expect(await within(stage).findByRole('alert')).toHaveTextContent('too long');
    expect(within(stage).queryByText('Loading contacts…')).not.toBeInTheDocument();
    mocks.get.mockImplementation(dispatchGet);
    fireEvent.click(within(stage).getByRole('button', { name: 'Retry stage' }));
    await within(stage).findByText('Mina Khan');
    expect(within(stage).queryByRole('alert')).not.toBeInTheDocument();
  });
  it('sends explicit all-time and all-platform report overrides instead of reusing saved defaults', async () => {
    const user = userEvent.setup(); render(<CRMReportsPage />);
    await screen.findByText('Current pipeline position');
    await user.selectOptions(screen.getByLabelText('Date range'), 'all');
    fireEvent.click(screen.getByText('Platforms · Email'));
    await user.click(screen.getByRole('checkbox', { name: 'All Platforms' }));
    await user.click(screen.getByRole('button', { name: 'Apply report filters' }));
    await waitFor(() => expect(mocks.get.mock.calls.some(([path]) => path.startsWith('/api/crm/reports?') && path.includes('dateRange=all') && path.includes('platforms=all'))).toBe(true));
  });
  it.each([['Gmail', 'gmail', 55], ['Email', 'email', 3]])('preserves %s report drill-down scope in Contacts and its export query', async (label, channel, expectedTotal) => {
    mocks.get.mockImplementation((path: string) => {
      const url = new URL(path, 'https://example.test');
      if (url.pathname === '/api/crm/configuration') return Promise.resolve({ ...configuration, preferences: { ...configuration.preferences, platform: ['all'] } });
      if (url.pathname === '/api/crm/reports') return Promise.resolve({ data: { ...analytics,
        channels: [{ channel: 'gmail', contacts: 55, conversations: 60, messages: 100, unread: 1 }, { channel: 'email', contacts: 3, conversations: 3, messages: 10, unread: 0 }] } });
      if (url.pathname === '/api/crm/contacts') return Promise.resolve({ contacts: [contact], total: url.searchParams.get('platforms') === 'gmail' ? 55 : url.searchParams.get('platforms') === 'email' ? 3 : 68, totalPages: 1 });
      if (url.pathname === '/api/crm/contacts/export') return Promise.resolve({ csv: 'synthetic csv', filename: 'synthetic.csv', exported: expectedTotal });
      return dispatchGet(path);
    });
    const user = userEvent.setup();
    const report = render(<CRMReportsPage />);
    const link = await screen.findByRole('link', { name: label });
    const href = link.getAttribute('href')!;
    expect(new URL(href, 'https://example.test').searchParams.get('platforms')).toBe(channel);
    report.unmount();
    window.history.replaceState(null, '', href);
    render(<CRMContactsPage />);
    await screen.findByText(`1 of ${expectedTotal} contacts`);
    expect(screen.getByText(new RegExp(`Report contacts .* ${channel} .* 30d`))).toBeVisible();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:fixture') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Export filtered CSV' }));
    await waitFor(() => expect(mocks.get.mock.calls.some(([path]) => path.startsWith('/api/crm/contacts/export?') && new URL(path, 'https://example.test').searchParams.get('platforms') === channel)).toBe(true));
    click.mockRestore();
    for (const mutation of [mocks.post, mocks.put, mocks.patch, mocks.delete]) expect(mutation).not.toHaveBeenCalled();
  });
  it('completes a work reminder with its actual entity ID and reloads the queue', async () => {
    const user = userEvent.setup(); render(<CRMWorkPage />);
    await screen.findByText('Follow up with Mina');
    await user.click(screen.getByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/crm/reminders/8', { status: 'completed' }));
    expect(screen.getByRole('link', { name: 'Open reminder' })).toHaveAttribute('href', '/dashboard/crm/reminders?reminderId=8');
  });
});
