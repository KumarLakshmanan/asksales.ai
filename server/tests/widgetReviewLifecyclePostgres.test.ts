import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq, getTableColumns, SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { widgetStatesTable as widgets } from '../models/widgetStates/schema.js';

const socket = process.env.SUPPORT_APPROVAL_QA_SOCKET;
const postgres = socket ? describe : describe.skip;
const schema = `widget_review_qa_${randomBytes(8).toString('hex')}`;
let admin: Pool;
let pool: Pool;
let database: NodePgDatabase;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get: (_target, key) => {
    const value = database[key as keyof typeof database];
    return typeof value === 'function' ? value.bind(database) : value;
  },
}) }));
const { WidgetStateModel: model } = await import('../models/widgetStates/functions.js');

async function seed(status: string, executionResult: unknown = null) {
  await database.insert(widgets).values({ id: 1, userId: 7, threadId: 42,
    toolName: 'analytics_query', widgetType: 'analytics_query', formValues: { question: 'Synthetic overview' },
    status, executionResult, executionAttemptCount: executionResult ? 1 : 0,
  });
  await pool.query("SELECT setval(pg_get_serial_sequence('widget_states','id'),1,true)");
}
async function saved() { return (await database.select().from(widgets).where(eq(widgets.id, 1)))[0]; }

