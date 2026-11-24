import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
// @ts-expect-error Application migrations use the JavaScript migration runner.
import { up } from '../migrations/587_campaign_history_lead_lookup.js';
import { sql } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { threadLeadIds } from '../services/threadLeadCohort.js';
import { mockAuthRequest, mockResponse } from './helpers/mockHelpers.js';

const connectionString = process.env.CAMPAIGN_HISTORY_QA_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `campaign_history_${process.pid}_${Date.now()}`;
let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let database: NodePgDatabase;

jest.unstable_mockModule('../models/db.js', () => ({
  db: { execute: (query: Parameters<typeof database.execute>[0]) => database.execute(query) },
}));
const { getChatThreadsHandler } = await import('../controllers/chatController.js');

suite('campaign history on PostgreSQL', () => {
  beforeAll(async () => {
    const target = connectionString ? new URL(connectionString) : null;
    if (target?.hostname !== '127.0.0.1' || target.pathname !== '/campaign_history_qa') {
      throw new Error('Use a disposable PostgreSQL database on loopback');
    }
    pool = new pg.Pool({ connectionString });
    client = await pool.connect();
    database = drizzle(client);
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}; SET LOCAL timezone='UTC';
      CREATE TABLE company_settings (id integer, user_id integer, name text, company_name text, industry text);
      CREATE TABLE chat_threads (id integer, user_id integer, business_id integer, business_profile_id integer,
        title text, selected_agent text, created_at timestamp DEFAULT now(), updated_at timestamp, deleted_at timestamp);
      CREATE TABLE icp_profiles (id integer, user_id integer, business_profile_id integer, thread_id integer,
        campaign_name text, target_audience text, industry text, fit_score integer, created_at timestamp);
      CREATE TABLE leads (id integer, user_id integer, business_profile_id integer, prompt_id integer,
        campaign_data jsonb, deleted_at timestamp);
      CREATE TABLE sent_messages (lead_id integer, business_profile_id integer);
      CREATE TABLE content_assets (thread_id integer, user_id integer, business_profile_id integer, type text);
      INSERT INTO company_settings VALUES (1,7,'Current',NULL,NULL),(2,7,'Other',NULL,NULL);
      INSERT INTO chat_threads (id,user_id,business_id,business_profile_id,title,updated_at,deleted_at) VALUES
        (42,7,1,1,'Earlier', '2026-01-01',NULL), (43,7,1,1,'Later', '2026-01-01',NULL),
        (44,7,1,1,'Deleted','2026-01-02',now()), (45,7,2,2,'Other business','2026-01-03',NULL),
        (46,8,1,1,'Other user','2026-01-04',NULL);
      INSERT INTO icp_profiles VALUES
        (12,7,1,43,'Old ICP',NULL,NULL,NULL,'2026-01-01'), (13,7,1,43,'Latest ICP',NULL,NULL,NULL,'2026-01-02');
      INSERT INTO leads VALUES
        (1,7,1,12,'{"threadId":"43"}',NULL), (2,7,1,NULL,'{"threadId":43}',NULL),
        (3,7,1,13,NULL,NULL), (4,7,2,13,'{"threadId":43}',NULL), (5,7,1,13,NULL,now()),
        (6,7,1,NULL,'{"threadId":"000000000043"}',NULL), (7,7,1,13,'{"threadId":42}',NULL);
      INSERT INTO sent_messages VALUES (1,1),(1,1),(2,1),(3,1),(4,2),(5,1),(1,2),(7,1);
      INSERT INTO content_assets VALUES (43,7,1,'ad_copy'),(43,7,1,'image'),(43,7,1,'video'),
        (43,7,1,'email'),(43,7,2,'video'),(43,8,1,'video');`);
    await up(client);
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    await pool?.end();
  });

  async function list(query: Record<string, string>) {
    const req = mockAuthRequest(7, { query: { businessProfileId: '1', ...query } });
    const res = mockResponse();
    await withBusinessScope({ userId: 7, businessProfileId: 1 }, () => getChatThreadsHandler(req, res));
    expect(res._status).toBe(200);
    return res._json;
  }

  it('returns only visible campaign IDs and titles in the same order as the detailed list', async () => {
    await expect(list({ view: 'compact' })).resolves.toEqual({ threads: [
      { id: 43, title: 'Later' }, { id: 42, title: 'Earlier' },
    ] });
  });

  it('keeps legacy and ICP counts without double-counting a lead linked both ways', async () => {
    const first = await list({ limit: '1' });
    expect(first).toMatchObject({ total: 2, limit: 1, offset: 0, threads: [{ id: 43,
      icp: { campaignName: 'Latest ICP' },
      stats: { leadsCount: 4, outreachCount: 5, contentCount: 4, adCopyCount: 1, imageCount: 1, videoCount: 1 },
    }] });
    expect(await list({ limit: '1', offset: '1' })).toMatchObject({ total: 2, threads: [{ id: 42,
      icp: null, stats: { leadsCount: 1, outreachCount: 1, contentCount: 0, adCopyCount: 0, imageCount: 0, videoCount: 0 },
    }] });
    expect(await list({ limit: '1', offset: '2' })).toMatchObject({ total: 2, threads: [] });
  });

  it('resolves the same thread cohort as the list for the campaign workspace', async () => {
    const ids = async (threadId: number) => (await database.execute(sql`${threadLeadIds(7, 1, threadId)} ORDER BY 1`))
      .rows.map(row => Number(row.id));
    await expect(ids(43)).resolves.toEqual([1, 2, 3, 7]);
    await expect(ids(42)).resolves.toEqual([7]);
    await expect(ids(46)).resolves.toEqual([]);
  });
});
