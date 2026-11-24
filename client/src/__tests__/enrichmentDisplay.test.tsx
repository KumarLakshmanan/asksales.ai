import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import EnrichmentPage from '@/app/dashboard/(main)/enrichment/page';

const { run, handlers, toast } = vi.hoisted(() => ({
  handlers: new Map<string, (data: Record<string, unknown>) => void>(), toast: () => {},
  run: { id: 1, userId: 1, leadName: 'Manan Tholia', status: 'completed', billingStatus: null as string | null, createdAt: '2026-09-03T00:00:00Z', phonesFound: 77, emailsFound: 3, websitesFound: 7, steps: [],
    summary: { person: { fullName: 'Manan Tholia' }, phones: ['26.8345538', '75.7789612', '+11038733556', '+911414700658', '9216035407'], emails: ['Hiring@celebaltech.com', 'hiring@celebaltech.com', 'icon@2x.png'], websites: ['http://www.celebaltech.com', 'https://celebaltech.com', 'https://lnkd.in/abc'] } },
}));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: (name: string, handler: (data: Record<string, unknown>) => void) => { handlers.set(name, handler); return () => handlers.delete(name); } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queryKey[0] === 'enrichment-runs' ? [run] : queryKey[0] === 'enrichment-run' ? run : [], isLoading: false }),
}));

describe('historical enrichment display', () => {
  beforeAll(() => { Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() }); });
  afterEach(() => { run.status = 'completed'; run.billingStatus = null; run.createdAt = '2026-09-03T00:00:00Z'; });
  it('associates the handle input with its visible label', () => {
    render(<EnrichmentPage />);
    fireEvent.click(screen.getByRole('button', { name: 'New enrichment' }));
    expect(screen.getByRole('textbox', { name: 'Handle / URL' })).toBeVisible();
  });
  it('names the existing-lead search field', () => {
    render(<EnrichmentPage />);
    fireEvent.click(screen.getByRole('button', { name: 'New enrichment' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'From Lead' }), { button: 0, ctrlKey: false });
    expect(screen.getByRole('searchbox', { name: 'Search leads by name or email' })).toBeVisible();
  });
  it('returns focus to the opener when the enrichment dialog closes with Escape', async () => {
    render(<EnrichmentPage />);
    const opener = screen.getByRole('button', { name: 'New enrichment' });
    opener.focus();fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });
  it('shows that ambiguous outcome credits remain held for review', () => {
    run.status = 'failed';
    run.billingStatus = 'held';
    render(<EnrichmentPage />);
    fireEvent.click(screen.getByRole('button', { name: /Manan Tholia/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('reserved fixed-fee credits are still held');
  });
  it('uses one run-scoped processing indicator and ignores another run completing', async () => {
    run.status = 'running';
    run.createdAt = new Date().toISOString();
    render(<EnrichmentPage />);
    fireEvent.click(screen.getByRole('button', { name: /Manan Tholia/ }));
    expect(screen.getAllByText('Processing...')).toHaveLength(1);
    act(() => handlers.get('events:tool:progress')?.({ toolName: 'deep_enrichment', runId: 2, iteration: 8, identifier: 'wrong-run' }));
    expect(screen.queryByText(/wrong-run/)).not.toBeInTheDocument();
    act(() => handlers.get('events:tool:progress')?.({ toolName: 'deep_enrichment', runId: 1, iteration: 3, total: 4, identifier: 'selected-run' }));
    expect(screen.getByText(/selected-run/)).toBeInTheDocument();
    expect(screen.queryByText('Processing...')).not.toBeInTheDocument();
    act(() => handlers.get('events:tool:completed')?.({ toolName: 'deep_enrichment', runId: 2 }));
    expect(screen.getByText(/selected-run/)).toBeInTheDocument();
    act(() => handlers.get('events:tool:failed')?.({ toolName: 'deep_enrichment', runId: 1 }));
    await waitFor(() => expect(screen.queryByText(/selected-run/)).not.toBeInTheDocument());
    expect(screen.getByText('Enrichment reported a failure. Refreshing saved status…')).toBeInTheDocument();
  });
  it('shows a queued indicator before execution begins', () => {
    run.status = 'pending';
    run.createdAt = new Date().toISOString();
    render(<EnrichmentPage />);
    fireEvent.click(screen.getByRole('button', { name: /Manan Tholia/ }));
    expect(screen.getByText('Queued for enrichment...')).toBeInTheDocument();
  });
  it('warns about stale activity without claiming the worker has failed', () => {
    run.status = 'running';
    run.createdAt = '2020-01-01T00:00:00Z';
    render(<EnrichmentPage />);
    fireEvent.click(screen.getByRole('button', { name: /Manan Tholia/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('does not confirm the worker is still active');
    expect(screen.queryByText('Processing...')).not.toBeInTheDocument();
    expect(screen.getByText('Recorded: Running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh enrichment status' })).toBeInTheDocument();
  });
  it('shows clean candidates, not map coordinates or invented country codes', async () => {
    const { container } = render(<EnrichmentPage />);
    fireEvent.click(screen.getByRole('button', { name: /Manan Tholia/ }));
    expect(container.textContent).not.toContain('26.8345538');
    expect(container.textContent).not.toContain('75.7789612');
    expect(container.textContent).not.toContain('+11038733556');
    expect(container.textContent).not.toContain('+19216035407');
    expect(container.textContent).not.toContain('77');
    expect(container.textContent).not.toContain('icon@2x.png');
    expect(container.textContent).not.toContain('lnkd.in');
    expect(screen.getByText('+911414700658')).toBeInTheDocument();
    expect(screen.getByText('9216035407')).toBeInTheDocument();
    expect(screen.getByText('hiring@celebaltech.com')).toBeInTheDocument();
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    // The shared copy helper only uses the async Clipboard API in a secure context.
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    fireEvent.click(screen.getByRole('button', { name: 'Copy phone 9216035407' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('9216035407'));
    expect(screen.getByText(/not verified personal contact details/)).toBeInTheDocument();
  });
});
