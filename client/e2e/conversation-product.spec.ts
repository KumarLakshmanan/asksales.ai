import { test, expect, expectNoHorizontalOverflow, installAppShellMocks } from './fixtures/app';
import type { Page } from '@playwright/test';

type Fixture = { turns: Array<{ request_id: string; status: string }>; stops: string[]; messages: unknown[] };
async function runtime(page: Page, state: Fixture) {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'synthetic-conversation-audit');
    localStorage.setItem('selectedBusinessProfileId', '4102');
    const Native = window.WebSocket;
    const sockets: WebSocket[] = [];
    Object.assign(window, { auditSockets: sockets, auditSends: [] });
    class Socket extends EventTarget {
      static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
      readyState = 1; bufferedAmount = 0;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror = null;
      constructor(url: string | URL) {
        super();
        if (String(url).includes('/_next/')) return new Native(url) as unknown as Socket;
        sockets.push(this as unknown as WebSocket);
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      send(data: string) { (window as unknown as { auditSends: string[] }).auditSends.push(data); }
      close() { this.readyState = 3; }
    }
    Object.defineProperty(window, 'WebSocket', { value: Socket, configurable: true });
  });
  await installAppShellMocks(page);
  await page.route('**/api/**', async route => {
    const req = route.request(); const url = new URL(req.url()); const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/chat/threads/42/stop') {
      state.stops.push(req.postDataJSON().requestId);
      state.turns = state.turns.map(turn => ({ ...turn, status: 'cancelled' }));
      return json({ success: true, data: {} });
    }
    if (!['GET', 'HEAD'].includes(req.method())) return json({ error: 'Unhandled mutation blocked in synthetic QA' }, 409);
    if (['/api/auth/me','/api/platform/access','/api/settings/preferences','/api/settings/business-profiles',
      '/api/settings/outreach/assistants/catalog','/api/organizations','/api/wallet','/api/notifications/unread/count'].includes(path)) return route.fallback();
    if (path === '/api/chat/threads') return json({ threads: [], total: 0 });
    if (path === '/api/chat/threads/42') return json({ id: 42, title: 'Disposable conversation', businessId: 4102, metadata: {} });
    if (path === '/api/chat/threads/42/turns') return json({ success: true, data: state.turns });
    if (path === '/api/chat/threads/42/messages') return json({ messages: state.messages, hasMore: false, nextCursor: null });
    if (path === '/api/chat/threads/42/tabs') return json([{ tabId: 'overview-42', tabType: 'overview', tabLabel: 'Overview', tabOrder: 0, isActive: true }]);
    if (path === '/api/widgets') return json({ widgets: [] });
    if (path === '/api/icp/thread/42') return json(null);
    if (path === '/api/chat/threads/42/overview') return json({ thread: { id: 42, title: 'Disposable conversation' }, stats: {}, activeAgents: [], workflowExecutions: [], timeline: [] });
    if (path === '/api/chat/threads/42/context-window') return json({ threadId: 42, messageCount: 0, canCompact: false, summary: null, lastCompactedAt: null, tokenUsage: { totalTokens: 0, promptTokens: 0, completionTokens: 0, estimatedCurrentContextTokens: 0, maxContextTokens: 128000, modelName: 'Synthetic fixture', usagePercent: 0 } });
    return json([]);
  });
}
async function emit(page: Page, type: string, data: Record<string, unknown>, eventId: string) {
  await page.evaluate(({ type, data, eventId }) => {
    const sockets = (window as unknown as { auditSockets: WebSocket[] }).auditSockets;
    if (!sockets.length) throw new Error('No application socket was created');
    for (const socket of sockets) socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type, data, eventId, threadId: 42 }) }));
  }, { type, data, eventId });
}

test('reload polling settles, aliases preserve identity, and two tabs stop the same durable turn safely', async ({ page, context }, testInfo) => {
  const state: Fixture = { turns: [{ request_id: 'before-reload', status: 'running' }], stops: [], messages: [] };
  await runtime(page, state);
  await page.goto('/dashboard/chat/42');
  await expect(page).toHaveURL(/\/dashboard\/conversations\/42$/);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  state.turns = [{ request_id: 'before-reload', status: 'completed' }];
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveAttribute('placeholder', /Ask/);
  const second = await context.newPage();
  await runtime(second, state);
  state.turns = [{ request_id: 'second-turn', status: 'running' }];
  await second.goto('/dashboard/chats/42');
  await expect(second).toHaveURL(/\/dashboard\/conversations\/42$/);
  await expect(second.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await stop.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(second.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  expect(state.stops).toEqual(['second-turn']);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('conversation-after-stop.png'), fullPage: true });
  await second.close();
});

test('out-of-order streaming, duplicate delivery and reload retain one durable assistant message', async ({ page }, testInfo) => {
  const state: Fixture = { turns: [], stops: [], messages: [] };
  await runtime(page, state);
  await page.goto('/dashboard/conversations/42');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  const chunk = { thread_id: 42, responseId: 'synthetic-response', role: 'assistant', agentType: 'orchestrator', timestamp: Date.now() };
  await emit(page, 'chat_response_chunk', { ...chunk, sequence: 2, chunk: ' world', done: true }, 'chunk-2');
  await emit(page, 'chat_response_chunk', { ...chunk, sequence: 1, chunk: 'Hello', done: false }, 'chunk-1');
  await emit(page, 'chat_response_chunk', { ...chunk, sequence: 1, chunk: 'Hello', done: false }, 'chunk-1-repeat');
  await expect(page.getByText('Hello world', { exact: true })).toHaveCount(1);
  const message = { id: 101, role: 'assistant', content: 'Hello world', agentType: 'orchestrator', metadata: { responseId: 'synthetic-response' }, createdAt: new Date().toISOString() };
  state.messages = [message];
  await emit(page, 'chat_message', { thread_id: 42, message: { ...message, timestamp: Date.now() } }, 'durable-101');
  await emit(page, 'chat_response_chunk', { ...chunk, sequence: 3, chunk: ' late corruption', done: true }, 'late-3');
  await expect(page.getByText('Hello world', { exact: true })).toHaveCount(1);
  await page.reload();
  await expect(page.getByText('Hello world', { exact: true })).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('conversation-reloaded.png'), fullPage: true });
});
