import { test as base } from '@playwright/test';
import { expect, installAppShellMocks, expectNoHorizontalOverflow } from './app';

type SpeechPart = { text: string; final: boolean };
type SpeechCommand = {
  action: 'result' | 'error' | 'end' | 'start' | 'fail-next-start' | 'unsupported' | 'webkit';
  instance?: number;
  parts?: SpeechPart[];
  error?: string;
};
type SpeechSnapshot = {
  starts: number; stops: number; aborts: number;
  continuous: boolean; interimResults: boolean; lang: string;
};
type BrowserInputState = {
  recognition: SpeechSnapshot[];
  microphoneRequests: number;
  sends: Array<{ type?: string; data?: Record<string, unknown> }>;
};

export const test = base.extend<{
  inputRuntime: {
    threadCreates: Record<string, unknown>[];
    unexpectedMutations: string[];
    snapshot: () => Promise<BrowserInputState>;
    speech: (command: SpeechCommand) => Promise<void>;
  };
}>({
  inputRuntime: [async ({ page, context, baseURL }, use) => {
    const origin = new URL(baseURL!).origin;
    if (origin !== 'http://127.0.0.1:3066') throw new Error('Use playwright.mobile-input.config.ts: local-only suite');
    const threadCreates: Record<string, unknown>[] = [];
    const unexpectedMutations: string[] = [];
    const externalRequests: string[] = [];
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    // No real account, backend, provider, or off-origin HTTP traffic may be used.
    await context.clearPermissions();
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin && ['http:', 'https:'].includes(url.protocol)) {
        externalRequests.push(url.origin + url.pathname);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    await page.route('**/api/**', route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (!['GET', 'HEAD'].includes(request.method())) {
        if (path === '/api/chat/threads' && request.method() === 'POST') {
          threadCreates.push(request.postDataJSON());
          return route.fulfill({ status: 409, json: { error: 'Synthetic thread rejection; draft must be preserved.' } });
        }
        unexpectedMutations.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 409, json: { error: 'Unexpected synthetic mutation blocked.' } });
      }
      if (path === '/api/dashboard/stats') return route.fulfill({ json: {} });
      if (path === '/api/suggestions') return route.fulfill({ json: { success: true, suggestions: [] } });
      if (path === '/api/setup/onboarding-status') return route.fulfill({ json: { profile: {}, completedTasks: ['brand'], connectedChannels: [] } });
      if (path === '/api/chat/threads') return route.fulfill({ json: { threads: [], total: 0 } });
      if (/^\/api\/chat\/threads\/42$/.test(path)) return route.fulfill({ json: { id: 42, title: 'Synthetic input lifecycle', businessId: 4102, metadata: {} } });
      if (path.endsWith('/messages')) return route.fulfill({ json: { messages: [], hasMore: false, nextCursor: null } });
      if (path.endsWith('/turns')) return route.fulfill({ json: { success: true, data: [] } });
      if (path.endsWith('/tabs')) return route.fulfill({ json: [{ tabId: 'overview-42', tabType: 'overview', tabLabel: 'Overview', tabOrder: 0, isActive: true }] });
      if (path.endsWith('/overview')) return route.fulfill({ json: {
        thread: { id: 42, title: 'Synthetic input lifecycle', createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z' },
        stats: { messageCount: 0, leadsCount: 0, contentAssetsCount: 0, agentExecutionsCount: 0, outreachCount: 0, scrapingCount: 0 },
        icp: null, activeAgents: [], workflowExecutions: [], timeline: [],
      } });
      if (path.endsWith('/context-window')) return route.fulfill({ json: {
        threadId: 42, messageCount: 0, canCompact: false, summary: null, lastCompactedAt: null,
        tokenUsage: { totalTokens: 0, promptTokens: 0, completionTokens: 0, estimatedCurrentContextTokens: 0, maxContextTokens: 128000, modelName: 'Synthetic', usagePercent: 0 },
      } });
      if (path === '/api/widgets') return route.fulfill({ json: { widgets: [] } });
      if (path === '/api/icp/thread/42') return route.fulfill({ json: null });
      return route.fulfill({ json: [] });
    });
    await installAppShellMocks(page);
    await page.route('**/api/chat/threads?*', route => route.fulfill({ json: { threads: [{
      id: 42, title: 'Synthetic input lifecycle', selectedAgent: null, stats: {},
      createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z',
    }], total: 1 } }));
    await page.addInitScript(() => {
      const scope = window as unknown as {
        inputTest: {
          instances: MockRecognition[]; microphoneRequests: number;
          sends: Array<{ type?: string; data?: Record<string, unknown> }>;
          failNextStart: boolean; speech: (command: SpeechCommand) => void;
        };
      };
      class MockRecognition {
        starts = 0; stops = 0; aborts = 0;
        continuous = false; interimResults = false; lang = '';
        onstart: (() => void) | null = null;
        onend: (() => void) | null = null;
        onerror: ((event: { error: string }) => void) | null = null;
        onresult: ((event: { results: unknown[] }) => void) | null = null;
        constructor() { scope.inputTest.instances.push(this); }
        start() {
          this.starts++;
          if (scope.inputTest.failNextStart) {
            scope.inputTest.failNextStart = false;
            throw new DOMException('Synthetic start failure', 'NotAllowedError');
          }
          this.onstart?.();
        }
        // Deliberately keep callbacks alive to emulate delayed browser delivery.
        stop() { this.stops++; }
        abort() { this.aborts++; }
      }
      scope.inputTest = {
        instances: [], microphoneRequests: 0, sends: [], failNextStart: false,
        speech(command) {
          if (command.action === 'fail-next-start') { this.failNextStart = true; return; }
          if (command.action === 'unsupported' || command.action === 'webkit') {
            Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
            Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: command.action === 'webkit' ? MockRecognition : undefined });
            return;
          }
          const recognition = this.instances[command.instance ?? this.instances.length - 1];
          if (!recognition) throw new Error('No mock recognition instance');
          if (command.action === 'result') recognition.onresult?.({ results: (command.parts ?? []).map(part => Object.assign([{ transcript: part.text }], { isFinal: part.final })) });
          if (command.action === 'error') recognition.onerror?.({ error: command.error ?? 'network' });
          if (command.action === 'end') recognition.onend?.();
          if (command.action === 'start') recognition.onstart?.();
        },
      };
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: MockRecognition });
      Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
        getUserMedia: () => {
          scope.inputTest.microphoneRequests++;
          return Promise.reject(new DOMException('Real microphone is forbidden in this suite', 'NotAllowedError'));
        },
      } });
      const NativeSocket = window.WebSocket;
      class InputSocket extends EventTarget {
        static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
        readyState = 1; bufferedAmount = 0;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onerror = null;
        constructor(url: string | URL, protocols?: string | string[]) {
          super();
          const target = new URL(String(url), location.href);
          if (target.host === location.host && target.pathname.startsWith('/_next/')) return new NativeSocket(url, protocols) as unknown as InputSocket;
          queueMicrotask(() => this.onopen?.(new Event('open')));
        }
        send(data: string) { scope.inputTest.sends.push(JSON.parse(data)); }
        close() { this.readyState = 3; }
      }
      Object.defineProperty(window, 'WebSocket', { configurable: true, value: InputSocket });
    });
    const snapshot = () => page.evaluate(() => {
      const state = (window as unknown as { inputTest: { instances: SpeechSnapshot[]; microphoneRequests: number; sends: BrowserInputState['sends'] } }).inputTest;
      return { recognition: state.instances.map(({ starts, stops, aborts, continuous, interimResults, lang }) => ({ starts, stops, aborts, continuous, interimResults, lang })), microphoneRequests: state.microphoneRequests, sends: state.sends };
    });
    await use({
      threadCreates, unexpectedMutations, snapshot,
      speech: command => page.evaluate(command => (window as unknown as { inputTest: { speech: (command: SpeechCommand) => void } }).inputTest.speech(command), command),
    });
    expect((await snapshot()).microphoneRequests, 'No native microphone acquisition').toBe(0);
    expect(unexpectedMutations).toEqual([]);
    expect(externalRequests, 'No off-origin resource requests').toEqual([]);
    expect(pageErrors).toEqual([]);
  }, { auto: true }],
});

export { expect, expectNoHorizontalOverflow };
