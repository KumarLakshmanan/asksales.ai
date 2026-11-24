import { describe, it, expect } from '@jest/globals';
import { z } from 'zod';
import { validateBody } from '../middleware/validation';

/**
 * Phase 9.8 / MID-005: validateBody accepts an options bag.
 * The default keeps the previous strict behaviour; explicit
 * `strict: false` falls back to Zod's `.passthrough()` so unknown
 * keys are preserved on `req.body`.
 */

function runMiddleware(mw: ReturnType<typeof validateBody>, body: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Promise<{ status: number; body: any }>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = { body, path: '/test' } as any;
    const res = {
      status(code: number) { this._status = code; return this; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      json(payload: any) { resolve({ status: this._status ?? 200, body: payload }); return this; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    mw(req, res, () => resolve({ status: 200, body: req.body }));
  });
}

describe('validateBody options (Phase 9.8 / MID-005)', () => {
  const schema = z.object({ name: z.string() });

  it('rejects unknown keys by default (strict)', async () => {
    const mw = validateBody(schema);
    const result = await runMiddleware(mw, { name: 'a', extra: 1 });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('Validation failed');
  });

  it('preserves unknown keys when strict: false', async () => {
    const mw = validateBody(schema, { strict: false });
    const result = await runMiddleware(mw, { name: 'a', extra: 1 });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ name: 'a', extra: 1 });
  });

  it('still validates known keys when strict: false', async () => {
    const mw = validateBody(schema, { strict: false });
    const result = await runMiddleware(mw, { name: 123 });
    expect(result.status).toBe(400);
  });
});
