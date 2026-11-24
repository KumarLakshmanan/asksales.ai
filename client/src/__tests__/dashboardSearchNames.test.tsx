import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnrichmentPage from '@/app/dashboard/(main)/enrichment/page';
import ChatsPage from '@/app/dashboard/(main)/chats/page';
import { RoomTypesTab } from '@/app/dashboard/(main)/hotel/components/RoomTypesTab';
import { BookingsTab } from '@/app/dashboard/(main)/hotel/components/BookingsTab';
import { searchBookings, searchCampaigns, searchNoMatch, searchRoomTypes, searchRuns } from './fixtures/as017Searches';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), refresh: vi.fn(),
  toast: vi.fn(), subscribe: () => () => {}, push: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: mocks, default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: mocks.subscribe }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-business-profiles', () => ({
  businessProfileName: () => 'Regression Business',
  useBusinessProfiles: () => ({ activeProfile: { id: 4102 }, isLoading: false, isError: false }),
}));
vi.mock('@/contexts/PreferencesContext', () => ({ usePreferences: () => ({
  preferences: { locale: 'en-US', currency: 'USD', timezone: 'UTC' },
  formatCurrency: (amount: number) => `$${amount}`,
}) }));

let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.get.mockImplementation(async (endpoint: string) => {
    const url = new URL(endpoint, 'http://local.test');
    if (url.pathname === '/api/enrichments') return searchRuns;
    if (url.pathname === '/api/chat/threads') {
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      return { threads: searchCampaigns.slice(offset, offset + limit), total: searchCampaigns.length, limit, offset };
    }
    throw new Error(`Unexpected read: ${endpoint}`);
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.put).not.toHaveBeenCalled();
  expect(mocks.delete).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
});

function searchInput(name: string, placeholder: string) {
  // Shared SearchInput renders type="search" (role "searchbox"); unmigrated fields are plain textboxes.
  const input = screen.queryByRole('searchbox', { name }) ?? screen.getByRole('textbox', { name });
  expect(input).toHaveAccessibleName(name);
  expect(input).toHaveAttribute('placeholder', placeholder);
  return input;
}

