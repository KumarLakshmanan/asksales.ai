import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '@/lib/api-client';
import { selectBusinessProfile } from '@/lib/business-profile';
import { contentRequestKey } from '@/lib/content-request-key';

const api = createApiClient({ tokenStorageKey: 'token', profileStorageKeys: ['user'], unauthorizedEvent: 'test:unauthorized' });
afterEach(() => vi.unstubAllGlobals());
describe('content API recovery keys', () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.stubGlobal('crypto', webcrypto); });
  afterEach(() => vi.unstubAllGlobals());
  it('reuses a CRM create key after a lost response and rotates only after a valid confirmed contact', async () => {
    const body = { email: 'crm-recovery@example.test', firstName: 'Synthetic retry' };
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Synthetic lost contact response'))
      .mockResolvedValueOnce(new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Request-Confirmed': 'true' } }))
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: { id: 411, ...body } }), { status: 201, headers: { 'Content-Type': 'application/json', 'Content-Request-Confirmed': 'true' } }));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.post('/api/crm/contacts', body)).rejects.toThrow('Synthetic lost contact response');
    await api.post('/api/crm/contacts', body);
    await api.post('/api/crm/contacts', body);
    await api.post('/api/crm/contacts', body);
    const keys = fetcher.mock.calls.map(call => new Headers(call[1].headers).get('Idempotency-Key'));
    expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]); expect(keys[2]).toBe(keys[0]); expect(keys[3]).not.toBe(keys[0]);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(body.email);
  });
  it('keeps the same key after gateway failure; only a confirmed receipt completes it', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('Gateway timeout', { status: 504 }))
      .mockResolvedValue(new Response(JSON.stringify({ success: true, assetId: 4 }), { headers: { 'Content-Type': 'application/json', 'Content-Request-Confirmed': 'true' } }));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.post('/api/content/studio/email', { prompt: 'recovery test' })).rejects.toThrow();
    await api.post('/api/content/studio/email', { prompt: 'recovery test' });
    const key = (index: number) => new Headers(fetcher.mock.calls[index][1].headers).get('Idempotency-Key');
    expect(key(0)).toBeTruthy(); expect(key(1)).toBe(key(0));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ assetId: 5 }), { headers: { 'Content-Type': 'application/json', 'Content-Request-Confirmed': 'true' } }));
    await api.post('/api/content/studio/email', { prompt: 'recovery test' });
    expect(key(2)).not.toBe(key(0));
  });
  it('retains a key after malformed JSON and isolates different signed-in users', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response('{broken', { headers: { 'Content-Type': 'application/json' } })));
    vi.stubGlobal('fetch', fetcher);
    localStorage.setItem('user', JSON.stringify({ id: 7 }));
    await api.post('/api/content/studio/sms', { prompt: 'same request' });
    await api.post('/api/content/studio/sms', { prompt: 'same request' });
    localStorage.setItem('user', JSON.stringify({ id: 8 }));
    await api.post('/api/content/studio/sms', { prompt: 'same request' });
    const keys = fetcher.mock.calls.map((call) => new Headers(call[1].headers).get('Idempotency-Key'));
    expect(keys[0]).toBe(keys[1]); expect(keys[2]).not.toBe(keys[0]);
  });
  it('keeps an uncertain request stable across bearer token renewal', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 17 }));
    localStorage.setItem('token', 'old-token');
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response('Gateway timeout', { status: 504 })));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.post('/api/content/studio/email', { prompt: 'token renewal test' })).rejects.toThrow();
    localStorage.setItem('token', 'renewed-token');
    await expect(api.post('/api/content/studio/email', { prompt: 'token renewal test' })).rejects.toThrow();
    expect(new Headers(fetcher.mock.calls[0][1].headers).get('Idempotency-Key')).toBe(new Headers(fetcher.mock.calls[1][1].headers).get('Idempotency-Key'));
  });
  it('does not erase a newer key when an older response arrives late', async () => {
    const first = await contentRequestKey('/api/content/studio/email', 'late reply test', 'user-77');
    const replay = await contentRequestKey('/api/content/studio/email', 'late reply test', 'user-77');
    first.clear();
    const newer = await contentRequestKey('/api/content/studio/email', 'late reply test', 'user-77');
    replay.clear();
    const retry = await contentRequestKey('/api/content/studio/email', 'late reply test', 'user-77');
    expect(newer.key).not.toBe(first.key);
    expect(retry.key).toBe(newer.key);
    newer.clear();
  });
  it.each(['CONTENT_REQUEST_PENDING', 'EMAIL_SAVE_UNCONFIRMED'])('retains the same key when the confirmed receipt still has an uncertain outcome: %s', async code => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ success: false, code }), { status: 503, headers: { 'Content-Type': 'application/json', 'Content-Request-Confirmed': 'true' } })));
    vi.stubGlobal('fetch', fetcher);
    const body = { prompt: `uncertain ${code}` };
    await expect(api.post('/api/content/studio/email', body)).rejects.toThrow();
    await expect(api.post('/api/content/studio/email', body)).rejects.toThrow();
    const key = (index: number) => new Headers(fetcher.mock.calls[index][1].headers).get('Idempotency-Key');
    expect(key(0)).toBeTruthy();
    expect(key(1)).toBe(key(0));
  });
  it('reuses a template-create key after a lost or malformed receipt and rotates only after a valid result', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 4101 }));
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Synthetic lost response'))
      .mockResolvedValueOnce(new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Request-Confirmed': 'true' } }))
      .mockResolvedValue(new Response(JSON.stringify({ id: 77, name: 'Synthetic template', content: 'Hello' }), { headers: { 'Content-Type': 'application/json', 'Content-Request-Confirmed': 'true' } }));
    vi.stubGlobal('fetch', fetcher);
    const body = { name: 'Synthetic template', type: 'email', content: 'Hello' };
    await expect(api.post('/api/content/templates', body)).rejects.toThrow('Synthetic lost response');
    await api.post('/api/content/templates', body); await api.post('/api/content/templates', body); await api.post('/api/content/templates', body);
    const keys = fetcher.mock.calls.map(call => new Headers(call[1].headers).get('Idempotency-Key'));
    expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]); expect(keys[2]).toBe(keys[0]); expect(keys[3]).not.toBe(keys[0]);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('Hello');
  });

  it('isolates an uncertain template-create key between businesses for the same actor', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 4101 })); selectBusinessProfile(4102);
    const fetcher = vi.fn().mockResolvedValue(new Response('Synthetic uncertain response', { status: 504 }));
    vi.stubGlobal('fetch', fetcher);
    const body = { name: 'Synthetic scoped template', type: 'email', content: 'Hello' };
    await expect(api.post('/api/content/templates', body)).rejects.toThrow();
    selectBusinessProfile(4103);
    await expect(api.post('/api/content/templates', body)).rejects.toThrow();
    const headers = fetcher.mock.calls.map(call => new Headers(call[1].headers));
    expect(headers[1].get('Idempotency-Key')).not.toBe(headers[0].get('Idempotency-Key'));
    expect(headers[0].get('X-Business-Profile-Id')).toBe('4102');
    expect(headers[1].get('X-Business-Profile-Id')).toBe('4103');
  });

});

