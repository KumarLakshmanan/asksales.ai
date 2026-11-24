import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AssistantResourceSelection } from '@/components/outreach/assistants/AssistantResourceSelection';
import { AssistantEditorStepper } from '@/components/outreach/assistants/AssistantEditorStepper';
import { setupCatalog } from './fixtures/assistantSetupCatalog';
import type { AssistantSelection } from '@/lib/outreach-assistants';
import api from '@/lib/api';

const mocks = vi.hoisted(() => ({ workspace: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: vi.fn() } }));
vi.mock('@/hooks/use-outreach-assistants', () => ({ ASSISTANT_API: '/api/settings/outreach/assistants', useAssistantWorkspace: mocks.workspace }));
const sources = [{ id: 1, name: 'Guest guide', channels: ['whatsapp'], preview: 'Published guest information.' }, { id: 2, name: 'Dining menu', channels: ['whatsapp'], preview: 'Restaurant hours.' }];
function Harness() {
  const [value, setValue] = useState<AssistantSelection>({ mode: 'selected', ids: [1] });
  return <><p data-testid="saved-selection">{value.ids.join(',')}</p><AssistantResourceSelection label="Knowledge sources" category="knowledge" resources={sources} value={value} onChange={setValue} /></>;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>) };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspace.mockReturnValue({ profileId: 5, scopeKey: ['outreach-assistants', 7, 5], requestOptions: { headers: { 'X-Business-Profile-Id': '5' } }, catalog: { data: { ...setupCatalog, knowledge: sources } } });
  vi.mocked(api.get).mockImplementation(async (_path, options) => {
    const page = Number(options?.params?.page || 1);
    const search = String(options?.params?.search || '');
    const items = sources.filter(item => !search || item.name.toLowerCase().includes(search.toLowerCase()));
    return { items: items.slice(page - 1, page).map(item => ({ ...item, id: String(item.id) })), total: items.length, page, pageSize: 1, hasMore: page < items.length };
  });
});
afterEach(cleanup);
describe('assistant resource drawers', () => {
  it('loads only on opening with the active profile and cancels staged changes', async () => {
    mount(); expect(api.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Change selection' }));
    const drawer = await screen.findByRole('dialog', { name: 'Knowledge sources' });
    expect(await within(drawer).findByRole('checkbox', { name: /Guest guide/ })).toBeChecked();
    expect(api.get).toHaveBeenCalledWith('/api/settings/outreach/assistants/resources/knowledge', expect.objectContaining({ headers: { 'X-Business-Profile-Id': '5' }, signal: expect.any(AbortSignal) }));
    fireEvent.click(within(drawer).getByRole('checkbox', { name: /Guest guide/ }));
    expect(screen.getByTestId('saved-selection')).toHaveTextContent('1');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('saved-selection')).toHaveTextContent('1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('retains selections across AJAX pages and search and applies once', async () => {
    const { client } = mount();
    client.setQueryData(['outreach-assistants', 7, 5, 'catalog'], { ...setupCatalog, knowledge: [{ ...sources[0], name: 'Outdated guide' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Change selection' }));
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByRole('checkbox', { name: /Guest guide/ });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Next page' }));
    fireEvent.click(await within(drawer).findByRole('checkbox', { name: /Dining menu/ }));
    fireEvent.change(within(drawer).getByRole('searchbox', { name: 'Search knowledge sources' }), { target: { value: 'guest' } });
    expect(await within(drawer).findByRole('checkbox', { name: /Guest guide/ })).toBeChecked();
    expect(within(drawer).getByText(/2 selected/)).toBeVisible();
    expect(screen.getByTestId('saved-selection')).toHaveTextContent('1');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Apply selection (2)' }));
    expect(screen.getByTestId('saved-selection')).toHaveTextContent('1,2');
    expect(client.getQueryData<{ knowledge: { id: number }[] }>(['outreach-assistants', 7, 5, 'catalog'])?.knowledge.map(item => item.id)).toEqual([1, 2]);
    expect(client.getQueryData<{ knowledge: { name: string }[] }>(['outreach-assistants', 7, 5, 'catalog'])?.knowledge[0].name).toBe('Guest guide');
  });
  it('keeps saved choices when loading fails and retries without clearing the selection', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Change selection' }));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent('Your selection is retained');
    expect(within(drawer).getByRole('button', { name: 'Apply selection (1)' })).toBeDisabled();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Try again' }));
    expect(await within(drawer).findByRole('checkbox', { name: /Guest guide/ })).toBeChecked();
    expect(screen.getByTestId('saved-selection')).toHaveTextContent('1');
  });
  it('does not replace the current search with a late result from an earlier request', async () => {
    let resolveOld!: (value: unknown) => void;
    vi.mocked(api.get).mockImplementation(async (_path, options) => {
      if (!options?.params?.search) return new Promise(done => { resolveOld = done; });
      return { items: [{ ...sources[1], id: '2' }], total: 1, page: 1, pageSize: 20, hasMore: false };
    });
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Change selection' }));
    const drawer = await screen.findByRole('dialog');
    fireEvent.change(within(drawer).getByRole('searchbox', { name: 'Search knowledge sources' }), { target: { value: 'dining' } });
    await within(drawer).findByRole('checkbox', { name: /Dining menu/ });
    resolveOld({ items: [{ ...sources[0], id: '1' }], total: 1, page: 1, pageSize: 20, hasMore: false });
    await waitFor(() => expect(within(drawer).queryByRole('checkbox', { name: /Guest guide/ })).not.toBeInTheDocument());
    expect(within(drawer).getByRole('checkbox', { name: /Dining menu/ })).toBeVisible();
  });
  it('presents numbered editor steps with the current step announced', () => {
    const navigate = vi.fn();
    render(<AssistantEditorStepper current="knowledge" onChange={navigate} steps={[{ tab: 'basic', label: 'Identity', issues: [] }, { tab: 'knowledge', label: 'Knowledge', issues: ['Choose resources'] }]} />);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Step 2: Knowledge' })).toHaveAttribute('aria-current', 'step');
    fireEvent.click(screen.getByRole('button', { name: 'Step 1: Identity' }));
    expect(navigate).toHaveBeenCalledWith('basic');
  });
});
