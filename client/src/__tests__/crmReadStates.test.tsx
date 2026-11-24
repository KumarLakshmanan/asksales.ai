import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CRMPipelinePage from '@/app/dashboard/(main)/crm/pipeline/page';
import CRMReportsPage from '@/app/dashboard/(main)/crm/reports/page';
import CRMWorkPage from '@/app/dashboard/(main)/crm/work/page';
import { DEFAULT_CRM_CONFIGURATION } from '@/lib/crm-configuration';

// Read states for the CRM board, reports and My work: a failed or slow read
// must end in a visible message with Try again, never a blank page.

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn(), push: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks, default: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 7, businessProfileId: 9 } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/hooks/use-crm-automation-refresh', () => ({ useCrmAutomationRefresh: () => {} }));
vi.mock('@/components/crm/CreateConversationDialog', () => ({ CreateConversationDialog: () => null }));
vi.mock('@/components/crm/ContactReminders', () => ({ ContactReminderDialog: () => null }));

const stages = DEFAULT_CRM_CONFIGURATION.stages.filter(stage => ['new', 'contacted', 'won', 'lost'].includes(stage.key));
const configuration = { stages, preferences: { ...DEFAULT_CRM_CONFIGURATION.preferences, platform: ['email'] } };
const analytics = {
  stages: stages.map(stage => ({ ...stage, count: stage.key === 'new' ? 21 : 0, stuckCount: 0, dealValueByCurrency: {} })),
  totalContacts: 21, wonCount: 0, lostCount: 0, flows: [], stuckContacts: 0, winRate: 0, totalPipelineValue: '0', totalPipelineValueByCurrency: {},
  channels: [], stageDurations: [], preferences: configuration.preferences, filters: { platforms: ['email'], dateRange: '30d' },
};

function baseGet(path: string): Promise<unknown> | undefined {
  const url = new URL(path, 'https://example.test');
  if (url.pathname === '/api/crm/configuration') return Promise.resolve(configuration);
  if (url.pathname === '/api/crm/assignees') return Promise.resolve({ data: [] });
  if (url.pathname === '/api/crm/pipeline/analytics') return Promise.resolve(analytics);
  return undefined;
}

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
  window.history.replaceState(null, '', '/dashboard/crm/reports');
  mocks.put.mockResolvedValue({});
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('CRM read states', () => {
  it('reports end a failed load with a visible error and a working Try again', async () => {
    const user = userEvent.setup();
    let reportCalls = 0;
    mocks.get.mockImplementation((path: string) => {
      const url = new URL(path, 'https://example.test');
      if (url.pathname === '/api/crm/reports') {
        reportCalls += 1;
        return reportCalls === 1 ? Promise.reject(new Error('This took too long to load, so it was stopped. Try again in a few seconds.')) : Promise.resolve({ data: analytics });
      }
      return baseGet(path) ?? Promise.reject(new Error(`Unexpected ${path}`));
    });
    render(<CRMReportsPage />);
    expect(await screen.findByText('CRM reports could not be loaded')).toBeVisible();
    expect(screen.getByText(/took too long to load/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('Current pipeline position')).toBeVisible());
    // The report request has a client deadline shorter than the page's patience.
    const reportCall = mocks.get.mock.calls.find(([path]) => String(path).startsWith('/api/crm/reports'));
    expect(reportCall?.[1]).toMatchObject({ timeoutMs: 20_000, retryTransient: false });
  });

  it('my work shows labelled counts while loading, then an error with Try again', async () => {
    const user = userEvent.setup();
    let workCalls = 0;
    mocks.get.mockImplementation((path: string) => {
      const url = new URL(path, 'https://example.test');
      if (url.pathname === '/api/crm/work') {
        workCalls += 1;
        return workCalls === 1 ? new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Work queue timed out.')), 30)) : Promise.resolve({ items: [], counts: { reminder: 0, conversation: 0, stuck_contact: 0, ticket: 0 }, total: 0, page: 1, limit: 20, totalPages: 1 });
      }
      return baseGet(path) ?? Promise.reject(new Error(`Unexpected ${path}`));
    });
    render(<CRMWorkPage />);
    expect(screen.getAllByText('Counting…').length).toBeGreaterThan(0);
    expect(await screen.findByText('Work queue could not be loaded')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('No work matches these filters')).toBeVisible());
  });

  it('pipeline shows "No contacts in this stage" for an empty stage and a retry when a populated stage fails to load', async () => {
    mocks.get.mockImplementation((path: string) => {
      const url = new URL(path, 'https://example.test');
      if (url.pathname === '/api/crm/pipeline/summary') return Promise.resolve({ stages: analytics.stages });
      if (url.pathname === '/api/crm/contacts') {
        // The populated "new" stage reports 21 contacts but returns none.
        return Promise.resolve({ contacts: [], total: 21, totalPages: 2, page: 1, dealValueByCurrency: {} });
      }
      return baseGet(path) ?? Promise.reject(new Error(`Unexpected ${path}`));
    });
    window.history.replaceState(null, '', '/dashboard/crm/pipeline');
    render(<CRMPipelinePage />);
    const empty = await screen.findByRole('region', { name: 'Won stage' });
    await waitFor(() => expect(within(empty).getByText('No contacts in this stage')).toBeVisible());
    const populated = await screen.findByRole('region', { name: 'Not Categorized stage' });
    await waitFor(() => expect(within(populated).getByText('21 contacts in this stage did not load.')).toBeVisible());
    expect(within(populated).getByRole('button', { name: 'Retry stage' })).toBeVisible();
    const board = screen.getByLabelText('Pipeline board');
    expect(board.className).toContain('overflow-x-auto');
    expect(board.className).toContain('w-full');
  });
});
