import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getTableColumns } from 'drizzle-orm';
import { outreachSettings } from '../models/outreachSettings/schema.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { responseWrapper } from '../middleware/responseWrapper.js';
import { FOLLOW_UP_CHANNELS } from '../../shared/followUpChannels.js';

const url = process.env.FOLLOW_UP_IMPLEMENTATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
const validateTemplate = jest.fn(async () => { throw new Error('Disabled template must not be loaded'); });
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, { get(_target, key) {
  const value = Reflect.get(database, key); return typeof value === 'function' ? value.bind(database) : value;
} }) }));
jest.unstable_mockModule('../services/followUpTemplateService.js', () => ({ loadFollowUpTemplate: validateTemplate, FollowUpTemplateError: class extends Error {} }));
jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({ ContentBrandContextError: class extends Error {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../middleware/auth.js', () => ({ authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
  req.user = { id: 4101, email: 'fixture@example.test', name: 'Synthetic owner' };
  withBusinessScope({ userId: 4101, businessProfileId: 4102 }, next);
} }));
jest.unstable_mockModule('../middleware/platformAccess.js', () => ({ requireModuleAccess: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next() }));
jest.unstable_mockModule('../routes/outreachAssistants.routes.js', () => ({ default: express.Router() }));
// Mount the real settings router while keeping unrelated controllers inert.
const source = readFileSync(new URL('../routes/settings.routes.ts', import.meta.url), 'utf8');
for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
  const path = match[2];
  if (!path.startsWith('../controllers/') || path.endsWith('/settingsController.js')) continue;
  jest.unstable_mockModule(path, () => Object.fromEntries(match[1].split(',').map(name => name.trim()).filter(Boolean).map(name => {
    const noop = (_req: express.Request, _res: express.Response, next?: express.NextFunction) => next?.();
    return [name, Object.assign(noop, { single: () => noop, array: () => noop, fields: () => noop })];
  })));
}
const router = (await import('../routes/settings.routes.js')).default;
const app = express(); app.use(express.json()); app.use('/api', responseWrapper); app.use('/api/settings', router);
const settings = [
  { id: 'paused-alpha', enabled: false, delayDays: 3, delayHours: 0, delayMinutes: 0, templateId: 77, templateName: 'Disabled unapproved template' },
  { id: '007', enabled: true, delayDays: 0, delayHours: 1, delayMinutes: 0, templateId: -1, templateName: 'Auto-generate' },
  { id: 'paused-zero', enabled: false, delayDays: 0, delayHours: 0, delayMinutes: 0, templateId: null, templateName: '' },
  { id: '02', enabled: true, delayDays: 1, delayHours: 0, delayMinutes: 0, templateId: -1, templateName: 'Auto-generate' },
];
suite('lossless follow-up step DTO through mounted settings routes and PostgreSQL', () => {
  beforeAll(async () => {
    if (!url || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/followup_qa') throw new Error('Disposable local followup_qa required');
    client = new Client({ connectionString: url }); await client.connect(); await client.query('SET search_path TO pg_temp,pg_catalog'); database = drizzle(client);
    const columns = Object.values(getTableColumns(outreachSettings)).map(column => `"${column.name}" ${column.getSQLType()}`);
    await client.query(`CREATE TEMP TABLE outreach_settings(${columns.join(',')});
      ALTER TABLE outreach_settings ALTER business_profile_id SET DEFAULT 4102,ALTER created_at SET DEFAULT NOW(),ALTER updated_at SET DEFAULT NOW();
      CREATE UNIQUE INDEX ON outreach_settings(business_profile_id,user_id);`);
  });
  beforeEach(async () => { validateTemplate.mockClear(); await client.query('TRUNCATE outreach_settings RESTART IDENTITY'); });
  afterAll(async () => { await client?.end(); });
  it.each(FOLLOW_UP_CHANNELS)('preserves disabled rows, opaque IDs, zero delay and enabled ordering for %s', async channel => {
    const seeded = await request(app).put('/api/settings/outreach').send({ enableAutoFollowUp: true, followUps: {
      [channel]: { enabled: true, maxFollowUps: settings.length, followUps: settings },
    } });
    expect(seeded.status).toBe(200);
    const initial = (await request(app).get(`/api/settings/integrations/${channel}/follow-ups`)).body.data;
    expect(initial.followUpSteps.map((step: { id: string }) => step.id)).toEqual(settings.map(step => step.id));
    expect(initial.followUpSteps.map((step: { enabled: boolean }) => step.enabled)).toEqual([false, true, false, true]);
    const before = (await client.query('SELECT channel_follow_ups FROM outreach_settings')).rows[0].channel_follow_ups[channel];
    const saved = await request(app).put(`/api/settings/integrations/${channel}/follow-ups`).send({ ...initial, expectedRevision: initial.revision });
    expect(saved.status).toBe(200); expect(saved.body).toMatchObject({ success: true, fenced: true, advanced: true });
    expect(saved.body.revision).not.toBe(initial.revision);
    const after = (await client.query('SELECT channel_follow_ups FROM outreach_settings')).rows[0].channel_follow_ups[channel];
    expect({ ...after, revision: undefined }).toEqual({ ...before, revision: undefined });
    expect(validateTemplate).not.toHaveBeenCalled();
    const read = (await request(app).get(`/api/settings/integrations/${channel}/follow-ups`)).body.data;
    expect(read.followUpSteps).toEqual(initial.followUpSteps);
    const stale = await request(app).put(`/api/settings/integrations/${channel}/follow-ups`).send({ ...initial, enableAutoFollowUp: false, expectedRevision: initial.revision });
    expect(stale.status).toBe(409);
  });
});
