import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
vi.mock('@/lib/api', () => ({ default: { get: (...args: unknown[]) => apiGet(...args) }, api: { get: (...args: unknown[]) => apiGet(...args) } }));

const { prefetchDashboardGates, PLATFORM_ACCESS_QUERY_KEY, businessProfilesQueryKey } = await import('@/lib/startup-queries');

beforeEach(() => { apiGet.mockReset(); });

describe('dashboard start-up reads', () => {
  it('asks for plan access and the business profiles together, without signing anyone out on failure', async () => {
    apiGet.mockImplementation(async (url: string) => url === '/api/platform/access' ? { modules: [] } : [{ id: 4 }]);
    const client = new QueryClient();

    prefetchDashboardGates(client, 7);

    // Both start at once, before either answers.
    expect(apiGet.mock.calls.map(([url]) => url)).toEqual(['/api/platform/access', '/api/settings/business-profiles']);
    for (const [, options] of apiGet.mock.calls) expect(options).toEqual({ suppressUnauthorizedEvent: true });
    await vi.waitFor(() => expect(client.getQueryData(businessProfilesQueryKey(7))).toEqual([{ id: 4 }]));
    expect(client.getQueryData(PLATFORM_ACCESS_QUERY_KEY)).toEqual({ modules: [] });
  });

  it('leaves no error behind when an early read fails, so the page fetches it again with its own retries', async () => {
    apiGet.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));
    const client = new QueryClient();

    prefetchDashboardGates(client, 7);

    await vi.waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      for (const key of [PLATFORM_ACCESS_QUERY_KEY, businessProfilesQueryKey(7)]) {
        expect(client.getQueryState(key)?.status).toBe('pending');
        expect(client.getQueryState(key)?.error).toBeNull();
      }
    });
    // An early read is never retried on its own.
    expect(apiGet).toHaveBeenCalledTimes(2);
  });
});
