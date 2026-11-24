import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { logger } from '../utils/logger.js';

export function compactContentReceipt(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const result = { ...(body as Record<string, unknown>) };
  if (result.persisted === true && Number.isSafeInteger(result.assetId) && Number(result.assetId) > 0) {
    for (const kind of ['image', 'video']) {
      const url = result[`${kind}Url`];
      if (typeof url === 'string' && (url.startsWith('/uploads/') || /^https:\/\//.test(url))) delete result[`${kind}Data`];
    }
  }
  return result;
}

/** Durable at-most-once dispatch. Pending/uncertain work is never automatically re-executed. */
export async function contentRequestReceipt(req: Request, res: Response, next: NextFunction) {
  const key = req.get('Idempotency-Key');
  if (!key) return next(); // Legacy callers remain compatible.
  if (!/^[a-zA-Z0-9_-]{8,200}$/.test(key)) return res.status(400).json({ error: 'Invalid idempotency key.' });
  const userId = Number((req as Request & { user?: { id: number } }).user?.id);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const hash = createHash('sha256').update(JSON.stringify({ path: req.path, body: req.body })).digest('hex');
  try {
    // Keep only a tombstone after 30 days. Expiring the body must never reopen
    // an old key and repeat a paid operation. Pending receipts never expire.
    await db.execute(sql`UPDATE content_request_receipts SET state='expired', response_body=NULL
      WHERE user_id=${userId} AND state='complete' AND completed_at < NOW() - INTERVAL '30 days'`);
    const claimed = await db.execute(sql`INSERT INTO content_request_receipts (user_id, request_key, request_hash)
      VALUES (${userId}, ${key}, ${hash}) ON CONFLICT DO NOTHING RETURNING request_key`);
    if (!claimed.rows.length) {
      const existing = await db.execute(sql`SELECT request_hash, state, status_code, response_body FROM content_request_receipts WHERE user_id=${userId} AND request_key=${key}`);
      const receipt = existing.rows[0];
      if (!receipt || receipt.request_hash !== hash) return res.status(409).json({ error: 'This request key belongs to different content.', code: 'REQUEST_KEY_CONFLICT' });
      if (receipt.state === 'complete') {
        res.setHeader('Idempotency-Replayed', 'true');
        res.setHeader('Content-Request-Confirmed', 'true');
        return res.status(receipt.status_code).json(receipt.response_body);
      }
      if (receipt.state === 'expired') return res.status(410).json({ error: 'This generation receipt has expired. Find the saved result in your library.', code: 'CONTENT_REQUEST_EXPIRED' });
      return res.status(409).json({ error: 'This request is still running or its result is unconfirmed. Check Recent before starting another generation. Retrying this request will not charge you again.', code: 'CONTENT_REQUEST_PENDING' });
    }
    const sendJson = res.json.bind(res);
    let captured = false;
    res.json = ((body: unknown) => {
      if (captured) return res;
      captured = true;
      const status = res.statusCode;
      const receiptBody = compactContentReceipt(body);
      void db.execute(sql`UPDATE content_request_receipts SET state='complete', status_code=${status}, response_body=${JSON.stringify(receiptBody)}::jsonb, completed_at=NOW() WHERE user_id=${userId} AND request_key=${key}`)
        .then(() => { res.setHeader('Content-Request-Confirmed', 'true'); sendJson(body); })
        .catch((error: unknown) => {
          logger.error({ err: error, userId }, 'Content request receipt could not be saved');
          res.status(503);
          sendJson({ error: 'The request result could not be confirmed. Check Recent; do not start a duplicate generation.', code: 'CONTENT_REQUEST_PENDING' });
        });
      return res;
    }) as Response['json'];
    return next();
  } catch (error) {
    logger.error({ err: error, userId }, 'Content request receipt unavailable');
    return res.status(503).json({ error: 'Generation recovery is temporarily unavailable. No new request was started.' });
  }
}
