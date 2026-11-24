import { StrictMode, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { OwnerSupportNotificationSettings } from '@/components/support/OwnerSupportNotificationSettings';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), toast: vi.fn(), whatsappToggle: undefined as ((enabled: boolean) => void) | undefined, userId: 1, profileId: 11, role: 'owner', profilesLoading: false, profilesError: false }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get, put: mocks.put, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: mocks.userId }, workspaceRole: mocks.role }) }));
vi.mock('@/hooks/use-business-profiles', () => ({ useBusinessProfiles: () => ({ activeProfile: { id: mocks.profileId, role: mocks.role }, isLoading: mocks.profilesLoading, isError: mocks.profilesError, refetch: vi.fn() }) }));
vi.mock('@/lib/business-profile', () => ({ selectedBusinessProfileId: () => mocks.profileId }));
vi.mock('@/components/ui/switch', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui/switch')>('@/components/ui/switch');
  return { Switch: (props: ComponentProps<typeof actual.Switch>) => { if (props['aria-label']?.endsWith('WhatsApp notifications')) mocks.whatsappToggle = props.onCheckedChange; return <actual.Switch {...props} />; } };
});
const approvedTemplate = { id: 71, name: 'support_ticket_assignment_v1', language: 'en_US', body: 'Ticket {{1}}', compatible: true, reasons: [], parameterCount: 7 };
const baseSettings = {
  email: { enabled: false, providerState: 'available', subject: '{{event_title}} · {{ticket_number}}', text: 'Ticket {{ticket_number}}', preview: { subject: 'Ticket assignment', text: 'Ticket', html: '' } },
  whatsapp: { enabled: false, providerState: 'connected', templateId: null as number | null, templates: [approvedTemplate] },
  recipients: [{ memberId: 3, memberName: 'Support QA', teamName: 'Reservations', active: true, emailReady: true, emailHint: 'su*****@example.com', whatsappReady: false, whatsappHint: null, memberProfileUrl: '/dashboard/support/teams/1/members/3' }],
};
const emptyHealth = { recentFailures: [], recentDeliveries: [] };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function tab(name: string) { await userEvent.click(await screen.findByRole('tab', { name })); }
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
const subject = () => screen.getByLabelText('Subject');
const template = () => screen.getByLabelText('Message template');
let state: typeof baseSettings;
let health: { recentFailures: Array<{ id: number; channel: string; status: string }>; recentDeliveries: never[] };
beforeEach(() => {
  vi.clearAllMocks(); Object.assign(mocks, { userId: 1, profileId: 11, role: 'owner', profilesLoading: false, profilesError: false, whatsappToggle: undefined });
  state = structuredClone(baseSettings); health = structuredClone(emptyHealth);
  mocks.get.mockImplementation(async (path: string) => structuredClone(path.endsWith('notification-health') ? health : state));
  mocks.put.mockImplementation(async (path: string, body) => { if (path.endsWith('/email')) state.email = { ...state.email, ...body }; else state.whatsapp = { ...state.whatsapp, enabled: body.enabled, templateId: body.whatsappTemplateId }; return structuredClone(state); });
  mocks.post.mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe('support notifications with explicit save and focused tabs', () => {
  it('shows two master switches and a recipient preview; tab changes never write', async () => {
    render(<OwnerSupportNotificationSettings />); await tab('Channels');
    expect(screen.getAllByRole('switch')).toHaveLength(2); expect(screen.getByText('Missing WhatsApp')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Add missing contact' })).toHaveAttribute('href', baseSettings.recipients[0].memberProfileUrl);
    await tab('Message templates'); expect(subject()).toBeVisible(); expect(template()).toBeVisible(); expect(screen.queryByRole('switch')).toBeNull();
    await tab('Recipients'); expect(screen.getByText('su*****@example.com')).toBeVisible(); await tab('Delivery activity'); expect(screen.getByText('No failed deliveries.')).toBeVisible();
    expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
  });
  it('stages channel switches and saves both channels sequentially only on Save', async () => {
    render(<OwnerSupportNotificationSettings />); await tab('Channels');
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Email notifications' })); fireEvent.click(screen.getByRole('switch', { name: 'Enable WhatsApp notifications' })); expect(mocks.put).not.toHaveBeenCalled();
    save(); await screen.findByText('Notification changes saved. Any newer edits remain unsaved.');
    expect(mocks.put.mock.calls.map(call => call[0])).toEqual(['/api/support/notification-settings/email', '/api/support/notification-settings/whatsapp']);
    expect(mocks.put.mock.calls[1][1]).toEqual({ enabled: true, whatsappTemplateId: 71 }); expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
  it('discards channel and template changes together without writing', async () => {
    render(<OwnerSupportNotificationSettings />); await tab('Channels'); fireEvent.click(screen.getByRole('switch', { name: 'Enable Email notifications' }));
    await tab('Message templates'); fireEvent.change(subject(), { target: { value: 'Unsaved draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' })); expect(subject()).toHaveValue(state.email.subject);
    await tab('Channels'); expect(screen.getByRole('switch', { name: 'Enable Email notifications' })).not.toBeChecked(); expect(mocks.put).not.toHaveBeenCalled();
  });
  it('edits and previews templates even while a channel is off', async () => {
    render(<OwnerSupportNotificationSettings />); await tab('Message templates'); fireEvent.change(subject(), { target: { value: 'Changed {{ticket_number}}' } });
    expect(screen.getByText('Changed TKT-1042')).toBeVisible(); save(); await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/support/notification-settings/email', { enabled: false, subject: 'Changed {{ticket_number}}', text: state.email.text }));
  });
  it('restores defaults in the draft and publishes them only on Save', async () => {
    state.email.subject = 'Custom'; render(<OwnerSupportNotificationSettings />); await tab('Message templates'); fireEvent.click(screen.getByRole('button', { name: 'Restore default' }));
    expect(subject()).toHaveValue('{{event_title}} · {{ticket_number}}'); expect(mocks.put).not.toHaveBeenCalled(); save(); await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
  });
  it('blocks a second save while the first channel is pending and keeps the other draft', async () => {
    const pending = deferred<typeof state>(); mocks.put.mockReturnValueOnce(pending.promise);
    render(<OwnerSupportNotificationSettings />); await tab('Channels'); fireEvent.click(screen.getByRole('switch', { name: 'Enable Email notifications' })); fireEvent.click(screen.getByRole('switch', { name: 'Enable WhatsApp notifications' })); save();
    expect(screen.getByRole('switch', { name: 'Disable Email notifications' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await act(async () => { state.email.enabled = true; pending.resolve(structuredClone(state)); });
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(2)); expect(state.whatsapp.enabled).toBe(true);
  });
  it('preserves a failed second-channel draft and retries only the unsaved section', async () => {
    mocks.put.mockImplementationOnce(async (_path, body) => { state.email = { ...state.email, ...body }; return structuredClone(state); }).mockRejectedValueOnce(new Error('Offline'));
    render(<OwnerSupportNotificationSettings />); await tab('Channels'); fireEvent.click(screen.getByRole('switch', { name: 'Enable Email notifications' })); fireEvent.click(screen.getByRole('switch', { name: 'Enable WhatsApp notifications' })); save();
    await screen.findByText(/Unable to save WhatsApp notifications. Your template selection/); expect(screen.getByRole('switch', { name: 'Disable WhatsApp notifications' })).toBeChecked();
    save(); await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(3)); expect(mocks.put.mock.calls[2][0]).toBe('/api/support/notification-settings/whatsapp');
  });
  it('keeps drafts through a settings refresh and discards to the newest saved baseline', async () => {
    render(<OwnerSupportNotificationSettings />); await tab('Message templates'); fireEvent.change(subject(), { target: { value: 'Kept draft' } }); state.email.subject = 'New server value';
    fireEvent.click(screen.getByRole('button', { name: 'Refresh settings' })); await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh settings' })).toBeEnabled());
    expect(subject()).toHaveValue('Kept draft'); fireEvent.click(screen.getByRole('button', { name: 'Discard changes' })); expect(subject()).toHaveValue('New server value'); expect(mocks.put).not.toHaveBeenCalled();
  });
  it('retains accessible settings refresh and save errors without clearing edits', async () => {
    render(<OwnerSupportNotificationSettings />); await tab('Message templates'); fireEvent.change(subject(), { target: { value: 'Kept draft' } }); mocks.get.mockRejectedValue(new Error('Offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh settings' })); await screen.findByText(/Notification settings could not be refreshed/); expect(subject()).toHaveValue('Kept draft');
    mocks.put.mockRejectedValueOnce(new Error('Offline')); save(); expect(await screen.findByText(/Unable to save email notifications. Your draft/)).toHaveAttribute('role', 'alert'); expect(subject()).toHaveValue('Kept draft');
  });
  it('does not replace a newer edit when an older save completes', async () => {
    const pending = deferred<typeof state>(); mocks.put.mockReturnValue(pending.promise); render(<OwnerSupportNotificationSettings />); await tab('Message templates');
    fireEvent.change(subject(), { target: { value: 'Submitted draft' } }); save(); fireEvent.change(subject(), { target: { value: 'Newer draft' } });
    await act(async () => pending.resolve({ ...state, email: { ...state.email, subject: 'Submitted draft' } })); expect(subject()).toHaveValue('Newer draft'); expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });
  it.each(['missing record', 'incompatible', 'wrong parameter count'])('blocks an unavailable WhatsApp template: %s', async kind => {
    state.whatsapp.templateId = 72; if (kind !== 'missing record') state.whatsapp.templates.push({ ...approvedTemplate, id: 72, compatible: kind !== 'incompatible', parameterCount: kind === 'wrong parameter count' ? 6 : 7 });
    render(<OwnerSupportNotificationSettings />); await tab('Channels'); const toggle = screen.getByRole('switch', { name: 'Enable WhatsApp notifications' }); expect(toggle).toBeDisabled(); expect(toggle).toHaveAccessibleDescription(/Choose an available approved support ticket template/);
    await act(async () => mocks.whatsappToggle?.(true)); expect(screen.getByRole('alert')).toHaveTextContent('Choose an available approved support ticket template'); expect(mocks.put).not.toHaveBeenCalled();
    await tab('Message templates'); expect(template()).toHaveValue('72'); expect(screen.getByRole('option', { name: 'Selected template 72 · unavailable' })).toBeDisabled();
  });
  it.each(['connected', 'not_connected'])('allows disabling WhatsApp with an unavailable template and %s provider', async providerState => {
    state.whatsapp = { ...state.whatsapp, enabled: true, providerState, templateId: 72, templates: [] };
    render(<OwnerSupportNotificationSettings />); await tab('Channels'); fireEvent.click(screen.getByRole('switch', { name: 'Disable WhatsApp notifications' })); expect(mocks.put).not.toHaveBeenCalled(); save();
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/support/notification-settings/whatsapp', { enabled: false, whatsappTemplateId: 72 }));
  });
  it('validates an old enable callback against the latest template catalog', async () => {
    render(<OwnerSupportNotificationSettings />); await tab('Channels'); const oldToggle = mocks.whatsappToggle; state.whatsapp.templates = [];
    fireEvent.click(screen.getByRole('button', { name: 'Refresh settings' })); await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh settings' })).toBeEnabled());
    await act(async () => oldToggle?.(true)); expect(screen.getByRole('alert')).toHaveTextContent('Choose an available approved support ticket template'); expect(mocks.put).not.toHaveBeenCalled();
  });
  it('syncs templates without erasing unsaved email fields', async () => {
    state.whatsapp.templates = []; render(<OwnerSupportNotificationSettings />); await tab('Message templates'); fireEvent.change(subject(), { target: { value: 'Kept draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sync from Meta' })); await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/whatsapp/templates/sync', {})); await waitFor(() => expect(screen.getByRole('button', { name: 'Sync from Meta' })).toBeEnabled()); expect(subject()).toHaveValue('Kept draft');
  });
  it('reports unknown delivery health, retries reads without writing, and distinguishes empty activity', async () => {
    mocks.get.mockImplementation(async path => { if (path.endsWith('notification-health')) throw new Error('Offline'); return structuredClone(state); }); render(<OwnerSupportNotificationSettings />); await tab('Delivery activity'); expect(screen.getByText('Status unknown')).toBeVisible(); expect(screen.queryByText('No failed deliveries.')).toBeNull();
    mocks.get.mockResolvedValue(emptyHealth); fireEvent.click(screen.getByRole('button', { name: 'Retry status read' })); await screen.findByText('0 issues'); expect(screen.getByText('No failed deliveries.')).toBeVisible(); expect(mocks.post).not.toHaveBeenCalled(); expect(mocks.put).not.toHaveBeenCalled();
  });
  it('marks retained delivery data stale and blocks duplicate retries', async () => {
    health.recentFailures = [{ id: 19, channel: 'email', status: 'failed' }]; render(<OwnerSupportNotificationSettings />); await tab('Delivery activity'); const pending = deferred<unknown>(); mocks.post.mockReturnValue(pending.promise);
    const retry = screen.getByRole('button', { name: 'Retry delivery 19' }); fireEvent.click(retry); fireEvent.click(retry); expect(mocks.post).toHaveBeenCalledTimes(1); expect(retry).toBeDisabled(); await act(async () => pending.resolve({}));
    mocks.get.mockRejectedValue(new Error('Offline')); fireEvent.click(screen.getByRole('button', { name: 'Refresh delivery status' })); await screen.findByText('1 issues · stale'); expect(screen.getByRole('button', { name: 'Retry delivery 19' })).toBeDisabled(); expect(within(screen.getByRole('region', { name: 'Delivery health' })).getByRole('alert')).toHaveTextContent('current health is unknown');
  });
  it('recovers from an initial read failure without publishing defaults', async () => {
    mocks.get.mockRejectedValue(new Error('Offline')); render(<OwnerSupportNotificationSettings />); await screen.findByText('Notification settings are unavailable'); mocks.get.mockResolvedValue(state); fireEvent.click(screen.getByRole('button', { name: 'Try again' })); await tab('Channels'); expect(mocks.put).not.toHaveBeenCalled();
  });
  it.each(['workspace', 'account', 'role'])('clears drafts and ignores an old save after a %s switch', async change => {
    const view = render(<OwnerSupportNotificationSettings />); await tab('Message templates'); fireEvent.change(subject(), { target: { value: 'Private old draft' } }); const pending = deferred<typeof state>(); mocks.put.mockReturnValue(pending.promise); save();
    if (change === 'workspace') mocks.profileId = 22; if (change === 'account') mocks.userId = 2; if (change === 'role') mocks.role = 'member'; view.rerender(<OwnerSupportNotificationSettings />);
    if (change !== 'role') await tab('Message templates'); await act(async () => pending.resolve({ ...state, email: { ...state.email, subject: 'Private old draft' } })); expect(screen.queryByDisplayValue('Private old draft')).toBeNull(); expect(mocks.toast).not.toHaveBeenCalled();
  });
  it.each(['member', 'billing_admin'])('does not read owner settings for %s', role => { mocks.role = role; render(<OwnerSupportNotificationSettings />); expect(screen.getByText('Notification settings require workspace owner access.')).toBeVisible(); expect(mocks.get).not.toHaveBeenCalled(); });
  it('does not read settings while workspace verification is unavailable', () => { mocks.profilesError = true; render(<OwnerSupportNotificationSettings />); expect(screen.getByRole('alert')).toHaveTextContent('workspace could not be verified'); expect(mocks.get).not.toHaveBeenCalled(); });
  it('ignores an older Strict Mode settings response after newer data and edits', async () => {
    const old = deferred<typeof state>(); let reads = 0; mocks.get.mockImplementation(async path => path.endsWith('notification-health') ? emptyHealth : ++reads === 1 ? old.promise : state);
    render(<StrictMode><OwnerSupportNotificationSettings /></StrictMode>); await tab('Message templates'); fireEvent.change(subject(), { target: { value: 'Newest draft' } }); await act(async () => old.resolve({ ...state, email: { ...state.email, subject: 'Old private response' } })); expect(subject()).toHaveValue('Newest draft');
  });
});
