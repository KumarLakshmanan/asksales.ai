import { installAppShellMocks } from './app';
import type { Page } from '@playwright/test';
export type Fixture = { turns: Array<{ request_id: string; status: string }>; stops: string[]; messages: unknown[] };
export async function runtime(page: Page, state: Fixture) {
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
export async function emit(page: Page, type: string, data: Record<string, unknown>, eventId: string) {
  await page.evaluate(({ type, data, eventId }) => {
    const sockets = (window as unknown as { auditSockets: WebSocket[] }).auditSockets;
    if (!sockets.length) throw new Error('No application socket was created');
    for (const socket of sockets) socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type, data, eventId, threadId: 42 }) }));
  }, { type, data, eventId });
}
