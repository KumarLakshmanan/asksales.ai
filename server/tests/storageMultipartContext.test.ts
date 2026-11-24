import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import Redis from 'ioredis';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { currentBusinessScope, type BusinessScope } from '../tenancy/businessContext.js';
import { currentBillingScope, type BillingScope } from '../tenancy/billingContext.js';

// Redirect only the database singleton. The mounted settings router, auth,
// scopes, multipart parser, quota SQL, receipt transaction and objects are real.
let database: NodePgDatabase;
jest.unstable_mockModule('../models/db.js', () => ({
  db: new Proxy({} as NodePgDatabase, {
    get(_target, key) {
      const value = database[key as keyof NodePgDatabase];
      return typeof value === 'function' ? value.bind(database) : value;
    },
  }),
}));
const local = process.env.STORAGE_MULTIPART_LOCAL_QA === '1' ? describe : describe.skip;
local('mounted settings multipart retains validated business and billing identities', () => {
  let admin: Pool, runtime: Pool, server: Server, port: number, root: string;
  let owner: number, member: number, alpha: number, beta: number;
  let tokens: Record<string, string>;
  let closeRedis: () => Promise<void>;
  const duplicates: Redis[] = [];

  beforeAll(async () => {
    const url = new URL(process.env.STORAGE_AUDIT_DATABASE_URL || '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !/^\/storage_audit(?:_[a-z0-9_]+)?$/.test(url.pathname) ||
        process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '56483')
      throw new Error('Provision an explicit disposable local storage audit database and Redis');
    admin = new Pool({ connectionString: url.href, max: 2 });
    runtime = createBusinessScopedPool(new Pool({ connectionString: url.href, max: 10 }));
    database = drizzle(runtime);
    expect((await admin.query("SELECT name FROM js_migrations WHERE name='342_subscription_credential_integrity.js'")).rowCount).toBe(1);
    root = await mkdtemp(join(tmpdir(), 'storage-multipart-fixture-'));
    process.env.LOCAL_STORAGE_PATH = root;
    process.env.STORAGE_BACKEND = 'local';
    process.env.JWT_SECRET = 'storage-multipart-synthetic-only-key';
    jest.spyOn(Redis.prototype, 'duplicate').mockImplementation(function (this: Redis, options) {
      const connection = new Redis({ ...this.options, ...options });
      duplicates.push(connection);
      return connection;
    });
    const users = await admin.query(`INSERT INTO users(email,name,is_verified,is_approved,is_setup_complete)
      VALUES($1,'Synthetic Owner',true,true,true),($2,'Synthetic Member',true,true,true) RETURNING id`,
    [`multipart-${randomUUID()}@example.invalid`, `multipart-${randomUUID()}@example.invalid`]);
    [owner, member] = users.rows.map(row => Number(row.id));
    const profiles = await admin.query(`INSERT INTO company_settings(user_id,company_name,is_default)
      VALUES($1,'Synthetic Alpha',true),($1,'Synthetic Beta',false) RETURNING id`, [owner]);
    [alpha, beta] = profiles.rows.map(row => Number(row.id));
    await admin.query(`INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status)
      VALUES($1,$3,'member@example.invalid','member','active'),($2,$3,'member@example.invalid','member','active')`, [alpha, beta, member]);
    const { generateToken } = await import('../utils/jwt.js');
    tokens = { owner: generateToken({ userId: owner, email: 'owner@example.invalid' }), member: generateToken({ userId: member, email: 'member@example.invalid' }) };
    const settings = (await import('../routes/settings.routes.js')).default;
    ({ closeRedisConnections: closeRedis } = await import('../infrastructure/redis.js'));
    const app = express();
    // Observe the live handler/error continuation, rather than a context captured
    // by an earlier response event listener or a helper-only unit test.
    app.use((_req, res, next) => {
      const writeHead = res.writeHead;
      res.writeHead = function (this: express.Response, ...args: Parameters<typeof writeHead>) {
        res.setHeader('X-Fixture-Business', JSON.stringify(currentBusinessScope() || null));
        res.setHeader('X-Fixture-Billing', JSON.stringify(currentBillingScope() || null));
        return writeHead.apply(this, args);
      } as typeof writeHead;
      next();
    });
    app.use('/api/settings', settings);
    app.use((error: Error & { code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ code: error.code, error: error.message });
    });
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    port = (server.address() as AddressInfo).port;
  }, 30000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    jest.restoreAllMocks();
    for (const duplicate of duplicates) duplicate.disconnect();
    await closeRedis?.();
    await runtime?.end();
    await admin?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function upload(bytes: number, { actor = 'owner', profile = alpha, receipt = randomUUID(), field = 'file' }: { actor?: string; profile?: number; receipt?: string; field?: string } = {}) {
    const boundary = `storage-fixture-${randomUUID()}`;
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="synthetic.txt"\r\nContent-Type: text/plain\r\n\r\n`);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    return new Promise<{ status: number; body: { data: { id: number }; code?: string }; business: BusinessScope | null; billing: BillingScope | null }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/settings/storage/files', headers: {
        Authorization: `Bearer ${tokens[actor]}`, 'X-Business-Profile-Id': String(profile),
        ...(receipt ? { 'X-Storage-Upload-Id': receipt } : {}),
        'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': prefix.length + bytes + suffix.length,
      } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()),
          business: JSON.parse(String(res.headers['x-fixture-business'])), billing: JSON.parse(String(res.headers['x-fixture-billing'])) }));
      });
      req.on('error', reject);
      // Headers and payload arrive on different turns. Never infer correctness
      // from whether a particular byte count fits in one buffered TCP read.
      req.write(prefix);
      let remaining = bytes;
      function chunk() {
        if (!remaining) { req.end(suffix); return; }
        const size = Math.min(64 * 1024, remaining);
        remaining -= size;
        req.write(Buffer.alloc(size, 120));
        setImmediate(chunk);
      }
      setImmediate(chunk);
    });
  }
  async function expectIdentity(result: Awaited<ReturnType<typeof upload>>, actor: number, profile: number) {
    expect(result.business).toMatchObject({ kind: 'business', userId: owner, businessProfileId: profile, actorUserId: actor });
    const payer = Number((await admin.query('SELECT billing_organization_id FROM company_settings WHERE id=$1', [profile])).rows[0].billing_organization_id);
    expect(result.billing).toEqual({ organizationId: payer, actorUserId: actor, businessProfileId: profile, businessOwnerUserId: owner });
  }
  it.each([1024, 2 * 1024 * 1024, 25 * 1024 * 1024 - 1])('persists a streamed %i-byte receipt upload with both stores', async bytes => {
    const result = await upload(bytes);
    expect(result.status).toBe(201);
    await expectIdentity(result, owner, alpha);
    const row = (await admin.query('SELECT user_id,business_profile_id,file_size_bytes FROM storage_files WHERE id=$1', [result.body.data.id])).rows[0];
    expect(row).toMatchObject({ user_id: owner, business_profile_id: alpha, file_size_bytes: String(bytes) });
  }, 30000);
  it('preserves member/owner, nondefault business and payer across concurrent requests and receipt replay', async () => {
    const receipt = randomUUID();
    const values = [
      { actor: 'member', profile: beta, receipt }, { actor: 'member', profile: beta, receipt },
      { actor: 'owner', profile: alpha, receipt: randomUUID() }, { actor: 'owner', profile: beta, receipt: randomUUID() },
    ];
    const results = await Promise.all(values.map(value => upload(2 * 1024 * 1024, value)));
    for (const [index, result] of results.entries()) {
      expect(result.status).toBe(201);
      await expectIdentity(result, values[index].actor === 'member' ? member : owner, values[index].profile);
    }
    expect(results[0].body.data.id).toBe(results[1].body.data.id);
    const replay = await upload(2 * 1024 * 1024, values[0]);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(results[0].body.data.id);
  }, 30000);
  it('keeps the no-receipt Chat/Knowledge caller compatible', async () => {
    const result = await upload(2 * 1024 * 1024, { actor: 'member', profile: beta, receipt: '' });
    expect(result.status).toBe(201);
    await expectIdentity(result, member, beta);
  });
  it('preserves both stores through parser errors without persisting bytes or quota reservations', async () => {
    const before = (await admin.query('SELECT count(*) FROM storage_files WHERE user_id=$1', [owner])).rows;
    const objectsBefore = await readdir(root, { recursive: true });
    const oversized = await upload(25 * 1024 * 1024 + 1, { actor: 'member', profile: beta });
    expect(oversized.status).toBe(413);
    expect(oversized.body.code).toBe('LIMIT_FILE_SIZE');
    await expectIdentity(oversized, member, beta);
    const unexpected = await upload(1024, { actor: 'member', profile: beta, field: 'unexpected' });
    expect(unexpected.status).toBe(400);
    expect(unexpected.body.code).toBe('LIMIT_UNEXPECTED_FILE');
    await expectIdentity(unexpected, member, beta);
    expect((await admin.query('SELECT count(*) FROM storage_files WHERE user_id=$1', [owner])).rows).toEqual(before);
    expect(await readdir(root, { recursive: true })).toEqual(objectsBefore);
    expect((await admin.query('SELECT count(*) FROM billing_storage_reservations WHERE user_id=$1', [owner])).rows[0].count).toBe('0');
    const sums = (await admin.query(`SELECT q.storage_used_bytes,q.file_count,(SELECT sum(file_size_bytes)::bigint FROM storage_files WHERE user_id=$1 AND is_deleted=false) AS actual_bytes,
      (SELECT count(*) FROM storage_files WHERE user_id=$1 AND is_deleted=false) AS actual_count FROM storage_quotas q WHERE q.user_id=$1`, [owner])).rows[0];
    expect(sums.storage_used_bytes).toBe(sums.actual_bytes);
    expect(String(sums.file_count)).toBe(sums.actual_count);
  }, 30000);
});
