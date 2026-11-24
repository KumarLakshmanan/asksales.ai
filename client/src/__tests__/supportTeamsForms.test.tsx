import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SupportTeamsPage from '@/app/dashboard/(main)/support/teams/page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), toast: vi.fn(), workspace: vi.fn(), refresh: null as null | (() => Promise<void>) }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get, put: mocks.put, post: mocks.post, delete: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-support-realtime-refresh', () => ({ useSupportRealtimeRefresh: (refresh: () => Promise<void>) => { mocks.refresh = refresh; return {}; } }));
vi.mock('@/hooks/use-support-report', () => ({ useSupportWorkspace: mocks.workspace }));

const defaults = { handlingMinutesPerTicket: 7, socialFallbackSlaMinutes: 45, emailFallbackSlaMinutes: 360 };
const team = { id: 1, name: 'Billing', description: 'Synthetic support team', color: '#3B82F6', icon: null, isActive: true, members: [], createdAt: '2026-10-01T00:00:00Z' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function workspace(profileId = 4102) {
  return { userId: 4101, profileId, ready: true, profiles: { isError: false, isLoading: false }, headers: { 'X-Business-Profile-Id': String(profileId) } };
}
async function mount() {
  const view = render(<SupportTeamsPage />);
  await screen.findByRole('heading', { name: 'Support teams' });
  return view;
}
async function routing() {
  fireEvent.click(screen.getByRole('button', { name: 'Routing defaults' }));
  return screen.findByRole('dialog', { name: 'Workspace routing defaults' });
}
async function manage(action: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Manage Billing' }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
  return screen.findByRole('dialog');
}
async function fillMember(dialog: HTMLElement) {
  fireEvent.change(within(dialog).getByLabelText('Name *'), { target: { value: 'Synthetic Member' } });
  fireEvent.change(within(dialog).getByLabelText('Email *'), { target: { value: 'member@example.test' } });
  fireEvent.change(within(dialog).getByLabelText('Password *'), { target: { value: 'Synthetic123!QA' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace.mockReturnValue(workspace());
  mocks.get.mockImplementation((url: string) => Promise.resolve(url.endsWith('capacity-settings') ? defaults : [team]));
  mocks.put.mockResolvedValue(defaults);
  mocks.post.mockResolvedValue({ id: 2 });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Support Teams asynchronous forms', () => {
  it('retains entered response targets and an actionable error on rejection, then closes on retry success', async () => {
    mocks.put.mockRejectedValueOnce(new Error('Synthetic save rejected'));
    await mount();
    const dialog = await routing();
    fireEvent.change(within(dialog).getByLabelText('Social fallback in minutes'), { target: { value: '64' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
    expect(within(dialog).getByLabelText('Social fallback in minutes')).toHaveValue(64);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/Synthetic save rejected.*try again/i);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocks.put.mock.calls[1][1].socialFallbackSlaMinutes).toBe(64);
  });

  it('blocks unknown defaults after initial load rejection and enables editing only after explicit successful retry', async () => {
    mocks.get.mockImplementation((url: string) => url.endsWith('capacity-settings') ? Promise.reject(new Error('Synthetic settings unavailable')) : Promise.resolve([team]));
    await mount();
    const dialog = await routing();
    expect(within(dialog).getByRole('button', { name: 'Save defaults' })).toBeDisabled();
    expect(within(dialog).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Synthetic settings unavailable');
    mocks.get.mockImplementation((url: string) => Promise.resolve(url.endsWith('capacity-settings') ? defaults : [team]));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry loading defaults' }));
    await waitFor(() => expect(within(dialog).getByLabelText('Social fallback in minutes')).toHaveValue(45));
    expect(within(dialog).getByRole('button', { name: 'Save defaults' })).toBeEnabled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it.each(['create', 'edit'])('locks %s team double-click and Enter submissions until the API settles', async (mode) => {
    const request = deferred<unknown>();
    mocks.post.mockReturnValue(request.promise);
    mocks.put.mockReturnValue(request.promise);
    await mount();
    if (mode === 'create') fireEvent.click(screen.getByRole('button', { name: 'Add team' }));
    else await manage('Edit team');
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Team name *'), { target: { value: 'QA team' } });
    const save = within(dialog).getByRole('button', { name: mode === 'create' ? 'Create Team' : 'Save Changes' });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(mode === 'create' ? mocks.post : mocks.put).toHaveBeenCalledTimes(1));
    expect(within(dialog).getByRole('status')).toHaveTextContent(/saving team/i);
    expect(within(dialog).getByLabelText('Team name *')).toBeDisabled();
    fireEvent.submit(within(dialog).getByLabelText('Team name *').closest('form')!);
    expect(mode === 'create' ? mocks.post : mocks.put).toHaveBeenCalledTimes(1);
    await act(async () => request.reject(new Error('Synthetic team rejection')));
    expect(within(dialog).getByLabelText('Team name *')).toHaveValue('QA team');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Synthetic team rejection');
    const mutation = mode === 'create' ? mocks.post : mocks.put;
    mutation.mockResolvedValueOnce({ id: 2 });
    await userEvent.setup().click(within(dialog).getByRole('button', { name: mode === 'create' ? 'Create Team' : 'Save Changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mutation.mock.calls[1][0]).toBe(mode === 'create' ? '/api/support/teams' : '/api/support/teams/1');
    expect(mutation.mock.calls[1][1]).toEqual({ name: 'QA team', description: mode === 'create' ? '' : team.description, color: team.color });
    expect(mutation.mock.calls[1][2]).toEqual({ headers: { 'X-Business-Profile-Id': '4102' } });
  });

  it('locks member double-click and Enter submissions until the API settles and preserves all fields on failure', async () => {
    const request = deferred<unknown>();
    mocks.post.mockReturnValue(request.promise);
    await mount();
    const dialog = await manage('Add member');
    await fillMember(dialog);
    fireEvent.change(within(dialog).getByLabelText(/WhatsApp number/), { target: { value: '+15555550123' } });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    const submit = within(dialog).getByRole('button', { name: 'Add Member' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.submit(within(dialog).getByLabelText('Name *').closest('form')!);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole('status')).toHaveTextContent(/adding member/i);
    expect(within(dialog).getByLabelText('Name *')).toBeDisabled();
    await act(async () => request.reject(new Error('Synthetic member rejection')));
    expect(within(dialog).getByLabelText('Password *')).toHaveValue('Synthetic123!QA');
    expect(within(dialog).getByRole('checkbox')).toBeChecked();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Synthetic member rejection');
    mocks.post.mockResolvedValueOnce({ id: 2 });
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Add Member' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocks.post.mock.calls[1][1]).toEqual({ name: 'Synthetic Member', email: 'member@example.test', password: 'Synthetic123!QA', role: 'member', whatsappNumber: '+15555550123', whatsappConsentAcknowledged: true });
  });

  it('keeps defaults unavailable while their read is deferred, including cancelled/reopened load UI', async () => {
    const read = deferred<typeof defaults>();
    mocks.get.mockImplementation((url: string) => url.endsWith('capacity-settings') ? read.promise : Promise.resolve([team]));
    await mount();
    let dialog = await routing();
    expect(within(dialog).getByRole('status')).toHaveTextContent('Loading response targets');
    expect(within(dialog).getByRole('button', { name: 'Save defaults' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    dialog = await routing();
    expect(within(dialog).queryByRole('spinbutton')).not.toBeInTheDocument();
    await act(async () => read.resolve(defaults));
    expect(within(dialog).getByLabelText('Social fallback in minutes')).toHaveValue(45);
  });

  it.each(['success', 'rejection'])('ignores a cancelled capacity %s after reopen without unlocking a duplicate save', async (outcome) => {
    const request = deferred<typeof defaults>();
    mocks.put.mockReturnValue(request.promise);
    await mount();
    let dialog = await routing();
    fireEvent.change(within(dialog).getByLabelText('Social fallback in minutes'), { target: { value: '64' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save defaults' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save defaults' }));
    fireEvent.submit(within(dialog).getByLabelText('Social fallback in minutes').closest('form')!);
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByLabelText('Social fallback in minutes')).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    dialog = await routing();
    // Busy save: kept focusable but marked unavailable (Button `loading`).
    expect(within(dialog).getByRole('button', { name: 'Save defaults' })).toHaveAttribute('aria-disabled', 'true');
    await act(async () => outcome === 'success' ? request.resolve(defaults) : request.reject(new Error('Old capacity error')));
    expect(dialog).toBeVisible();
    expect(within(dialog).getByLabelText('Social fallback in minutes')).toHaveValue(64);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save defaults' })).toBeEnabled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it.each(['success', 'rejection'])('ignores a cancelled team %s after a different edit dialog opens', async (outcome) => {
    const request = deferred<unknown>();
    mocks.post.mockReturnValue(request.promise);
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add team' }));
    let dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Team name *'), { target: { value: 'Old create' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Team' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    dialog = await manage('Edit team');
    expect(within(dialog).getByRole('button', { name: 'Save Changes' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.submit(within(dialog).getByLabelText('Team name *').closest('form')!);
    expect(mocks.put).not.toHaveBeenCalled();
    await act(async () => outcome === 'success' ? request.resolve({ id: 2 }) : request.reject(new Error('Old team error')));
    expect(dialog).toBeVisible();
    expect(within(dialog).getByLabelText('Team name *')).toHaveValue('Billing');
    expect(within(dialog).getByRole('button', { name: 'Save Changes' })).toBeEnabled();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it.each(['success', 'rejection'])('ignores a cancelled member %s after another team is selected', async (outcome) => {
    const request = deferred<unknown>();
    mocks.post.mockReturnValue(request.promise);
    mocks.get.mockImplementation((url: string) => Promise.resolve(url.endsWith('capacity-settings') ? defaults : [team, { ...team, id: 2, name: 'Accounts' }]));
    await mount();
    let dialog = await manage('Add member');
    await fillMember(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Member' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Manage Accounts' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add member' }));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Name *')).toBeDisabled();
    fireEvent.submit(within(dialog).getByLabelText('Name *').closest('form')!);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await act(async () => outcome === 'success' ? request.resolve({ id: 2 }) : request.reject(new Error('Old member error')));
    expect(dialog).toBeVisible();
    expect(within(dialog).getByLabelText('Name *')).toHaveValue('');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    await fillMember(dialog);
    mocks.post.mockResolvedValueOnce({ id: 3 });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Member' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocks.post.mock.calls[1][0]).toBe('/api/support/teams/2/members');
  });

  it.each(['capacity', 'team', 'member'].flatMap(kind => ['success', 'rejection'].map(outcome => [kind, outcome])))('ignores old %s mutation %s after a workspace change and pins request headers', async (kind, outcome) => {
    const request = deferred<unknown>();
    mocks.put.mockReturnValue(request.promise);
    mocks.post.mockReturnValue(request.promise);
    const view = await mount();
    if (kind === 'capacity') {
      const dialog = await routing();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save defaults' }));
    } else if (kind === 'team') {
      fireEvent.click(screen.getByRole('button', { name: 'Add team' }));
      fireEvent.change(screen.getByLabelText('Team name *'), { target: { value: 'Old workspace' } });
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create Team' }));
    } else {
      const dialog = await manage('Add member');
      await fillMember(dialog);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add Member' }));
    }
    const mutation = kind === 'capacity' ? mocks.put : mocks.post;
    expect(mutation.mock.calls[0][2]).toEqual({ headers: { 'X-Business-Profile-Id': '4102' } });
    mocks.workspace.mockReturnValue(workspace(5102));
    mocks.get.mockImplementation((url: string) => Promise.resolve(url.endsWith('capacity-settings') ? { ...defaults, socialFallbackSlaMinutes: 91 } : [{ ...team, name: 'New workspace' }]));
    view.rerender(<SupportTeamsPage />);
    await screen.findByRole('button', { name: 'Open New workspace team roster and task list' });
    const dialog = await routing();
    await act(async () => outcome === 'success' ? request.resolve(defaults) : request.reject(new Error('Old workspace save rejected')));
    expect(dialog).toBeVisible();
    expect(within(dialog).getByLabelText('Social fallback in minutes')).toHaveValue(91);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.get.mock.calls.filter(([, options]) => options.headers['X-Business-Profile-Id'] === '5102')).toHaveLength(2);
  });

  it('ignores old workspace reads even when the mock disregards AbortSignal', async () => {
    const oldTeams = deferred<typeof team[]>();
    const oldDefaults = deferred<typeof defaults>();
    mocks.get.mockImplementation((url: string) => url.endsWith('capacity-settings') ? oldDefaults.promise : oldTeams.promise);
    const view = render(<SupportTeamsPage />);
    const oldSignal = mocks.get.mock.calls[0][1].signal as AbortSignal;
    mocks.workspace.mockReturnValue(workspace(5102));
    mocks.get.mockImplementation((url: string) => Promise.resolve(url.endsWith('capacity-settings') ? defaults : [{ ...team, name: 'Current team' }]));
    view.rerender(<SupportTeamsPage />);
    await screen.findByRole('button', { name: 'Open Current team team roster and task list' });
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { oldTeams.resolve([team]); oldDefaults.reject(new Error('Old workspace load failed')); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Current team team roster and task list' })).toBeVisible());
    const dialog = await routing();
    expect(within(dialog).getByLabelText('Social fallback in minutes')).toHaveValue(45);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the latest roster when realtime reads complete out of order', async () => {
    await mount();
    const oldRead = deferred<typeof team[]>();
    const newRead = deferred<typeof team[]>();
    mocks.get.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    act(() => { void mocks.refresh!(); void mocks.refresh!(); });
    await act(async () => newRead.resolve([{ ...team, name: 'Latest team' }]));
    await act(async () => oldRead.resolve([team]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Latest team team roster and task list' })).toBeVisible());
  });

  it('performs no team/default reads or mutations before workspace verification', () => {
    mocks.workspace.mockReturnValue({ ...workspace(), ready: false });
    const view = render(<SupportTeamsPage />);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Add team' })).not.toBeInTheDocument();
    mocks.workspace.mockReturnValue({ ...workspace(), profiles: { isError: true, isLoading: false, refetch: vi.fn() } });
    view.rerender(<SupportTeamsPage />);
    expect(screen.getByText('Support workspace could not be verified')).toBeVisible();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it.each([null, {}, { ...defaults, socialFallbackSlaMinutes: 0 }])('blocks an unusable defaults response (%j) instead of offering an implicit fallback', async (invalid) => {
    mocks.get.mockImplementation((url: string) => Promise.resolve(url.endsWith('capacity-settings') ? invalid : [team]));
    await mount();
    const dialog = await routing();
    expect(within(dialog).getByRole('button', { name: 'Save defaults' })).toBeDisabled();
    expect(within(dialog).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('incomplete or invalid response targets');
  });

  it('retains existing required-name and strong-password validation before any mutation', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add team' }));
    let dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Team' }));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'Team name is required', variant: 'destructive' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    dialog = await manage('Add member');
    await fillMember(dialog);
    fireEvent.change(within(dialog).getByLabelText('Password *'), { target: { value: 'weak' } });
    fireEvent.submit(within(dialog).getByLabelText('Name *').closest('form')!);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Strong password required', variant: 'destructive' }));
  });

  it('discards a pending member result after the page unmounts without toasts or refresh reads', async () => {
    const request = deferred<unknown>();
    mocks.post.mockReturnValue(request.promise);
    const view = await mount();
    const dialog = await manage('Add member');
    await fillMember(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Member' }));
    const reads = mocks.get.mock.calls.length;
    view.unmount();
    await act(async () => request.resolve({ id: 2 }));
    expect(mocks.get).toHaveBeenCalledTimes(reads);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('keeps a failed-save dialog and its draft available when a background roster refresh rejects', async () => {
    mocks.put.mockRejectedValueOnce(new Error('Save rejected'));
    await mount();
    const dialog = await routing();
    fireEvent.change(within(dialog).getByLabelText('Social fallback in minutes'), { target: { value: '64' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save defaults' }));
    await within(dialog).findByRole('alert');
    mocks.get.mockRejectedValueOnce(new Error('Background roster unavailable'));
    await act(async () => mocks.refresh!());
    expect(dialog).toBeVisible();
    expect(within(dialog).getByLabelText('Social fallback in minutes')).toHaveValue(64);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Save rejected');
    expect(within(dialog).getByRole('button', { name: 'Save defaults' })).toBeEnabled();
  });
});
