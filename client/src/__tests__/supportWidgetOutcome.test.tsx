import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ useParams: () => ({ token: 'outcome-widget' }) }));
vi.mock('@/lib/widget-history-poll', () => ({ startWidgetHistoryPoll: () => () => {} }));
import SupportWidgetPage from '@/app/support-widget/[token]/page';
const notice = 'Your message was saved, but an automated reply is not available.';
const userMessage = { id: 1, role: 'user', content: 'Synthetic question', processingStatus: 'completed', sources: [], confidence: null, createdAt: '2026-10-23T00:00:00Z' };
const response = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
beforeEach(() => {
  localStorage.clear();sessionStorage.clear();Element.prototype.scrollIntoView = vi.fn();
  localStorage.setItem('sw_session_outcome-widget', '1');localStorage.setItem('sw_session_outcome-widget_token', 'synthetic-session');
});
afterEach(() => { cleanup();vi.restoreAllMocks(); });
function history(messages: unknown[], handoff?: string) {
  return vi.spyOn(globalThis,'fetch').mockImplementation(url => response(String(url).includes('/config')
    ? { success: true, data: { teamName: 'Synthetic help' } }
    : { success: true, data: messages, session: { handoff } }));
}
it('explains a completed unanswered message restored from history', async () => {
  history([userMessage]);render(<SupportWidgetPage />);
  await screen.findByText('Synthetic question');expect(await screen.findByText(notice)).toHaveAttribute('role','status');
  expect(screen.queryByText('Preparing a response…')).not.toBeInTheDocument();
});
it.each(['queued','processing','committing','reconciliation_required','cancelled'])('preserves the distinct %s state', async processingStatus => {
  history([{...userMessage,processingStatus}]);render(<SupportWidgetPage />);await screen.findByText('Synthetic question');expect(screen.queryByText(notice)).not.toBeInTheDocument();
});
it('preserves human handoff without replacing it with an unavailable notice', async () => {
  history([userMessage],'requested');render(<SupportWidgetPage />);await screen.findByText('Synthetic question');expect(screen.queryByText(notice)).not.toBeInTheDocument();
});
it('does not show the notice for an answered turn', async () => {
  history([userMessage,{...userMessage,id:2,role:'assistant',content:'Synthetic answer'}]);render(<SupportWidgetPage />);await screen.findByText('Synthetic answer');expect(screen.queryByText(notice)).not.toBeInTheDocument();
});
it('explains immediate completed no-op acknowledgement without automatically resending', async () => {
  localStorage.clear();let sends=0;
  vi.spyOn(globalThis,'fetch').mockImplementation((url,options) => {
    if(String(url).includes('/chat')){sends++;expect(options?.method).toBe('POST');return response({success:true,data:{sessionId:1,sessionToken:'synthetic-session',userMessage,assistantMessage:null}});}
    return response({success:true,data:{teamName:'Synthetic help'}});
  });
  render(<SupportWidgetPage />);const input=await screen.findByRole('textbox',{name:'Message to support'});fireEvent.change(input,{target:{value:'Synthetic question'}});fireEvent.keyDown(input,{key:'Enter'});
  await screen.findByText(notice);expect(sends).toBe(1);
});

it('omits owner credentials from public config and session restoration reads', async () => {
  const fetch=history([userMessage]);render(<SupportWidgetPage />);await screen.findByText('Synthetic question');
  for(const [,options] of fetch.mock.calls) expect(options?.credentials).toBe('omit');
});
