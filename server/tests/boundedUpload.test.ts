import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { readFile } from 'node:fs/promises';
import { boundedUpload } from '../middleware/boundedUpload.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

const app = express();
app.use((req, _res, next) => {
  req.user = { id: 1 } as typeof req.user;
  withBusinessScope({ userId: 1, actorUserId: 1, businessProfileId: 11 }, next);
});
app.post('/images', boundedUpload({ field: 'images', files: 5, mimeTypes: ['image/png'] }), async (req, res) => {
  const files = req.files as Express.Multer.File[];
  res.json({ count: files.length, memoryBuffered: files.some(file => Boolean(file.buffer)), size: (await readFile(files[0].path)).length });
});

describe('streamed support upload limits', () => {
  it('spools accepted multipart files to quarantine instead of retaining buffers', async () => {
    const result = await request(app).post('/images').attach('images', Buffer.alloc(2048), { filename: 'one.png', contentType: 'image/png' }).expect(200);
    expect(result.body).toEqual({ count: 1, memoryBuffered: false, size: 2048 });
  });
  it('rejects a file above five MiB before image processing', async () => {
    await request(app).post('/images').attach('images', Buffer.alloc(5 * 1024 * 1024 + 1), { filename: 'oversized.png', contentType: 'image/png' }).expect(413);
  });
  it('meters aggregate streamed bytes even when each file is within its limit', async () => {
    const body = Buffer.alloc(4 * 1024 * 1024 + 1);
    let upload = request(app).post('/images');
    for (let index = 0; index < 5; index++) upload = upload.attach('images', body, { filename: `${index}.png`, contentType: 'image/png' });
    await upload.expect(413);
  });
  it('rejects unsupported MIME types and excessive file counts', async () => {
    await request(app).post('/images').attach('images', Buffer.from('<svg/>'), { filename: 'one.svg', contentType: 'image/svg+xml' }).expect(413);
    let upload = request(app).post('/images');
    for (let index = 0; index < 6; index++) upload = upload.attach('images', Buffer.alloc(1), { filename: `${index}.png`, contentType: 'image/png' });
    await upload.expect(413);
  });
});
