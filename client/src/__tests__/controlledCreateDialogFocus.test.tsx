import { StrictMode, useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateContactDialog } from '@/components/crm/CreateContactDialog';
import { CreateSupportTicketDialog } from '@/components/support/CreateSupportTicketDialog';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), created: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

function Fixture({ kind = 'contact', revision = 0, showDialog = true, nextDialog = false, captureOpener = false, showFirstOpener = true }: {
  kind?: 'contact' | 'support ticket'; revision?: number; showDialog?: boolean; nextDialog?: boolean; captureOpener?: boolean; showFirstOpener?: boolean;
}) {
  const CreateDialog = kind === 'contact' ? CreateContactDialog : CreateSupportTicketDialog;
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const openFrom = (button: HTMLButtonElement) => { openerRef.current = button; setOpen(true); };
  return <>
    {showFirstOpener && <button onClick={event => openFrom(event.currentTarget)}>First opener</button>}
    <button onClick={event => openFrom(event.currentTarget)}>Second opener</button>
    <button>New navigation action</button>
    <span>Revision {revision}</span>
    {showDialog && <CreateDialog open={open} onOpenChange={setOpen} onCreated={mocks.created}
      returnFocusRef={captureOpener ? openerRef : undefined} />}
    <Dialog open={nextDialog}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Newer dialog</DialogTitle>
        <button>Newer dialog action</button>
      </DialogContent>
    </Dialog>
  </>;
}

beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function settled() {
  // Radix restores focus in a deferred unmount callback. Assert after that runs.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
}

