import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useContentCounts, useRefreshContentLibrary } from '@/hooks/use-content-counts';
const mocks = vi.hoisted(() => ({ get: vi.fn(), handlers: new Set<() => void>() }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get } }));
const subscribe = (_event: string, handler: () => void) => { mocks.handlers.add(handler); return () => { mocks.handlers.delete(handler); }; };
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe }) }));
function Counts({ label }: { label: string }) { const query = useContentCounts(42); return <output aria-label={label}>{query.counts.email}</output>; }
function Save() { const refresh = useRefreshContentLibrary(); return <button onClick={refresh}>Confirmed save</button>; }
beforeEach(() => { mocks.get.mockReset(); mocks.handlers.clear(); });
afterEach(cleanup);
describe('one scoped counts cache', () => {
  it('shares a counts-only request and refreshes after a confirmed save without timers', async () => {
    mocks.get.mockResolvedValueOnce({ email_template: 2 }).mockResolvedValue({ email_template: 3 });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Counts label="Chat counts" /><Counts label="Overview counts" /><Save /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByLabelText('Chat counts')).toHaveTextContent('2'));
    expect(screen.getByLabelText('Overview counts')).toHaveTextContent('2');
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith('/api/content/assets/counts?threadId=42');
    fireEvent.click(screen.getByText('Confirmed save'));
    await waitFor(() => expect(screen.getByLabelText('Chat counts')).toHaveTextContent('3'));
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Overview counts')).toHaveTextContent('3');
    client.clear();
  });
});
