import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import express from 'express';
import request from 'supertest';

const connectionString = process.env.CONVERSATION_HISTORY_QA_DATABASE_URL;
const postgres = connectionString ? describe : describe.skip;
const schema = `conversation_history_qa_${process.pid}_${Date.now()}`;
let admin: Pool;
let pool: Pool;
let database: ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db.js', () => ({ db: new Proxy({}, {
  get: (_target, key) => {
    const value = database[key as keyof typeof database];
    return typeof value === 'function' ? value.bind(database) : value;
  },
}) }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter: {} }));
jest.unstable_mockModule('../services/ICPGenerationService.js', () => ({ ICPGenerationService: class {} }));
const { getChatMessagesByThreadIdCursor } = await import('../models/chatMessages/functions.js');
const { getChatThreadMessagesHandler, updateChatThreadHandler } = await import('../controllers/chatController.js');
const { validateBody } = await import('../middleware/validation.js');
const { updateThreadSchema } = await import('../middleware/schemas.js');
const app = express();
app.use((req, _res, next) => { req.user = { id: 7, email: 'history@example.test' }; next(); });
app.get('/api/chat/threads/:id/messages', getChatThreadMessagesHandler);
app.patch('/api/chat/threads/:id',express.json(),validateBody(updateThreadSchema),updateChatThreadHandler);

