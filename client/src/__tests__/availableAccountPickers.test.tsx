import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render as testingRender, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailSenderPicker } from '@/components/outreach/EmailSenderPicker';
import { SendOutreachWidget } from '@/components/widgets/SendOutreachWidget';
import type { WidgetState } from '@/components/widgets/types';
import api from '@/lib/api';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => '/dashboard/conversations/42', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-outreach-draft-scope', () => ({ useOutreachDraftScope: () => '4101:4102' }));
vi.mock('@/components/outreach/TemplateSelector', () => ({ TemplateSelector: () => null }));

vi.mock('@/lib/api', () => {
  const api = { get: vi.fn(), post: vi.fn(), put: vi.fn() };
  return { default: api, api };
});
const widget: WidgetState = { id: 41, threadId: 42, messageId: 1, widgetType: 'send_outreach', toolName: 'send_outreach', status: 'active', agentType: null,
  formValues: { channel: 'facebook', provider_account_id: 'old-page' }, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
const current = { id: 'current-page', providerAccountId: 'current-page', label: 'Current page', ready: true };
beforeEach(() => {
  vi.resetAllMocks(); vi.mocked(api.post).mockResolvedValue({});
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe('available email senders', () => {
  it('ignores disconnected and unverified defaults and selects the connected sender', async () => {
    const sender = { id: 1, type: 'gmail', email: 'current@example.test', label: 'Current sender', isDefault: false, isVerified: true, connectionActive: true };
    vi.mocked(api.get).mockResolvedValue({ senders: [
      { ...sender, id: 2, email: 'old@example.test', isDefault: true, connectionActive: false },
      { ...sender, id: 3, email: 'unverified@example.test', isVerified: false },
      { ...sender, id: 4, type: 'resend', email: 'old@resend.test', connectionActive: false }, sender,
    ] });
    const onChange = vi.fn(); const onLoad = vi.fn();
    render(<EmailSenderPicker value={2} onChange={onChange} onLoad={onLoad} />);
    await screen.findByText('From: current@example.test');
    expect(api.get).toHaveBeenCalledWith('/api/email-senders?availableOnly=true');
    expect(screen.queryByText('old@example.test')).not.toBeInTheDocument();
    expect(screen.queryByText('unverified@example.test')).not.toBeInTheDocument();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(1, sender));
    expect(onLoad).toHaveBeenCalledWith(sender);
  });
  it('reports no current sender when all saved records are disconnected', async () => {
    vi.mocked(api.get).mockResolvedValue({ senders: [{ id: 2, type: 'gmail', email: 'old@example.test', isDefault: true, isVerified: true, connectionActive: false }] });
    const onLoad = vi.fn(); const onChange = vi.fn();
    render(<EmailSenderPicker onChange={onChange} onLoad={onLoad} />);
    await waitFor(() => expect(onLoad).toHaveBeenCalledWith(null));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText('old@example.test')).not.toBeInTheDocument();
  });
  it('keeps an existing thread identity locked without syncing or selecting a different account', () => {
    const onChange = vi.fn();
    render(<EmailSenderPicker lockedSender={{ email: 'historical@example.test', type: 'gmail' }} onChange={onChange} />);
    expect(screen.getByText('historical@example.test')).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled();
  });
});

describe('current outreach widget accounts', () => {
  it('uses provider-available options, clears a disconnected saved selection, and marks assistant setup separately', async () => {
    vi.mocked(api.get).mockImplementation(async path => String(path).includes('/compose/options')
      ? { channel: 'facebook', accounts: [current, { ...current, id: 'setup-page', providerAccountId: 'setup-page', label: 'Setup page', ready: false }] }
      : String(path).includes('/compose/recipients') ? { recipients: [], nextCursor: null } : []);
    const onFormChange = vi.fn();
    render(<SendOutreachWidget widget={widget} onFormChange={onFormChange} onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(onFormChange).toHaveBeenCalledWith(expect.not.objectContaining({ provider_account_id: 'old-page' }));
    const choice = await screen.findByRole('combobox', { name: 'Send from' });
    await within(choice).findByRole('option', { name: 'Current page' });
    expect(api.get).toHaveBeenCalledWith('/api/outreach-conversations/compose/options?channel=facebook');
    expect(within(choice).getByRole('option', { name: /Setup page/ })).toHaveTextContent('Needs attention');
    expect(choice).toHaveValue('current-page');
    await waitFor(() => expect(onFormChange).toHaveBeenLastCalledWith(expect.not.objectContaining({ provider_account_id: 'old-page' })));
    fireEvent.change(choice, { target: { value: 'current-page' } });
    expect(onFormChange).toHaveBeenLastCalledWith(expect.objectContaining({ composerDraft: expect.objectContaining({ accountId: 'current-page' }), _review_validation_error: expect.any(String) }));
  });
  it('drops the previous channel selection and ignores its late inventory response', async () => {
    let resolveFacebook!: (value: unknown) => void;
    vi.mocked(api.get).mockImplementation(path => String(path).includes('/compose/options') && String(path).endsWith('channel=facebook')
      ? new Promise(resolve => { resolveFacebook = resolve; })
      : Promise.resolve(String(path).includes('/compose/options') ? { channel: 'instagram', accounts: [{ ...current, id: 'instagram-account', providerAccountId: 'instagram-account', label: 'Current Instagram' }] } : String(path).includes('/compose/recipients') ? { recipients: [], nextCursor: null } : []));
    const onFormChange = vi.fn();
    render(<SendOutreachWidget widget={widget} onFormChange={onFormChange} onClose={vi.fn()} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Instagram$/ }));
    expect(onFormChange).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'instagram' }));
    expect(onFormChange).toHaveBeenLastCalledWith(expect.not.objectContaining({ provider_account_id: 'old-page' }));
    await screen.findByRole('option', { name: 'Current Instagram' });
    await act(async () => resolveFacebook({ channel: 'facebook', accounts: [current] }));
    expect(screen.queryByRole('option', { name: 'Current page' })).not.toBeInTheDocument();
  });
});

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return testingRender(ui, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}

vi.mock('@/components/outreach/EmailDesignPicker', () => ({ EmailDesignPicker: () => null }));
