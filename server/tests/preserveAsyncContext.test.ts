import { describe, expect, it } from '@jest/globals';
import { AsyncResource } from 'node:async_hooks';
import { once } from 'node:events';
import { request } from 'node:http';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { preserveAsyncContext } from '../middleware/preserveAsyncContext.js';
import { currentBusinessScope, withBusinessScope } from '../tenancy/businessContext.js';
import { currentBillingScope, withBillingScope } from '../tenancy/billingContext.js';

const fixtures = [
  { business: { userId: 101, businessProfileId: 201, actorUserId: 101, role: 'owner' }, billing: { organizationId: 301, actorUserId: 101, businessProfileId: 201, businessOwnerUserId: 101 } },
  { business: { userId: 102, businessProfileId: 202, actorUserId: 902, role: 'member' }, billing: { organizationId: 302, actorUserId: 902, businessProfileId: 202, businessOwnerUserId: 102 } },
] as const;
const snapshot = () => ({ business: currentBusinessScope() ?? null, billing: currentBillingScope() ?? null,
  businessFrozen: !!currentBusinessScope() && Object.isFrozen(currentBusinessScope()), billingFrozen: !!currentBillingScope() && Object.isFrozen(currentBillingScope()) });
type Snapshot = ReturnType<typeof snapshot>;
function expectIdentity(actual: Snapshot, index: number) {
  expect(actual.business).toEqual({ ...fixtures[index].business, kind: 'business' });
  expect(actual.billing).toEqual(fixtures[index].billing);
  expect(actual.businessFrozen).toBe(true); expect(actual.billingFrozen).toBe(true);
}
function scope<T>(index: number, work: () => T) {
  return withBusinessScope(fixtures[index].business, () => withBillingScope(fixtures[index].billing, work));
}

describe('existing preserveAsyncContext continuation contract', () => {
  it('keeps independent immutable business/actor/payer snapshots across interleaved foreign callbacks', async () => {
    const stream = new AsyncResource('synthetic-pre-auth-stream');
    try {
      const failures = [new Error('Synthetic parser failure A'), new Error('Synthetic parser failure B')];
      const observe = (index: number) => scope(index, () => new Promise<Snapshot & { error: unknown }>(resolve => {
        const parser: RequestHandler = (_req, _res, next) => stream.runInAsyncScope(() => setImmediate(() => next(failures[index])));
        preserveAsyncContext(parser)({} as Request, {} as Response, error => resolve({ ...snapshot(), error }));
      }));
      const results = await Promise.all([observe(0), observe(1)]);
      results.forEach((result, index) => { expectIdentity(result, index); expect(result.error).toBe(failures[index]); });
      expect(currentBusinessScope()).toBeUndefined(); expect(currentBillingScope()).toBeUndefined();
    } finally { stream.emitDestroy(); }
  });

  it('does not invent a business or payer when invoked outside validated scopes', async () => {
    const stream = new AsyncResource('synthetic-unscoped-stream');
    try {
      const result = await new Promise<Snapshot>(resolve => {
        const parser: RequestHandler = (_req, _res, next) => scope(1, () => stream.runInAsyncScope(() => next()));
        preserveAsyncContext(parser)({} as Request, {} as Response, () => resolve(snapshot()));
      });
      expect(result.business).toBeNull(); expect(result.billing).toBeNull();
    } finally { stream.emitDestroy(); }
  });

  it('leaves synchronous parser exceptions intact for Express', () => {
    const failure = new Error('Synthetic synchronous parser failure');
    const parser: RequestHandler = () => { throw failure; };
    expect(() => scope(1, () => preserveAsyncContext(parser)({} as Request, {} as Response, () => undefined))).toThrow(failure);
  });
});

type MultipartResult = Snapshot & { status: number; bytes?: number; error?: string };
async function withMultipartServer(work: (send: (path: string, size: number, identity: number) => Promise<MultipartResult>) => Promise<void>) {
  const app = express();
  // Synthetic validated scope fixture. These tests do not claim JWT/auth coverage.
  app.use((req, _res, next) => scope(req.get('X-Synthetic-Identity') === '1' ? 1 : 0, next));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });
  const limited = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 } });
  const handler: RequestHandler = (req, res) => { res.json({ bytes: req.file?.buffer.length, ...snapshot() }); };
  app.post('/bound', preserveAsyncContext(upload.single('file')), handler);
  app.post('/bare', upload.single('file'), handler);
  app.post('/limit', preserveAsyncContext(limited.single('file')), handler);
  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: error instanceof multer.MulterError ? error.code : error.message, ...snapshot() });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
  async function send(path: string, size: number, identity: number): Promise<MultipartResult> {
    const boundary = 'synthetic-context-fixture';
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.txt"\r\nContent-Type: text/plain\r\n\r\n`), Buffer.alloc(size, 97), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address && typeof address !== 'string' ? address.port : 0, path, method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length, 'X-Synthetic-Identity': String(identity) } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, ...JSON.parse(Buffer.concat(chunks).toString()) } as MultipartResult); }
          catch (error) { reject(error); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Synthetic upload timed out')));
      // Explicit chunk scheduling crosses actual pre-auth request-stream events.
      let offset = 0;
      const write = () => {
        if (req.destroyed) return;
        if (offset >= body.length) { req.end(); return; }
        const ready = req.write(body.subarray(offset, offset + 16384)); offset += 16384;
        if (ready) setImmediate(write); else req.once('drain', () => setImmediate(write));
      };
      write();
    });
  }
  try { await work(send); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

describe('real loopback HTTP and Multer stream boundaries', () => {
  it.each([[1024, 0], [2 * 1024 * 1024, 1]])('preserves the validated identity for %i bytes (fixture %i)', async (size, identity) => {
    await withMultipartServer(async send => {
      const result = await send('/bound', size, identity);
      expect(result.status).toBe(200); expect(result.bytes).toBe(size); expectIdentity(result, identity);
    });
  });
  it('keeps two concurrent 2 MiB requests separate across different actors and payers', async () => {
    await withMultipartServer(async send => {
      const results = await Promise.all([send('/bound', 2 * 1024 * 1024, 0), send('/bound', 2 * 1024 * 1024, 1)]);
      results.forEach((result, index) => { expect(result.status).toBe(200); expect(result.bytes).toBe(2 * 1024 * 1024); expectIdentity(result, index); });
    });
  });
  it('passes real parser errors through the bound continuation without reaching the success handler', async () => {
    await withMultipartServer(async send => {
      const result = await send('/limit', 1024, 1);
      expect(result.status).toBe(400); expect(result.error).toBe('LIMIT_FILE_SIZE'); expect(result.bytes).toBeUndefined(); expectIdentity(result, 1);
    });
  });
  it('control: an unwrapped stream may retain its own context or lose it', async () => {
    await withMultipartServer(async send => {
      const result = await send('/bare', 2 * 1024 * 1024, 1);
      expect(result.status).toBe(200); expect(result.bytes).toBe(2 * 1024 * 1024);
      if (result.business || result.billing) expectIdentity(result, 1);
      else { expect(result.business).toBeNull(); expect(result.billing).toBeNull(); }
    });
  });
});
