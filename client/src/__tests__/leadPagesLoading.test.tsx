import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import LeadViewPage from '@/app/dashboard/(main)/leads/view/[id]/page';
import LeadEditPage from '@/app/dashboard/(main)/leads/edit/[id]/page';
import { api } from '@/lib/api';
const { route, router, toast } = vi.hoisted(() => ({ route: { id: '1' }, router: { push: vi.fn() }, toast: vi.fn() }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: route.id }), useRouter: () => router }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));

describe('lead detail and edit loading', () => {
  it.each([{}, { city: 'Goa', state: 'Goa', country: 'India' }])('renders structured location %j without crashing', async location => {
    route.id = '2';
    vi.mocked(api.get).mockImplementation((url: string) => Promise.resolve(url === '/api/leads/2'
      ? { id: 2, name: 'Location QA', location, createdAt: '2026-09-07T00:00:00Z', source: 'manual', score: 0 } : []) as never);
    render(<LeadViewPage />);
    expect(await screen.findByRole('heading', { name: 'Location QA' })).toBeInTheDocument();
    expect(screen.getByText('Sent').parentElement).toHaveTextContent('Sent0');
    if ('city' in location) expect(screen.getByText('Goa, India')).toBeInTheDocument();
  });
  it.each([['details', LeadViewPage], ['edit', LeadEditPage]] as const)('ignores a previous lead response on the %s page', async (kind, Page) => {
    route.id = '1';
    let finishOld: (value: unknown) => void = () => {};
    const lead = { id: 2, name: 'Current lead', email: 'current@company.test', source: 'manual', score: 0, createdAt: '2026-09-07T00:00:00Z' };
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/api/leads/1') return new Promise(resolve => { finishOld = resolve; }) as never;
      return Promise.resolve(url === '/api/leads/2' ? lead : []) as never;
    });
    const { rerender, container } = render(<Page />);
    route.id = '2';
    rerender(<Page />);
    if (kind === 'edit') await screen.findByDisplayValue('Current lead');
    else await screen.findByRole('heading', { name: 'Current lead' });
    await act(async () => finishOld({ ...lead, id: 1, name: 'Wrong lead' }));
    expect(container.textContent).not.toContain('Wrong lead');
    expect(screen.queryByDisplayValue('Wrong lead')).not.toBeInTheDocument();
  });
});
