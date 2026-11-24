import { webcrypto } from 'node:crypto';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowUpTemplateDialog } from '@/components/follow-ups/FollowUpTemplates';
import { selectBusinessProfile } from '@/lib/business-profile';

const mocks = vi.hoisted(() => ({ scope: '4101:4102', created: vi.fn(), toast: vi.fn() }));
vi.mock('@/hooks/use-outreach-draft-scope', () => ({ useOutreachDraftScope: () => mocks.scope }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
function Workspace() { const [open, setOpen] = useState(true); return <><button onClick={() => setOpen(true)}>Reopen draft</button><FollowUpTemplateDialog channel="email" open={open} onOpenChange={setOpen} onCreated={mocks.created} /></>; }
const receipt = () => new Response(JSON.stringify({ success: true, data: { id: 77, name: 'Synthetic intent', content: 'Synthetic private wording' } }), { status: 201, headers: { 'Content-Type': 'application/json', 'Content-Request-Confirmed': 'true' } });
function fill() {
  fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Synthetic intent' } });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Synthetic private wording' } });
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.clearAllMocks(); mocks.scope = '4101:4102'; localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('user', JSON.stringify({ id: 4101 })); selectBusinessProfile(4102); vi.stubGlobal('crypto', webcrypto);
});
describe('actual template API client receipt recovery', () => {
  it.each(['fetch', 'body'])('retains the same key through stalled %s, late confirmation, dismissal and explicit retry', async stalled => {
    let finish!: (value: Response) => void; let finishBody!: (value: unknown) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => stalled === 'fetch'
      ? new Promise<Response>(resolve => { finish = resolve; })
      : Promise.resolve({ ok: true, status: 201, headers: new Headers({ 'Content-Type': 'application/json', 'Content-Request-Confirmed': 'true' }), json: () => new Promise(resolve => { finishBody = resolve; }) }))
      .mockImplementation(async () => receipt());
    vi.stubGlobal('fetch', fetcher); render(<Workspace />); fill(); vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Create template' }));
    await act(async () => { await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    expect(screen.getByRole('alert')).toHaveTextContent('unconfirmed');
    expect(screen.getByLabelText('Message')).toBeDisabled();
    const firstKey = new Headers(fetcher.mock.calls[0][1].headers).get('Idempotency-Key'); expect(firstKey).toBeTruthy();
    await act(async () => { if (stalled === 'fetch') finish(receipt()); else finishBody({ success: true, data: { id: 77, content: 'Synthetic private wording' } }); });
    expect(mocks.created).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close draft' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    fireEvent.click(screen.getByRole('button', { name: 'Reopen draft' }));
    expect(screen.getByLabelText('Message')).toHaveValue('Synthetic private wording');
    fireEvent.click(screen.getByRole('button', { name: 'Retry same create' }));
    await act(async () => { await vi.waitFor(() => expect(mocks.created).toHaveBeenCalledTimes(1)); });
    expect(mocks.created).toHaveBeenCalledWith(expect.objectContaining({ id: 77 }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new Headers(fetcher.mock.calls[1][1].headers).get('Idempotency-Key')).toBe(firstKey);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('Synthetic private wording');
    expect(JSON.stringify(window.history.state)).not.toContain('Synthetic private wording');
  });
});
