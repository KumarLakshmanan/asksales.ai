/**
 * API Client Tests
 * Tests: buildApiUrl, api.get/post/put/delete/patch,
 *        401 handling, 429 rate-limit, 402 credits,
 *        { success, data } envelope auto-unwrap
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildApiUrl, api } from '@/lib/api';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Helper to create a mock Response
function mockResponse(
  body: unknown,
  status = 200,
  contentType = 'application/json'
) {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (header: string) => {
        if (header === 'content-type') return contentType;
        if (header === 'retry-after') return null;
        return null;
      },
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(String(body)),
  } as unknown as Response);
}

describe('buildApiUrl', () => {
  it('should prepend base URL to relative paths', () => {
    process.env.NEXT_PUBLIC_API_URL = '';
    expect(buildApiUrl('/api/users')).toBe('/api/users');
  });

  it('should return absolute URLs unchanged', () => {
    const abs = 'https://example.com/api/users';
    expect(buildApiUrl(abs)).toBe(abs);
  });
});

describe('API Client', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Clear localStorage
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    sessionStorage.clear();
    document.cookie = 'XSRF-TOKEN=; Max-Age=0; Path=/';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── GET ────────────────────────────────────────────────────────────────
  describe('api.get', () => {
    it('uses the selected business and preserves an explicit newly created business for analysis', async () => {
      localStorage.setItem('user', JSON.stringify({ id: 1 }));
      sessionStorage.setItem('active-business-profile:1', '11');
      mockFetch.mockReturnValue(mockResponse({}));
      await api.get('/api/chat/threads');
      expect(new Headers(mockFetch.mock.calls[0][1].headers).get('X-Business-Profile-Id')).toBe('11');
      await api.post('/api/setup/analyze-website', { url: 'https://new.example.test' }, { headers: { 'X-Business-Profile-Id': '22' } });
      expect(new Headers(mockFetch.mock.calls[1][1].headers).get('X-Business-Profile-Id')).toBe('22');
      expect(sessionStorage.getItem('active-business-profile:1')).toBe('11');
    });
    it('ignores obsolete organization selection and derives billing from the selected business', async () => {
      localStorage.setItem('user', JSON.stringify({ id: 1 }));
      sessionStorage.setItem('active-business-profile:1', '11');
      sessionStorage.setItem('active-billing-organization:1', '7');
      mockFetch.mockReturnValue(mockResponse({}));
      await api.get('/api/wallet');
      await api.post('/api/settings/business-profiles', { name: 'New business' });
      await api.post('/api/crm/contacts', { name: 'Contact' });
      await api.get('/api/subscriptions/catalog');
      const requests = mockFetch.mock.calls.map(call => new Headers(call[1].headers));
      expect(requests[0].get('X-Billing-Organization-Id')).toBeNull();
      expect(requests[0].get('X-Business-Profile-Id')).toBe('11');
      expect(requests[1].get('X-Billing-Organization-Id')).toBeNull();
      expect(requests[2].get('X-Billing-Organization-Id')).toBeNull();
      expect(requests[2].get('X-Business-Profile-Id')).toBe('11');
      expect(requests[3].get('X-Billing-Organization-Id')).toBeNull();
    });
    it('preserves captured business and payer identity after the selected business changes', async () => {
      localStorage.setItem('user', JSON.stringify({ id: 1 }));
      sessionStorage.setItem('active-business-profile:1', '99');
      mockFetch.mockReturnValue(mockResponse({}));
      await api.post('/api/subscriptions/verify', { subscriptionId: 'existing' }, { headers: { 'X-Billing-Organization-Id': '7', 'X-Business-Profile-Id': '11' } });
      expect(new Headers(mockFetch.mock.calls[0][1].headers).get('X-Billing-Organization-Id')).toBe('7');
      expect(new Headers(mockFetch.mock.calls[0][1].headers).get('X-Business-Profile-Id')).toBe('11');
    });
    it('supports business wallet reads without applying the billing selector', async () => {
      localStorage.setItem('user', JSON.stringify({ id: 1 }));
      sessionStorage.setItem('active-business-profile:1', '11');
      sessionStorage.setItem('active-billing-organization:1', '7');
      mockFetch.mockReturnValue(mockResponse({}));
      await api.get('/api/wallet', { skipBillingOrganization: true });
      const request = mockFetch.mock.calls[0][1];
      expect(new Headers(request.headers).get('X-Billing-Organization-Id')).toBeNull();
      expect(new Headers(request.headers).get('X-Business-Profile-Id')).toBe('11');
      expect(request).not.toHaveProperty('skipBillingOrganization');
    });
    it('does not carry organization selection between signed-in accounts', async () => {
      localStorage.setItem('user', JSON.stringify({ id: 2 }));
      sessionStorage.setItem('active-billing-organization:1', '7');
      mockFetch.mockReturnValue(mockResponse({}));
      await api.get('/api/subscriptions/current');
      expect(new Headers(mockFetch.mock.calls[0][1].headers).get('X-Billing-Organization-Id')).toBeNull();
    });
    it('should make a GET request and return data', async () => {
      const responseData = { id: 1, name: 'Test User' };
      mockFetch.mockReturnValue(mockResponse(responseData));

      const result = await api.get('/api/user');
      expect(result).toEqual(responseData);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/user',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('treats timezone-less API timestamp fields as UTC instants', async () => {
      mockFetch.mockReturnValue(mockResponse({
        updatedAt: '2026-09-18T11:42:16.913',
        nested: { last_message_at: '2026-09-18 11:45:00', localTime: '11:45' },
      }));

      const result = await api.get<{ updatedAt: string; nested: { last_message_at: string; localTime: string } }>('/api/timestamps');

      expect(result.updatedAt).toBe('2026-09-18T11:42:16.913Z');
      expect(result.nested.last_message_at).toBe('2026-09-18T11:45:00Z');
      expect(result.nested.localTime).toBe('11:45');
    });

    it('normalizes reminder dueDate instants without changing calendar dates or explicit offsets', async () => {
      mockFetch.mockReturnValue(mockResponse({ success: true, data: [
        { dueDate: '2026-10-28 08:30:00', snoozedUntil: null, createdAt: '2026-10-26 19:04:00.676144', sentAt: null, reminder_due_at: '2026-10-28 08:30:00' },
        { dueDate: '2026-10-28T08:30:00.123456', snoozedUntil: '2026-10-29 08:30:00' },
        { dueDate: '2026-10-28T08:30:00Z' },
        { dueDate: '2026-10-28T14:00:00+05:30' },
        { dueDate: '2026-10-28' },
        { dueDate: null, localTime: '2026-10-28T14:00:00' },
      ] }));

      const result = await api.get<Array<Record<string, unknown>>>('/api/crm/reminders?contactId=740');

      expect(result).toEqual([
        { dueDate: '2026-10-28T08:30:00Z', snoozedUntil: null, createdAt: '2026-10-26T19:04:00.676144Z', sentAt: null, reminder_due_at: '2026-10-28T08:30:00Z' },
        { dueDate: '2026-10-28T08:30:00.123456Z', snoozedUntil: '2026-10-29T08:30:00Z' },
        { dueDate: '2026-10-28T08:30:00Z' },
        { dueDate: '2026-10-28T14:00:00+05:30' },
        { dueDate: '2026-10-28' },
        { dueDate: null, localTime: '2026-10-28T14:00:00' },
      ]);
    });

    it('should omit Content-Type for a bodyless GET', async () => {
      mockFetch.mockReturnValue(mockResponse({}));
      await api.get('/api/test');
      const callArgs = mockFetch.mock.calls[0][1];
      expect(new Headers(callArgs.headers).has('Content-Type')).toBe(false);
    });

    it('should add Authorization header when token exists', async () => {
      localStorage.setItem('token', 'mock-jwt-token');
      mockFetch.mockReturnValue(mockResponse({ user: 'test' }));
      await api.get('/api/user');
      const callArgs = mockFetch.mock.calls[0][1];
      expect(new Headers(callArgs.headers).get('Authorization')).toBe('Bearer mock-jwt-token');
    });

    it('should NOT add Authorization header when skipAuth is true', async () => {
      localStorage.setItem('token', 'mock-jwt-token');
      mockFetch.mockReturnValue(mockResponse({}));
      await api.get('/api/public', { skipAuth: true });
      const callArgs = mockFetch.mock.calls[0][1];
      expect(new Headers(callArgs.headers).has('Authorization')).toBe(false);
    });
  });

  // ── POST ───────────────────────────────────────────────────────────────
  describe('api.post', () => {
    it('should make a POST request with JSON body', async () => {
      mockFetch.mockReturnValue(mockResponse({ created: true }, 201));
      const body = { name: 'Test', email: 'test@test.com' };
      await api.post('/api/users', body);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/users',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(body),
        })
      );
    });

    it('should handle POST without body', async () => {
      mockFetch.mockReturnValue(mockResponse({ ok: true }));
      await api.post('/api/action');
      const callArgs = mockFetch.mock.calls[0][1];
      expect(callArgs.method).toBe('POST');
      expect(callArgs.body).toBeUndefined();
    });

    it('should echo the double-submit CSRF cookie on unsafe requests', async () => {
      document.cookie = 'XSRF-TOKEN=csrf%20token; Path=/';
      mockFetch.mockReturnValue(mockResponse({ ok: true }));

      await api.post('/api/action', { enabled: true });

      const callArgs = mockFetch.mock.calls[0][1];
      expect(new Headers(callArgs.headers).get('X-XSRF-TOKEN')).toBe('csrf token');
      expect(callArgs.credentials).toBe('include');
    });

    it('should refresh a stale CSRF cookie and retry an unsafe request once', async () => {
      mockFetch
        .mockReturnValueOnce(mockResponse({ message: 'CSRF token missing or mismatched' }, 403))
        .mockImplementationOnce(() => {
          document.cookie = 'XSRF-TOKEN=refreshed-token; Path=/';
          return mockResponse({ ok: true });
        })
        .mockReturnValueOnce(mockResponse({ saved: true }));

      await expect(api.put('/api/chat/threads/171/active-tab', { activeTabId: 'leads' }))
        .resolves.toEqual({ saved: true });

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch.mock.calls[1][0]).toBe('/api/auth/csrf-token');
      expect(new Headers(mockFetch.mock.calls[2][1].headers).get('X-XSRF-TOKEN')).toBe('refreshed-token');
    });
  });

  // ── Error Handling ─────────────────────────────────────────────────────
  describe('error handling', () => {
    it('should throw ApiError on 401 and clear token', async () => {
      localStorage.setItem('token', 'expired-token');
      mockFetch.mockReturnValue(mockResponse({ error: 'Unauthorized' }, 401));

      await expect(api.get('/api/protected')).rejects.toMatchObject({
        name: 'ApiError',
        status: 401,
      });
      // Token should be cleared
      expect(localStorage.getItem('token')).toBeNull();
    });

    it('keeps the app session when Gmail refresh requires reconnecting only the mailbox', async () => {
      const account = JSON.stringify({ id: 4101, email: 'fixture@example.test' });
      localStorage.setItem('token', 'fixture-app-session');
      localStorage.setItem('user', account);
      sessionStorage.setItem('active-business-profile:4101', '4102');
      const dispatch = vi.spyOn(window, 'dispatchEvent');
      mockFetch.mockReturnValueOnce(mockResponse({
        code: 'GMAIL_RECONNECT_REQUIRED',
        error: 'Gmail authorization expired or was revoked. Reconnect this mailbox.',
      }, 409)).mockReturnValueOnce(mockResponse({ connected: false }));

      await expect(api.post('/api/gmail/oauth/refresh')).rejects.toMatchObject({
        name: 'ApiError', status: 409, data: { code: 'GMAIL_RECONNECT_REQUIRED' },
      });
      expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'auth:unauthorized' }));
      expect(localStorage.getItem('token')).toBe('fixture-app-session');
      expect(localStorage.getItem('user')).toBe(account);
      expect(sessionStorage.getItem('active-business-profile:4101')).toBe('4102');
      await expect(api.get('/api/gmail/oauth/status')).resolves.toEqual({ connected: false });
      const headers = new Headers(mockFetch.mock.calls[1][1].headers);
      expect(headers.get('Authorization')).toBe('Bearer fixture-app-session');
      expect(headers.get('X-Business-Profile-Id')).toBe('4102');
    });

    it('still ends an app session when the Gmail refresh route rejects actual app authentication', async () => {
      localStorage.setItem('token', 'expired-app-session');
      localStorage.setItem('user', JSON.stringify({ id: 4101 }));
      const dispatch = vi.spyOn(window, 'dispatchEvent');
      mockFetch.mockReturnValueOnce(mockResponse({ error: 'App session expired' }, 401));

      await expect(api.post('/api/gmail/oauth/refresh')).rejects.toMatchObject({ status: 401 });
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'auth:unauthorized' }));
      expect(localStorage.getItem('token')).toBeNull();
      expect(localStorage.getItem('user')).toBeNull();
    });

    it('should throw ApiError on 429 rate limit', async () => {
      mockFetch.mockReturnValue(mockResponse({ error: 'Too many requests' }, 429));

      await expect(api.get('/api/data')).rejects.toMatchObject({
        name: 'ApiError',
        status: 429,
      });
    });

    it('should throw ApiError on 402 insufficient credits', async () => {
      mockFetch.mockReturnValue(mockResponse({ message: 'No credits' }, 402));

      await expect(api.post('/api/generate', {})).rejects.toMatchObject({
        name: 'ApiError',
        status: 402,
      });
    });

    it('should throw ApiError on 500 server error', async () => {
      mockFetch.mockReturnValue(mockResponse({ error: 'Internal server error' }, 500));

      await expect(api.get('/api/data')).rejects.toMatchObject({
        name: 'ApiError',
        status: 500,
      });
    });

    it('should throw ApiError with error message from response', async () => {
      mockFetch.mockReturnValue(mockResponse({ error: 'Custom error message' }, 422));

      let caught: unknown;
      try {
        await api.get('/api/data');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('Custom error message');
    });

    it('should throw ApiError on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(api.get('/api/data')).rejects.toMatchObject({
        name: 'ApiError',
        message: 'Network error',
      });
    });
  });

  // ── Auto-unwrap { success, data } envelope ─────────────────────────────
  describe('auto-unwrap envelope', () => {
    it('should unwrap { success: true, data } response', async () => {
      const innerData = { id: 1, name: 'Alice' };
      mockFetch.mockReturnValue(mockResponse({ success: true, data: innerData }));

      const result = await api.get('/api/user');
      expect(result).toEqual(innerData);
    });

    it('should NOT unwrap if there are extra keys', async () => {
      const response = { success: true, data: { id: 1 }, extra: 'value' };
      mockFetch.mockReturnValue(mockResponse(response));

      const result = await api.get('/api/resource');
      expect(result).toEqual(response);
    });

    it('should NOT unwrap arrays', async () => {
      const response = [1, 2, 3];
      mockFetch.mockReturnValue(mockResponse(response));

      const result = await api.get('/api/list');
      expect(result).toEqual(response);
    });
  });

  // ── PUT / DELETE ────────────────────────────────────────────────────────
  describe('api.put', () => {
    it('should make a PUT request with JSON body', async () => {
      mockFetch.mockReturnValue(mockResponse({ updated: true }));
      await api.put('/api/users/1', { name: 'Updated' });
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/users/1',
        expect.objectContaining({ method: 'PUT' })
      );
    });
  });

  describe('api.delete', () => {
    it('should make a DELETE request', async () => {
      mockFetch.mockReturnValue(mockResponse({ deleted: true }));
      await api.delete('/api/users/1');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/users/1',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });
});