describe.each(['contact', 'support ticket'] as const)('%s dialog focus lifecycle', kind => {
  const CreateDialog = kind === 'contact' ? CreateContactDialog : CreateSupportTicketDialog;
  const title = kind === 'contact' ? 'Add Contact' : 'Create support ticket';
  const initialLabel = kind === 'contact' ? 'First name' : 'Subject';
  const draftLabel = kind === 'contact' ? 'Company' : 'Description';
  const fieldLabels = kind === 'contact' ? ['First name', 'Last name', 'Email', 'Phone', 'Company', 'Job role'] : ['Subject', 'Description', 'CRM customer'];
  it.each(['Cancel', 'Escape', 'Close'])('restores the exact opener after %s on repeated keyboard cycles', async method => {
    const user = userEvent.setup();
    render(<Fixture kind={kind} />);
    for (const name of ['First opener', 'Second opener', 'First opener']) {
      const opener = screen.getByRole('button', { name });
      opener.focus();
      await user.keyboard('{Enter}');
      const dialog = await screen.findByRole('dialog', { name: title });
      for (const label of fieldLabels) {
        expect(within(dialog).getByLabelText(label)).toHaveValue('');
      }
      if (kind === 'support ticket') expect(within(dialog).getByRole('button', { name: 'Create and open' })).toBeDisabled();
      if (method === 'Escape') await user.keyboard('{Escape}');
      else {
        within(dialog).getByRole('button', { name: method }).focus();
        await user.keyboard('{Enter}');
      }
      await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).toBeNull());
      await settled();
      expect(document.activeElement).toBe(opener);
    }
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.created).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('retains the opening control through unrelated controlled rerenders', async () => {
    const view = render(<Fixture kind={kind} />);
    const opener = screen.getByRole('button', { name: 'Second opener' });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole('dialog', { name: title });
    view.rerender(<Fixture kind={kind} revision={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settled();
    expect(document.activeElement).toBe(opener);
  });

  it('uses the captured activation target even when clicking did not focus it', async () => {
    render(<StrictMode><Fixture kind={kind} captureOpener /></StrictMode>);
    screen.getByRole('button', { name: 'New navigation action' }).focus();
    const opener = screen.getByRole('button', { name: 'Second opener' });
    fireEvent.click(opener);
    await screen.findByRole('dialog', { name: title });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settled();
    expect(document.activeElement).toBe(opener);
  });

  it('takes a snapshot of an explicit opener ref rather than following later ref changes', async () => {
    const openerRef = { current: null as HTMLElement | null };
    const ui = (open: boolean) => <>
      <button>Original opener</button><button>Replacement control</button>
      <CreateDialog open={open} onOpenChange={vi.fn()} returnFocusRef={openerRef} />
    </>;
    const view = render(ui(false));
    const original = screen.getByRole('button', { name: 'Original opener' });
    const replacement = screen.getByRole('button', { name: 'Replacement control' });
    openerRef.current = original;
    view.rerender(ui(true));
    await screen.findByRole('dialog', { name: title });
    openerRef.current = replacement;
    view.rerender(ui(false));
    await settled();
    expect(document.activeElement).toBe(original);
  });

  it('keeps an unsaved draft when cancelling without writing a record', async () => {
    render(<Fixture kind={kind} />);
    const opener = screen.getByRole('button', { name: 'First opener' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.change(await screen.findByLabelText(draftLabel), { target: { value: 'Disposable draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settled();
    fireEvent.click(opener);
    expect(await screen.findByLabelText(draftLabel)).toHaveValue('Disposable draft');
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.created).not.toHaveBeenCalled();
  });

  it('does not reclaim focus from a newer navigation action during close', async () => {
    render(<Fixture kind={kind} />);
    const opener = screen.getByRole('button', { name: 'First opener' });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole('dialog', { name: title });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const next = screen.getByRole('button', { name: 'New navigation action' });
    next.focus();
    await settled();
    expect(document.activeElement).toBe(next);
  });

  it('remembers a newer focus action even when that action subsequently blurs', async () => {
    render(<Fixture kind={kind} />);
    const opener = screen.getByRole('button', { name: 'First opener' });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole('dialog', { name: title });
    const focus = vi.spyOn(opener, 'focus');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const next = screen.getByRole('button', { name: 'New navigation action' });
    next.focus();
    next.blur();
    await settled();
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(['pointer', 'keyboard'])('yields to a newer %s action even without a focus destination', async action => {
    render(<Fixture kind={kind} />);
    const opener = screen.getByRole('button', { name: 'First opener' });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole('dialog', { name: title });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const next = screen.getByRole('button', { name: 'New navigation action' });
    if (action === 'pointer') fireEvent.pointerDown(next);
    else fireEvent.keyDown(next, { key: 'Enter' });
    const focus = vi.spyOn(opener, 'focus');
    await settled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('does not restore focus after the route changes during a deferred close', async () => {
    render(<Fixture kind={kind} />);
    const opener = screen.getByRole('button', { name: 'First opener' });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole('dialog', { name: title });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const focus = vi.spyOn(opener, 'focus');
    const previousUrl = window.location.href;
    try {
      window.history.pushState(null, '', '/newer-navigation');
      await settled();
      expect(focus).not.toHaveBeenCalled();
    } finally { window.history.replaceState(null, '', previousUrl); }
  });

  it.each(['removed', 'disabled', 'hidden', 'inert', 'aria-hidden'])('does not restore an opener that is %s during close', async state => {
    const view = render(<Fixture kind={kind} />);
    const opener = screen.getByRole('button', { name: 'First opener' });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole('dialog', { name: title });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    if (state === 'removed') view.rerender(<Fixture kind={kind} showFirstOpener={false} />);
    else opener.setAttribute(state, state === 'aria-hidden' ? 'true' : '');
    const focus = vi.spyOn(opener, 'focus');
    await settled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('does not focus the opener when its consumer unmounts while open', async () => {
    const view = render(<Fixture kind={kind} />);
    const opener = screen.getByRole('button', { name: 'First opener' });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole('dialog', { name: title });
    const focus = vi.spyOn(opener, 'focus');
    view.rerender(<Fixture kind={kind} showDialog={false} />);
    await settled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('yields a closing dialog to a newer dialog opened before close settles', async () => {
    const view = render(<Fixture kind={kind} />);
    const opener = screen.getByRole('button', { name: 'First opener' });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole('dialog', { name: title });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    view.rerender(<Fixture kind={kind} nextDialog />);
    await settled();
    expect(screen.getByRole('button', { name: 'Newer dialog action' })).toHaveFocus();
  });

  it('ignores a retired focus callback after an immediate reopen', async () => {
    render(<Fixture kind={kind} />);
    const opener = screen.getByRole('button', { name: 'First opener' });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole('dialog', { name: title });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const second = screen.getByRole('button', { name: 'Second opener' });
    second.focus();
    fireEvent.click(second);
    await settled();
    expect(screen.getByLabelText(initialLabel)).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settled();
    expect(document.activeElement).toBe(second);
  });
});
