import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DmPage from '@/app/dashboard/(main)/saved-templates/dm/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), push: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/components/content-studio/useDmOutreach', () => ({ useDmOutreach: () => ({ openOutreach: vi.fn(), destinationDialog: null }) }));
vi.mock('@/components/ui/masonry-grid', () => ({ MasonryGrid: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const template = { id: 2401, name: 'Alpha launch guide', type: 'social_message', content: 'A fictional launch article.', isPredefined: false, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
const predefined = { ...template, id: 2402, name: 'Beta reusable guide', isPredefined: true };
const asset = { id: 2403, title: 'Gamma saved draft', type: 'social_dm', channel: 'instagram', content: 'A fictional saved draft.', status: 'draft', createdAt: '2026-10-01T00:00:00Z' };
let templates: typeof template[];
let assets: typeof asset[];
let failTemplates: boolean;
let failAssets: boolean;
let client: QueryClient;

function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><DmPage /></QueryClientProvider>);
}

function getSearch() { return screen.getByRole('textbox', { name: 'Search DM templates' }); }
function searchFor(value: string) { fireEvent.change(getSearch(), { target: { value } }); }

describe('AS024 dashboard Social DM list states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    templates = [template, predefined];
    assets = [asset];
    failTemplates = false;
    failAssets = false;
    mocks.get.mockImplementation(async (path: string) => {
      const url = new URL(path, 'http://fixture.test');
      if (url.pathname === '/api/content/templates') {
        if (failTemplates) throw new Error('Synthetic templates unavailable');
        const query = (url.searchParams.get('search') || '').toLowerCase();
        const matching = templates.filter(item => `${item.name} ${item.content}`.toLowerCase().includes(query));
        return { templates: matching, total: matching.length };
      }
      if (url.pathname === '/api/content/assets') {
        if (failAssets) throw new Error('Synthetic drafts unavailable');
        return assets;
      }
      return [];
    });
  });

  afterEach(() => {
    cleanup();
    client.clear();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('keeps true-empty create actions routed to the existing generator', async () => {
    templates = [];
    assets = [];
    mount();
    expect(await screen.findByRole('heading', { name: 'No DM templates yet' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create Template' }));
    fireEvent.click(screen.getByRole('button', { name: 'New Template' }));
    expect(mocks.push.mock.calls).toEqual([
      ['/dashboard/saved-templates/dm/generate'], ['/dashboard/saved-templates/dm/generate'],
    ]);
  });

  it.each(['templates', 'assets', 'both'] as const)('recovers zero matches from %s without changing card permissions', async source => {
    if (source === 'templates') assets = [];
    if (source === 'assets') templates = [];
    mount();
    const name = source === 'assets' ? asset.title : template.name;
    expect(await screen.findByText(name, { exact: true })).toBeVisible();
    searchFor('unmatched');
    expect(await screen.findByRole('heading', { name: 'No matching DM templates' })).toBeVisible();
    expect(screen.queryByText('No DM templates yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create Template' })).not.toBeInTheDocument();
    expect(getSearch()).toHaveValue('unmatched');
    const user = userEvent.setup();
    getSearch().focus();
    for (let i = 0; i < 5; i++) await user.tab();
    expect(screen.getByRole('button', { name: 'Clear search' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(getSearch()).toHaveValue('');
    expect(getSearch()).toHaveFocus();
    expect(await screen.findByText(name, { exact: true })).toBeVisible();
    if (source !== 'assets') {
      expect(screen.getByRole('button', { name: 'Edit Alpha launch guide' })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Edit Beta reusable guide' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Delete Beta reusable guide' })).not.toBeInTheDocument();
    }
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('normalizes whitespace consistently with server search and manual keyboard clearing', async () => {
    mount();
    await screen.findByText(template.name, { exact: true });
    searchFor('   ');
    expect(screen.getByText(template.name, { exact: true })).toBeVisible();
    expect(screen.getByText(asset.title, { exact: true })).toBeVisible();
    searchFor('  GAMMA  ');
    expect(await screen.findByText(asset.title, { exact: true })).toBeVisible();
    await waitFor(() => expect(screen.queryByText(template.name, { exact: true })).not.toBeInTheDocument());
    expect(screen.queryByText('No matching DM templates')).not.toBeInTheDocument();
    searchFor('unmatched');
    await screen.findByRole('button', { name: 'Clear search' });
    const user = userEvent.setup();
    getSearch().focus();
    await user.keyboard('{Control>}a{/Control}{Backspace}');
    expect(getSearch()).toHaveValue('');
    expect(getSearch()).toHaveFocus();
    expect(await screen.findByText(template.name, { exact: true })).toBeVisible();
  });

  it('offers search recovery in an empty collection, then returns to its create state', async () => {
    templates = [];
    assets = [];
    mount();
    await screen.findByText('No DM templates yet');
    searchFor('unmatched');
    await screen.findByRole('heading', { name: 'No matching DM templates' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('No DM templates yet')).toBeVisible();
  });

  it('announces initial loading until both sources resolve instead of claiming an empty collection', async () => {
    const releases: (() => void)[] = [];
    mocks.get.mockImplementation((path: string) => new Promise(resolve => {
      releases.push(() => resolve(path.includes('/templates') ? { templates: [], total: 0 } : []));
    }));
    templates = [];
    assets = [];
    mount();
    expect(screen.getByRole('status')).toHaveTextContent('Loading DM templates…');
    expect(screen.queryByText('No DM templates yet')).not.toBeInTheDocument();
    expect(releases).toHaveLength(2);
    await act(async () => { releases[0](); });
    expect(screen.getByRole('status')).toHaveTextContent('Loading DM templates…');
    await act(async () => { releases[1](); });
    expect(await screen.findByText('No DM templates yet')).toBeVisible();
  });

  it('waits through the debounce and requested template search before showing no matches', async () => {
    mount();
    await screen.findByText(template.name, { exact: true });
    const originalGet = mocks.get.getMockImplementation()!;
    let release!: (value: unknown) => void;
    mocks.get.mockImplementation((path: string) => path.includes('search=unmatched')
      ? new Promise(resolve => { release = resolve; }) : originalGet(path));
    searchFor('unmatched');
    expect(screen.getByRole('status')).toHaveTextContent('Loading DM templates…');
    await waitFor(() => expect(release).toBeDefined());
    expect(screen.queryByText('No matching DM templates')).not.toBeInTheDocument();
    await act(async () => { release({ templates: [], total: 0 }); });
    expect(await screen.findByText('No matching DM templates')).toBeVisible();
  });

  it('preserves the filter and reusable-template editor while resolving partial errors', async () => {
    failAssets = true;
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Saved drafts could not be loaded');
    expect(screen.getByText(template.name, { exact: true })).toBeVisible();
    searchFor('unmatched');
    expect(await screen.findByRole('alert')).toHaveTextContent('DM templates could not be loaded');
    expect(screen.queryByText('No DM templates yet')).not.toBeInTheDocument();
    expect(screen.queryByText('No matching DM templates')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Build reusable template' }));
    expect(screen.getByRole('dialog', { name: 'Create DM Template' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(getSearch()).toHaveValue('unmatched');
    failAssets = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No matching DM templates')).toBeVisible();
    expect(getSearch()).toHaveValue('unmatched');
  });

  it('reports complete load failures and retries to true empty without creation or generation', async () => {
    failAssets = true;
    failTemplates = true;
    templates = [];
    assets = [];
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('DM templates could not be loaded');
    expect(screen.queryByText('No DM templates yet')).not.toBeInTheDocument();
    failAssets = false;
    failTemplates = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No DM templates yet')).toBeVisible();
  });
});
