import { webcrypto } from 'node:crypto';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowUpTemplates, FollowUpTemplateDialog } from '@/components/follow-ups/FollowUpTemplates';
import { FollowUpSettings } from '@/components/FollowUpSettings';
import { FollowUpHistory } from '@/components/follow-ups/FollowUpHistory';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), toast: vi.fn(), scope: '4101:4102' }));
vi.mock('@/hooks/use-outreach-draft-scope', () => ({ useOutreachDraftScope: () => mocks.scope }));
vi.mock('@/hooks/use-paginated-content-templates', () => ({ usePaginatedContentTemplates: () => ({ templates: [], refetch: vi.fn() }) }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/contexts/PreferencesContext', () => ({ usePreferences: () => ({ formatDate: (value: string) => value }) }));
vi.mock('@/components/outreach/TemplateSelector', () => ({ TemplateSelector: () => null }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto); mocks.scope = '4101:4102';
  mocks.get.mockResolvedValue({ revision: 'r1', fenced: true, enableAutoFollowUp: false, followUpSteps: [{ id: 'one', enabled: true, delayValue: 1, delayUnit: 'days', templateId: null, templateName: '' }] });
});
describe('follow-up dialog focus and bounded recovery', () => {
  it.each(['library', 'step'])('returns keyboard focus to the %s opener after Escape', async entry => {
    render(entry === 'library' ? <FollowUpTemplates channel="email" /> : <FollowUpSettings integrationKey="email" />);
    const opener = await screen.findByRole('button', { name: entry === 'library' ? 'Create template' : 'Create template for step 1' });
    opener.focus(); fireEvent.click(opener);
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });
  it('bounds a stalled history read, releases Refresh and retries with the original offset', async () => {
    mocks.get.mockImplementation(() => new Promise(() => {}));
    render(<FollowUpHistory channel="sms" />);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    vi.useFakeTimers();
    // Establish the timer under fake time with an explicit retry lifecycle.
    cleanup(); render(<FollowUpHistory channel="sms" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    expect(screen.getByRole('alert')).toHaveTextContent(/timed out/i);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    mocks.get.mockResolvedValue([{ id: 7, message: 'Synthetic recovered', status: 'sent', followUpStep: 1 }]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => {});
    expect(screen.getByText('Synthetic recovered')).toBeVisible();
    expect(mocks.get.mock.calls.at(-1)?.[0]).toContain('offset=0');
  });
  it('bounds a stalled template create and retains the uncertain draft on dismissal and reopen', async () => {
    const Controlled = () => { const [open, setOpen] = useState(false); return <><button onClick={() => setOpen(true)}>New draft</button><FollowUpTemplateDialog channel="email" open={open} onOpenChange={setOpen} onCreated={vi.fn()} /></>; };
    mocks.post.mockImplementation(() => new Promise(() => {}));
    render(<Controlled />); fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Unconfirmed template' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Synthetic private wording' } });
    vi.useFakeTimers(); fireEvent.click(screen.getByRole('button', { name: 'Create template' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    expect(screen.getByRole('alert')).toHaveTextContent(/unconfirmed/i);
    expect(screen.getByRole('button', { name: 'Close draft' })).toBeEnabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
    expect(screen.getByLabelText('Message')).toHaveValue('Synthetic private wording');
    expect(screen.getByLabelText('Message')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Retry same create/i })).toBeEnabled();
  });
});
