import type { CDPSession, Page, TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';

type ObservedHook = { memoizedState: unknown; next: ObservedHook | null };
type ObservedFiber = { tag: number; memoizedState: ObservedHook | null; return: ObservedFiber | null; alternate: ObservedFiber | null };

/** Opt-in, synthetic-only observation. Never classifies or exempts failed requests. */
export async function installKnowledgeDiagnostics(page: Page, testInfo: TestInfo) {
  const events: Record<string, unknown>[] = [];
  let sequence = 0;
  const emit = (event: Record<string, unknown>) => events.push({ sequence: ++sequence, ...event });
  await page.exposeBinding('__knowledgeDiagnosticEmit', (_source, event) => emit(event));
  await page.addInitScript(() => {
    const diagnosticWindow = window as typeof window & {
      __knowledgeDiagnosticEmit: (event: Record<string, unknown>) => Promise<void>;
      __knowledgeDiagnosticRecord: (stage: string, detail?: Record<string, unknown>) => void;
    };
    const documentId = crypto.randomUUID();
    const stack = () => new Error().stack;
    const describe = (element: Element | null) => element ? {
      tag: element.tagName, id: element.id, name: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 100),
    } : null;
    const state = () => {
      const url = document.getElementById('knowledge-url') as HTMLInputElement | null;
      const save = [...document.querySelectorAll('button')].find(element => element.textContent?.trim() === 'Save');
      const fiberKey = save && Object.keys(save).find(key => key.startsWith('__reactFiber$'));
      // Read only selected form state, never account/auth/context values or draft text.
      let fiber = fiberKey ? (save as unknown as Record<string, ObservedFiber>)[fiberKey] : null;
      const react: Record<string, unknown> = {};
      for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
        if (!fiber.memoizedState || fiber.tag !== 0) continue;
        for (const candidate of [fiber, fiber.alternate]) {
          let hook = candidate?.memoizedState;
          const values: Record<string, unknown>[] = [];
          for (let index = 0; hook && index < 80; index++, hook = hook.next) {
            const value = hook.memoizedState;
            if (value && typeof value === 'object' && 'title' in value && 'type' in value && 'content' in value) {
              const entry = value as { type: string; title: string; content: string; fileName?: string };
              values.push({ index, entryType: entry.type, titleLength: entry.title.length, contentLength: entry.content?.length, fileName: entry.fileName || null });
            }
            if (value && typeof value === 'object' && 'field' in value && 'message' in value) values.push({ index, error: { field: value.field, message: value.message } });
          }
          if (values.length) react[candidate === fiber ? 'fiber' : 'alternate'] = values;
        }
        if (Object.keys(react).length) break;
      }
      return { active: describe(document.activeElement), urlMounted: !!url, urlInvalid: url?.getAttribute('aria-invalid'),
        urlDescription: url?.getAttribute('aria-describedby'), urlLength: url?.value.length,
        selectedType: describe(document.querySelector('[aria-pressed="true"]')), saveDisabled: save?.disabled,
        saveRect: save?.getBoundingClientRect().toJSON(),
        toasts: [...document.querySelectorAll('[data-sonner-toast]')].map(element => ({ ...describe(element),
          rect: element.getBoundingClientRect().toJSON(), expanded: element.getAttribute('data-expanded'),
          visible: element.getAttribute('data-visible'), pointerEvents: getComputedStyle(element).pointerEvents })),
        errors: [...document.querySelectorAll('[id^="knowledge-"][role="alert"]')].map(element => ({ id: element.id, text: element.textContent })),
        scroll: { x: scrollX, y: scrollY }, viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale,
          dpr: devicePixelRatio, touchPoints: navigator.maxTouchPoints, zoom: getComputedStyle(document.documentElement).zoom }, react };
    };
    const record = (stage: string, detail: Record<string, unknown> = {}) => {
      void diagnosticWindow.__knowledgeDiagnosticEmit({ documentId, stage, time: performance.now(), timeOrigin: performance.timeOrigin, href: location.href, ...detail });
    };
    diagnosticWindow.__knowledgeDiagnosticRecord = (stage, detail = {}) => record(stage, { ...detail, state: state() });
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'focusin', 'focusout', 'keydown', 'change']) {
      for (const capture of [true, false]) document.addEventListener(type, event => {
        const element = event.target instanceof Element ? event.target : null;
        if (!element?.closest('button, [id^="knowledge-"], [data-sonner-toast]')) return;
        const pointer = event instanceof MouseEvent ? { x: event.clientX, y: event.clientY, button: event.button, buttons: event.buttons,
          pointerType: event instanceof PointerEvent ? event.pointerType : undefined,
          hit: describe(document.elementFromPoint(event.clientX, event.clientY)), detail: event.detail } : {};
        record(`${type}-${capture ? 'capture' : 'bubble'}`, { target: describe(element), control: describe(element.closest('button, input, textarea')),
          trusted: event.isTrusted, defaultPrevented: event.defaultPrevented, ...pointer, state: state() });
        if (type === 'click' && capture) queueMicrotask(() => record('click-microtask', { target: describe(element), state: state() }));
      }, capture);
    }
    let previousState = '';
    new MutationObserver(() => {
      const current = state();
      const serialized = JSON.stringify(current);
      if (serialized !== previousState) { previousState = serialized; record('dom-state', { state: current }); }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-invalid', 'aria-describedby', 'aria-pressed', 'disabled', 'data-visible', 'data-expanded', 'data-mounted', 'data-removed'] });
    for (const method of ['pushState', 'replaceState'] as const) {
      const native = history[method];
      history[method] = function (...args) { record(`history-${method}`, { destination: String(args[2] ?? ''), stack: stack() }); return native.apply(this, args); };
    }
    for (const type of ['popstate', 'pagehide', 'pageshow', 'beforeunload']) window.addEventListener(type, () => record(type));
    let controllerCounter = 0;
    let fetchCounter = 0;
    const signals = new WeakMap<AbortSignal, { controllerId: string; createdStack: string | undefined; abortStack?: string }>();
    const NativeAbortController = window.AbortController;
    window.AbortController = class extends NativeAbortController {
      constructor() { super(); signals.set(this.signal, { controllerId: `${documentId}:controller:${++controllerCounter}`, createdStack: stack() }); }
      abort(reason?: unknown) {
        const owner = signals.get(this.signal)!;
        owner.abortStack = stack();
        record('controller-abort', { ...owner, alreadyAborted: this.signal.aborted });
        return super.abort(reason);
      }
    };
    const streams = new WeakMap<ReadableStream, Record<string, unknown>>();
    const readers = new WeakMap<ReadableStreamDefaultReader, Record<string, unknown>>();
    const nativeTee = ReadableStream.prototype.tee;
    ReadableStream.prototype.tee = function (this: ReadableStream) {
      const branches = nativeTee.call(this);
      const owner = streams.get(this);
      if (owner) { for (const branch of branches) streams.set(branch, owner); record('stream-tee', { ...owner, stack: stack() }); }
      return branches;
    };
    const nativeStreamCancel = ReadableStream.prototype.cancel;
    ReadableStream.prototype.cancel = function (this: ReadableStream, ...args) {
      const owner = streams.get(this);
      if (owner) record('body-cancel', { ...owner, stack: stack() });
      return nativeStreamCancel.apply(this, args);
    };
    const nativeGetReader = ReadableStream.prototype.getReader;
    ReadableStream.prototype.getReader = function (this: ReadableStream, ...args: Parameters<typeof nativeGetReader>) {
      const reader = nativeGetReader.apply(this, args);
      const owner = streams.get(this);
      if (owner) { readers.set(reader as ReadableStreamDefaultReader, owner); record('stream-reader', { ...owner, stack: stack() }); }
      return reader;
    } as typeof nativeGetReader;
    const nativeRead = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = function (...args) {
      const owner = readers.get(this);
      const result = nativeRead.apply(this, args);
      if (owner) void result.then(value => record(value.done ? 'stream-done' : 'stream-chunk', { ...owner, bytes: value.value?.byteLength || 0 }),
        error => record('stream-reject', { ...owner, error: String(error), name: error?.name }));
      return result;
    };
    const nativeCancel = ReadableStreamDefaultReader.prototype.cancel;
    ReadableStreamDefaultReader.prototype.cancel = function (...args) {
      const owner = readers.get(this);
      if (owner) record('stream-cancel', { ...owner, stack: stack() });
      return nativeCancel.apply(this, args);
    };
    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (!url.pathname.includes('/knowledge-base')) return nativeFetch.call(this, input, init);
      const signal = init?.signal || (input instanceof Request ? input.signal : null);
      const owner = signal ? signals.get(signal) : undefined;
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      const operation = { fetchId: `${documentId}:fetch:${++fetchCounter}`, url: url.href, method: init?.method || (input instanceof Request ? input.method : 'GET'),
        controllerId: owner?.controllerId || null, hasSignal: !!signal, signalInitiallyAborted: signal?.aborted || false,
        createdStack: owner?.createdStack, fetchStack: stack(), headers: Object.fromEntries([...headers].filter(([key]) => /^(rsc|next-router|next-url|next-action|x-deployment-id|x-business-profile-id)/.test(key))) };
      let fetchState = 'pending';
      record('fetch-start', operation);
      signal?.addEventListener('abort', () => record('signal-abort', { ...operation, abortStack: owner?.abortStack, fetchState }), { once: true });
      const result = nativeFetch.call(this, input, init);
      void result.then(response => {
        fetchState = 'response';
        record('fetch-response', { ...operation, status: response.status, contentType: response.headers.get('content-type'), redirected: response.redirected, responseUrl: response.url });
        if (response.body) streams.set(response.body, operation);
      }, error => { fetchState = 'rejected'; record('fetch-reject', { ...operation, error: String(error), name: error?.name }); });
      return result;
    };
    record('document-init');
  });
  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Debugger.enable');
  const networkIds = new Set<string>();
  const frames: { scriptId: string; url: string; functionName: string; lineNumber: number; columnNumber: number }[] = [];
  const relevantHeaders = (headers: Record<string, unknown>) => Object.fromEntries(Object.entries(headers).filter(([key]) => /^(rsc|next-url|next-action|x-deployment-id|content-type|content-encoding|transfer-encoding|vary|location)$/i.test(key) || /^next-router-/i.test(key)));
  cdp.on('Network.requestWillBeSent', event => {
    if (!event.request.url.includes('/knowledge-base')) return;
    networkIds.add(event.requestId);
    let trace = event.initiator.stack;
    while (trace) { frames.push(...trace.callFrames); trace = trace.parent; }
    emit({ stage: 'cdp-request', requestId: event.requestId, url: event.request.url, method: event.request.method, headers: relevantHeaders(event.request.headers),
      timestamp: event.timestamp, wallTime: event.wallTime, documentURL: event.documentURL, type: event.type, initiator: event.initiator, loaderId: event.loaderId });
  });
  cdp.on('Network.responseReceived', event => { if (networkIds.has(event.requestId)) emit({ stage: 'cdp-response', requestId: event.requestId, timestamp: event.timestamp,
    url: event.response.url, status: event.response.status, mimeType: event.response.mimeType, headers: relevantHeaders(event.response.headers) }); });
  cdp.on('Network.loadingFinished', event => { if (networkIds.has(event.requestId)) emit({ stage: 'cdp-finished', ...event }); });
  cdp.on('Network.loadingFailed', event => { if (networkIds.has(event.requestId)) emit({ stage: 'cdp-failed', ...event }); });
  page.on('requestfailed', request => emit({ stage: 'playwright-requestfailed', url: request.url(), method: request.method(), error: request.failure()?.errorText }));
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) emit({ stage: 'playwright-navigation', url: frame.url() }); });
  page.on('pageerror', error => emit({ stage: 'pageerror', error: error.message }));
  let breakpoint: string | undefined;
  return {
    /** V8 logpoint on the actual React Save callback, without replacing it or pausing. */
    async armSave() {
      if (breakpoint) await cdp.send('Debugger.removeBreakpoint', { breakpointId: breakpoint });
      const result = await cdp.send('Runtime.evaluate', { expression: `(() => { const button = [...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'Save'); const key = button && Object.keys(button).find(k => k.startsWith('__reactProps$')); return key && button[key].onClick; })()` });
      if (!result.result.objectId || result.result.type !== 'function') throw new Error('Knowledge diagnostics could not locate the actual Save callback');
      const registered = await cdp.send('Debugger.setBreakpointOnFunctionCall', { objectId: result.result.objectId,
        condition: 'window.__knowledgeDiagnosticRecord("handler-enter", { callback: "Save" }), false' });
      breakpoint = registered.breakpointId;
      emit({ stage: 'handler-logpoint-armed', description: result.result.description });
    },
    async finish() {
      if (!page.isClosed()) await page.evaluate(() => (window as typeof window & { __knowledgeDiagnosticRecord: (stage: string) => void }).__knowledgeDiagnosticRecord('test-end'));
      const sources = new Map<string, string>();
      for (const frame of frames) {
        if (!sources.has(frame.scriptId)) {
          const result = await cdp.send('Debugger.getScriptSource', { scriptId: frame.scriptId });
          sources.set(frame.scriptId, result.scriptSource);
        }
      }
      emit({ stage: 'request-source-frames', frames: frames.map(frame => {
        const source = sources.get(frame.scriptId)!;
        const line = source.split('\n')[frame.lineNumber] || '';
        return { ...frame, sourceSHA256: createHash('sha256').update(source).digest('hex'),
          excerpt: line.slice(Math.max(0, frame.columnNumber - 160), frame.columnNumber + 240) };
      }) });
      await testInfo.attach('knowledge-diagnostics', { body: JSON.stringify({ test: testInfo.title, project: testInfo.project.name, repeat: testInfo.repeatEachIndex,
        status: testInfo.status, events }, null, 2), contentType: 'application/json' });
      await cdp.detach();
    },
  };
}
