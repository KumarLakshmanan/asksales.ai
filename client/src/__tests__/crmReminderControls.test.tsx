import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactReminderDialog, ReminderList, type CrmReminder } from '@/components/crm/ContactReminders';
import { normalizeApiTimestamps } from '@/lib/api-client';
import { crmRunHelp } from '@/lib/crm-run-help';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), toast: vi.fn(), change: vi.fn(), saved: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
  mocks.get.mockResolvedValue({ users: [{ id: 42, name: 'Alex Smith', email: 'alex@example.test' }] });
  mocks.post.mockResolvedValue({ id: 1 }); mocks.put.mockResolvedValue({ id: 1 });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Reusable CRM reminder controls', () => {
  it.each([
    { dueDate: '2099-10-03 08:30:00', snoozedUntil: null },
    { dueDate: '2099-10-03T08:30:00.000Z', snoozedUntil: null },
    { dueDate: '2099-10-03T14:00:00+05:30', snoozedUntil: null },
    { dueDate: '2099-10-02 08:30:00', snoozedUntil: '2099-10-03 08:30:00' },
  ])('keeps API reminder $dueDate / snooze $snoozedUntil at the same instant in the list and editor', async fields => {
    const reminder = normalizeApiTimestamps({
      id: 11, contactId: 15, contactName: 'Taylor', title: 'Review proposal', description: null,
      priority: 'medium', reminderType: 'followup', status: fields.snoozedUntil ? 'snoozed' : 'pending',
      createdAt: '2099-10-01T00:00:00Z', metadata: { notifyContact: false }, ...fields,
    }) as CrmReminder;
    const due = new Date('2099-10-03T08:30:00Z');
    render(<ReminderList reminders={[reminder]} />);
    const user = userEvent.setup();
    expect(screen.getByText(due.toLocaleDateString(undefined, { dateStyle: 'medium' }))).toBeVisible();
    expect(screen.getByText(due.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Edit Review proposal' }));
    const input = screen.getByLabelText('Due Date *');
    // Reading the native local input back must recover the original UTC instant.
    expect(new Date((input as HTMLInputElement).value).toISOString()).toBe(due.toISOString());
    expect(screen.getByRole('switch', { name: 'Email Taylor' })).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Update Reminder' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/crm/reminders/11', expect.objectContaining({ notifyContact: false })));
    expect(mocks.put.mock.calls[0][1]).not.toHaveProperty('dueDate');
  });

  it('creates an assigned follow-up in local time without emailing the contact by default', async () => {
    render(<ContactReminderDialog open onOpenChange={mocks.change} contactId={15} contactName="Taylor" onSaved={mocks.saved} />);
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'Alex Smith' });
    await user.type(screen.getByLabelText('Title *'), 'Review proposal');
    fireEvent.change(screen.getByLabelText('Due Date *'), { target: { value: '2099-10-03T14:45' } });
    await user.selectOptions(screen.getByLabelText('Assigned to'), '42');
    await user.click(screen.getByRole('button', { name: 'Add Reminder' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/crm/reminders', expect.objectContaining({ contactId: 15, assignedTo: 42, notifyContact: false, dueDate: new Date('2099-10-03T14:45').toISOString() })));
    expect(mocks.saved).toHaveBeenCalledOnce();
  });

  it('keeps an unchanged overdue due date when editing the title', async () => {
    const reminder: CrmReminder = { id: 11, contactId: 15, contactName: 'Taylor', title: 'Old follow-up', description: null, dueDate: '2020-01-01T09:00:00Z', priority: 'medium', reminderType: 'followup', status: 'pending', createdAt: '2020-01-01T00:00:00Z', assignedTo: 42, assignedName: 'Alex Smith' };
    render(<ContactReminderDialog open onOpenChange={mocks.change} reminder={reminder} />);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Title *')); await user.type(screen.getByLabelText('Title *'), 'Updated title');
    await user.click(screen.getByRole('button', { name: 'Update Reminder' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalled());
    expect(mocks.put.mock.calls[0][1]).toMatchObject({ title: 'Updated title', notifyContact: false });
    expect(mocks.put.mock.calls[0][1]).not.toHaveProperty('dueDate');
    expect(mocks.put.mock.calls[0][1]).not.toHaveProperty('assignedTo');
  });

  it('rejects changed past times and preserves the draft after a rejected save', async () => {
    render(<ContactReminderDialog open onOpenChange={mocks.change} contactId={15} contactName="Taylor" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Title *'), 'Call Taylor');
    fireEvent.change(screen.getByLabelText('Due Date *'), { target: { value: '2020-01-01T12:00' } });
    await user.click(screen.getByRole('button', { name: 'Add Reminder' }));
    expect(screen.getByText('Choose a time at least one minute from now.')).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Due Date *'), { target: { value: '2099-10-03T14:45' } });
    mocks.post.mockRejectedValueOnce(new Error('Reminder could not be saved.'));
    await user.click(screen.getByRole('button', { name: 'Add Reminder' }));
    await screen.findByText('Reminder could not be saved.');
    expect(screen.getByLabelText('Title *')).toHaveValue('Call Taylor');
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it('guards unsaved closing and requires content for explicit contact delivery', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<ContactReminderDialog open onOpenChange={mocks.change} contactId={15} contactName="Taylor" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Title *'), 'Call Taylor');
    fireEvent.change(screen.getByLabelText('Due Date *'), { target: { value: '2099-10-03T14:45' } });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.change).not.toHaveBeenCalled();
    await user.click(screen.getByRole('switch', { name: 'Email Taylor' }));
    await user.click(screen.getByRole('button', { name: 'Add Reminder' }));
    expect(screen.getByText('Add the message to email to this contact.')).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

describe('Automation troubleshooting guidance', () => {
  it('holds uncertain outcomes and gives specific recovery links without exposing raw provider content', () => {
    expect(crmRunHelp('token=private-value invalid credentials', 'failed')).toMatchObject({ title: 'Sending connection needs attention', href: '/dashboard/integrations' });
    expect(JSON.stringify(crmRunHelp('token=private-value invalid credentials', 'failed'))).not.toContain('private-value');
    expect(crmRunHelp(null, 'uncertain').description).toContain('before sending again');
    expect(crmRunHelp('Insufficient wallet balance', 'failed').href).toBe('/dashboard/billing');
    expect(crmRunHelp('Recipient phone is missing', 'failed').title).toBe('Contact details need attention');
  });
});
