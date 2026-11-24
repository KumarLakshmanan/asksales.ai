import type { Page, Request } from '@playwright/test';

export type NavigationBody = {
  url: string;
  method: string;
  headers: Record<string, string>;
  status: number;
  contentType: string | null;
  bytesRead: number;
  ended: boolean;
  canceled: boolean;
  readError: boolean;
};

export type RequestFailure = {
  url: string;
  method: string;
  resourceType: string;
  navigation: boolean;
  errorText: string | undefined;
  headers: Record<string, string>;
  response?: { status: number; contentType: string | undefined };
  completedNavigation?: { body: NavigationBody; destination: string; uniqueRequest: boolean };
};

// Limit the exception to the observed successful, speculative conversation
// responses. A URL or ERR_ABORTED alone cannot distinguish a failed navigation.
export function isExpectedConversationPrefetchCancellation(failure: RequestFailure, conversationRoutes: ReadonlySet<string>) {
  const url = new URL(failure.url);
  return conversationRoutes.has(`${url.origin}${url.pathname}`)
    && failure.method === 'GET'
    && failure.resourceType === 'fetch'
    && !failure.navigation
    && failure.errorText === 'net::ERR_ABORTED'
    && failure.headers.rsc === '1'
    && failure.headers['next-router-prefetch'] === '1'
    && failure.response?.status === 200
    && failure.response.contentType?.split(';')[0].trim() === 'text/x-component';
}

export function failureText(failure: RequestFailure) {
  return `${failure.method} ${failure.url}: ${failure.errorText}`;
}

// Chromium can report ERR_ABORTED even when React's reader receives normal
// EOF. Headers and a rendered route alone are insufficient: require evidence
// from the application's own reader, tied to one exact request and destination.
export function isCompletedConversationNavigation(failure: RequestFailure, conversationRoutes: ReadonlySet<string>) {
  const url = new URL(failure.url);
  const completion = failure.completedNavigation;
  const body = completion?.body;
  return conversationRoutes.has(`${url.origin}${url.pathname}`)
    && url.searchParams.has('_rsc')
    && failure.method === 'GET' && failure.resourceType === 'fetch' && !failure.navigation
    && failure.errorText === 'net::ERR_ABORTED'
    && failure.headers.rsc === '1' && !('next-router-prefetch' in failure.headers)
    && !('next-router-segment-prefetch' in failure.headers)
    && failure.response?.status === 200
    && failure.response.contentType?.split(';')[0].trim() === 'text/x-component'
    && completion?.uniqueRequest === true
    && completion.destination === `${url.origin}${url.pathname}`
    && body?.url === failure.url && body.method === failure.method
    && body.headers.rsc === '1' && !('next-router-prefetch' in body.headers)
    && !('next-router-segment-prefetch' in body.headers)
    && body.status === 200 && body.contentType?.split(';')[0].trim() === 'text/x-component'
    && body.bytesRead > 0 && body.ended && !body.canceled && !body.readError;
}

export function unexpectedRequestFailures(rawFailures: readonly string[], observedFailures: readonly RequestFailure[], conversationRoutes: ReadonlySet<string>) {
  const cancellations = new Map<string, number>();
  for (const failure of observedFailures) {
    if (!isExpectedConversationPrefetchCancellation(failure, conversationRoutes)
      && !isCompletedConversationNavigation(failure, conversationRoutes)) continue;
    const text = failureText(failure);
    cancellations.set(text, (cancellations.get(text) || 0) + 1);
  }
  // Count occurrences: a navigation failure can have the same URL/error text
  // as a canceled prefetch. Never remove both based on string membership.
  return rawFailures.filter(text => {
    const remaining = cancellations.get(text) || 0;
    if (!remaining) return true;
    cancellations.set(text, remaining - 1);
    return false;
  });
}

