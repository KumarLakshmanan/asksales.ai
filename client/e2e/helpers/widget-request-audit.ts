import { createHash, randomUUID } from 'node:crypto';
import type { Page, Request as BrowserRequest } from '@playwright/test';

const identityHeader = 'x-finder-widget-read-id';
const widgetPath = '/api/support-widget/token';

export interface WidgetSourceProof {
  scriptUrl: string;
  scriptSha256: string;
  moduleId: string;
  line: number;
  column: number;
  statement: string;
}

/** Resolve the actual loaded Turbopack frame, including hashed chunk names. */
export function widgetEffectSourceProof(stack: string, scriptUrl: string, source: string): WidgetSourceProof | null {
  const frame = stack.match(/at WidgetSettingsWorkspace\.useEffect \((https?:\/\/.+?):(\d+):(\d+)\)/);
  if (!frame || frame[1] !== scriptUrl) return null;
  const line = Number(frame[2]);
  const lines = source.split('\n');
  if (line < 1 || line > lines.length) return null;
  let moduleId = '';
  for (const text of lines.slice(0, line)) {
    const moduleMarker = text.trimStart().match(/^"(\[project\]\/[^"\n]+)",\s*\(\(/);
    if (moduleMarker) moduleId = moduleMarker[1];
  }
  return { scriptUrl, scriptSha256: createHash('sha256').update(source).digest('hex'), moduleId, line, column: Number(frame[3]), statement: lines[line - 1].trim() };
}

export interface WidgetOperationEvent {
  stage: 'fetch-start' | 'signal-abort' | 'fetch-fulfilled' | 'fetch-rejected';
  sequence: number;
  observedSequence: number;
  operationId: string;
  controllerId: string | null;
  signalId: string | null;
  method: string;
  url: string;
  createdStack: string;
  fetchStack: string;
  abortStack?: string;
  initiallyAborted: boolean;
  errorName?: string;
  fetchState?: 'pending' | 'fulfilled' | 'rejected';
  createdSource?: WidgetSourceProof | null;
  fetchSource?: WidgetSourceProof | null;
  abortSource?: WidgetSourceProof | null;
}

export interface RequestIdentity {
  networkRequestId: string;
  operationId: string | null;
  method: string;
  url: string;
}

export interface RequestFailure extends RequestIdentity { error: string; observedSequence: number }
export interface WidgetRequestAudit {
  requests: RequestIdentity[];
  failures: RequestFailure[];
  events: WidgetOperationEvent[];
}

