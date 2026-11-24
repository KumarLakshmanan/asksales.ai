import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';

const fetchPublic = jest.fn<(url: string, init?: RequestInit, redirects?: number) => Promise<{ response: globalThis.Response; finalUrl: string }>>();
const readBuffer = jest.fn<(response: globalThis.Response, limit: number) => Promise<Buffer>>();
jest.unstable_mockModule('../utils/safeRemoteFetch.js', () => ({ fetchPublicHttpUrl: fetchPublic, readResponseBuffer: readBuffer }));
const { preflightTemplateMedia, templateMediaSignatureMatches } = await import('../controllers/whatsappTemplateMediaPreflightController.js');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const request = (body: unknown = { url: 'https://example.com/photo.png', headerType: 'IMAGE' }) => ({ user: { id: 7 }, body }) as Request;
function response() { const res = { status: jest.fn(), json: jest.fn() }; res.status.mockReturnValue(res); return res as unknown as Response & { status: ReturnType<typeof jest.fn>; json: ReturnType<typeof jest.fn> }; }
beforeEach(() => { jest.clearAllMocks(); fetchPublic.mockResolvedValue({ response: new globalThis.Response(png, { headers: { 'content-type': 'image/png' } }), finalUrl: 'https://example.com/photo.png' }); readBuffer.mockResolvedValue(png); });

describe('WhatsApp public media preflight', () => {
  it('checks type, bounded bytes and signature without a database or provider write', async () => {
    const res = response(); await preflightTemplateMedia(request(), res);
    expect(fetchPublic).toHaveBeenCalledWith('https://example.com/photo.png', expect.objectContaining({ signal: expect.anything() }), 3);
    expect(readBuffer).toHaveBeenCalledWith(expect.anything(), 5 * 1024 * 1024);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, mimeType: 'image/png', sizeBytes: 8 }));
  });
  it('rejects unauthenticated calls before making a request', async () => {
    const res = response(); await preflightTemplateMedia({ body: {} } as Request, res);
    expect(res.status).toHaveBeenCalledWith(401); expect(fetchPublic).not.toHaveBeenCalled();
  });
  it('rejects HTTP links', async () => {
    const res = response(); await preflightTemplateMedia(request({ url: 'http://example.com/a.png', headerType: 'IMAGE' }), res);
    expect(res.status).toHaveBeenCalledWith(400); expect(fetchPublic).not.toHaveBeenCalled();
  });
  it('surfaces private-network rejection from the shared safe fetch', async () => {
    fetchPublic.mockRejectedValue(new Error('Private network addresses are not supported'));
    const res = response(); await preflightTemplateMedia(request({ url: 'https://127.0.0.1/a.png', headerType: 'IMAGE' }), res);
    expect(res.json).toHaveBeenCalledWith({ error: 'Private network addresses are not supported' });
    expect(readBuffer).not.toHaveBeenCalled();
  });
  it('rejects a login page instead of media', async () => {
    fetchPublic.mockResolvedValue({ response: new globalThis.Response('login', { headers: { 'content-type': 'text/html' } }), finalUrl: 'https://example.com/login' });
    const res = response(); await preflightTemplateMedia(request(), res);
    expect(res.status).toHaveBeenCalledWith(400); expect(readBuffer).not.toHaveBeenCalled();
  });
  it('rejects declared images whose file content is not an image', async () => {
    readBuffer.mockResolvedValue(Buffer.from('not an actual png file'));
    const res = response(); await preflightTemplateMedia(request(), res);
    expect(res.json).toHaveBeenCalledWith({ error: 'The file contents do not match the declared media type.' });
  });
  it('recognizes only supported file signatures', () => {
    expect(templateMediaSignatureMatches(png, 'image/png')).toBe(true);
    expect(templateMediaSignatureMatches(Buffer.from('%PDF-1.7'), 'application/pdf')).toBe(true);
    expect(templateMediaSignatureMatches(Buffer.from('0000ftyp'), 'video/mp4')).toBe(true);
    expect(templateMediaSignatureMatches(Buffer.from('0000ftyp'), 'image/png')).toBe(false);
  });
});
