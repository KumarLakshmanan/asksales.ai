import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { SQL } from 'drizzle-orm';
import { Job, Queue } from 'bullmq';

// Opt-in, fixed local disposable targets. Never load a .env or inherited DSN.
const local = process.env.STUDIO_DISPOSABLE_AUDIT === '1' ? describe : describe.skip;
let fixtureDb: ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db', () => ({ db: new Proxy({}, {
  get(_target, property) {
    const value = Reflect.get(fixtureDb, property);
    return typeof value === 'function' ? value.bind(fixtureDb) : value;
  },
}) }));
const model = await import('../models/contentTemplates/functions');
const tables = await import('../models/contentTemplates/schema');
const { runDurableVideoJob } = await import('../services/media/DurableVideoJobService.js');

local('studio persistence on disposable PostgreSQL and Redis', () => {
  let admin: Pool;
  let pool: Pool;
  let queue: Queue;
  const nonce = randomBytes(6).toString('hex');
  const schema = `studio_audit_${nonce}`;
  beforeAll(async () => {
    admin = new Pool({ host: '127.0.0.1', port: 5544, user: 'postgres', database: 'studio_audit', connectionTimeoutMillis: 3000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ host: '127.0.0.1', port: 5544, user: 'postgres', database: 'studio_audit', options: `-c search_path=${schema},pg_catalog`, max: 4 });
    fixtureDb = drizzle(pool);
    // The real schema default expects the selected business. This fixture
    // tests model transactions and owner filters, not production RLS policy.
    await pool.query('CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE sql AS $$ SELECT 70 $$');
    const dialect = new PgDialect();
    for (const table of [tables.contentTemplatesTable, tables.contentTemplateVersionsTable]) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        let defaultSql = '';
        if (column.default instanceof SQL) defaultSql = dialect.sqlToQuery(column.default).sql;
        else if (column.default !== undefined) defaultSql = typeof column.default === 'object'
          ? `'${JSON.stringify(column.default).replaceAll("'", "''")}'::jsonb`
          : typeof column.default === 'string' ? `'${column.default.replaceAll("'", "''")}'` : String(column.default);
        return `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${defaultSql ? ` DEFAULT ${defaultSql}` : ''}`;
      });
      await pool.query(`CREATE TABLE "${definition.name}" (${columns.join(',')})`);
    }
    await pool.query('CREATE UNIQUE INDEX template_version_uq ON content_template_versions(template_id,version)');
    queue = new Queue(`studio-audit-${nonce}`, { connection: { host: '127.0.0.1', port: 6391 } });
    await queue.waitUntilReady();
  });
  afterAll(async () => {
    if (queue) { await queue.obliterate({ force: true }); await queue.close(); }
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
  });
  beforeEach(async () => { await pool.query('TRUNCATE content_templates,content_template_versions RESTART IDENTITY'); });
  const create = () => model.createContentTemplate({ userId: 7, name: 'Synthetic manual email', type: 'email', content: 'Hello {{first_name}}', htmlContent: '<p>Hello {{first_name}}</p>' });

  it('persists a manual template and full version snapshots across independent reads', async () => {
    const saved = await create();
    await model.updateContentTemplateForUser(saved.id, 7, { content: 'Changed manual draft' }, 1);
    const reloaded = await model.getContentTemplateById(saved.id);
    expect(reloaded).toMatchObject({ content: 'Changed manual draft', version: 2, isApproved: false });
    const versions = await model.getContentTemplateVersionsForUser(saved.id, 7);
    expect(versions.map(row => [row.version, row.snapshot.content])).toEqual([[2, 'Changed manual draft'], [1, 'Hello {{first_name}}']]);
  });
  it('allows one concurrent validated save and rejects the stale competing save atomically', async () => {
    const saved = await create();
    const results = await Promise.allSettled(['First', 'Second'].map(content => model.updateContentTemplateForUser(saved.id, 7, { content }, 1)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await model.getContentTemplateVersionsForUser(saved.id, 7)).toHaveLength(2);
  });
  it('rejects stale approval and foreign-owner writes without adding history', async () => {
    const saved = await create();
    await model.updateContentTemplateForUser(saved.id, 7, { content: 'Current version' }, 1);
    await expect(model.approveContentTemplateForUser(saved.id, 7, undefined, 1)).rejects.toBeInstanceOf(model.ContentTemplateVersionConflictError);
    expect(await model.updateContentTemplateForUser(saved.id, 8, { content: 'Foreign' })).toBeNull();
    expect(await model.approveContentTemplateForUser(saved.id, 8)).toBeNull();
    expect(await model.getContentTemplateVersionsForUser(saved.id, 8)).toEqual([]);
    expect(await model.getContentTemplateVersionsForUser(saved.id, 7)).toHaveLength(2);
  });
  it('resumes the persisted provider operation after a BullMQ job reload', async () => {
    const job = await queue.add('video', {});
    const provider = jest.fn<any>().mockResolvedValueOnce({ success: true, status: 'pending', operationName: 'synthetic/op-1', provider: 'google', model: 'synthetic' })
      .mockResolvedValueOnce({ success: true, videoUrl: '/synthetic-storage/video.mp4' });
    await runDurableVideoJob(job as any, provider);
    const reloaded = await Job.fromId(queue, job.id!);
    await runDurableVideoJob(reloaded as any, provider);
    const completed = await Job.fromId(queue, job.id!);
    expect(await runDurableVideoJob(completed as any, provider)).toMatchObject({ videoUrl: '/synthetic-storage/video.mp4' });
    expect(provider.mock.calls).toEqual([[undefined], ['synthetic/op-1']]);
  });
  it('blocks resubmission after an ambiguous timeout even after job reload', async () => {
    const job = await queue.add('video', {});
    const provider = jest.fn<any>().mockRejectedValue(new Error('Synthetic submission timeout'));
    await expect(runDurableVideoJob(job as any, provider)).rejects.toThrow('Synthetic submission timeout');
    const reloaded = await Job.fromId(queue, job.id!);
    await expect(runDurableVideoJob(reloaded as any, provider)).rejects.toThrow('no duplicate generation');
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
