import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
// @ts-expect-error JavaScript migration
import { up, down } from '../migrations/294_conversation_request_recovery.js';

const connectionString = process.env.SUPPORT_TURN_QA_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const schema = `conversation_request_qa_${process.pid}_${Date.now()}`;
let pool: Pool;
let admin: Pool;
jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
const { ConversationRequestCoordinator, ConversationRequestError, checkpointConversationRequest } = await import('../services/ConversationRequestCoordinator.js');
let first: InstanceType<typeof ConversationRequestCoordinator>;
let second: InstanceType<typeof ConversationRequestCoordinator>;
const identity = (requestId = 'request-1', conversationId = 1, userId = 1) => ({ requestId, conversationId, userId, kind: 'campaign', input: { content: 'Hello' } });
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

suite('durable conversation requests on independent PostgreSQL connections', () => {
  beforeAll(async () => {
    if (!connectionString || !['localhost','127.0.0.1','[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Loopback QA database required');
    admin = new Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${schema},pg_catalog` });
    await pool.query('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2); CREATE TABLE support_chat_sessions(id INTEGER PRIMARY KEY); CREATE TABLE support_chat_messages(id INTEGER PRIMARY KEY);');
    await up(pool);
    first = new ConversationRequestCoordinator(drizzle(pool) as never);
    second = new ConversationRequestCoordinator(drizzle(pool) as never);
  });
  beforeEach(async () => { await pool.query('TRUNCATE conversation_requests,conversation_request_scopes CASCADE'); });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });

  it('migration is repeatable and reversible', async () => { await up(pool); await down(pool); await up(pool); });
  it('serializes one conversation, allows another, and replays a concurrent duplicate only once', async () => {
    const entered = gate(); const release = gate(); const order: string[] = [];
    const run = jest.fn(async () => { order.push('first'); entered.resolve(); await release.promise; return { answer: 'saved' }; });
    const a = first.run(identity(), run); await entered.promise;
    const duplicate = second.run(identity(), run);
    const b = second.run(identity('request-2'), async () => { order.push('second'); return { answer: 'next' }; });
    await second.run(identity('other-chat', 2), async () => { order.push('other'); return {}; });
    expect(order).toEqual(['first','other']); release.resolve();
    expect(await a).toEqual({ answer: 'saved' }); expect(await duplicate).toEqual({ answer: 'saved' }); await b;
    expect(order).toEqual(['first','other','second']); expect(run).toHaveBeenCalledTimes(1);
  });
  it('rejects changed payloads and isolates replay by owner', async () => {
    await first.run(identity(), async () => ({ answer: 'private' }));
    await expect(second.run({ ...identity(), input: { content: 'Changed' } }, async () => ({}))).rejects.toMatchObject({ code: 'request_conflict' });
    expect(await second.run(identity('request-1',1,2), async () => ({ answer: 'other owner' }))).toEqual({ answer: 'other owner' });
    expect(await second.list(2,'campaign',99)).toEqual([]);
  });
  it('cancels at the next checkpoint without undoing an earlier receipt', async () => {
    const entered = gate(); const release = gate(); const effects = ['earlier receipt'];
    const running = first.run(identity(), async () => { entered.resolve(); await release.promise; await checkpointConversationRequest(); effects.push('should not run'); return {}; });
    const rejected = expect(running).rejects.toMatchObject({ code: 'cancelled' });
    await entered.promise; await second.cancel(1,'campaign',1); release.resolve(); await rejected;
    expect(effects).toEqual(['earlier receipt']); expect((await first.list(1,'campaign',1))[0].status).toBe('cancelled');
    await expect(second.run(identity('request-2'), async () => 'next')).resolves.toBe('next');
  });
  it('blocks an uncertain attempt until a scoped review, without replaying it', async () => {
    await expect(first.run(identity(), async () => { throw new Error('crashed after mutation'); })).rejects.toThrow('crashed');
    await expect(second.run(identity('request-2'), async () => ({}))).rejects.toMatchObject({ code: 'uncertain' });
    await expect(second.reconcile(2,'campaign',1,'request-1','Verified receipt')).rejects.toMatchObject({ code: 'not_found' });
    await second.reconcile(1,'campaign',1,'request-1','Verified saved receipt in the campaign.');
    await expect(first.run(identity(), async () => ({}))).rejects.toMatchObject({ code: 'reconciled' });
    await expect(second.run(identity('request-2'), async () => 'resumed')).resolves.toBe('resumed');
  });
  it('keeps a waiting turn blocked after an executed tool loses its workflow receipt', async () => {
    const entered = gate(); const release = gate(); const effects: string[] = [];
    const running = first.run(identity(), async () => {
      effects.push('executed once'); entered.resolve(); await release.promise;
      throw new ConversationRequestError('uncertain', 'Tool finished but its workflow receipt failed');
    });
    const failed = expect(running).rejects.toMatchObject({ code: 'uncertain' });
    await entered.promise;
    const next = jest.fn(async () => { effects.push('must wait'); return {}; });
    const waiting = expect(second.run(identity('request-2'), next)).rejects.toMatchObject({ code: 'uncertain' });
    release.resolve(); await failed; await waiting;
    expect(effects).toEqual(['executed once']); expect(next).not.toHaveBeenCalled();
    expect((await first.list(1,'campaign',1)).find((row: { request_id: string }) => row.request_id === 'request-1')).toMatchObject({ status: 'uncertain' });
  });
  it('fences an expired owner and exposes its uncertain status', async () => {
    const entered = gate(); const release = gate();
    const running = first.run(identity(), async () => { entered.resolve(); await release.promise; return 'late result'; });
    const rejected = expect(running).rejects.toMatchObject({ code: 'uncertain' });
    await entered.promise; await pool.query("UPDATE conversation_request_scopes SET lease_expires_at=NOW()-INTERVAL '1 second'");
    expect((await second.list(1,'campaign',1))[0].status).toBe('uncertain');
    release.resolve(); await rejected;
    await expect(second.run(identity('request-2'), async () => 'unsafe')).rejects.toMatchObject({ code: 'uncertain' });
  });
  it('expires abandoned queued payloads and allows the same identity to resume safely', async () => {
    await pool.query("INSERT INTO conversation_request_scopes(scope_key) VALUES('1:campaign:1'); INSERT INTO conversation_requests(user_id,scope_key,kind,conversation_id,request_id,input_hash,updated_at) VALUES(1,'1:campaign:1','campaign',1,'abandoned','unused',NOW()-INTERVAL '1 minute')");
    await expect(first.run(identity(), async () => 'new')).resolves.toBe('new');
    expect((await first.list(1,'campaign',1)).find((r: { request_id: string }) => r.request_id === 'abandoned')).toMatchObject({ status: 'cancelled', error_code: 'queue_expired' });
  });
});
