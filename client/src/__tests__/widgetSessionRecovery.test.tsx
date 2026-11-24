import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SupportWidgetPage from '@/app/support-widget/[token]/page';
import { afterAll as afterAllReadRetry, beforeAll as beforeAllReadRetry } from 'vitest';
import { TRANSIENT_READ_RETRY_DELAYS_MS, transientReadRetry } from '@/lib/api-client';

// These cases exercise the feature's own recovery screen after one failed
// read, so the API client's automatic read retry is turned off here.
beforeAllReadRetry(() => { transientReadRetry.delaysMs = []; });
afterAllReadRetry(() => { transientReadRetry.delaysMs = TRANSIENT_READ_RETRY_DELAYS_MS; });
vi.mock('next/navigation',() => ({useParams:() => ({token:'qa-widget'})}));
const key = 'sw_session_qa-widget';
beforeEach(() => {
  localStorage.setItem(key,'21'); localStorage.setItem(`${key}_token`,'session-credential');
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
it.each([429,503])('keeps the saved chat after a temporary %s during reload', async status => {
  vi.stubGlobal('fetch',vi.fn(async (url:string) => url.includes('/config')
    ? new Response(JSON.stringify({success:true,data:{teamName:'QA'}}))
    : new Response(JSON.stringify({error:'Temporary failure'}),{status})));
  render(<SupportWidgetPage />);
  await screen.findByRole('textbox');
  expect(localStorage.getItem(key)).toBe('21');
  expect(localStorage.getItem(`${key}_token`)).toBe('session-credential');
});
it('restores an attachment card from history', async () => {
  vi.stubGlobal('fetch',vi.fn(async (url:string) => new Response(JSON.stringify(url.includes('/config')
    ? {success:true,data:{teamName:'QA'}}
    : {success:true,data:[{id:42,role:'assistant',content:'Here is the brochure.',metadata:{documents:[{id:8,title:'Day outing brochure'}]}}]}))));
  render(<SupportWidgetPage />);
  expect(await screen.findByRole('button',{name:'Download Day outing brochure (PDF)'})).toBeEnabled();
});
it('clears expired credentials instead of treating them as recoverable', async () => {
  vi.stubGlobal('fetch',vi.fn(async (url:string) => url.includes('/config')
    ? new Response(JSON.stringify({success:true,data:{teamName:'QA'}}))
    : new Response(JSON.stringify({error:'Expired'}),{status:440})));
  render(<SupportWidgetPage />);
  await waitFor(() => expect(localStorage.getItem(key)).toBeNull());
  expect(localStorage.getItem(`${key}_token`)).toBeNull();
});
it('accepts queued turns without fabricating an assistant message and permits the next message', async () => {
  let nextId = 1;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('/config')) return new Response(JSON.stringify({ success: true, data: { teamName: 'QA' } }));
    if (url.endsWith('/chat')) return new Response(JSON.stringify({ success: true, data: {
      sessionId: 21, sessionToken: 'session-credential', assistantMessage: null, processingStatus: 'queued',
      userMessage: { id: nextId++, role: 'user', content: JSON.parse(String(options?.body)).message, processingStatus: 'processing', createdAt: new Date().toISOString() },
    } }), { status: 202 });
    return new Response(JSON.stringify({ success: true, data: [] }));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<SupportWidgetPage />);
  const input = await screen.findByRole('textbox');
  fireEvent.change(input, { target: { value: '2 adults and 2 kids' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(input).not.toBeDisabled());
  expect(await screen.findByText('2 adults and 2 kids')).toBeInTheDocument();
  fireEvent.change(input, { target: { value: 'Kids 1 and 7 years' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(screen.getByText('Kids 1 and 7 years')).toBeInTheDocument());
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/chat'))).toHaveLength(2));
  expect(screen.queryByText("We couldn't confirm your message. Please try again.")).not.toBeInTheDocument();
});
it('describes an uncertain send outcome without claiming the message was not received', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/config')) return new Response(JSON.stringify({ success: true, data: { teamName: 'QA' } }));
    if (url.endsWith('/chat')) return new Response(JSON.stringify({ error: 'Temporary failure' }), { status: 500 });
    return new Response(JSON.stringify({ success: true, data: [] }));
  }));
  render(<SupportWidgetPage />);
  const input = await screen.findByRole('textbox');
  fireEvent.change(input, { target: { value: 'Test message' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(await screen.findByText("We couldn't confirm your message. Please try again.")).toBeInTheDocument();
  expect(input).toHaveValue('Test message');
});