// Observe consumption without cloning, draining, or canceling a response. An
// absent reader/EOF, an aborted signal, or an explicit cancel cannot qualify.
// A hard navigation loses this document's evidence and therefore fails closed.
export async function observeConversationNavigationBodies(page: Page, baseURL: string, threadIds: readonly number[]) {
  const origin = new URL(baseURL).origin;
  await page.addInitScript(({ origin, paths }) => {
    const bodies: NavigationBody[] = [];
    (window as typeof window & { as023NavigationBodies?: NavigationBody[] }).as023NavigationBodies = bodies;
    const streams = new WeakMap<ReadableStream, NavigationBody>();
    const readers = new WeakMap<ReadableStreamReader<unknown>, NavigationBody>();
    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      if (url.origin !== origin || !paths.includes(url.pathname) || method !== 'GET'
        || headers.get('rsc') !== '1' || headers.has('next-router-prefetch') || headers.has('next-router-segment-prefetch')) {
        return nativeFetch.call(this, input, init);
      }
      const body: NavigationBody = {
        url: url.href, method, headers: { rsc: '1' }, status: 0, contentType: null,
        bytesRead: 0, ended: false, canceled: false, readError: false,
      };
      bodies.push(body);
      const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
      if (signal?.aborted) body.canceled = true;
      signal?.addEventListener('abort', () => { body.canceled = true; });
      return nativeFetch.call(this, input, init).then(response => {
        body.status = response.status;
        body.contentType = response.headers.get('content-type');
        if (response.body) streams.set(response.body, body);
        return response;
      }, error => { body.readError = true; throw error; });
    };
    const getReader = ReadableStream.prototype.getReader;
    ReadableStream.prototype.getReader = function (this: ReadableStream, options?: ReadableStreamGetReaderOptions) {
      const reader = getReader.call(this, options);
      const body = streams.get(this);
      if (body) readers.set(reader, body);
      return reader;
    } as typeof getReader;
    const read = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = function () {
      const body = readers.get(this);
      const result = read.call(this);
      if (!body) return result;
      return result.then(chunk => {
        body.bytesRead += chunk.value?.byteLength || 0;
        if (chunk.done) body.ended = true;
        return chunk;
      }, error => { body.readError = true; throw error; });
    };
    const readerCancel = ReadableStreamDefaultReader.prototype.cancel;
    ReadableStreamDefaultReader.prototype.cancel = function (reason) {
      const body = readers.get(this);
      if (body) body.canceled = true;
      return readerCancel.call(this, reason);
    };
    const streamCancel = ReadableStream.prototype.cancel;
    ReadableStream.prototype.cancel = function (reason) {
      const body = streams.get(this);
      if (body) body.canceled = true;
      return streamCancel.call(this, reason);
    };
  }, { origin, paths: threadIds.map(id => `/dashboard/conversations/${id}`) });
  return () => page.evaluate(() => (window as typeof window & { as023NavigationBodies?: NavigationBody[] }).as023NavigationBodies || []);
}

export function installCampaignRequestAudit(page: Page, baseURL: string, threadIds: readonly number[]) {
  const origin = new URL(baseURL).origin;
  const conversationRoutes = new Set([
    `${origin}/dashboard/conversations`,
    ...threadIds.map(id => `${origin}/dashboard/conversations/${id}`),
  ]);
  const requestFailures: RequestFailure[] = [];
  const httpErrors: { url: string; status: number }[] = [];
  const pageErrors: string[] = [];
  const requestCounts = new Map<string, number>();
  page.on('request', request => {
    const key = `${request.method()} ${request.url()}`;
    requestCounts.set(key, (requestCounts.get(key) || 0) + 1);
  });
  const responses = new WeakMap<Request, RequestFailure['response']>();
  page.on('response', response => {
    responses.set(response.request(), { status: response.status(), contentType: response.headers()['content-type'] });
    if (response.status() >= 400) httpErrors.push({ url: response.url(), status: response.status() });
  });
  page.on('requestfailed', request => {
    const headers = request.headers();
    requestFailures.push({
      url: request.url(), method: request.method(), resourceType: request.resourceType(),
      navigation: request.isNavigationRequest(), errorText: request.failure()?.errorText,
      // Keep only protocol evidence; never retain authorization or cookies.
      headers: Object.fromEntries(['rsc', 'next-router-prefetch', 'next-router-segment-prefetch']
        .filter(key => key in headers).map(key => [key, headers[key]])),
      response: responses.get(request),
    });
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  let confirmedNavigation: { destination: string; bodies: readonly NavigationBody[] } | undefined;
  const refreshCompletionEvidence = () => {
    if (!confirmedNavigation) return;
    // Recheck identity counts at the final audit, including requests/failures
    // arriving after the browser snapshot. Ambiguous matches fail closed.
    for (const failure of requestFailures) {
      delete failure.completedNavigation;
      const matches = confirmedNavigation.bodies.filter(body => body.url === failure.url && body.method === failure.method);
      if (matches.length !== 1) continue;
      failure.completedNavigation = {
        body: matches[0], destination: confirmedNavigation.destination,
        uniqueRequest: requestCounts.get(`${failure.method} ${failure.url}`) === 1,
      };
    }
  };
  return {
    requestFailures, httpErrors, pageErrors,
    expectedCancellations: () => requestFailures.filter(failure => isExpectedConversationPrefetchCancellation(failure, conversationRoutes)),
    completedNavigations: () => {
      refreshCompletionEvidence();
      return requestFailures.filter(failure => isCompletedConversationNavigation(failure, conversationRoutes));
    },
    confirmNavigationBody: (destination: string, bodies: readonly NavigationBody[]) => {
      // Duplicate identical requests cannot be matched safely by URL. Keep all
      // their failures, even if another reader for that URL completed normally.
      confirmedNavigation = { destination, bodies };
      refreshCompletionEvidence();
    },
    unexpectedFailures: (rawFailures: readonly string[]) => {
      refreshCompletionEvidence();
      return unexpectedRequestFailures(rawFailures, requestFailures, conversationRoutes);
    },
  };
}
