import multer from 'multer';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, RequestHandler } from 'express';
import { currentBusinessScope } from '../tenancy/businessContext.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export const SUPPORT_UPLOAD_FILE_BYTES = 5 * 1024 * 1024;
export const SUPPORT_UPLOAD_TOTAL_BYTES = 20 * 1024 * 1024;
const activeTenants = new Map<number, number>();
let activeTotal = 0;

/** Keep multipart bodies on private temporary disk and meter actual bytes.
 * Content-Length is only an early rejection; chunked bodies share the same cap.
 */
export function boundedUpload(options: { field: string; files: number; mimeTypes: string[]; single?: boolean }): RequestHandler {
  return async (req, res, next) => {
    const resume = AsyncLocalStorage.bind(next);
    const tenant = currentBusinessScope()?.businessProfileId || req.user?.id;
    if (!tenant) { res.status(401).json({ error: 'Unauthorized' }); return; }
    if (Number(req.headers['content-length']) > SUPPORT_UPLOAD_TOTAL_BYTES + 64 * 1024) {
      res.status(413).json({ error: 'Upload request exceeds 20 MiB.' }); return;
    }
    if (activeTotal >= 8 || (activeTenants.get(tenant) || 0) >= 2) {
      res.status(429).json({ error: 'An upload is already in progress. Please retry shortly.' }); return;
    }
    activeTotal++;
    activeTenants.set(tenant, (activeTenants.get(tenant) || 0) + 1);
    let directory: string | undefined;
    let released = false;
    const cancellation = new AbortController();
    const writes = new Set<Promise<void>>();
    const timer = setTimeout(() => {
      cleanup();
      if (!res.headersSent) res.status(408).json({ error: 'Upload timed out. Please retry.' });
    }, 30_000);
    const cleanup = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      cancellation.abort();
      activeTotal--;
      const count = (activeTenants.get(tenant) || 1) - 1;
      if (count) activeTenants.set(tenant, count); else activeTenants.delete(tenant);
      if (directory) {
        const target = directory;
        void Promise.allSettled([...writes]).then(() => rm(target, { recursive: true, force: true })).catch(() => undefined);
      }
    };
    res.once('finish', cleanup);
    res.once('close', cleanup);
    try {
      directory = await mkdtemp(path.join(tmpdir(), 'asksales-upload-'));
      if (released) { await rm(directory, { recursive: true, force: true }); return; }
      let total = 0;
      let fileIndex = 0;
      const storage: multer.StorageEngine = {
        _handleFile(_req, file, callback) {
          const filePath = path.join(directory!, String(fileIndex++));
          let size = 0;
          const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
            size += chunk.length;
            total += chunk.length;
            done(total > SUPPORT_UPLOAD_TOTAL_BYTES ? new Error('Upload request exceeds 20 MiB.') : null, chunk);
          } });
          const pending = pipeline(file.stream, meter, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }), { signal: cancellation.signal })
            .then(() => callback(null, { path: filePath, size, destination: directory, filename: path.basename(filePath) }))
            .catch(error => callback(error));
          writes.add(pending);
        },
        _removeFile(_req: Request, file, callback) {
          void rm(file.path, { force: true }).then(() => callback(null), callback);
        },
      };
      const upload = multer({
        storage,
        limits: { fileSize: SUPPORT_UPLOAD_FILE_BYTES, files: options.files, fields: 5, fieldSize: 32 * 1024, parts: options.files + 5 },
        fileFilter: (_req, file, callback) => {
          if (options.mimeTypes.includes(file.mimetype)) callback(null, true);
          else callback(new Error('Unsupported file type'));
        },
      });
      const handler = options.single ? upload.single(options.field) : upload.array(options.field, options.files);
      handler(req, res, error => {
        clearTimeout(timer);
        if (released) return;
        if (error) {
          cleanup();
          res.status(413).json({ error: error.message || 'Upload limit exceeded.' });
          return;
        }
        resume();
      });
    } catch (error) {
      cleanup();
      resume(error);
    }
  };
}
