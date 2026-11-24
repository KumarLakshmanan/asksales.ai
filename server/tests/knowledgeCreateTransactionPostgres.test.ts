import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';

let fixtureDb: ReturnType<typeof drizzle>;
const defaultInsert = jest.fn((...args: Parameters<typeof fixtureDb.insert>) => fixtureDb.insert(...args));
jest.unstable_mockModule('../models/db.js', () => ({ db: { insert: defaultInsert } }));
const { KnowledgeBaseModel } = await import('../models/knowledgeBase/functions.js');
const { knowledgeBaseTable } = await import('../models/knowledgeBase/schema.js');

const local = process.env.AUDIT_LOCAL_POSTGRES === '1' && process.env.KNOWLEDGE_CREATE_TX_PG_SOCKET
  ? describe : describe.skip;
local('KnowledgeBaseModel.create executor (disposable PostgreSQL only)', () => {
  const schema = 'knowledge_create_tx_' + randomBytes(8).toString('hex');
  let admin: Pool;
  let pool: Pool;
  beforeAll(async () => {
    const host = process.env.KNOWLEDGE_CREATE_TX_PG_SOCKET!;
    if (!/^\/(?:workspace|tmp)\//.test(host)) throw new Error('Explicit disposable Unix socket required');
    const config = { host, user: 'postgres', database: 'postgres', connectionTimeoutMillis: 5000, max: 2 };
    admin = new Pool({ ...config, max: 1, options: '-c search_path=pg_catalog' });
    await admin.query('CREATE SCHEMA "' + schema + '"');
    pool = new Pool({ ...config, options: '-c search_path=' + schema + ',pg_catalog' });
    fixtureDb = drizzle(pool);
    const defaults: Record<string, string> = {
      type: "'document'", processing_status: "'completed'", extraction_status: "'completed'",
      indexing_status: "'completed'", created_at: 'now()', updated_at: 'now()',
    };
    // Actual model columns/types/defaults; external profile FK is outside this fixture.
    const columns = getTableConfig(knowledgeBaseTable).columns.map(column =>
      '"' + column.name + '" ' + column.getSQLType()
      + (column.primary ? ' PRIMARY KEY' : column.notNull ? ' NOT NULL' : '')
      + (defaults[column.name] ? ' DEFAULT ' + defaults[column.name] : ''));
    await pool.query('CREATE TABLE knowledge_base (' + columns.join(',') + ')');
  });
  afterAll(async () => {
    await pool?.end();
    if (admin && /^knowledge_create_tx_[a-f0-9]{16}$/.test(schema)) {
      await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
    }
    await admin?.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE knowledge_base RESTART IDENTITY');
    defaultInsert.mockClear();
  });
  const data = (title: string) => ({ userId: 101, businessProfileId: 201, title, content: 'Synthetic knowledge only' });

  it('keeps default creation compatible, including returned defaults and persisted row', async () => {
    const row = await KnowledgeBaseModel.create(data('Default caller'));
    expect(row).toMatchObject({ id: expect.any(Number), userId: 101, businessProfileId: 201,
      title: 'Default caller', type: 'document', processingStatus: 'completed' });
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(defaultInsert).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT title FROM knowledge_base')).rows).toEqual([{ title: 'Default caller' }]);
  });

  it('rolls back the supplied transaction insert while retaining an earlier committed callback', async () => {
    const earlier = await KnowledgeBaseModel.create(data('Earlier committed callback'));
    defaultInsert.mockClear();
    await expect(fixtureDb.transaction(async tx => {
      const row = await KnowledgeBaseModel.create(data('Cancelled callback'), tx);
      expect(row.title).toBe('Cancelled callback');
      expect((await tx.select().from(knowledgeBaseTable)).some(item => item.id === row.id)).toBe(true);
      throw new Error('Synthetic setup callback failure');
    })).rejects.toThrow('Synthetic setup callback failure');
    expect((await pool.query('SELECT id,title FROM knowledge_base ORDER BY id')).rows)
      .toEqual([{ id: earlier.id, title: 'Earlier committed callback' }]);
    expect(defaultInsert).not.toHaveBeenCalled();
  });

  it('commits the supplied executor insert without using the default executor', async () => {
    const row = await fixtureDb.transaction(tx => KnowledgeBaseModel.create(data('Transaction commit'), tx));
    expect((await pool.query('SELECT id,title FROM knowledge_base')).rows)
      .toEqual([{ id: row.id, title: 'Transaction commit' }]);
    expect(defaultInsert).not.toHaveBeenCalled();
  });
});