postgres('widget review lifecycle on exclusively owned PostgreSQL', () => {
  beforeAll(async () => {
    if (process.env.NODE_ENV !== 'test' || !socket || !isAbsolute(socket)) throw new Error('A disposable PostgreSQL socket is required.');
    const config = { host: socket, database: 'agent_reliability_qa', user: 'postgres' };
    admin = new Pool(config);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...config, max: 4, options: `-c search_path=${schema},pg_catalog -c statement_timeout=8000` });
    database = drizzle(pool);
    await pool.query("CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE sql AS 'SELECT 9'");
    const dialect = new PgDialect();
    const definitions = Object.values(getTableColumns(widgets)).map(column => {
      let definition = `"${column.name}" ${column.getSQLType()}`;
      if (column.primary) definition += ' PRIMARY KEY';
      if (column.notNull) definition += ' NOT NULL';
      if (column.default instanceof SQL) definition += ` DEFAULT ${dialect.sqlToQuery(column.default).sql}`;
      else if (column.default !== undefined) {
        const value = typeof column.default === 'object' ? JSON.stringify(column.default) : String(column.default);
        definition += ` DEFAULT '${value.replaceAll("'", "''")}'`;
      }
      return definition;
    });
    await pool.query(`CREATE TABLE widget_states (${definitions.join(', ')})`);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });
  beforeEach(async () => { await pool.query('TRUNCATE widget_states RESTART IDENTITY'); });

  it.each([
    { retrySafe: true, ambiguous: true },
    { retrySafe: true, output: { queuedCount: 1 } },
    { retrySafe: true, output: { status: 'partial_success' } },
    { retrySafe: true, results: [{ success: true }] },
    { retrySafe: true, sideEffectsMayHaveOccurred: true },
  ])('preserves an uncertain failed receipt across all review mutations: %j', async receipt => {
    await seed('failed', receipt);
    const edited = await model.updateFormValuesForUser(1, 7, { question: 'Changed' });
    const cancelled = await model.cancelPendingForThreadForUser(7, 42, 1);
    const claimed = await model.claimSubmissionForUser(1, 7, {});
    const deleted = await model.deleteForUser(1, 7);
    expect({ edited: Boolean(edited), cancelled: cancelled.length, claimed: claimed.claimed, deleted })
      .toEqual({ edited: false, cancelled: 0, claimed: false, deleted: false });
    expect(await saved()).toMatchObject({ status: 'failed', executionResult: receipt, executionAttemptCount: 1 });
  });

  it.each(['active', 'draft'])('does not treat an uncertain %s row as a new unstarted review', async status => {
    const receipt = { retrySafe: true, ambiguous: true };
    await seed(status, receipt);
    expect(await model.updateFormValuesForUser(1, 7, {})).toBeUndefined();
    expect(await model.closeForUser(1, 7, 'draft')).toBeUndefined();
    expect(await model.reopenForUser(1, 7)).toBeUndefined();
    expect((await model.claimSubmissionForUser(1, 7, {})).claimed).toBe(false);
    expect(await model.cancelPendingForThreadForUser(7, 42, 1)).toEqual([]);
    expect(await model.deleteForUser(1, 7)).toBe(false);
    expect(await saved()).toMatchObject({ status, executionResult: receipt });
  });

  it('retains an uncertain legacy cancelled receipt for reconciliation', async () => {
    await seed('cancelled', { retrySafe: true, ambiguous: true });
    expect(await model.deleteForUser(1, 7)).toBe(false);
    expect((await saved()).executionResult).toMatchObject({ ambiguous: true });
  });

  it('cannot replace an uncertain legacy review with a fresh executable one', async () => {
    const receipt = { retrySafe: true, ambiguous: true };
    await seed('active', receipt);
    await expect(model.replacePendingReviewForUser(1, { userId: 7, threadId: 42,
      toolName: 'analytics_query', widgetType: 'analytics_query', formValues: { question: 'Revised' },
    })).rejects.toThrow('no longer editable');
    expect(await saved()).toMatchObject({ status: 'active', executionResult: receipt });
    expect(await database.select().from(widgets)).toHaveLength(1);
  });

  it('retains ordinary revision and deletion of the known unexecuted prior review', async () => {
    await seed('active');
    const replacement = await model.replacePendingReviewForUser(1, { userId: 7, threadId: 42,
      toolName: 'analytics_query', widgetType: 'analytics_query', formValues: { question: 'Revised' },
    });
    expect(replacement).toMatchObject({ id: 2, status: 'active' });
    expect(await saved()).toMatchObject({ status: 'cancelled', executionResult: { executed: false, reason: 'review_revised' } });
    expect(await model.deleteForUser(1, 7)).toBe(true);
    expect(await database.select().from(widgets)).toHaveLength(1);
  });

  it('saves a confirmed pre-effect failure as a draft without clearing its receipt or running work', async () => {
    const receipt = { success: false, output: { retrySafe: true, status: 'failed_before_side_effect' } };
    await seed('failed', receipt);
    expect(await model.updateFormValuesForUser(1, 7, { question: 'Saved correction' })).toBeDefined();
    expect(await model.closeForUser(1, 7, 'draft')).toMatchObject({ status: 'draft', executionResult: receipt });
    expect(await saved()).toMatchObject({ status: 'draft', formValues: { question: 'Saved correction' }, executionAttemptCount: 1 });
    expect(await model.reopenForUser(1, 8)).toBeUndefined();
    expect(await model.reopenForUser(1, 7)).toMatchObject({ status: 'active', executionResult: receipt });
    expect((await model.claimSubmissionForUser(1, 7, { question: 'Saved correction' })).claimed).toBe(true);
    expect((await model.claimSubmissionForUser(1, 7, {})).claimed).toBe(false);
    expect(await saved()).toMatchObject({ status: 'running', executionAttemptCount: 2 });
  });

  it('allows ordinary unstarted review edits and cancellation without changing owner scope', async () => {
    await seed('active');
    expect(await model.updateFormValuesForUser(1, 8, {})).toBeUndefined();
    expect(await model.cancelPendingForThreadForUser(8, 42, 1)).toEqual([]);
    expect(await model.deleteForUser(1, 8)).toBe(false);
    expect(await model.updateFormValuesForUser(1, 7, { question: 'Edited' })).toMatchObject({ formValues: { question: 'Edited' } });
    expect(await model.cancelPendingForThreadForUser(7, 42, 1)).toHaveLength(1);
    expect(await model.deleteForUser(1, 7)).toBe(true);
  });

  it('serializes explicit safe retry against cancellation without acquiring two claims', async () => {
    await seed('failed', { success: false, retrySafe: true });
    const [claim, cancelled] = await Promise.all([
      model.claimSubmissionForUser(1, 7, {}), model.cancelPendingForThreadForUser(7, 42, 1),
    ]);
    expect(Number(claim.claimed) + cancelled.length).toBe(1);
    expect((await saved()).status).toBe(claim.claimed ? 'running' : 'cancelled');
    expect((await model.claimSubmissionForUser(1, 7, {})).claimed).toBe(false);
  });
});