export function classifyWidgetRequestFailures(audit: WidgetRequestAudit) {
  const expected: RequestFailure[] = [];
  const unexpected: RequestFailure[] = [];
  const widgetSource = /client\/src\/app\/dashboard\/\(main\)\/support-ai\/widget-settings\/page\.tsx \[app-client\]/;
  const widgetEffect = /WidgetSettingsWorkspace\.useEffect/;
  const reactCleanup = /commitHookEffectListUnmount|commitHookPassiveUnmountEffects|disconnectPassiveEffect/;
  for (const failure of audit.failures) {
    const starts = audit.events.filter(event => event.stage === 'fetch-start' && event.operationId === failure.operationId);
    const start = starts[0];
    const aborts = audit.events.filter(event => event.stage === 'signal-abort' && event.operationId === failure.operationId);
    const abort = aborts[0];
    const settlements = audit.events.filter(event => (event.stage === 'fetch-fulfilled' || event.stage === 'fetch-rejected') && event.operationId === failure.operationId);
    const settlement = settlements[0];
    const requests = audit.requests.filter(request => request.operationId === failure.operationId);
    const exactCleanup = failure.operationId !== null && starts.length === 1 && aborts.length === 1 && requests.length === 1
      && requests[0].networkRequestId === failure.networkRequestId
      && failure.method === 'GET' && new URL(failure.url).pathname === widgetPath && new URL(failure.url).search === ''
      && failure.error === 'net::ERR_ABORTED'
      && start.method === failure.method && start.url === failure.url && !start.initiallyAborted
      && !!start.controllerId && !!start.signalId
      && abort.controllerId === start.controllerId && abort.signalId === start.signalId && abort.sequence > start.sequence
      // Cleanup must act on a pending fetch and cause its AbortError rejection.
      // A failed/settled read cannot be excused by its later ordinary cleanup.
      && abort.fetchState === 'pending' && settlements.length === 1 && settlement.stage === 'fetch-rejected'
      && settlement.errorName === 'AbortError' && settlement.sequence > abort.sequence
      && settlement.controllerId === start.controllerId && settlement.signalId === start.signalId
      && settlement.method === start.method && settlement.url === start.url
      && failure.observedSequence > abort.observedSequence
      && !!start.createdSource && !!start.fetchSource && !!abort.abortSource
      && widgetSource.test(start.createdSource.moduleId) && widgetSource.test(start.fetchSource.moduleId) && widgetSource.test(abort.abortSource.moduleId)
      && /\bnew AbortController\(\)/.test(start.createdSource.statement) && /\bcontroller\.abort\(\)/.test(abort.abortSource.statement)
      && /\.get\([^\n]*["']\/api\/support-widget\/token["']/.test(start.fetchSource.statement)
      && start.createdSource.scriptUrl === abort.abortSource.scriptUrl && start.createdSource.scriptSha256 === abort.abortSource.scriptSha256
      && start.createdSource.scriptUrl === start.fetchSource.scriptUrl && start.createdSource.scriptSha256 === start.fetchSource.scriptSha256
      && widgetEffect.test(start.createdStack) && widgetEffect.test(abort.abortStack || '') && reactCleanup.test(abort.abortStack || '');
    (exactCleanup ? expected : unexpected).push(failure);
  }
  return { expected, unexpected };
}

export function assertOnlyIntentionalWidgetCleanup(audit: WidgetRequestAudit) {
  const classification = classifyWidgetRequestFailures(audit);
  if (classification.unexpected.length) {
    throw new Error(`Unmatched request failures: ${classification.unexpected.map(failure => `${failure.networkRequestId} ${failure.method} ${failure.url}: ${failure.error}`).join('; ')}`);
  }
  return classification;
}

/** Test-only observation. Native controllers/signals and product cleanup stay unchanged. */
export async function installWidgetRequestAudit(page: Page) {
  const audit: WidgetRequestAudit = { requests: [], failures: [], events: [] };
  const auditId = randomUUID();
  let requestSequence = 0;
  let observedSequence = 0;
  const identities = new WeakMap<BrowserRequest, RequestIdentity>();
  const loadedScripts = new Map<string, Promise<string>>();
  // Use bytes actually delivered to this browser, rather than refetching a
  // possibly changed chunk or trusting a function name without module ownership.
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/_next/static/chunks/') && url.pathname.endsWith('.js') && !loadedScripts.has(url.href)) {
      loadedScripts.set(url.href, response.text().catch(() => ''));
    }
  });
  const sourceProof = async (stack: string) => {
    const frame = stack.match(/at WidgetSettingsWorkspace\.useEffect \((https?:\/\/.+?):\d+:\d+\)/);
    if (!frame) return null;
    const source = loadedScripts.get(frame[1]);
    return source ? widgetEffectSourceProof(stack, frame[1], await source) : null;
  };
  const identity = (request: BrowserRequest) => {
    let record = identities.get(request);
    if (!record) {
      record = { networkRequestId: `${auditId}:request:${++requestSequence}`, operationId: request.headers()[identityHeader] || null, method: request.method(), url: request.url() };
      identities.set(request, record);
    }
    return record;
  };
  page.on('request', request => {
    const record = identity(request);
    if (new URL(record.url).pathname === widgetPath) audit.requests.push(record);
  });
  page.on('requestfailed', request => {
    if (!request.url().includes('/_next/webpack-hmr')) audit.failures.push({ ...identity(request), error: request.failure()?.errorText || 'Unknown failure', observedSequence: ++observedSequence });
  });
  await page.exposeBinding('__finderWidgetRequestEvent', async (_source, browserEvent: Omit<WidgetOperationEvent, 'observedSequence'>) => {
    const event: WidgetOperationEvent = { ...browserEvent, observedSequence: ++observedSequence };
    audit.events.push(event);
    if (event.stage === 'fetch-start') {
      [event.createdSource, event.fetchSource] = await Promise.all([sourceProof(event.createdStack), sourceProof(event.fetchStack)]);
    }
    if (event.stage === 'signal-abort') event.abortSource = await sourceProof(event.abortStack || '');
  });
  await page.addInitScript(({ identityHeader, widgetPath }) => {
    const documentId = crypto.randomUUID();
    let sequence = 0;
    let controllerSequence = 0;
    const pending = new Set<Promise<void>>();
    const browser = window as typeof window & {
      __finderWidgetRequestEvent: (event: Omit<WidgetOperationEvent, 'observedSequence'>) => Promise<void>;
      __flushFinderWidgetAudit: () => Promise<void>;
    };
    const emit = (event: Omit<WidgetOperationEvent, 'sequence' | 'observedSequence'>) => {
      const promise = browser.__finderWidgetRequestEvent({ ...event, sequence: ++sequence });
      pending.add(promise);
      void promise.finally(() => pending.delete(promise)).catch(() => {});
    };
    browser.__flushFinderWidgetAudit = async () => { await Promise.all([...pending]); };
    const signals = new WeakMap<AbortSignal, { controllerId: string; signalId: string; createdStack: string; abortStack?: string }>();
    const callerStack = () => (new Error().stack || '').split('\n').slice(0, 14).join('\n');
    const NativeAbortController = browser.AbortController;
    browser.AbortController = class extends NativeAbortController {
      constructor() {
        super();
        const id = `${documentId}:controller:${++controllerSequence}`;
        signals.set(this.signal, { controllerId: id, signalId: `${id}:signal`, createdStack: callerStack() });
      }
      abort(reason?: unknown) {
        const record = signals.get(this.signal);
        if (record) record.abortStack = callerStack();
        super.abort(reason);
      }
    };
    const nativeFetch = browser.fetch.bind(browser);
    browser.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const original = input instanceof Request ? input : null;
      const url = new URL(original?.url || String(input), location.href);
      const method = (init?.method || original?.method || 'GET').toUpperCase();
      if (url.pathname !== widgetPath || method !== 'GET') return nativeFetch(input, init);
      const signal = init?.signal || original?.signal;
      const controller = signal ? signals.get(signal) : undefined;
      const operation = {
        operationId: `${documentId}:operation:${++sequence}`, controllerId: controller?.controllerId || null,
        signalId: controller?.signalId || null, createdStack: controller?.createdStack || '', fetchStack: callerStack(),
        method, url: url.href, initiallyAborted: signal?.aborted === true,
      };
      const headers = new Headers(init?.headers || original?.headers);
      headers.set(identityHeader, operation.operationId);
      let fetchState: 'pending' | 'fulfilled' | 'rejected' = 'pending';
      emit({ ...operation, stage: 'fetch-start' });
      signal?.addEventListener('abort', () => emit({ ...operation, stage: 'signal-abort', abortStack: controller?.abortStack, fetchState }), { once: true });
      return nativeFetch(input, { ...init, headers }).then(response => {
        fetchState = 'fulfilled';
        emit({ ...operation, stage: 'fetch-fulfilled' });
        return response;
      }, error => {
        fetchState = 'rejected';
        emit({ ...operation, stage: 'fetch-rejected', errorName: error instanceof Error ? error.name : 'Unknown' });
        throw error;
      });
    };
  }, { identityHeader, widgetPath });
  return {
    audit,
    flush: () => page.evaluate(async () => {
      await (window as typeof window & { __flushFinderWidgetAudit: () => Promise<void> }).__flushFinderWidgetAudit();
    }),
  };
}
