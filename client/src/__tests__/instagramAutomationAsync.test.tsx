import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationHistory, AutomationHub } from '@/components/instagram-automations/AutomationHub';
import { AutomationDiagnostics } from '@/components/instagram-automations/AutomationDiagnostics';
import { newInstagramRule, type InstagramAutomationOverview, type InstagramAutomationRule } from '@/lib/instagram-automations';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: api }));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function rule(id: number, status: 'paused' | 'active' = 'paused'): InstagramAutomationRule {
  const definition = newInstagramRule('comment_dm');
  definition.name = `Guide ${id}`; definition.trigger.keywords = ['guide']; definition.message.text = 'Here is your guide';
  return { id, accountId: '1001', definition, priority: id, revision: 2, status, createdAt: '', updatedAt: '' };
}
function overview(rules: InstagramAutomationRule[]): InstagramAutomationOverview {
  return { account: { id: '1001', username: 'shop' }, readiness: { enabled: true, profile: true, messages: true, comments: true, richMessages: true, reasons: [] }, profiles: [], rules, stats: { triggers: 0, sent: 0, failed: 0, skipped: 0, pending: 0, uncertain: 0 } };
}
beforeEach(() => { vi.resetAllMocks(); vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Instagram rule action lifetime', () => {
  it.each(['activate', 'pause', 'delete', 'reorder', 'duplicate'] as const)('settles %s after a focus refresh without stranding controls', async action => {
    const first = rule(1, action === 'pause' ? 'active' : 'paused'), second = rule(2), copied = rule(3), navigate = vi.fn();
    api.get.mockResolvedValue(overview([first, second]));
    const result = deferred<InstagramAutomationRule | InstagramAutomationRule[] | { deleted: boolean }>();
    api.put.mockReturnValue(result.promise); api.delete.mockReturnValue(result.promise); api.post.mockReturnValue(result.promise);
    render(<AutomationHub accountId="1001" navigation={{ view: 'rules' }} onNavigate={navigate} />);
    const label = action === 'activate' ? 'Activate Guide 1' : action === 'pause' ? 'Pause Guide 1' : action === 'delete' ? 'Delete Guide 1' : action === 'reorder' ? 'Move Guide 1 down' : 'Duplicate Guide 1';
    await userEvent.click(await screen.findByRole('button', { name: label }));
    fireEvent.focus(window);
    await act(async () => { result.resolve(action === 'delete' ? { deleted: true } : action === 'duplicate' ? copied : action === 'reorder' ? [{ ...second, priority: 1 }, { ...first, priority: 2 }] : { ...first, revision: 3, status: action === 'activate' ? 'active' : 'paused' }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh automations' })).toBeEnabled());
    if (action === 'activate' || action === 'pause') expect(screen.getByRole('button', { name: `${action === 'activate' ? 'Pause' : 'Activate'} Guide 1` })).toBeEnabled();
    else if (action === 'delete') expect(screen.queryByRole('button', { name: 'Guide 1' })).not.toBeInTheDocument();
    else if (action === 'duplicate') expect(navigate).toHaveBeenCalledWith({ view: 'edit', ruleId: 3 });
    else expect(screen.getByText('Rule order saved. The first matching rule within each scope wins.')).toBeVisible();
  });
  it('shows an action rejection and clears pending after focus returns', async () => {
    api.get.mockResolvedValue(overview([rule(1)])); const result = deferred<InstagramAutomationRule>(); api.put.mockReturnValue(result.promise);
    render(<AutomationHub accountId="1001" navigation={{ view: 'rules' }} onNavigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Activate Guide 1' })); fireEvent.focus(window);
    await act(async () => { result.reject(new Error('The saved revision changed.')); });
    expect(await screen.findByText('The saved revision changed.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Activate Guide 1' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Refresh automations' })).toBeEnabled();
  });
  it('invalidates an older read without leaving its loading state behind', async () => {
    const initial = overview([rule(1)]), read = deferred<InstagramAutomationOverview>(), update = deferred<InstagramAutomationRule>();
    api.get.mockResolvedValueOnce(initial).mockReturnValueOnce(read.promise); api.put.mockReturnValue(update.promise);
    render(<AutomationHub accountId="1001" navigation={{ view: 'rules' }} onNavigate={vi.fn()} />);
    await screen.findByRole('button', { name: 'Activate Guide 1' }); fireEvent.focus(window);
    await userEvent.click(screen.getByRole('button', { name: 'Activate Guide 1' }));
    await act(async () => { update.resolve({ ...rule(1, 'active'), revision: 3 }); read.resolve(initial); });
    expect(await screen.findByRole('button', { name: 'Pause Guide 1' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Refresh automations' })).toBeEnabled();
  });
  it('ignores a completed action from a previous account', async () => {
    const update = deferred<InstagramAutomationRule>(); api.get.mockResolvedValue(overview([rule(1)])); api.put.mockReturnValue(update.promise);
    const view = render(<AutomationHub accountId="1001" navigation={{ view: 'rules' }} onNavigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Activate Guide 1' }));
    api.get.mockResolvedValue({ ...overview([]), account: { id: '1002', username: 'other' } });
    view.rerender(<AutomationHub accountId="1002" navigation={{ view: 'rules' }} onNavigate={vi.fn()} />);
    await screen.findByText('@other'); await act(async () => { update.resolve(rule(1, 'active')); });
    expect(screen.queryByRole('button', { name: 'Guide 1' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh automations' })).toBeEnabled();
  });
});

describe('Instagram sample request identity', () => {
  const match = { matched: true, targetWins: true, winner: { id: 1, name: 'Guide 1' }, keyword: 'guide', firstResponse: 'Here is your guide', summary: 'Original sample', warnings: [] };
  it.each(['text', 'media', 'type'] as const)('discards the old response after the sample %s changes', async field => {
    const result = deferred<typeof match>(); api.post.mockReturnValue(result.promise);
    render(<AutomationDiagnostics accountId="1001" rule={rule(1)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check sample comment' }));
    if (field === 'text') fireEvent.change(screen.getByLabelText('Sample comment'), { target: { value: 'pineapple' } });
    else if (field === 'media') fireEvent.change(screen.getByLabelText('Sample post or reel ID'), { target: { value: 'different-post' } });
    else fireEvent.change(screen.getByLabelText('Sample content type'), { target: { value: 'reel' } });
    await act(async () => { result.resolve(match); });
    expect(screen.queryByText('This automation would win the trigger match.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check sample comment' })).toBeEnabled();
  });
  it('ignores an error from a superseded sample', async () => {
    const result = deferred<typeof match>(); api.post.mockReturnValue(result.promise);
    render(<AutomationDiagnostics accountId="1001" rule={rule(1)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check sample comment' }));
    fireEvent.change(screen.getByLabelText('Sample comment'), { target: { value: 'pineapple' } });
    await act(async () => { result.reject(new Error('Old request failed.')); });
    expect(screen.queryByText('Old request failed.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check sample comment' })).toBeEnabled();
  });
  it('keeps the newer result when the superseded request completes last', async () => {
    const first = deferred<typeof match>(), second = deferred<typeof match>(); api.post.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<AutomationDiagnostics accountId="1001" rule={rule(1)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check sample comment' }));
    fireEvent.change(screen.getByLabelText('Sample comment'), { target: { value: 'pineapple' } });
    await userEvent.click(screen.getByRole('button', { name: 'Check sample comment' }));
    expect(api.post).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve({ ...match, matched: false, targetWins: false, summary: 'New sample' }); first.resolve(match); });
    expect(screen.getByText('This comment does not match this automation.')).toBeVisible();
    expect(screen.queryByText('Original sample')).not.toBeInTheDocument();
  });
  it.each(['account', 'rule', 'revision'] as const)('invalidates results when the saved %s changes', async field => {
    const result = deferred<typeof match>(); api.post.mockReturnValue(result.promise);
    const source = rule(1), view = render(<AutomationDiagnostics accountId="1001" rule={source} />);
    await userEvent.click(screen.getByRole('button', { name: 'Check sample comment' }));
    view.rerender(<AutomationDiagnostics accountId={field === 'account' ? '1002' : '1001'} rule={field === 'rule' ? rule(2) : field === 'revision' ? { ...source, revision: 3 } : source} />);
    await act(async () => { result.resolve(match); });
    expect(screen.queryByText('This automation would win the trigger match.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check sample comment' })).toBeEnabled();
  });
});

describe('Instagram delivery presentation', () => {
  it('distinguishes an unloaded view from a successful empty refresh and retains it on failure', async () => {
    api.get.mockResolvedValueOnce({ runs: [] }).mockRejectedValueOnce(new Error('Refresh unavailable.'));
    render(<AutomationDiagnostics accountId="1001" rule={rule(1)} />);
    expect(screen.getByText('No delivery results loaded. Run your test, then refresh.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh delivery details' }));
    expect(await screen.findByText('No recorded deliveries for this automation yet.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh delivery details' }));
    expect(await screen.findByText('Refresh unavailable.')).toBeVisible();
    expect(screen.getByText('No recorded deliveries for this automation yet.')).toBeVisible();
  });
  it('uses the same uncertain and failed outcomes in history and delivery details', async () => {
    api.get.mockResolvedValue({ runs: [
      { id: 1, status: 'uncertain', createdAt: '2026-10-23T00:00:00Z', effects: [{ kind: 'private', status: 'uncertain' }] },
      { id: 2, status: 'failed', createdAt: '2026-10-23T00:00:00Z', effects: [] },
    ], nextCursor: null });
    const history = render(<AutomationHistory accountId="1001" />);
    expect(await screen.findByText('Delivery unconfirmed')).toBeVisible();
    expect(screen.getByText('Could not send')).toBeVisible(); history.unmount();
    render(<AutomationDiagnostics accountId="1001" rule={rule(1)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh delivery details' }));
    expect(await screen.findByText('Delivery unconfirmed · Run #1')).toBeVisible();
    expect(screen.getByText('Could not send · Run #2')).toBeVisible();
    expect(screen.getByText('Private message: uncertain')).toBeVisible();
    expect(screen.getByText(/Replaying this send could deliver twice/)).toBeVisible();
  });
  it('labels a recorded send as accepted and retains its receipt meaning', async () => {
    api.get.mockResolvedValue({ runs: [{ id: 1, status: 'sent', createdAt: '2026-10-23T00:00:00Z', effects: [{ kind: 'private', status: 'sent' }] }] });
    render(<AutomationDiagnostics accountId="1001" rule={rule(1)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh delivery details' }));
    expect(await screen.findByText('Accepted by Instagram · Run #1')).toBeVisible();
    expect(screen.getByText('Private message: accepted')).toBeVisible();
    expect(screen.queryByText(/read by/i)).not.toBeInTheDocument();
  });
});
