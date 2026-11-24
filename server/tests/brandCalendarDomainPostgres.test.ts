import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import express from 'express';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { assertBusinessScopeSchema } from '../tenancy/schemaGuard.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

const database = process.env.BRAND_CALENDAR_TEST_DATABASE;
const suite = database ? describe : describe.skip;
let admin: Pool, pool: Pool, server: Server, base: string;
const databaseProxy = new Proxy({}, { get: (_target, key) => Reflect.get(drizzle(pool), key) });
jest.unstable_mockModule('../models/db.js', () => ({ db: databaseProxy }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const changeSchedule = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ affected: 1 });
jest.unstable_mockModule('../services/social/OrganicPublishLifecycleService.js', () => ({
  changeOrganicPublishSchedule: changeSchedule, publishAttemptCapabilities: () => ({}),
}));
const { authenticateToken } = await import('../middleware/auth.js');
const { requireModuleAccess } = await import('../middleware/platformAccess.js');
const { generateToken } = await import('../utils/jwt.js');
const { closeRedisConnections } = await import('../infrastructure/redis.js');
const { SmartThrottlingService } = await import('../services/SmartThrottlingService.js');
const { validateBody } = await import('../middleware/validation.js');
const { brandToolkitSchema, contentCalendarSchema } = await import('../middleware/schemas.js');
const brand = await import('../controllers/brandToolkitController.js');
const calendar = await import('../controllers/contentCalendarController.js');
const { StorageService } = await import('../services/StorageService.js');
const { objectStorage } = await import('../services/ObjectStorageService.js');
const { resolveContentBrandContext } = await import('../services/content/ContentBrandContextService.js');
const { resolveApprovedTemplate } = await import('../services/content/ApprovedTemplateResolver.js');
const { createContentTemplate } = await import('../models/contentTemplates/functions.js');
const { contentAssetsTable } = await import('../models/contentAssets/schema.js');
let fetchGuard: ReturnType<typeof jest.spyOn>;
let owner: number, member: number, other: number, north: number, south: number, foreign: number;
let ownerToken: string, memberToken: string, otherToken: string;
let toolkit: { id: number; version: number };

async function request(path: string, method = 'GET', body?: unknown, profile = north, token = ownerToken, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/api/content${path}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'X-Business-Profile-Id': String(profile), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? {} : await response.json() as Record<string, any> };
}
async function imageForm(version?: number) {
  const buffer = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#33669980' } }).png().toBuffer();
  const form = new FormData();
  form.append('logo', new Blob([new Uint8Array(buffer)], { type: 'image/png' }), 'fixture.png');
  if (version !== undefined) form.append('expectedVersion', String(version));
  return form;
}

async function withPlanWriteDelay<T>(planId: number, work: () => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(planId) || planId <= 0) throw new Error('Invalid fixture plan ID');
  await admin.query(`CREATE FUNCTION brand_calendar_audit_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${planId} THEN PERFORM pg_sleep(0.15); END IF; RETURN NEW; END $$; CREATE TRIGGER brand_calendar_audit_delay BEFORE UPDATE ON content_plans FOR EACH ROW EXECUTE FUNCTION brand_calendar_audit_delay()`);
  try { return await work(); }
  finally { await admin.query('DROP TRIGGER brand_calendar_audit_delay ON content_plans; DROP FUNCTION brand_calendar_audit_delay()'); }
}

