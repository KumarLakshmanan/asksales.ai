import { describe, expect, it } from 'vitest';
import { failureText, isCompletedConversationNavigation, isExpectedConversationPrefetchCancellation, unexpectedRequestFailures, type NavigationBody, type RequestFailure } from '../../e2e/fixtures/campaign-request-audit';

const origin = 'http://127.0.0.1:3123';
const routes = new Set([`${origin}/dashboard/conversations`, `${origin}/dashboard/conversations/801`]);
const cancellation: RequestFailure = {
  url: `${origin}/dashboard/conversations/801?_rsc=synthetic`, method: 'GET', resourceType: 'fetch',
  navigation: false, errorText: 'net::ERR_ABORTED', headers: { rsc: '1', 'next-router-prefetch': '1' },
  response: { status: 200, contentType: 'text/x-component' },
};

describe('AS023 Campaign request audit', () => {
  it('recognizes only successful background RSC prefetch cancellations on allowed routes', () => {
    expect(isExpectedConversationPrefetchCancellation(cancellation, routes)).toBe(true);
    expect(isExpectedConversationPrefetchCancellation({ ...cancellation, url: `${origin}/dashboard/conversations?_rsc=synthetic`, response: { status: 200, contentType: 'text/x-component; charset=utf-8' } }, routes)).toBe(true);
    expect(unexpectedRequestFailures([failureText(cancellation)], [cancellation], routes)).toEqual([]);
  });

  it.each<{ name: string; change: Partial<RequestFailure> }>([
    { name: 'RSC navigation', change: { headers: { rsc: '1' } } },
    { name: 'document navigation', change: { navigation: true } },
    { name: 'script asset', change: { resourceType: 'script' } },
    { name: 'API read', change: { url: `${origin}/api/chat/threads/801` } },
    { name: 'other application route', change: { url: `${origin}/dashboard/chats?_rsc=synthetic` } },
    { name: 'unknown conversation', change: { url: `${origin}/dashboard/conversations/999?_rsc=synthetic` } },
    { name: 'nested conversation path', change: { url: `${origin}/dashboard/conversations/801/messages?_rsc=synthetic` } },
    { name: 'external origin', change: { url: 'https://outside.example.test/dashboard/conversations/801?_rsc=synthetic' } },
    { name: 'POST', change: { method: 'POST' } },
    { name: 'missing RSC header', change: { headers: { 'next-router-prefetch': '1' } } },
    { name: 'ordinary fetch', change: { headers: {} } },
    { name: 'missing response', change: { response: undefined } },
    { name: 'HTML response', change: { response: { status: 200, contentType: 'text/html' } } },
    { name: 'missing content type', change: { response: { status: 200, contentType: undefined } } },
    { name: 'HTTP 404', change: { response: { status: 404, contentType: 'text/x-component' } } },
    { name: 'HTTP 500', change: { response: { status: 500, contentType: 'text/x-component' } } },
    { name: 'failed connection', change: { errorText: 'net::ERR_CONNECTION_REFUSED' } },
    { name: 'DNS failure', change: { errorText: 'net::ERR_NAME_NOT_RESOLVED' } },
    { name: 'disconnected network', change: { errorText: 'net::ERR_INTERNET_DISCONNECTED' } },
    { name: 'timeout', change: { errorText: 'net::ERR_TIMED_OUT' } },
  ])('retains $name failures', ({ change }) => {
    const failure = { ...cancellation, ...change };
    expect(isExpectedConversationPrefetchCancellation(failure, routes)).toBeFalsy();
    expect(unexpectedRequestFailures([failureText(failure)], [failure], routes)).toEqual([failureText(failure)]);
  });

  it('retains a real failure sharing the canceled prefetch URL/error and any unobserved failures', () => {
    const navigation = { ...cancellation, headers: { rsc: '1' } };
    const raw = [failureText(cancellation), failureText(navigation), 'unobserved failure'];
    expect(unexpectedRequestFailures(raw, [cancellation, navigation], routes)).toEqual([failureText(navigation), 'unobserved failure']);
    expect(raw).toEqual([failureText(cancellation), failureText(navigation), 'unobserved failure']);
  });
});

