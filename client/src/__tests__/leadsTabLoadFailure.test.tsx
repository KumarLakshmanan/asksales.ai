import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LeadsTab from '@/components/tabs/LeadsTab';
import api from '@/lib/api';

vi.mock('@/lib/api', () => ({ default: { get: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: () => () => undefined }) }));

describe('lead list loading failures', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('shows a recoverable error instead of pretending the search returned zero leads', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url === '/api/leads/thread/42') throw new Error('Lead list service unavailable');
      return [] as never;
    });
    render(<LeadsTab threadId={42} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This is a loading error, not an empty search result');
    expect(screen.getByRole('button', { name: 'Retry loading leads' })).toBeInTheDocument();
    expect(screen.queryByText('No Leads Found')).not.toBeInTheDocument();
  });
  it('does not replace the current campaign with an older request result', async () => {
    let finishOld: (value: unknown) => void = () => {};
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/api/leads/thread/42') return new Promise(resolve => { finishOld = resolve; }) as never;
      return Promise.resolve([]) as never;
    });
    const { rerender } = render(<LeadsTab threadId={42} />);
    rerender(<LeadsTab threadId={43} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/leads/thread/43'));
    await act(async () => finishOld([{ id: 991, name: 'Wrong campaign lead', email: 'wrong@company.test', score: 50 }]));
    expect(screen.queryByText('Wrong campaign lead')).not.toBeInTheDocument();
  });
});
