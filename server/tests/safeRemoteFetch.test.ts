import { describe, expect, it } from '@jest/globals';
import { assertPublicHttpUrl, readResponseBuffer } from '../utils/safeRemoteFetch.js';
import { normalizeStorageKey } from '../services/ObjectStorageService.js';

describe('safe remote fetch boundaries', () => {
  it.each([
    'http://127.0.0.1/file',
    'http://10.0.0.1/file',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/file',
    'http://[::ffff:a9fe:a9fe]/latest/meta-data',
    'http://[::ffff:7f00:1]/file',
    'http://[0:0:0:0:0:ffff:192.168.1.1]/file',
    'http://[fec0::1]/file',
    'http://[::127.0.0.1]/file',
    'http://[64:ff9b::7f00:1]/file',
    'http://[2002:7f00:1::]/file',
    'http://localhost/file',
    'http://service.internal/file',
  ])('rejects private destination %s', async (url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toThrow('Private network');
  });

  it('rejects credentials, non-web protocols, and non-standard ports', async () => {
    await expect(assertPublicHttpUrl('https://user:password@8.8.8.8/file')).rejects.toThrow('credentials');
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow('HTTP');
    await expect(assertPublicHttpUrl('https://8.8.8.8:8443/file')).rejects.toThrow('ports');
  });

  it('accepts a public standard-port URL', async () => {
    await expect(assertPublicHttpUrl('https://8.8.8.8/file')).resolves.toMatchObject({ protocol: 'https:' });
  });

  it('enforces declared and streamed response limits', async () => {
    const declared = new Response('small', { headers: { 'content-length': '100' } });
    await expect(readResponseBuffer(declared, 10)).rejects.toThrow('limit');

    const streamed = new Response('this body is too large');
    await expect(readResponseBuffer(streamed, 5)).rejects.toThrow('limit');
  });

  it('returns a bounded response body intact', async () => {
    const buffer = await readResponseBuffer(new Response('safe'), 10);
    expect(buffer.toString('utf8')).toBe('safe');
  });
});

describe('storage key normalization', () => {
  it.each(['../secret', '/absolute/file', 'user//file', 'user/../secret', 'user\\..\\secret', 'user/\0file'])('rejects unsafe key %s', (key) => {
    expect(() => normalizeStorageKey(key)).toThrow('Invalid storage key');
  });

  it('normalizes a safe relative key', () => {
    expect(normalizeStorageKey('./42/document/report.pdf')).toBe('42/document/report.pdf');
  });

  it('only permits an empty key for a list prefix', () => {
    expect(() => normalizeStorageKey('')).toThrow('Invalid storage key');
    expect(normalizeStorageKey('', true)).toBe('');
  });
});