describe('AS023 completed navigation body evidence', () => {
  const navigation: RequestFailure = {
    ...cancellation, headers: { rsc: '1' }, completedNavigation: {
      destination: `${origin}/dashboard/conversations/801`, uniqueRequest: true,
      body: { url: cancellation.url, method: 'GET', headers: { rsc: '1' }, status: 200,
        contentType: 'text/x-component', bytesRead: 6547, ended: true, canceled: false, readError: false },
    },
  };

  it('accepts a late diagnostic only with unique, uncanceled application-reader EOF and the verified destination', () => {
    expect(isExpectedConversationPrefetchCancellation(navigation, routes)).toBe(false);
    expect(isCompletedConversationNavigation(navigation, routes)).toBe(true);
    expect(unexpectedRequestFailures([failureText(navigation)], [navigation], routes)).toEqual([]);
  });

  it.each<{ name: string; change: Partial<RequestFailure> }>([
    { name: '200/ERR_ABORTED without body evidence', change: { completedNavigation: undefined } },
    { name: 'duplicate request identities', change: { completedNavigation: { ...navigation.completedNavigation!, uniqueRequest: false } } },
    { name: 'different or stale destination', change: { completedNavigation: { ...navigation.completedNavigation!, destination: `${origin}/dashboard/chats` } } },
    { name: 'document fallback', change: { navigation: true, resourceType: 'document' } },
    { name: 'asset failure', change: { resourceType: 'script' } },
    { name: 'API failure', change: { url: `${origin}/api/chat/threads/801` } },
    { name: 'unknown conversation', change: { url: `${origin}/dashboard/conversations/999?_rsc=synthetic` } },
    { name: 'ordinary fetch', change: { headers: {} } },
    { name: 'HTTP 500', change: { response: { status: 500, contentType: 'text/x-component' } } },
    { name: 'transport disconnection', change: { errorText: 'net::ERR_INCOMPLETE_CHUNKED_ENCODING' } },
    { name: 'connection refusal', change: { errorText: 'net::ERR_CONNECTION_REFUSED' } },
  ])('retains $name', ({ change }) => {
    const failure = { ...navigation, ...change };
    expect(isCompletedConversationNavigation(failure, routes)).toBeFalsy();
    expect(unexpectedRequestFailures([failureText(failure)], [failure], routes)).toEqual([failureText(failure)]);
  });

  it.each<{ name: string; change: Partial<NavigationBody> }>([
    { name: 'partial stream', change: { ended: false } },
    { name: 'empty stream', change: { bytesRead: 0 } },
    { name: 'EOF after explicit reader cancellation', change: { canceled: true } },
    { name: 'reader error', change: { readError: true } },
    { name: 'different exact request URL', change: { url: `${cancellation.url}-other` } },
    { name: 'wrong method', change: { method: 'POST' } },
    { name: 'wrong protocol', change: { headers: {} } },
    { name: 'prefetch reader', change: { headers: { rsc: '1', 'next-router-prefetch': '1' } } },
    { name: 'unsuccessful body', change: { status: 404 } },
    { name: 'HTML body', change: { contentType: 'text/html' } },
  ])('retains $name evidence', ({ change }) => {
    const failure = { ...navigation, completedNavigation: {
      ...navigation.completedNavigation!, body: { ...navigation.completedNavigation!.body, ...change },
    } };
    expect(isCompletedConversationNavigation(failure, routes)).toBeFalsy();
    expect(unexpectedRequestFailures([failureText(failure)], [failure], routes)).toEqual([failureText(failure)]);
  });

  it('retains another failed request with identical URL/error text and preserves the raw list', () => {
    const realFailure = { ...navigation, completedNavigation: undefined };
    const raw = [failureText(navigation), failureText(realFailure), 'unobserved failure'];
    expect(unexpectedRequestFailures(raw, [navigation, realFailure], routes)).toEqual([failureText(realFailure), 'unobserved failure']);
    expect(raw).toHaveLength(3);
  });
});
