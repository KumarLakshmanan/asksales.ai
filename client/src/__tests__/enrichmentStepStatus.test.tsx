import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EnrichmentPage from '@/app/dashboard/(main)/enrichment/page';
import { historyRun, historySteps } from './fixtures/enrichmentHistory';

const state = vi.hoisted(() => ({ status: 'completed', createdAt: new Date().toISOString(), durationOverride: undefined as number | undefined }));
const subscribe = () => () => {};
const toast = () => {};
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    const run = historyRun(state.status, 901, state.createdAt);
    if (state.durationOverride !== undefined) run.steps = run.steps.map(step => ({ ...step, durationMs: state.durationOverride! }));
    return { data: queryKey[0] === 'enrichment-runs' ? [run] : run, isLoading: false };
  },
}));

function openHistory() {
  const rendered = render(<EnrichmentPage />);
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`Synthetic ${state.status} history`) }));
  return [...rendered.container.querySelectorAll('[class~="max-w-[85%]"]')];
}

afterEach(() => {
  state.status = 'completed';
  state.createdAt = new Date().toISOString();
  state.durationOverride = undefined;
});

describe('recorded enrichment step status and elapsed time', () => {
  it.each(['completed', 'running', 'pending'])('keeps step text and icons authoritative in a %s run across null, zero, positive and absent durations', status => {
    state.status = status;
    const bubbles = openHistory();
    expect(bubbles).toHaveLength(historySteps.length);
    historySteps.forEach((step, index) => {
      const row = bubbles[index].querySelector('div.text-xs.text-muted-foreground') as HTMLElement;
      expect(within(row).getByText(step.status, { exact: true })).toBeInTheDocument();
      expect(row.textContent).not.toContain(step.status === 'pending' ? 'running' : 'pending');
      const elapsed = within(row).queryByText('Elapsed time:', { exact: true });
      if (step.durationMs == null) {
        expect(elapsed).not.toBeInTheDocument();
      } else {
        expect(elapsed?.parentElement).toHaveTextContent(step.durationMs === 0 ? 'Elapsed time: 0s' : 'Elapsed time: 1s');
      }
      const icon = row.querySelector('svg');
      const iconClass = { completed: 'lucide-circle-check', failed: 'lucide-circle-x', running: 'lucide-loader-circle', pending: null }[step.status];
      if (iconClass) {
        expect(icon).toHaveClass(iconClass);
        expect(icon).toHaveAttribute('aria-hidden', 'true');
      } else expect(icon).toBeNull();
    });
    if (status === 'completed') {
      expect(screen.getByText('Completed', { exact: true })).toBeInTheDocument();
      expect(screen.getByText('Enrichment complete', { exact: true })).toBeInTheDocument();
    } else {
      expect(screen.getByText(status === 'running' ? 'Processing...' : 'Queued for enrichment...')).toBeInTheDocument();
      expect(screen.queryByText('Enrichment complete', { exact: true })).not.toBeInTheDocument();
    }
  });

  it('preserves minute formatting independently of every recorded step state', () => {
    state.durationOverride = 61500;
    for (const bubble of openHistory()) expect(bubble.querySelector('div.text-xs.text-muted-foreground')).toHaveTextContent('Elapsed time: 1m 2s');
  });

  it('retains stale-running semantics without a spinner or an invented failed state', () => {
    state.status = 'running';
    state.createdAt = '2020-01-01T00:00:00Z';
    const bubbles = openHistory();
    expect(screen.getByText('Recorded: Running')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('does not confirm the worker is still active');
    for (const bubble of bubbles.filter((_, index) => historySteps[index].status === 'running')) {
      expect(within(bubble as HTMLElement).getByText('running', { exact: true })).toBeInTheDocument();
      expect(bubble.querySelector('.animate-spin')).toBeNull();
    }
  });
});
