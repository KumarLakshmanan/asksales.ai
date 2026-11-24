import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { conversationAttempt } from '@/lib/conversation-attempt';
const params = vi.hoisted(() => ({ token: 'widget-audit-0' }));
vi.mock('next/navigation', () => ({ useParams: () => params }));
vi.mock('@/lib/widget-history-poll', () => ({ startWidgetHistoryPoll: () => () => {} }));
import SupportWidgetPage from '@/app/support-widget/[token]/page';

let sequence = 0;
beforeEach(() => {
  params.token = `widget-audit-${++sequence}`;
  localStorage.clear();
  sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it('starts a fresh first-message identity after an expired uncertain attempt is explicitly reset', async () => {
  const prior = conversationAttempt(`widget:${params.token}:new`, 'Hours?', null);
  const bodies: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (String(url).includes('/config')) return response({ success: true, data: { teamName: 'Synthetic help' } });
    bodies.push(JSON.parse(String(options?.body)));
    return response({ error: 'Expired conversation' }, 401);
  });
  render(<SupportWidgetPage />);
  const input = await screen.findByRole('textbox', { name: 'Message to support' });
  await waitFor(() => expect(input).toHaveValue('Hours?'));
  fireEvent.keyDown(input, { key: 'Enter' });
  await screen.findByText(/This conversation has expired/);
  await waitFor(() => expect(screen.getByRole('button', { name: 'New chat' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  fireEvent.change(input, { target: { value: 'Hours?' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[0].clientSessionKey).toBe(prior.clientSessionKey);
  expect(bodies[1].clientSessionKey).not.toBe(prior.clientSessionKey);
  expect(bodies[1].requestId).not.toBe(prior.requestId);
});