it('rotates a confirmed production-envelope template key for identical-body recreation after deletion', async () => {
  sessionStorage.clear(); localStorage.clear(); vi.stubGlobal('crypto', webcrypto);
  const body = { name: 'Synthetic envelope create', type: 'email', content: 'Hello' };
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { id: 77, ...body } }), { status: 201, headers: { 'Content-Type': 'application/json', 'Content-Request-Confirmed': 'true' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, message: 'Deleted' }), { headers: { 'Content-Type': 'application/json' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { id: 78, ...body } }), { status: 201, headers: { 'Content-Type': 'application/json', 'Content-Request-Confirmed': 'true' } }));
  vi.stubGlobal('fetch', fetcher);
  const first = await api.post<{ id: number }>('/api/content/templates', body);
  await api.delete('/api/content/templates/77');
  const next = await api.post<{ id: number }>('/api/content/templates', body);
  expect(first.id).toBe(77); expect(next.id).toBe(78);
  const key = (index: number) => new Headers(fetcher.mock.calls[index][1].headers).get('Idempotency-Key');
  expect(key(0)).toBeTruthy(); expect(key(2)).not.toBe(key(0));
  vi.unstubAllGlobals();
});

it('retains EMAIL_SAVE_UNCONFIRMED keys with wrapped errors even when the wrapper removes their code', async () => {
  sessionStorage.clear(); localStorage.clear(); vi.stubGlobal('crypto', webcrypto);
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: 'Unconfirmed draft save' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Content-Request-Confirmed': 'true' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { code: 'EMAIL_SAVE_UNCONFIRMED' } }), { headers: { 'Content-Type': 'application/json', 'Content-Request-Confirmed': 'true' } }))
    .mockResolvedValue(new Response(JSON.stringify({ success: true, assetId: 15 }), { headers: { 'Content-Type': 'application/json', 'Content-Request-Confirmed': 'true' } }));
  vi.stubGlobal('fetch', fetcher);
  const body = { prompt: 'Synthetic envelope unconfirmed' };
  await expect(api.post('/api/content/studio/email', body)).rejects.toThrow();
  await api.post('/api/content/studio/email', body); await api.post('/api/content/studio/email', body);
  const keys = fetcher.mock.calls.map(call => new Headers(call[1].headers).get('Idempotency-Key'));
  expect(keys[1]).toBe(keys[0]); expect(keys[2]).toBe(keys[0]);
  vi.unstubAllGlobals();
});
