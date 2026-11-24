import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from '@/app/dashboard/(main)/home/page';
import { PasswordInput } from '@/components/ui/password-input';
import { AdminAuthShell } from '@/components/admin/AdminAuthShell';

const fixture = vi.hoisted(() => ({
  stats: {} as Record<string, unknown>,
  profile: { id: 1, name: 'Fixture' }, toast: vi.fn(), push: vi.fn(), post: vi.fn(),
  historyFailures: 0, historyUrls: [] as string[],
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: fixture.push }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { name: 'Fixture' } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: fixture.toast }) }));
vi.mock('@/hooks/useSetupComplete', () => ({ useSetupComplete: () => ({ hasBusinessProfile: true }) }));
vi.mock('@/hooks/use-business-profiles', () => ({ useBusinessProfiles: () => ({ profiles: [fixture.profile], activeProfile: fixture.profile }) }));
vi.mock('@/components/WorkspaceNextSteps', () => ({ WorkspaceNextSteps: () => null }));
vi.mock('@/components/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/lib/api', () => ({ api: {
  get: vi.fn(async (url: string) => {
    if (url.includes('limit=1&')) {
      fixture.historyUrls.push(url);
      if (fixture.historyFailures > 0) { fixture.historyFailures -= 1; throw new Error('The request took too long. Please try again.'); }
      return [{}];
    }
    return url.includes('limit=6') ?{ threads: [{ id: 7, title: 'Fixture campaign', selectedAgent: 'outreach', createdAt: '2026-11-06T10:00:00Z', stats: {} }] } : url.includes('suggestions') ? { success: true, suggestions: [] } : fixture.stats;
  }),
  post: fixture.post,
} }));

class Recognition {
  static instances: Recognition[] = [];
  static failStart = false;
  onstart = () => {};
  onend = () => {};
  onerror = () => {};
  onresult = (_event: unknown) => {};
  start = vi.fn(() => { if (Recognition.failStart) throw new Error('Denied'); this.onstart(); });
  abort = vi.fn();
  constructor() { Recognition.instances.push(this); }
}

beforeEach(() => { vi.clearAllMocks(); fixture.stats = {}; fixture.historyFailures = 0; fixture.historyUrls = [];Recognition.instances = []; Recognition.failStart = false; vi.stubGlobal('SpeechRecognition', Recognition); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function renderBrief() {
  const view = render(<Home />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Brief an agent' })).toHaveAttribute('aria-pressed', 'true'));
  return view;
}

describe('Home input and navigation', () => {
  it('does not submit Enter during IME composition or Shift+Enter', async () => {
    await renderBrief();
    const input = screen.getByLabelText('What should the team accomplish?');
    fireEvent.change(input, { target: { value: 'Fixture brief' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(fixture.post).not.toHaveBeenCalled();
    fixture.post.mockResolvedValueOnce({ id: 99 });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(fixture.post).toHaveBeenCalledOnce());
  });

  it('announces the selected view and exposes native recent-run navigation', async () => {
    await renderBrief();
    const { api } = await import('@/lib/api');
    const fullListCalls = () => vi.mocked(api.get).mock.calls.filter(([url]) => String(url).includes('limit=6'));
    expect(fullListCalls()).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Performance' }));
    expect(screen.getByRole('button', { name: 'Performance' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Brief an agent' })).toHaveAttribute('aria-pressed', 'false');
    const link = await screen.findByRole('link', { name: /Fixture campaign/ });
    expect(link).toHaveAttribute('href', '/dashboard/conversations/7');
    link.focus();
    expect(link).toHaveFocus();
    // Re-opening the tab for the same profile does not refetch the heavy list.
    await userEvent.click(screen.getByRole('button', { name: 'Brief an agent' }));
    await userEvent.click(screen.getByRole('button', { name: 'Performance' }));
    expect(fullListCalls()).toHaveLength(1);
  });

  it('labels recorded CRM wins with coverage limits and distinguishes an empty activity period', async () => {
    fixture.stats = {
      dailyActivity: [{ date: '2026-11-06', leads: 0, messages: 0, customerUpdates: 0, recordedWins: 0 }],
      campaignPerformance: [], recordedWins: { total: 2, crmContacts: 10, thisWeek: 2, lastWeek: 1, rate: '20.0' },
    };
    await renderBrief();
    await userEvent.click(screen.getByRole('button', { name: 'Performance' }));
    expect(screen.getByText('Recorded first CRM wins', { selector: 'p' })).toBeVisible();
    expect(screen.getByText('No activity data available yet.')).toBeVisible();
    expect(screen.getByText(/over 7 UTC days/)).toBeVisible();
    expect(screen.queryByText('Conversions')).toBeNull();
    expect(screen.getByText(/Top 10 outreach campaigns by recorded outbound receipts/)).toBeVisible();
    await userEvent.click(screen.getByText('View daily activity values'));
    expect(screen.getByRole('table', { name: 'Daily activity values' })).toBeVisible();
    expect(screen.getByRole('rowheader', { name: '2026-11-06' })).toBeVisible();
  });

  it('checks conversation history with the compact list and retries in place after a failure', async () => {
    fixture.historyFailures = 1;
    render(<Home />);
    expect(await screen.findByText('Conversation history could not be checked')).toBeVisible();
    expect(screen.getByText('The request took too long. Please try again.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText('Conversation history could not be checked')).toBeNull());
    expect(fixture.historyUrls).toEqual([
      '/api/chat/threads?limit=1&view=compact&businessProfileId=1',
      '/api/chat/threads?limit=1&view=compact&businessProfileId=1',
    ]);
  });

  it('cancels dictation immediately and ignores late results and errors', async () => {
    await renderBrief();
    await userEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    const recognition = Recognition.instances[0];
    await userEvent.click(screen.getByRole('button', { name: 'Stop voice input' }));
    expect(recognition.abort).toHaveBeenCalledOnce();
    act(() => { recognition.onresult({ results: [[{ transcript: 'Late result' }]] }); recognition.onerror(); });
    expect(screen.getByLabelText('What should the team accomplish?')).toHaveValue('');
    expect(fixture.toast).not.toHaveBeenCalled();
  });

  it('cleans up recognition on view changes and unmount', async () => {
    const view = await renderBrief();
    await userEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    await userEvent.click(screen.getByRole('button', { name: 'Performance' }));
    expect(Recognition.instances[0].abort).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Brief an agent' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    view.unmount();
    expect(Recognition.instances[1].abort).toHaveBeenCalledOnce();
  });

  it('recovers from synchronous start failures and permits retry', async () => {
    await renderBrief();
    Recognition.failStart = true;
    await userEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    expect(fixture.toast).toHaveBeenCalledOnce();
    Recognition.failStart = false;
    await userEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    expect(screen.getByRole('button', { name: 'Stop voice input' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Shared auth accessibility', () => {
  it('allows keyboard reveal without changing the password or submitting', async () => {
    const submit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(<form onSubmit={submit}><PasswordInput aria-label="Password" defaultValue="Synthetic123!" /></form>);
    await userEvent.tab();
    expect(screen.getByLabelText('Password')).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    await userEvent.keyboard(' ');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Password')).toHaveValue('Synthetic123!');
    expect(submit).not.toHaveBeenCalled();
  });

  it('provides a programmatically focusable admin skip destination', () => {
    render(<AdminAuthShell title="Admin sign in"><p>Fixture</p></AdminAuthShell>);
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    main.focus();
    expect(main).toHaveFocus();
  });
});