postgres('conversation history with real PostgreSQL ordering and cursors', () => {
  beforeAll(async () => {
    if (!connectionString || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname)) {
      throw new Error('An explicit disposable loopback QA database is required');
    }
    admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema},pg_catalog` });
    database = drizzle(pool);
    await pool.query(`CREATE TABLE chat_threads (
      id INTEGER PRIMARY KEY, business_profile_id INTEGER, user_id INTEGER NOT NULL,
      business_id INTEGER, title TEXT, selected_agent TEXT, metadata JSONB,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
      deleted_at TIMESTAMP, deleted_by INTEGER
    ); INSERT INTO chat_threads(id,user_id) VALUES(42,7),(99,8)`);
    await pool.query(`CREATE TABLE company_settings(id INTEGER PRIMARY KEY,user_id INTEGER);
      INSERT INTO company_settings VALUES(1,7),(2,8),(77,7);
      ALTER TABLE chat_threads ADD CONSTRAINT fixture_rejected_business CHECK(business_id IS DISTINCT FROM 77);
      CREATE TABLE chat_messages (
      id INTEGER PRIMARY KEY, business_profile_id INTEGER, user_id INTEGER NOT NULL,
      thread_id INTEGER, role TEXT NOT NULL, content TEXT NOT NULL, agent_type TEXT,
      metadata JSONB, created_at TIMESTAMP NOT NULL, deleted_at TIMESTAMP, deleted_by INTEGER
    )`);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE chat_messages; UPDATE chat_threads SET title='Original title',business_id=NULL");
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });

  it('pages every message exactly once even when timestamps differ from insertion order', async () => {
    await pool.query(`INSERT INTO chat_messages(id,user_id,thread_id,role,content,created_at) VALUES
      (1,7,42,'user','newest','2026-10-23 12:03'),
      (2,7,42,'assistant','oldest','2026-10-23 12:00'),
      (3,7,42,'user','middle','2026-10-23 12:02'),
      (4,7,42,'assistant','older','2026-10-23 12:01'),
      (5,7,99,'user','other thread','2026-10-23 12:02')`);
    const ids: number[] = [];
    let cursor: number | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await getChatMessagesByThreadIdCursor(42, 2, cursor);
      ids.unshift(...result.messages.map(message => message.id));
      if (!result.hasMore) break;
      cursor = result.nextCursor!;
    }
    expect(ids).toEqual([2,4,3,1]);
    expect(new Set(ids).size).toBe(4);
  });

  it('uses the message ID to break equal-timestamp ties across page boundaries', async () => {
    await pool.query(`INSERT INTO chat_messages(id,user_id,thread_id,role,content,created_at)
      SELECT id,7,42,'user','message ' || id,'2026-10-23 12:00'::timestamp FROM generate_series(1,7) id`);
    const first = await getChatMessagesByThreadIdCursor(42, 3);
    const second = await getChatMessagesByThreadIdCursor(42, 3, first.nextCursor!);
    const third = await getChatMessagesByThreadIdCursor(42, 3, second.nextCursor!);
    expect([third.messages,second.messages,first.messages].flat().map(message => message.id)).toEqual([1,2,3,4,5,6,7]);
    expect(third.hasMore).toBe(false);
  });

  it('preserves PostgreSQL sub-millisecond precision at a cursor boundary', async () => {
    await pool.query(`INSERT INTO chat_messages(id,user_id,thread_id,role,content,created_at) VALUES
      (1,7,42,'user','older','2026-10-23 12:00:00.000100'),
      (2,7,42,'user','anchor','2026-10-23 12:00:00.000200'),
      (3,7,42,'user','newer','2026-10-23 12:00:00.000300')`);
    const first = await getChatMessagesByThreadIdCursor(42, 2);
    const second = await getChatMessagesByThreadIdCursor(42, 2, first.nextCursor!);
    expect([...second.messages,...first.messages].map(message => message.id)).toEqual([1,2,3]);
  });

  it('does not use a cursor from another thread and preserves paging after its anchor is soft-deleted', async () => {
    await pool.query(`INSERT INTO chat_messages(id,user_id,thread_id,role,content,created_at) VALUES
      (1,7,42,'user','older','2026-10-23 12:00'),
      (2,7,42,'user','anchor','2026-10-23 12:01'),
      (3,7,99,'user','foreign anchor','2026-10-23 12:02')`);
    expect((await getChatMessagesByThreadIdCursor(42, 2, 3)).messages).toEqual([]);
    await pool.query('UPDATE chat_messages SET deleted_at=NOW() WHERE id=2');
    expect((await getChatMessagesByThreadIdCursor(42, 2, 2)).messages.map(message => message.id)).toEqual([1]);
  });

  it('serves exact cursor pages through the actual HTTP controller and rejects another owner', async () => {
    await pool.query(`INSERT INTO chat_messages(id,user_id,thread_id,role,content,created_at)
      SELECT id,7,42,'user','message ' || id,'2026-10-23 12:00'::timestamp FROM generate_series(1,7) id`);
    const first = await request(app).get('/api/chat/threads/42/messages?limit=3').expect(200);
    expect(first.body.messages.map((message: { id: number }) => message.id)).toEqual([5,6,7]);
    const second = await request(app).get(`/api/chat/threads/42/messages?limit=3&cursor=${first.body.nextCursor}`).expect(200);
    expect(second.body.messages.map((message: { id: number }) => message.id)).toEqual([2,3,4]);
    await request(app).get('/api/chat/threads/99/messages').expect(403);
    await request(app).get('/api/chat/threads/42/messages?cursor=invalid').expect(400);
  });

  it('advances reconnect pages without truncating the durable timestamp to JavaScript milliseconds', async () => {
    await pool.query(`INSERT INTO chat_messages(id,user_id,thread_id,role,content,created_at)
      SELECT id,7,42,'user','message ' || id,'2026-10-23 12:00:00.000100'::timestamp FROM generate_series(1,105) id`);
    const first = await request(app).get('/api/chat/threads/42/messages?since=2026-10-23T12:00:00Z').expect(200);
    expect(first.body.messages).toHaveLength(100); expect(first.body.hasMore).toBe(true);
    await pool.query('UPDATE chat_messages SET deleted_at=NOW() WHERE id=100');
    const second = await request(app).get(`/api/chat/threads/42/messages?since=${encodeURIComponent(first.body.nextSince)}&sinceId=${first.body.nextSinceId}`).expect(200);
    expect(second.body.messages.map((message: { id: number }) => message.id)).toEqual([101,102,103,104,105]);
    expect(second.body.hasMore).toBe(false);
  });

  it('does not persist a title when the combined business selection is unavailable', async () => {
    await request(app).patch('/api/chat/threads/42').send({title:'Should not persist',businessId:2}).expect(404);
    expect((await pool.query('SELECT title FROM chat_threads WHERE id=42')).rows[0].title).toBe('Original title');
  });

  it('rolls back a combined rename if the business update fails at the database boundary', async () => {
    await request(app).patch('/api/chat/threads/42').send({title:'Should not persist',businessId:77}).expect(500);
    expect((await pool.query('SELECT title FROM chat_threads WHERE id=42')).rows[0].title).toBe('Original title');
  });

  it('saves both reviewed fields together and preserves fields omitted by a later edit', async () => {
    const response = await request(app).patch('/api/chat/threads/42').send({title:'  Saved campaign  ',businessId:1}).expect(200);
    expect(response.body).toMatchObject({title:'Saved campaign',businessId:1});
    const renamed = await request(app).patch('/api/chat/threads/42').send({title:'Renamed campaign'}).expect(200);
    expect(renamed.body).toMatchObject({title:'Renamed campaign',businessId:1});
  });
});