describe('AS017 stable dashboard search names', () => {
  it('keeps enrichment names and each status population through searching and clearing', async () => {
    render(<QueryClientProvider client={client}><EnrichmentPage /></QueryClientProvider>);
    await screen.findByText(searchRuns[0].leadName);
    const name = 'Search enrichment runs';
    const input = searchInput(name, 'Search enrichments...');
    for (const status of ['all', 'completed', 'running', 'failed']) {
      const population = searchRuns.filter(run => status === 'all' || (status === 'running' ? ['running', 'pending'].includes(run.status) : run.status === status));
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${status} ${population.length}$`, 'i') }));
      for (const run of searchRuns) expect(Boolean(screen.queryByText(run.leadName))).toBe(population.includes(run));
      fireEvent.change(input, { target: { value: population[0].leadEmail } });
      expect(screen.getByText(population[0].leadName)).toBeInTheDocument();
      expect(searchInput(name, 'Search enrichments...')).toHaveValue(population[0].leadEmail);
      fireEvent.change(input, { target: { value: searchNoMatch } });
      expect(screen.getByText('No results match your search')).toBeInTheDocument();
      expect(searchInput(name, 'Search enrichments...')).toHaveValue(searchNoMatch);
      fireEvent.change(input, { target: { value: '' } });
      expect(searchInput(name, 'Search enrichments...')).toHaveValue('');
      for (const run of searchRuns) expect(Boolean(screen.queryByText(run.leadName))).toBe(population.includes(run));
    }
    expect(mocks.get.mock.calls.every(([endpoint]) => endpoint === '/api/enrichments?limit=100')).toBe(true);
  });

  it('labels campaign filtering with its current-page scope and preserves that scope after pagination', async () => {
    render(<ChatsPage />);
    await screen.findByText(searchCampaigns[0].title);
    const name = 'Filter campaigns on this page';
    let input = searchInput(name, 'Filter this page by campaign title...');
    const firstPage = searchCampaigns.slice(0, 10);
    fireEvent.change(input, { target: { value: searchCampaigns[10].title } });
    expect(screen.getByText('No matches on this page')).toBeInTheDocument();
    expect(screen.getByText('Clear the filter or check another page.')).toBeInTheDocument();
    expect(screen.queryByText('No campaigns found')).not.toBeInTheDocument();
    expect(searchInput(name, 'Filter this page by campaign title...')).toHaveValue(searchCampaigns[10].title);
    fireEvent.change(input, { target: { value: '' } });
    for (const campaign of firstPage) expect(screen.getByText(campaign.title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText(searchCampaigns[10].title);
    input = searchInput(name, 'Filter this page by campaign title...');
    fireEvent.change(input, { target: { value: searchCampaigns[4].title } });
    expect(screen.getByText('No matches on this page')).toBeInTheDocument();
    expect(screen.getByText('Clear the filter or check another page.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
    expect(searchInput(name, 'Filter this page by campaign title...')).toHaveValue(searchCampaigns[4].title);
    fireEvent.change(input, { target: { value: '' } });
    expect(searchInput(name, 'Filter this page by campaign title...')).toHaveValue('');
    for (const campaign of searchCampaigns) expect(Boolean(screen.queryByText(campaign.title))).toBe(!firstPage.includes(campaign));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(mocks.get.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      '/api/chat/threads?limit=10&offset=0&businessProfileId=4102',
      '/api/chat/threads?limit=10&offset=10&businessProfileId=4102',
    ]);
  });

  it('does not suggest another campaign page when there is only one', async () => {
    mocks.get.mockResolvedValue({ threads: [searchCampaigns[0]], total: 1, limit: 10, offset: 0 });
    render(<ChatsPage />);
    await screen.findByText(searchCampaigns[0].title);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter campaigns on this page' }), { target: { value: searchNoMatch } });
    expect(screen.getByText('No matches on this page')).toBeInTheDocument();
    expect(screen.getByText('Clear the filter or try a different search term.')).toBeInTheDocument();
    expect(screen.queryByText('Clear the filter or check another page.')).not.toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('retains the genuine empty campaign-history state without a filter', async () => {
    mocks.get.mockResolvedValue({ threads: [], total: 0, limit: 10, offset: 0 });
    render(<ChatsPage />);
    expect(await screen.findByText('No campaigns found')).toBeInTheDocument();
    expect(screen.getByText('Start a new campaign to get started')).toBeInTheDocument();
    expect(screen.queryByText('No matches on this page')).not.toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it('names the Room Types search and restores its own population', () => {
    render(<RoomTypesTab roomTypes={searchRoomTypes} currency="USD" onRefresh={mocks.refresh} />);
    const name = 'Search room types';
    const input = searchInput(name, 'Search room types...');
    fireEvent.change(input, { target: { value: 'suite' } });
    expect(screen.getByText(searchRoomTypes[1].name)).toBeInTheDocument();
    expect(screen.queryByText(searchRoomTypes[0].name)).not.toBeInTheDocument();
    expect(searchInput(name, 'Search room types...')).toHaveValue('suite');
    fireEvent.change(input, { target: { value: searchNoMatch } });
    expect(screen.getByText('No room types found')).toBeInTheDocument();
    expect(searchInput(name, 'Search room types...')).toHaveValue(searchNoMatch);
    fireEvent.change(input, { target: { value: '' } });
    expect(searchInput(name, 'Search room types...')).toHaveValue('');
    expect(screen.getByText(`Select all (${searchRoomTypes.length})`)).toBeInTheDocument();
    for (const room of searchRoomTypes) expect(screen.getByText(room.name)).toBeInTheDocument();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('retains the existing Hotel Bookings search name independently of value', () => {
    render(<BookingsTab bookings={searchBookings} timezone="UTC" onRefresh={mocks.refresh} />);
    const input = screen.getByRole('searchbox', { name: 'Search bookings' });
    for (const value of [searchNoMatch, '']) {
      fireEvent.change(input, { target: { value } });
      expect(screen.getByRole('searchbox', { name: 'Search bookings' })).toHaveAccessibleName('Search bookings');
    }
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
