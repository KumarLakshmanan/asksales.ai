import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ContentAllView from '@/components/content-library/ContentAllView';
import api from '@/lib/api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/modals/PublishContentDialog', () => ({ default: () => null }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => undefined }) }));
vi.mock('@/lib/api', () => ({ default: { get: vi.fn() } }));
afterEach(cleanup);

describe('campaign content overview', () => {
  it('updates saved counts after refresh and keeps all nine libraries actionable', () => {
    const select = vi.fn();
    const { rerender } = render(<ContentAllView mode="overview" contentCounts={{ ad_copy: 1, all: 1 }} onTabChange={select} />);
    expect(screen.getAllByRole('button')).toHaveLength(9);
    expect(screen.getByRole('button', { name: /Ad Copy/ })).toHaveTextContent('1 saved');
    rerender(<ContentAllView mode="overview" contentCounts={{ ad_copy: 3, all: 3 }} onTabChange={select} />);
    const adTab = screen.getByRole('button', { name: /Ad Copy/ });
    expect(adTab).toHaveTextContent('3 saved');
    fireEvent.click(adTab);
    expect(select).toHaveBeenCalledWith('ad_copy');
  });

  it('does not present pending counts as an empty library', () => {
    const { rerender } = render(<ContentAllView mode="overview" loadingCounts contentCounts={{}} />);
    expect(screen.getByRole('status', { name: 'Loading content library' })).toBeInTheDocument();
    rerender(<ContentAllView mode="overview" loadingCounts={false} contentCounts={{ image: 0 }} />);
    expect(screen.getByRole('button', { name: /Images/ })).toHaveTextContent('0 saved');
    expect(screen.getByRole('button', { name: /Videos/ })).toHaveTextContent('— saved');
  });

  it('keeps libraries available when counts fail and offers a retry', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ad_copy: 2 });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ContentAllView mode="overview" /></QueryClientProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.getByRole('button', { name: /Ad Copy/ })).toHaveTextContent('— saved');
    fireEvent.click(screen.getByRole('button', { name: 'Retry counts' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Ad Copy/ })).toHaveTextContent('2 saved'));
  });
});
