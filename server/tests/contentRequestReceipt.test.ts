import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const execute = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: (query: unknown) => JSON.stringify(query).includes("state='expired'") ? Promise.resolve({ rows: [] }) : execute(query) } }));
const { contentRequestReceipt, compactContentReceipt } = await import('../middleware/contentRequestReceipt.js');
function request(key = 'test-request-key') { return { path: '/studio/email', body: { prompt: 'hello' }, user: { id: 7 }, get: () => key } as any; }
function response() {
  const res: any = { statusCode: 200 };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn(() => res); res.setHeader = jest.fn(); return res;
}
describe('durable content request receipts', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  it('claims a request before allowing provider work', async () => {
    execute.mockResolvedValueOnce({ rows: [{ request_key: 'test-request-key' }] });
    const next = jest.fn(); const res = response(); const send = res.json;
    await contentRequestReceipt(request(), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    execute.mockResolvedValueOnce({ rows: [] });
    res.json({ assetId: 4 });
    await new Promise(resolve => setImmediate(resolve));
    expect(send).toHaveBeenCalledWith({ assetId: 4 });
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('blocks a pending duplicate without running the handler', async () => {
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(JSON.stringify({ path: '/studio/email', body: { prompt: 'hello' } })).digest('hex');
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ request_hash: hash, state: 'pending' }] });
    const next = jest.fn(); const res = response(); await contentRequestReceipt(request(), res, next);
    expect(next).not.toHaveBeenCalled(); expect(res.statusCode).toBe(409); expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONTENT_REQUEST_PENDING' }));
  });
  it('replays a completed receipt and refuses changed payloads', async () => {
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(JSON.stringify({ path: '/studio/email', body: { prompt: 'hello' } })).digest('hex');
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ request_hash: hash, state: 'complete', status_code: 200, response_body: { assetId: 4 } }] });
    const res = response(); const next = jest.fn(); await contentRequestReceipt(request(), res, next);
    expect(res.json).toHaveBeenCalledWith({ assetId: 4 }); expect(next).not.toHaveBeenCalled();
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ request_hash: 'other' }] });
    const conflict = response(); await contentRequestReceipt(request(), conflict, next); expect(conflict.statusCode).toBe(409);
  });
  it('fails closed if recovery persistence is unavailable', async () => {
    execute.mockRejectedValueOnce(new Error('offline')); const next = jest.fn(); const res = response();
    await contentRequestReceipt(request(), res, next); expect(next).not.toHaveBeenCalled(); expect(res.statusCode).toBe(503);
  });
  it('never reopens an expired receipt for another paid operation', async () => {
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(JSON.stringify({ path: '/studio/email', body: { prompt: 'hello' } })).digest('hex');
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ request_hash: hash, state: 'expired' }] });
    const next = jest.fn(); const res = response();
    await contentRequestReceipt(request(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(410);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONTENT_REQUEST_EXPIRED' }));
  });
  it('compacts binary payloads only after durable asset storage is confirmed', () => {
    const body = { persisted: true, assetId: 4, imageUrl: '/uploads/image.png', imageData: 'large-base64', videoData: 'keep-without-url' };
    expect(compactContentReceipt(body)).toEqual({ persisted: true, assetId: 4, imageUrl: '/uploads/image.png', videoData: 'keep-without-url' });
    expect(compactContentReceipt({ ...body, persisted: false })).toHaveProperty('imageData');
    expect(compactContentReceipt({ ...body, imageUrl: 'blob:temporary' })).toHaveProperty('imageData');
    expect(body.imageData).toBe('large-base64');
  });
});
