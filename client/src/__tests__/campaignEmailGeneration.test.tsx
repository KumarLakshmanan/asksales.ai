import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendEmailModal } from '@/components/modals/SendEmailModal';
import { OutreachDialog } from '@/components/OutreachDialog';
import { ApiError } from '@/lib/api-client';
import { EMAIL_GENERATION_WAIT_MS } from '@/lib/emailGenerationRecovery';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), confirm: vi.fn(), close: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get, post: mocks.post } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

const leads = [{ id: 901, name: 'Fixture Ada', email: 'ada@example.test', company: 'Fixture Company', role: 'Operations' }];
const output = { subject: 'Reviewed AI subject', greeting: 'Hello {{first_name}},', body: 'Reviewed AI body.', cta: 'Read the notes.', closing: 'Kind regards,', signature: 'Fixture Team' };
const expectedBody = 'Hello {{first_name}},\n\nReviewed AI body.\n\nRead the notes.\n\nKind regards,\n\nFixture Team';
const nested = { success: true, content: JSON.stringify(output), emailContent: output };
const oldSubject = 'My existing subject';
const oldBody = 'My existing hand-written draft.';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const caller of ['SendEmailModal', 'OutreachDialog'] as const) {
  const element = (open = true, selectedLeads = leads) => caller === 'SendEmailModal'
    ? <SendEmailModal open={open} onOpenChange={mocks.close} leads={selectedLeads} initialSubject={oldSubject} initialBody={oldBody} onSuccess={mocks.confirm} />
    : <OutreachDialog open={open} onOpenChange={mocks.close} leads={selectedLeads} onConfirm={mocks.confirm} />;
  const subject = () => screen.getByLabelText('Subject', { exact: true });
  const body = () => screen.getByLabelText(caller === 'SendEmailModal' ? 'Email Body' : 'Body', { exact: true });
  const generate = () => screen.getByRole('button', { name: caller === 'SendEmailModal' ? 'AI Generate' : 'Generate Email' });
  async function mount() {
    const view = render(element());
    await act(async () => {});
    if (caller === 'OutreachDialog') {
      fireEvent.mouseDown(screen.getByRole('tab', { name: 'Custom Email' }), { button: 0 });
      fireEvent.change(screen.getByLabelText('Subject', { exact: true }), { target: { value: oldSubject } });
      fireEvent.change(screen.getByLabelText('Body', { exact: true }), { target: { value: oldBody } });
      fireEvent.mouseDown(screen.getByRole('tab', { name: 'Generate with AI' }), { button: 0 });
    }
    return view;
  }
  describe(`${caller} generation contract and draft safety`, () => {
    beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue([]); mocks.post.mockReset(); localStorage.clear(); sessionStorage.clear(); });
    afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });
    it.each([nested, { success: true, content: JSON.stringify(output) }, { success: true, emailContent: output }, { success: true, ...output }])('uses the valid unsaved result and includes all email sections %#', async response => {
      mocks.post.mockResolvedValue(response);
      await mount();
      fireEvent.click(generate());
      await waitFor(() => expect(subject()).toHaveValue(output.subject));
      expect(body()).toHaveValue(expectedBody);
      expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/api/content/studio/email', expect.objectContaining({ persist: false, prompt: expect.any(String) }), { signal: expect.any(AbortSignal) });
      expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Email Generated' }));
      expect(mocks.confirm).not.toHaveBeenCalled();
    });
    it.each([
      { success: true }, { success: true, content: 'malformed fixture JSON' },
      { success: true, emailContent: { subject: 'Missing body' } },
      { success: true, emailContent: { subject: '', body: 'Missing subject' } },
      { success: true, subject: 'HTML only', html: '<p>No required body</p>' },
      { success: false, ...output }, { ...output },
      { success: false, error: 'fixture-upstream-secret', emailContent: output },
    ])('rejects malformed/failed responses without fabricating or replacing the draft %#', async response => {
      mocks.post.mockResolvedValue(response);
      await mount();
      fireEvent.click(generate());
      await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
      expect(subject()).toHaveValue(oldSubject);
      expect(body()).toHaveValue(oldBody);
      expect(generate()).toBeEnabled();
      expect(mocks.toast.mock.calls.some(([notice]) => notice.title === 'Email Generated')).toBe(false);
      expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('fixture-upstream-secret');
      expect(screen.queryByText(/I hope this email finds you well/)).not.toBeInTheDocument();
    });
    it('retains the draft after a sanitized provider error', async () => {
      mocks.post.mockRejectedValue(new ApiError('fixture-upstream-secret', 503, { code: 'AI_PROVIDER_CREDITS' }));
      await mount();
      fireEvent.click(generate());
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('insufficient provider credits or a quota limit on the AskSales side');
      expect(alert).not.toHaveTextContent('fixture-upstream-secret');
      expect(subject()).toHaveValue(oldSubject);
      expect(body()).toHaveValue(oldBody);
      expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain('fixture-upstream-secret');
    });
    it('dispatches once for duplicate same-render clicks', async () => {
      const pending = deferred<typeof nested>();
      mocks.post.mockReturnValue(pending.promise);
      await mount();
      const button = generate();
      act(() => { button.click(); button.click(); });
      expect(mocks.post).toHaveBeenCalledTimes(1);
      await act(async () => { pending.resolve(nested); });
      expect(subject()).toHaveValue(output.subject);
    });
    it('stops waiting without replacing the draft or accepting a late success', async () => {
      const pending = deferred<typeof nested>();
      mocks.post.mockReturnValue(pending.promise);
      await mount();
      fireEvent.click(generate());
      const signal = mocks.post.mock.calls[0][2].signal as AbortSignal;
      fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));
      expect(signal.aborted).toBe(true);
      expect(generate()).toBeEnabled();
      await act(async () => { pending.resolve(nested); });
      expect(subject()).toHaveValue(oldSubject);
      expect(body()).toHaveValue(oldBody);
      expect(mocks.toast).not.toHaveBeenCalled();
    });
    it('times out waiting, releases the loader and ignores late failure', async () => {
      const pending = deferred<typeof nested>();
      mocks.post.mockReturnValue(pending.promise);
      await mount();
      vi.useFakeTimers();
      fireEvent.click(generate());
      act(() => { vi.advanceTimersByTime(EMAIL_GENERATION_WAIT_MS); });
      expect(mocks.post.mock.calls[0][2].signal.aborted).toBe(true);
      expect(generate()).toBeEnabled();
      expect(screen.getByRole('alert')).toHaveTextContent('taking longer than expected');
      await act(async () => { pending.reject(new Error('Fixture late failure')); });
      expect(subject()).toHaveValue(oldSubject);
      expect(body()).toHaveValue(oldBody);
      expect(mocks.toast).not.toHaveBeenCalled();
    });
    it('keeps manual edits made during an in-flight generation', async () => {
      const pending = deferred<typeof nested>();
      mocks.post.mockReturnValue(pending.promise);
      await mount();
      fireEvent.click(generate());
      fireEvent.change(body(), { target: { value: 'My newer manual edits' } });
      expect(mocks.post.mock.calls[0][2].signal.aborted).toBe(true);
      await act(async () => { pending.resolve(nested); });
      expect(subject()).toHaveValue(oldSubject);
      expect(body()).toHaveValue('My newer manual edits');
      expect(mocks.toast).not.toHaveBeenCalled();
    });
    it.each(['close', 'recipient', 'unmount', 'navigation'])('ignores a completion from before %s', async transition => {
      const pending = deferred<typeof nested>();
      mocks.post.mockReturnValue(pending.promise);
      const view = await mount();
      fireEvent.click(generate());
      const signal = mocks.post.mock.calls[0][2].signal as AbortSignal;
      if (transition === 'close') view.rerender(element(false));
      if (transition === 'recipient') view.rerender(element(true, [{ ...leads[0], id: 902, name: 'Fixture Bob' }]));
      if (transition === 'unmount') view.unmount();
      if (transition === 'navigation') fireEvent.mouseDown(screen.getByRole('tab', { name: caller === 'SendEmailModal' ? 'Preview' : 'Custom Email' }), { button: 0 });
      expect(signal.aborted).toBe(true);
      await act(async () => { pending.resolve(nested); });
      expect(mocks.toast).not.toHaveBeenCalled();
      expect(mocks.confirm).not.toHaveBeenCalled();
      if (transition === 'recipient') { expect(subject()).toHaveValue(oldSubject); expect(body()).toHaveValue(oldBody); }
    });
    it('does not let a cancelled older attempt finish a newer generation', async () => {
      const old = deferred<typeof nested>();
      const next = deferred<typeof nested>();
      mocks.post.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
      await mount();
      fireEvent.click(generate());
      fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));
      fireEvent.click(generate());
      await act(async () => { old.resolve(nested); });
      expect(screen.getByRole('button', { name: 'Generating...' })).toHaveAttribute('aria-disabled', 'true');
      expect(subject()).toHaveValue(oldSubject);
      await act(async () => { next.resolve({ ...nested, emailContent: { ...output, subject: 'Newest reviewed generation' } }); });
      expect(subject()).toHaveValue('Newest reviewed generation');
      expect(mocks.toast).toHaveBeenCalledTimes(1);
    });
  });
}
