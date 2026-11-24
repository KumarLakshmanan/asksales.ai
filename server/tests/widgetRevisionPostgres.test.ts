import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

const connectionString = process.env.WIDGET_QA_DATABASE_URL;
const postgres = connectionString ? describe : describe.skip;
let client: Client;
let database: NodePgDatabase;
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  transaction: (callback: Parameters<typeof database.transaction>[0]) => database.transaction(callback),
  select: (...args: Parameters<typeof database.select>) => database.select(...args),
  update: (...args: Parameters<typeof database.update>) => database.update(...args),
} }));
const { WidgetStateModel } = await import('../models/widgetStates/functions.js');

postgres('atomic pending review replacement in isolated PostgreSQL TEMP tables', () => {
  beforeAll(async () => {
    if (!connectionString || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname)) {
      throw new Error('Widget revision QA requires an explicit loopback database');
    }
    client = new Client({ connectionString }); await client.connect();
    // No application rows or sequences are modified. Copy schema only, replace
    // the serial default with a TEMP sequence before any inserts, and prohibit
    // fallback lookup of application tables through search_path.
    await client.query(`
      SET search_path TO pg_temp;
      CREATE TEMP TABLE widget_states (LIKE public.widget_states INCLUDING DEFAULTS);
      CREATE TEMP SEQUENCE qa_widget_ids START 10;
      ALTER TABLE widget_states ALTER COLUMN id SET DEFAULT nextval('pg_temp.qa_widget_ids');
      CREATE UNIQUE INDEX qa_widget_identity ON widget_states(user_id, idempotency_key);
    `);
    database = drizzle(client);
  });
  afterAll(async () => { await client?.end(); });
  beforeEach(async () => {
    await client.query('TRUNCATE pg_temp.widget_states');
    await client.query(`INSERT INTO widget_states (id, user_id, thread_id, tool_name, widget_type, status, form_values)
      VALUES (1, 7, 42, 'generate_social_media_post', 'social', 'active', '{"tone":"casual"}'),
             (2, 7, 42, 'generate_ad', 'ad', 'draft', '{}')`);
  });
  const replacement = () => ({ userId: 7, threadId: 42, toolName: 'generate_social_media_post',
    widgetType: 'social', formValues: { tone: 'professional' }, idempotencyKey: 'new-revision' });

  it('commits the new review and old retirement together without changing unrelated drafts', async () => {
    const revised = await WidgetStateModel.replacePendingReviewForUser(1, replacement());
    expect(revised).toMatchObject({ status: 'active', formValues: { tone: 'professional' } });
    const rows = await client.query('SELECT id, status, execution_result FROM widget_states ORDER BY id');
    expect(rows.rows[0]).toEqual({ id: 1, status: 'cancelled', execution_result: {
      supersededByWidgetId: revised.id, reason: 'review_revised', executed: false,
    } });
    expect(rows.rows[1]).toMatchObject({ id: 2, status: 'draft' });
    expect(rows.rows).toHaveLength(3);
    // A stale browser's approval cannot claim the superseded review.
    expect((await WidgetStateModel.claimSubmissionForUser(1, 7, { tone: 'casual' })).claimed).toBe(false);
  });

  it.each(['running', 'succeeded', 'cancelled', 'queued'])('cannot replace an already claimed/terminal review (%s)', async status => {
    await client.query('UPDATE widget_states SET status = $1 WHERE id = 1', [status]);
    await expect(WidgetStateModel.replacePendingReviewForUser(1, replacement())).rejects.toThrow('no longer editable');
    expect((await client.query('SELECT id FROM widget_states')).rowCount).toBe(2);
  });

  it.each([{ userId: 99 }, { threadId: 99 }, { toolName: 'generate_ad' }])('rejects ownership or tool mismatch: %j', async change => {
    await expect(WidgetStateModel.replacePendingReviewForUser(1, { ...replacement(), ...change })).rejects.toThrow('no longer editable');
    expect((await client.query('SELECT status FROM widget_states WHERE id = 1')).rows[0].status).toBe('active');
    expect((await client.query('SELECT id FROM widget_states')).rowCount).toBe(2);
  });

  it('keeps the original review active if replacement insertion fails', async () => {
    await client.query("UPDATE widget_states SET idempotency_key = 'new-revision' WHERE id = 2");
    await expect(WidgetStateModel.replacePendingReviewForUser(1, replacement())).rejects.toThrow();
    expect((await client.query('SELECT status FROM widget_states WHERE id = 1')).rows[0].status).toBe('active');
    expect((await client.query('SELECT id FROM widget_states')).rowCount).toBe(2);
  });
});