suite('brand/calendar domain with real HTTP, scoped PostgreSQL, Redis and local objects', () => {
  jest.setTimeout(20000);
  beforeAll(async () => {
    if (!database?.startsWith('asksales_brand_calendar_audit') || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '5546' || process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '6396' || process.env.STORAGE_BACKEND !== 'local' || !process.env.LOCAL_STORAGE_PATH?.startsWith('/tmp/asksales-brand-calendar-')) throw new Error('Only disposable local audit infrastructure is allowed');
    const config = { host: '127.0.0.1', port: 5546, user: 'postgres', database };
    admin = new Pool({ ...config, max: 2 });
    pool = createBusinessScopedPool(new Pool({ ...config, max: 8 }));
    await assertBusinessScopeSchema(admin);
    const suffix = randomUUID();
    const users = await admin.query("INSERT INTO users(email,password,name,is_verified,is_approved,is_setup_complete) VALUES($1,'fixture','Owner',true,true,true),($2,'fixture','Member',true,true,true),($3,'fixture','Other',true,true,true) RETURNING id", [`owner-${suffix}@example.invalid`, `member-${suffix}@example.invalid`, `other-${suffix}@example.invalid`]);
    [owner, member, other] = users.rows.map(row => row.id);
    const profiles = await admin.query("INSERT INTO company_settings(user_id,name,is_default,is_approved) VALUES($1,'North',true,true),($1,'South',false,true),($2,'Foreign',true,true) RETURNING id", [owner, other]);
    [north, south, foreign] = profiles.rows.map(row => row.id);
    await admin.query("INSERT INTO business_profile_memberships(business_profile_id,user_id,email,role,status) VALUES($1,$2,$3,'member','active')", [north, member, `member-${suffix}@example.invalid`]);
    ownerToken = generateToken({ userId: owner, email: `owner-${suffix}@example.invalid` });
    memberToken = generateToken({ userId: member, email: `member-${suffix}@example.invalid` });
    otherToken = generateToken({ userId: other, email: `other-${suffix}@example.invalid` });
    const app = express(); app.use(express.json());
    app.use('/api/content', authenticateToken, requireModuleAccess('content'));
    app.get('/api/content/brand-toolkits', brand.getBrandToolkits);
    app.get('/api/content/brand-toolkits/:id', brand.getBrandToolkit);
    app.post('/api/content/brand-toolkits', validateBody(brandToolkitSchema), brand.createBrandToolkit);
    app.put('/api/content/brand-toolkits/:id', validateBody(brandToolkitSchema.partial()), brand.updateBrandToolkit);
    app.delete('/api/content/brand-toolkits/:id', brand.deleteBrandToolkit);
    app.post('/api/content/brand-toolkits/:id/logo', brand.uploadLogoMiddleware, brand.uploadLogo);
    app.post('/api/content/brand-toolkits/upload-image', brand.uploadBrandImageMiddleware, brand.uploadBrandImage);
    app.get('/api/content/calendar', calendar.getCalendarItems);
    app.post('/api/content/calendar', validateBody(contentCalendarSchema), calendar.createCalendarItem);
    app.put('/api/content/calendar/:itemId', calendar.updateCalendarItem);
    app.patch('/api/content/calendar/:itemId/status', calendar.updateCalendarItemStatus);
    app.delete('/api/content/calendar/:itemId', calendar.deleteCalendarItem);
    app.post('/api/content/calendar/bulk', calendar.bulkCalendarAction);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const actualFetch = globalThis.fetch;
    fetchGuard = jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(`${base}/`)) throw new Error('External network calls are forbidden in the brand/calendar fixture');
      return actualFetch(input, init);
    });
    const created = await request('/brand-toolkits', 'POST', { name: 'Audit brand' });
    expect(created.status).toBe(201); toolkit = created.body as typeof toolkit;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    SmartThrottlingService.getInstance().destroy();
    await closeRedisConnections();
    fetchGuard?.mockRestore();
    if (pool) await pool.end();
    if (admin) await admin.end();
  });

  it('uses real auth and forced RLS to isolate businesses and tenants while allowing an active member', async () => {
    expect((await request('/brand-toolkits', 'GET', undefined, north, '')).status).toBe(401);
    expect((await request(`/brand-toolkits/${toolkit.id}`, 'GET', undefined, foreign, otherToken)).status).toBe(404);
    expect((await request(`/brand-toolkits/${toolkit.id}`, 'GET', undefined, south)).status).toBe(404);
    expect((await request(`/brand-toolkits/${toolkit.id}`, 'PUT', { name: 'Forbidden' }, south)).status).toBe(404);
    expect((await request('/brand-toolkits', 'GET', undefined, north, otherToken)).status).toBe(403);
    expect((await request(`/brand-toolkits/${toolkit.id}`, 'GET', undefined, north, memberToken)).status).toBe(200);
  });

  it('rejects stale and concurrent expected versions without overwriting the winner', async () => {
    const outcomes = await Promise.all(['First', 'Second'].map(name => request(`/brand-toolkits/${toolkit.id}`, 'PUT', { name, expectedVersion: toolkit.version })));
    expect(outcomes.map(result => result.status).sort()).toEqual([200, 409]);
    const saved = await request(`/brand-toolkits/${toolkit.id}`);
    expect(saved.body.version).toBe(toolkit.version + 1);
    expect((await request(`/brand-toolkits/${toolkit.id}`, 'PUT', { name: 'Old draft', expectedVersion: toolkit.version })).status).toBe(409);
    expect((await request(`/brand-toolkits/${toolkit.id}`)).body.name).toBe(saved.body.name);
    toolkit = saved.body as typeof toolkit;
  });

  it('rejects a logo attachment when another editor commits while its object uploads', async () => {
    const storage = StorageService.getInstance();
    const original = storage.upload.bind(storage);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    let uploadedKey = '';
    const spy = jest.spyOn(storage, 'upload').mockImplementationOnce(async (...args) => {
      const uploaded = await original(...args); uploadedKey = uploaded.storageKey; entered(); await resume; return uploaded;
    });
    const upload = request(`/brand-toolkits/${toolkit.id}/logo`, 'POST', await imageForm(toolkit.version));
    try {
      await waiting;
      expect((await request(`/brand-toolkits/${toolkit.id}`, 'PUT', { name: 'Concurrent winner', logoUrl: '/uploads/kept.png', logoUrls: ['/uploads/kept.png'], expectedVersion: toolkit.version })).status).toBe(200);
    } finally { release(); }
    const result = await upload; spy.mockRestore();
    expect(result.status).toBe(409);
    expect((await request(`/brand-toolkits/${toolkit.id}`)).body.logoUrl).toBe('/uploads/kept.png');
    expect(await objectStorage.exists(uploadedKey)).toBe(false);
  });

  it('rejects forged image types and optimizes actual stored images with a bounded preview', async () => {
    const forged = new FormData(); forged.append('image', new Blob(['not a png'], { type: 'image/png' }), 'bad.png');
    expect((await request('/brand-toolkits/upload-image', 'POST', forged)).status).toBe(400);
    const input = await sharp({ create: { width: 3000, height: 1500, channels: 4, background: '#33669980' } }).png().toBuffer();
    const form = new FormData(); form.append('image', new Blob([new Uint8Array(input)], { type: 'image/png' }), 'large.png');
    const result = await request('/brand-toolkits/upload-image', 'POST', form);
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ width: 2400, height: 1200 });
    const rows = await admin.query('SELECT storage_key FROM storage_files WHERE user_id=$1 AND url=$2 AND NOT is_deleted', [owner, result.body.url]);
    const decoded = await sharp(await objectStorage.download(rows.rows[0].storage_key)).metadata();
    expect(decoded).toMatchObject({ format: 'webp', width: 2400, height: 1200, hasAlpha: true });
    expect(result.body.thumbnailUrl).toBeTruthy();
  });

  it('rejects stale or malformed logo preconditions before upload and returns the successful attachment version', async () => {
    const current = (await request(`/brand-toolkits/${toolkit.id}`)).body;
    const storage = StorageService.getInstance(); const spy = jest.spyOn(storage, 'upload');
    expect((await request(`/brand-toolkits/${toolkit.id}/logo`, 'POST', await imageForm(current.version - 1))).status).toBe(409);
    const invalid = await imageForm(); invalid.append('expectedVersion', '4junk');
    expect((await request(`/brand-toolkits/${toolkit.id}/logo`, 'POST', invalid)).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    const uploaded = await request(`/brand-toolkits/${toolkit.id}/logo`, 'POST', await imageForm(current.version));
    spy.mockRestore();
    expect(uploaded.status).toBe(200); expect(uploaded.body.toolkit.version).toBe(current.version + 1);
    expect((await request(`/brand-toolkits/${toolkit.id}`, 'PUT', { name: 'After logo', expectedVersion: uploaded.body.toolkit.version })).status).toBe(200);
  });

  it('invalidates a persisted approved template after a real brand version change', async () => {
    const scope = { userId: owner, businessProfileId: north };
    const context = await withBusinessScope(scope, () => resolveContentBrandContext(owner));
    const { id } = await withBusinessScope(scope, () => createContentTemplate({ userId: owner, businessProfileId: north, brandToolkitId: toolkit.id, name: 'Approved fixture', type: 'email', content: 'Approved copy', isApproved: true, version: 1, brandContextSnapshot: { provenance: context.provenance } }));
    expect(await withBusinessScope(scope, () => resolveApprovedTemplate(owner, id, {}, 1))).toMatchObject({ success: true, content: 'Approved copy' });
    expect((await request(`/brand-toolkits/${toolkit.id}`, 'PUT', { tagline: 'A new approved revision', expectedVersion: context.brandToolkit.version })).status).toBe(200);
    await expect(withBusinessScope(scope, () => resolveApprovedTemplate(owner, id, {}, 1))).rejects.toMatchObject({ code: 'TEMPLATE_BRAND_CONTEXT_STALE', status: 409 });
  });

  it('persists editorial edits/cancellation/deletion and never grants provider delivery status', async () => {
    const created = await request('/calendar', 'POST', { title: 'Editorial', contentType: 'social', channel: 'instagram', scheduledDate: '2026-11-03', scheduledTime: '10:30' });
    expect(created.status).toBe(200); const item = created.body.item;
    expect((await request('/calendar', 'POST', { title: 'Invalid date', contentType: 'social', channel: 'instagram', scheduledDate: '2026-02-30' })).status).toBe(400);
    expect((await request(`/calendar/${item.id}`, 'PUT', { contentPlanId: item.contentPlanId, title: 'Edited' }, south)).status).toBe(404);
    expect((await request(`/calendar/${item.id}`, 'PUT', { contentPlanId: item.contentPlanId, title: 'Edited' })).status).toBe(200);
    expect((await request(`/calendar/${item.id}/status`, 'PATCH', { contentPlanId: item.contentPlanId, status: 'published' })).status).toBe(400);
    expect((await request(`/calendar/${item.id}/status`, 'PATCH', { contentPlanId: item.contentPlanId, status: 'cancelled' })).status).toBe(200);
    const reload = await request('/calendar?startDate=2026-11-03&endDate=2026-11-03&timezone=America%2FNew_York');
    expect(reload.body.items).toEqual([expect.objectContaining({ title: 'Edited', status: 'cancelled', providerBacked: false })]);
    expect((await request(`/calendar/${item.id}?contentPlanId=${item.contentPlanId}`, 'DELETE')).status).toBe(200);
    expect((await request('/calendar')).body.items).toEqual([]);
  });

  it('replays a creation receipt once per business and rejects reuse for different details', async () => {
    const body = { name: 'Creation retry fixture', idempotencyKey: randomUUID() };
    const first = await request('/brand-toolkits', 'POST', body);
    const retry = await request('/brand-toolkits', 'POST', body);
    expect(first.status).toBe(201); expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect((await request('/brand-toolkits', 'POST', { ...body, name: 'Different intent' })).status).toBe(409);
    const sibling = await request('/brand-toolkits', 'POST', body, south);
    expect(sibling.status).toBe(201); expect(sibling.body.id).not.toBe(first.body.id);
    const result = await admin.query('SELECT count(*)::integer AS total FROM brand_toolkits WHERE user_id=$1 AND business_profile_id=$2 AND creation_request_key=$3', [owner, north, body.idempotencyKey]);
    expect(result.rows[0].total).toBe(1);
  });

  describe('editorial calendar concurrency acceptance', () => {
    async function createItem(title: string, contentPlanId?: number) {
      const result = await request('/calendar', 'POST', { title, contentType: 'social', channel: 'instagram', scheduledDate: '2026-11-03', ...(contentPlanId ? { contentPlanId } : {}) });
      expect(result.status).toBe(200); return result.body.item;
    }
    async function readPlan(id: number) {
      return (await admin.query('SELECT content_calendar FROM content_plans WHERE id=$1', [id])).rows[0].content_calendar as Array<{ id: number; title: string; description?: string; status: string }>;
    }

    it('retains concurrent title and status changes to one editorial item', async () => {
      const item = await createItem('Race fixture');
      const results = await withPlanWriteDelay(item.contentPlanId, () => Promise.all([
        request(`/calendar/${item.id}`, 'PUT', { contentPlanId: item.contentPlanId, title: 'Concurrent title' }),
        request(`/calendar/${item.id}/status`, 'PATCH', { contentPlanId: item.contentPlanId, status: 'cancelled' }),
      ]));
      expect(results.map(value => value.status)).toEqual([200, 200]);
      expect(await readPlan(item.contentPlanId)).toEqual([expect.objectContaining({ title: 'Concurrent title', status: 'cancelled' })]);
    });

    it('retains concurrent appends and allocates unique item IDs within the locked plan', async () => {
      const item = await createItem('Original');
      const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now());
      try {
        await withPlanWriteDelay(item.contentPlanId, () => Promise.all([createItem('Append one', item.contentPlanId), createItem('Append two', item.contentPlanId)]));
      } finally { now.mockRestore(); }
      const saved = await readPlan(item.contentPlanId);
      expect(saved.map(value => value.title).sort()).toEqual(['Append one', 'Append two', 'Original']);
      expect(new Set(saved.map(value => value.id)).size).toBe(3);
    });

    it('does not resurrect a deleted item or lose an append racing its deletion', async () => {
      const item = await createItem('Delete me');
      const results = await withPlanWriteDelay(item.contentPlanId, () => Promise.all([
        request(`/calendar/${item.id}?contentPlanId=${item.contentPlanId}`, 'DELETE'),
        createItem('Keep appended item', item.contentPlanId),
      ]));
      expect(results[0].status).toBe(200);
      expect(await readPlan(item.contentPlanId)).toEqual([expect.objectContaining({ title: 'Keep appended item' })]);
    });

    it('retains simultaneous edits to distinct items in one plan', async () => {
      const first = await createItem('First'); const second = await createItem('Second', first.contentPlanId);
      const results = await withPlanWriteDelay(first.contentPlanId, () => Promise.all([
        request(`/calendar/${first.id}`, 'PUT', { contentPlanId: first.contentPlanId, title: 'Edited first' }),
        request(`/calendar/${second.id}`, 'PUT', { contentPlanId: first.contentPlanId, description: 'Edited second description' }),
      ]));
      expect(results.map(value => value.status)).toEqual([200, 200]);
      expect(await readPlan(first.contentPlanId)).toEqual([expect.objectContaining({ title: 'Edited first' }), expect.objectContaining({ title: 'Second', description: 'Edited second description' })]);
    });

    it('rolls back a failed plan write and allows a verified retry without a leaked lock', async () => {
      const item = await createItem('Before failed write');
      await admin.query(`CREATE FUNCTION brand_calendar_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=${Number(item.contentPlanId)} THEN RAISE EXCEPTION 'Synthetic calendar write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER brand_calendar_audit_fail BEFORE UPDATE ON content_plans FOR EACH ROW EXECUTE FUNCTION brand_calendar_audit_fail()`);
      try {
        expect((await request(`/calendar/${item.id}`, 'PUT', { contentPlanId: item.contentPlanId, title: 'Should roll back' })).status).toBe(500);
      } finally { await admin.query('DROP TRIGGER brand_calendar_audit_fail ON content_plans; DROP FUNCTION brand_calendar_audit_fail()'); }
      expect(await readPlan(item.contentPlanId)).toEqual([expect.objectContaining({ title: 'Before failed write' })]);
      expect((await request(`/calendar/${item.id}`, 'PUT', { contentPlanId: item.contentPlanId, title: 'Verified retry' })).status).toBe(200);
      expect(await readPlan(item.contentPlanId)).toEqual([expect.objectContaining({ title: 'Verified retry' })]);
    });
  });

  describe('calendar timezone and bulk retry acceptance', () => {
    const year = new Date().getUTCFullYear() + 1;
    const firstSunday = (month: number) => 1 + (7 - new Date(Date.UTC(year, month, 1)).getUTCDay()) % 7;
    const day = (month: number, date: number) => `${year}-${String(month + 1).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
    const spring = day(2, firstSunday(2) + 7), fall = day(10, firstSunday(10));
    const santiagoPreviousDate = new Date(Date.UTC(year, 8, firstSunday(8) - 1)).toISOString().slice(0, 10);
    const body = { action: 'reschedule', assetIds: [991], timezone: 'America/New_York' };

    it.each([
      ['New York spring gap', spring, '02:30', 'America/New_York', /does not exist/],
      ['New York fall fold', fall, '01:30', 'America/New_York', /occurs twice|ambiguous/],
      ['Lord Howe half-hour gap', day(9, firstSunday(9)), '02:15', 'Australia/Lord_Howe', /does not exist/],
      ['Lord Howe half-hour fold', day(3, firstSunday(3)), '01:45', 'Australia/Lord_Howe', /occurs twice|ambiguous/],
    ] as const)('rejects %s before invoking scheduling', async (_label, scheduledDate, scheduledTime, timezone, message) => {
      changeSchedule.mockClear();
      const result = await request('/calendar/bulk', 'POST', { ...body, timezone, scheduledDate, scheduledTime });
      expect(result.status).toBe(400); expect(result.body.error).toMatch(message);
      expect(changeSchedule).not.toHaveBeenCalled();
    });

    it.each([
      ['UTC midnight', day(0, 15), '00:00', 'UTC', `${day(0, 15)}T00:00:00.000Z`],
      ['Kolkata midnight', day(0, 15), '00:00', 'Asia/Kolkata', `${day(0, 14)}T18:30:00.000Z`],
      ['UTC+14 date rollover', day(0, 15), '00:00', 'Pacific/Kiritimati', `${day(0, 14)}T10:00:00.000Z`],
      ['Lord Howe summer midnight', day(0, 15), '00:00', 'Australia/Lord_Howe', `${day(0, 14)}T13:00:00.000Z`],
      ['New York before spring gap', spring, '01:30', 'America/New_York', `${spring}T06:30:00.000Z`],
      ['New York after spring gap', spring, '03:30', 'America/New_York', `${spring}T07:30:00.000Z`],
      ['New York before fall fold', fall, '00:30', 'America/New_York', `${fall}T04:30:00.000Z`],
      ['New York after fall fold', fall, '02:30', 'America/New_York', `${fall}T07:30:00.000Z`],
    ] as const)('resolves %s to the exact reviewed UTC instant', async (_label, scheduledDate, scheduledTime, timezone, expected) => {
      changeSchedule.mockClear();
      const result = await request('/calendar/bulk', 'POST', { ...body, timezone, scheduledDate, scheduledTime });
      expect(result.status).toBe(200); expect(result.body.scheduledFor).toBe(expected);
      expect((changeSchedule.mock.calls[0][2] as Date).toISOString()).toBe(expected);
    });

    it.each([
      ['23-hour spring day', spring, `${spring}T05:00:00.000Z`, new Date(Date.UTC(year, 2, firstSunday(2) + 8, 4)).toISOString(), 'America/New_York'],
      ['25-hour fall day', fall, `${fall}T04:00:00.000Z`, new Date(Date.UTC(year, 10, firstSunday(10) + 1, 5)).toISOString(), 'America/New_York'],
      ['24-hour day before Santiago midnight gap', santiagoPreviousDate, `${santiagoPreviousDate}T04:00:00.000Z`, `${day(8, firstSunday(8))}T04:00:00.000Z`, 'America/Santiago'],
      ['25-hour Havana repeated-midnight day', fall, `${fall}T04:00:00.000Z`, new Date(Date.UTC(year, 10, firstSunday(10) + 1, 5)).toISOString(), 'America/Havana'],
      ['24-hour day before Apia skipped date', '2011-12-29', '2011-12-29T10:00:00.000Z', '2011-12-30T10:00:00.000Z', 'Pacific/Apia'],
    ] as const)('reads the inclusive local calendar date across a %s', async (_label, date, start, end, timezone) => {
      const scope = { userId: owner, businessProfileId: north };
      const instants = [new Date(Date.parse(start) - 1), new Date(start), new Date(Date.parse(end) - 1), new Date(end)];
      const assets = await withBusinessScope(scope, () => drizzle(pool).insert(contentAssetsTable).values(instants.map((scheduledPublishAt, index) => ({ userId: owner, businessProfileId: north, type: 'social_post', channel: 'instagram', publishPlatform: 'instagram', title: `Boundary ${index}`, content: 'Synthetic calendar boundary', status: 'scheduled', scheduledPublishAt }))).returning());
      const result = await request(`/calendar?startDate=${date}&endDate=${date}&timezone=${encodeURIComponent(timezone)}`);
      expect(result.status).toBe(200);
      const fixtureIds = new Set(assets.map(asset => asset.id));
      const observed = result.body.items.filter((item: { contentAssetId?: number }) => fixtureIds.has(item.contentAssetId ?? -1));
      expect(observed.map((item: { id: number }) => item.id)).toEqual([assets[1].id, assets[2].id]);
      expect(observed.map((item: { scheduled_date: string; scheduled_time: string }) => [item.scheduled_date, item.scheduled_time])).toEqual([[date, '00:00'], [date, '23:59']]);
    });

    it('reports an in-progress replay and reuses its completed result through real Redis', async () => {
      const headers = { 'Idempotency-Key': `calendar-retry-${randomUUID()}` };
      const input = { ...body, scheduledDate: day(0, 15), scheduledTime: '12:00' };
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      const resume = new Promise<void>(resolve => { release = resolve; });
      changeSchedule.mockClear();
      changeSchedule.mockImplementationOnce(async () => { entered(); await resume; return { affected: 1 }; });
      const first = request('/calendar/bulk', 'POST', input, north, ownerToken, headers);
      try {
        await waiting;
        const inProgress = await request('/calendar/bulk', 'POST', input, north, ownerToken, headers);
        expect(inProgress.status).toBe(202); expect(inProgress.body.inProgress).toBe(true);
        release(); const committed = await first; expect(committed.status).toBe(200);
        expect(await request('/calendar/bulk', 'POST', input, north, ownerToken, headers)).toEqual(committed);
        expect((await request('/calendar/bulk', 'POST', { ...input, scheduledTime: '13:00' }, north, ownerToken, headers)).status).toBe(409);
        expect(changeSchedule).toHaveBeenCalledTimes(1);
      } finally { release(); await first; }
    });

    it('allows a verified retry after a definite pre-write scheduling-boundary failure', async () => {
      const headers = { 'Idempotency-Key': `calendar-failure-${randomUUID()}` };
      const input = { ...body, scheduledDate: day(0, 15), scheduledTime: '12:00' };
      changeSchedule.mockClear(); changeSchedule.mockRejectedValueOnce(new Error('Synthetic rejection before any mutation'));
      expect((await request('/calendar/bulk', 'POST', input, north, ownerToken, headers)).status).toBe(409);
      expect((await request('/calendar/bulk', 'POST', input, north, ownerToken, headers)).status).toBe(200);
      expect(changeSchedule).toHaveBeenCalledTimes(2);
    });
  });

  if (process.env.BRAND_CALENDAR_BROWSER_URL) {
    it.each([1311, 390, 320])('real calendar browser/API/PostgreSQL edit/cancel/delete at %d pixels', async width => {
      const site = process.env.BRAND_CALENDAR_BROWSER_URL;
      if (site !== 'http://127.0.0.1:3046') throw new Error('Only the isolated local Next audit server is allowed');
      const title = `Combined calendar fixture ${width}`, editedTitle = `Edited combined fixture ${width}`;
      const created = await request('/calendar', 'POST', { title, contentType: 'social', channel: 'instagram', scheduledDate: '2026-11-03', scheduledTime: '12:00' });
      expect(created.status).toBe(200); const item = created.body.item;
      const { chromium } = await import('playwright-core');
      const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage({ viewport: { width, height: width === 1311 ? 841 : width === 390 ? 844 : 900 } });
      const pageErrors: string[] = [], blocked: string[] = [], shellRequests: string[] = [], consoleErrors: string[] = [];
      const domainResponses: Array<{ method: string; path: string; status: number }> = [];
      let editStarted: (() => void) | undefined;
      const user = { id: owner, email: 'synthetic-calendar@example.invalid', name: 'Calendar fixture owner', isSetupComplete: true, isApproved: true, hasBusinessProfile: true, hasBrandToolkit: true };
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      await page.clock.setFixedTime(new Date('2026-11-03T16:00:00Z'));
      await page.routeWebSocket('**/*', socket => {
        const target = new URL(socket.url());
        if (target.host === '127.0.0.1:3046' && target.pathname === '/_next/webpack-hmr') socket.connectToServer();
        // Application sockets are simulated; only local development HMR connects.
      });
      await page.route('**/*', async route => {
        const incoming = route.request(), url = new URL(incoming.url());
        if (url.origin !== site) { blocked.push(url.origin); await route.abort(); return; }
        if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
        shellRequests.push(`${incoming.method()} ${url.pathname}`);
        if (url.pathname.startsWith('/api/content/calendar')) {
          if (incoming.method() === 'PUT') editStarted?.();
          const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers: { Authorization: `Bearer ${ownerToken}`, 'X-Business-Profile-Id': String(north), 'Content-Type': 'application/json' } });
          domainResponses.push({ method: incoming.method(), path: `${url.pathname}${url.search}`, status: response.status() });
          await route.fulfill({ response }); return;
        }
        let json: unknown = [];
        if (url.pathname === '/api/auth/me') json = { user };
        else if (url.pathname === '/api/platform/access') json = { maintenance: { enabled: false, message: '' }, modules: ['campaigns', 'lead_generation', 'content', 'performance_marketing', 'ai_visibility', 'outreach', 'crm', 'support', 'support_ai', 'proposals', 'knowledge_base', 'integrations', 'billing', 'storage'].map(key => ({ key, name: key, status: 'available', enabled: true, mode: 'enabled', description: '', message: null })) };
        else if (url.pathname === '/api/settings/preferences') json = { theme: 'light', language: 'en', timezone: 'America/New_York' };
        else if (url.pathname === '/api/settings/business-profiles') json = [{ id: north, name: 'Calendar fixture business', companyName: 'Calendar fixture business', role: 'owner', isDefault: true }];
        else if (url.pathname === '/api/organizations') json = { organizations: [] };
        else if (url.pathname === '/api/wallet') json = { balance: 10000 };
        else if (url.pathname === '/api/notifications/unread/count') json = { count: 0 };
        else if (url.pathname === '/api/chat/threads') json = { threads: [], total: 0 };
        else if (url.pathname === '/api/settings/outreach/assistants/catalog') json = { runtimeEnabled: false, presets: [], accounts: [], models: [], knowledge: [], playbooks: [], templates: [], documents: [], galleries: [], tools: [], permissions: { canManage: false } };
        else if (url.pathname === '/api/auth/csrf-token') json = { csrfToken: 'local-fixture' };
        await route.fulfill({ json });
      });
      try {
        await page.goto(`${site}/dashboard/content-calendar`);
        await page.getByRole('button', { name: `Open ${title}`, exact: true }).click();
        await page.getByRole('button', { name: `Actions for ${title}`, exact: true }).click();
        await page.getByRole('menuitem', { name: 'Edit plan', exact: true }).click();
        const editor = page.getByRole('dialog', { name: 'Edit editorial plan', exact: true });
        await editor.getByLabel('Title', { exact: true }).fill(editedTitle);
        await editor.getByLabel('Content', { exact: true }).fill('Edited through the rendered calendar');
        await withPlanWriteDelay(item.contentPlanId, async () => {
          const waiting = new Promise<void>(resolve => { editStarted = resolve; });
          const response = page.waitForResponse(value => new URL(value.url()).pathname === `/api/content/calendar/${item.id}` && value.request().method() === 'PUT');
          await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
          await waiting;
          expect((await request(`/calendar/${item.id}/status`, 'PATCH', { contentPlanId: item.contentPlanId, status: 'cancelled' })).status).toBe(200);
          expect((await response).status()).toBe(200);
        });
        const stored = (await admin.query('SELECT content_calendar FROM content_plans WHERE id=$1', [item.contentPlanId])).rows[0].content_calendar;
        expect(stored).toEqual([expect.objectContaining({ title: editedTitle, description: 'Edited through the rendered calendar', status: 'cancelled' })]);
        await page.reload();
        await page.getByRole('button', { name: `Open ${editedTitle}`, exact: true }).click();
        await page.getByRole('heading', { name: editedTitle, exact: true }).waitFor({ state: 'visible' });
        await page.waitForFunction('Array.from(document.querySelectorAll("[role=dialog]")).some(element => { const bounds=element.getBoundingClientRect(); return bounds.width>0 && bounds.x>=-1 && bounds.right<=innerWidth+1; })');
        const viewport = await page.evaluate<{ scale: number; width: number; scrollWidth: number }>('({scale:visualViewport.scale,width:innerWidth,scrollWidth:document.documentElement.scrollWidth})');
        expect(viewport.scale).toBe(1); expect(viewport.width).toBe(width); expect(viewport.scrollWidth).toBeLessThanOrEqual(width);
        await page.screenshot({ path: `/tmp/asksales-brand-calendar-real-${width}.png` });
        await page.getByRole('button', { name: `Actions for ${editedTitle}`, exact: true }).click();
        await page.getByRole('menuitem', { name: 'Delete plan', exact: true }).click();
        const deleted = page.waitForResponse(value => new URL(value.url()).pathname === `/api/content/calendar/${item.id}` && value.request().method() === 'DELETE');
        await page.getByRole('button', { name: 'Delete', exact: true }).click();
        await deleted;
        expect((await admin.query('SELECT content_calendar FROM content_plans WHERE id=$1', [item.contentPlanId])).rows[0].content_calendar).toEqual([]);
        await page.reload(); expect(await page.getByRole('button', { name: `Open ${editedTitle}`, exact: true }).count()).toBe(0);
        expect(domainResponses.some(value => value.method === 'PUT' && value.status === 200)).toBe(true);
        expect(domainResponses.some(value => value.method === 'DELETE' && value.status === 200)).toBe(true);
        expect(pageErrors).toEqual([]); expect(blocked).toEqual([]);
      } catch (error) {
        await page.screenshot({ path: `/tmp/asksales-brand-calendar-real-failure-${width}.png` });
        writeFileSync(`/tmp/asksales-brand-calendar-real-failure-${width}.json`, JSON.stringify({ url: page.url(), body: await page.locator('body').innerText(), domainResponses, shellRequests, pageErrors, consoleErrors, blocked }, null, 2));
        throw error;
      } finally { await browser.close(); }
    }, 60000);
  }
});
