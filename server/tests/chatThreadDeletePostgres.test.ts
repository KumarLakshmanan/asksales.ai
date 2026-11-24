import {afterAll,beforeAll,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import express from 'express';
import request from 'supertest';
const connectionString=process.env.CONVERSATION_HISTORY_QA_DATABASE_URL;
const suite=connectionString?describe:describe.skip;
const schema=`chat_delete_${process.pid}_${Date.now()}`;
let admin:Pool;let pool:Pool;let database:ReturnType<typeof drizzle>;
jest.unstable_mockModule('../models/db.js',()=>({db:new Proxy({}, {get:(_target,key)=>{
  const value=database[key as keyof typeof database];return typeof value==='function'?value.bind(database):value;
}})}));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js',()=>({webSocketEmitter:{}}));
jest.unstable_mockModule('../services/ICPGenerationService.js',()=>({ICPGenerationService:class {}}));
const {deleteChatThreadHandler}=await import('../controllers/chatController.js');
const {validateParams}=await import('../middleware/validation.js');
const {idParamSchema}=await import('../middleware/schemas.js');
const app=express();app.use((req,_res,next)=>{req.user={id:7,email:'disposable@example.test'};next();});
app.delete('/api/chat/threads/:id',validateParams(idParamSchema),deleteChatThreadHandler);
suite('owned soft thread deletion is atomic and safely repeatable in real PostgreSQL',()=>{
  beforeAll(async()=>{
    if(!connectionString||new URL(connectionString).hostname!=='127.0.0.1')throw new Error('Explicit disposable loopback database required');
    admin=new Pool({connectionString});await admin.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString,options:`-c search_path=${schema},pg_catalog`});database=drizzle(pool);
    await pool.query(`CREATE TABLE chat_threads(id INTEGER PRIMARY KEY,business_profile_id INTEGER,user_id INTEGER,business_id INTEGER,title TEXT,selected_agent TEXT,metadata JSONB,created_at TIMESTAMP,updated_at TIMESTAMP,deleted_at TIMESTAMP,deleted_by INTEGER);
      CREATE TABLE chat_messages(id INTEGER PRIMARY KEY,business_profile_id INTEGER,user_id INTEGER,thread_id INTEGER,role TEXT,content TEXT,agent_type TEXT,metadata JSONB,created_at TIMESTAMP,deleted_at TIMESTAMP,deleted_by INTEGER);`);
  });
  beforeEach(async()=>{await pool.query(`TRUNCATE chat_threads,chat_messages;
    INSERT INTO chat_threads(id,user_id) VALUES(42,7),(99,8);
    INSERT INTO chat_messages(id,user_id,thread_id,role,content) VALUES(1,7,42,'user','Harmless'),(2,8,99,'user','Foreign');`);});
  afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
  async function state(){return (await pool.query('SELECT ct.deleted_at AS thread_deleted_at,ct.deleted_by AS thread_deleted_by,cm.deleted_at AS message_deleted_at,cm.deleted_by AS message_deleted_by FROM chat_threads ct JOIN chat_messages cm ON cm.thread_id=ct.id WHERE ct.id=42')).rows[0];}
  it('rolls back the thread when the message update fails, then permits the same retry',async()=>{
    await pool.query('ALTER TABLE chat_messages ADD CONSTRAINT reject_fixture CHECK(deleted_at IS NULL)');
    try{
      await request(app).delete('/api/chat/threads/42').expect(500);
      expect(await state()).toEqual({thread_deleted_at:null,thread_deleted_by:null,message_deleted_at:null,message_deleted_by:null});
    }finally{await pool.query('ALTER TABLE chat_messages DROP CONSTRAINT reject_fixture');}
    await request(app).delete('/api/chat/threads/42').expect(204);
  });
  it('does not change messages when the thread update fails',async()=>{
    await pool.query('ALTER TABLE chat_threads ADD CONSTRAINT reject_fixture CHECK(deleted_at IS NULL)');
    try{await request(app).delete('/api/chat/threads/42').expect(500);expect((await state()).message_deleted_at).toBeNull();}
    finally{await pool.query('ALTER TABLE chat_threads DROP CONSTRAINT reject_fixture');}
  });
  it('soft deletes both records and replays success without refreshing tombstones or removing rows',async()=>{
    await request(app).delete('/api/chat/threads/42').expect(204);
    const first=await state();expect(first.thread_deleted_at).toBeInstanceOf(Date);expect(first.message_deleted_at).toEqual(first.thread_deleted_at);
    await request(app).delete('/api/chat/threads/42').expect(204);expect(await state()).toEqual(first);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM chat_threads')).rows[0].count).toBe(2);
  });
  it('completes a previously partial owned deletion using its existing tombstone',async()=>{
    await pool.query("UPDATE chat_threads SET deleted_at='2026-09-01 12:00',deleted_by=7 WHERE id=42");
    const prior=(await state()).thread_deleted_at;
    await request(app).delete('/api/chat/threads/42').expect(204);
    expect(await state()).toMatchObject({thread_deleted_at:prior,message_deleted_at:prior,thread_deleted_by:7,message_deleted_by:7});
  });
  it('retains already-deleted message timestamps and attribution',async()=>{
    await pool.query("UPDATE chat_messages SET deleted_at='2026-01-01 12:00',deleted_by=5 WHERE id=1");
    const before=await state();await request(app).delete('/api/chat/threads/42').expect(204);
    expect(await state()).toMatchObject({message_deleted_at:before.message_deleted_at,message_deleted_by:5});
  });
  it('serializes repeated concurrent deletes into one unchanged tombstone',async()=>{
    const results=await Promise.all(Array.from({length:6},()=>request(app).delete('/api/chat/threads/42')));
    expect(results.map(result=>result.status)).toEqual([204,204,204,204,204,204]);
    const after=await state();expect(after.message_deleted_at).toEqual(after.thread_deleted_at);
  });
  it('keeps missing, foreign-owner and foreign-message records outside this mutation',async()=>{
    await request(app).delete('/api/chat/threads/99').expect(403);await request(app).delete('/api/chat/threads/100').expect(403);
    await pool.query("INSERT INTO chat_messages(id,user_id,thread_id,role,content) VALUES(3,8,42,'user','Foreign ownership fixture')");
    await request(app).delete('/api/chat/threads/42').expect(204);
    expect((await pool.query('SELECT deleted_at FROM chat_threads WHERE id=99')).rows[0].deleted_at).toBeNull();
    expect((await pool.query('SELECT deleted_at FROM chat_messages WHERE user_id=8')).rows.every(row=>row.deleted_at===null)).toBe(true);
  });
});
