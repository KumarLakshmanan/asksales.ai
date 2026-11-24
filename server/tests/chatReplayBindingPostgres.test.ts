import {afterAll,beforeAll,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {getTableConfig} from 'drizzle-orm/pg-core';
import express from 'express';
import request from 'supertest';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {withBusinessScope,businessCacheKey} from '../tenancy/businessContext.js';
import {usersTable} from '../models/users/schema.js';
import {chatThreadsTable} from '../models/chatThreads/schema.js';
import {chatMessagesTable} from '../models/chatMessages/schema.js';

const connectionString=process.env.CONVERSATION_HISTORY_QA_DATABASE_URL;
const suite=connectionString&&process.env.CONVERSATION_REDIS_QA_PORT?describe:describe.skip;
const schema=`chat_replay_binding_${process.pid}_${Date.now()}`;
let admin:Pool;let pool:Pool;let database:ReturnType<typeof drizzle>;
const scope={userId:7,businessProfileId:4102,actorUserId:7,role:'owner' as const};
jest.unstable_mockModule('../models/db.js',()=>({db:new Proxy({}, {get:(_target,key)=>{
  const value=database[key as keyof typeof database];return typeof value==='function'?value.bind(database):value;
}})}));
jest.unstable_mockModule('../middleware/auth.js',()=>({authenticateToken:(req:express.Request,_res:express.Response,next:express.NextFunction)=>{
  req.user={id:7,email:'disposable@example.test'};withBusinessScope(scope,next);
}}));
jest.unstable_mockModule('../middleware/platformAccess.js',()=>({requireModuleAccess:()=>(_req:express.Request,_res:express.Response,next:express.NextFunction)=>next()}));
jest.unstable_mockModule('../middleware/creditCheck.js',()=>({requireCredits:(_req:express.Request,_res:express.Response,next:express.NextFunction)=>next(),checkUserCredits:async()=>({allowed:true})}));
jest.unstable_mockModule('../services/ICPGenerationService.js',()=>({ICPGenerationService:class {}}));
jest.unstable_mockModule('../services/agents/WebSocketEmitter.js',()=>({webSocketEmitter:{updateClientThread:jest.fn(),unregisterClient:jest.fn()}}));
jest.unstable_mockModule('../mastra/index.js',()=>({processMessage:jest.fn(),handleApproval:jest.fn(),switchAgent:jest.fn(),getConversationState:jest.fn(),createInitialState:()=>({messages:[]}),getAgentDisplayName:(name:string)=>name}));
jest.unstable_mockModule('../mastra/unifiedRouter.js',()=>({runUnifiedRouter:jest.fn()}));
jest.unstable_mockModule('../services/LLMConfigService.js',()=>({getUserLLMConfig:jest.fn(),getModelFallbackConfig:jest.fn()}));
jest.unstable_mockModule('../utils/jwt.js',()=>({verifyToken:()=>({userId:7}),isTokenRevoked:async()=>false}));
jest.unstable_mockModule('../models/platformAccess/functions.js',()=>({getEffectiveModuleAccess:async()=>[{key:'campaigns',enabled:true}]}));
jest.unstable_mockModule('../tenancy/businessScopeResolver.js',()=>({resolveBusinessScope:async(actor:number,profile?:number)=>actor===7&&(!profile||profile===4102)?scope:undefined,forEachBusiness:jest.fn(),scopeForRecord:jest.fn()}));
jest.unstable_mockModule('../gateway/RealtimeGateway.js',()=>({bridgeUserToEventBus:async()=>{},unbridgeUserFromEventBus:async()=>{}}));
const {default:chatRouter}=await import('../routes/chat.routes.js');
const {setupChatWebSocket}=await import('../websocket/ChatWebSocketServer.js');
const {conversationRequestHash}=await import('../services/ConversationRequestCoordinator.js');
const {idempotencyService}=await import('../services/IdempotencyService.js');
const {getRedisConnection,closeRedisConnections}=await import('../infrastructure/redis.js');
const app=express();app.use(express.json());app.use('/api/chat',chatRouter);
const server=createServer(app);let wss:ReturnType<typeof setupChatWebSocket>;
const sockets:WebSocket[]=[];const cacheKeys:string[]=[];
type Input={content:string;businessProfileId?:number;attachments?:unknown;routeToAgent?:string};
const original:Input={content:'Original harmless prompt'};
const receipt=(threadId=1)=>({threadId,message:null,response:`Durable receipt ${threadId}`});
async function seed(requestId:string,input:Input=original,threadId=1){
  const key=`7:4102:campaign:${threadId}`;
  await pool.query('INSERT INTO conversation_request_scopes(scope_key) VALUES($1) ON CONFLICT DO NOTHING',[key]);
  await pool.query(`INSERT INTO conversation_requests(user_id,scope_key,kind,conversation_id,request_id,input_hash,status,response) VALUES(7,$1,'campaign',$2,$3,$4,'completed',$5)`,[key,threadId,requestId,conversationRequestHash(input),receipt(threadId)]);
}
async function staleCache(transport:'http'|'ws',key:string){
  const cacheKey=withBusinessScope(scope,()=>businessCacheKey(`${transport}-chat:7:${key}`));cacheKeys.push(cacheKey);
  await idempotencyService.checkAndStore(cacheKey);
  const stale={threadId:999,response:'Unattested legacy Redis receipt'};
  await idempotencyService.storeResponse(cacheKey,JSON.stringify(transport==='http'?stale:{type:'message_sent',data:{success:true,ackMessageId:key,...stale}}));
}
async function socket(){
  const address=server.address();if(!address||typeof address==='string')throw new Error('Missing loopback address');
  const client=new WebSocket(`ws://127.0.0.1:${address.port}/api/agents/progress?businessProfileId=4102`,{headers:{Cookie:'asksales_session=synthetic-fixture',Origin:'http://localhost:3000'}});
  sockets.push(client);await once(client,'message');return client;
}
async function send(client:WebSocket,key:string,input:Input=original,threadId=1){
  const response=once(client,'message');client.send(JSON.stringify({type:'send_chat_message',messageId:key,data:{...input,threadId}}));
  const [data]=await response;return JSON.parse(String(data));
}
suite('chat replay binding through actual HTTP/WS adapters, PostgreSQL coordinator and legacy Redis fixtures',()=>{
  beforeAll(async()=>{
    if(!connectionString||new URL(connectionString).hostname!=='127.0.0.1'||process.env.REDIS_HOST!=='127.0.0.1'||process.env.REDIS_PORT!=='56389')throw new Error('Explicit disposable loopback fixtures required');
    admin=new Pool({connectionString});await admin.query(`CREATE SCHEMA ${schema}`);pool=new Pool({connectionString,options:`-c search_path=${schema},pg_catalog`});database=drizzle(pool);
    for(const table of [usersTable,chatThreadsTable,chatMessagesTable]){
      const config=getTableConfig(table);
      await pool.query(`CREATE TABLE ${config.name} (${config.columns.map(column=>`"${column.name}" ${column.getSQLType()}`).join(',')})`);
    }
    await pool.query(`INSERT INTO users(id,email,name,is_approved) VALUES(7,'disposable@example.test','Disposable',true);
      INSERT INTO chat_threads(id,user_id,business_id) VALUES(1,7,4102),(42,7,4102),(99,8,4102),(2147483647,7,4102);
      INSERT INTO chat_messages(id,user_id,thread_id,role,content,created_at) VALUES(2147483647,7,42,'user','Harmless maximum ID',NOW());
      CREATE TABLE conversation_request_scopes(scope_key TEXT PRIMARY KEY,lease_token UUID,lease_expires_at TIMESTAMPTZ);
      CREATE TABLE conversation_requests(id BIGSERIAL PRIMARY KEY,user_id INTEGER,scope_key TEXT,kind TEXT,conversation_id INTEGER,request_id TEXT,input_hash TEXT,status TEXT DEFAULT 'queued',response JSONB,cancel_requested BOOLEAN DEFAULT false,error_code TEXT,updated_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(scope_key,request_id));`);
    wss=setupChatWebSocket(server);server.listen(0,'127.0.0.1');await once(server,'listening');await getRedisConnection().ping();
  });
  beforeEach(async()=>{await pool.query('TRUNCATE conversation_requests,conversation_request_scopes');});
  afterAll(async()=>{
    sockets.forEach(client=>client.terminate());
    if(wss){wss.clients.forEach(client=>client.terminate());await new Promise<void>(resolve=>wss.close(()=>resolve()));}
    if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
    for(const key of cacheKeys)await idempotencyService.forget(key);await closeRedisConnections();
    await pool?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
  });
  it.each(['/api/chat/messages','/api/chat/langgraph/message'])('validates durable input before replaying %s, despite a completed legacy cache',async path=>{
    const key=randomUUID();await seed(key);await staleCache('http',key);
    const same=await request(app).post(path).set('Idempotency-Key',key).send({...original,threadId:1});
    expect(same.status).toBe(201);expect(same.body).toMatchObject(receipt());
    const changed=await request(app).post(path).set('Idempotency-Key',key).send({content:'Changed prompt',threadId:1});
    expect(changed.status).toBe(409);expect(changed.body.code).toBe('request_conflict');
  });
  it('keeps thread and ownership validation ahead of replay and preserves explicit body request identity',async()=>{
    const key=randomUUID();const bodyKey=randomUUID();await seed(bodyKey);await seed(bodyKey,original,42);await staleCache('http',key);
    const body={...original,requestId:bodyKey,idempotencyKey:key};
    expect((await request(app).post('/api/chat/messages').send({...body,threadId:42})).body).toMatchObject(receipt(42));
    await request(app).post('/api/chat/messages').send({...body,threadId:99}).expect(404);
  });
  it.each([{...original,businessProfileId:4102},{...original,routeToAgent:'lead_generation'},{...original,attachments:[{fileId:5}]}])('rejects changed bound input %j before provider work',async changed=>{
    const key=randomUUID();await seed(key);await staleCache('http',key);
    const result=await request(app).post('/api/chat/messages').set('Idempotency-Key',key).send({...changed,threadId:1});
    expect(result.status).toBe(409);expect(result.body.code).toBe('request_conflict');
  });
  it('uses the same durable binding over actual loopback WS and HTTP, ignoring legacy WS replay',async()=>{
    const key=randomUUID();await seed(key);await staleCache('ws',key);const client=await socket();
    expect(await send(client,key)).toMatchObject({type:'message_sent',data:{success:true,ackMessageId:key,...receipt()}});
    expect(await send(client,key,{content:'Changed over WS'})).toMatchObject({type:'error',data:{code:'request_conflict',ackMessageId:key,terminal:true}});
    const same=await request(app).post('/api/chat/messages').set('Idempotency-Key',key).send({...original,threadId:1});
    expect(same.status).toBe(201);expect(same.body).toMatchObject(receipt());
  });
  it('replays concurrently across two sockets and HTTP without consulting unavailable response cache',async()=>{
    const key=randomUUID();await seed(key);const first=await socket();const second=await socket();
    const cache=jest.spyOn(idempotencyService,'checkAndStore').mockRejectedValue(new Error('Synthetic response-cache outage'));
    try{
      const [a,b,http]=await Promise.all([send(first,key),send(second,key),request(app).post('/api/chat/messages').set('Idempotency-Key',key).send({...original,threadId:1})]);
      expect(a.data).toMatchObject({success:true,...receipt()});expect(b.data).toMatchObject({success:true,...receipt()});
      expect(http.status).toBe(201);expect(http.body).toMatchObject(receipt());expect(cache).not.toHaveBeenCalled();
      expect((await pool.query('SELECT COUNT(*)::int AS count FROM conversation_requests')).rows[0].count).toBe(1);
    }finally{cache.mockRestore();}
  });
  it('does not fall back to a cached success if durable request validation fails',async()=>{
    const key=randomUUID();await seed(key);await staleCache('http',key);
    await pool.query('ALTER TABLE conversation_requests RENAME TO unavailable_requests_fixture');
    try{
      const response=await request(app).post('/api/chat/messages').set('Idempotency-Key',key).send({...original,threadId:1});
      expect(response.status).toBe(500);expect(response.body.threadId).toBeUndefined();
    }finally{await pool.query('ALTER TABLE unavailable_requests_fixture RENAME TO conversation_requests');}
  });
  it.each([
    '/api/chat/threads/2147483648','/api/chat/threads/2147483648/stats',
    '/api/chat/threads/2147483648/turns','/api/chat/threads/2147483648/tabs',
    '/api/chat/threads/2147483648/lead-inputs/latest','/api/chat/langgraph/state/2147483648',
    '/api/chat/threads/42/messages?cursor=2147483648',
    '/api/chat/threads/42/messages?since=2026-10-23T00:00:00Z&sinceId=2147483648',
  ])('rejects out-of-range chat identifiers before SQL: %s',async path=>{
    const queries=jest.spyOn(pool,'query');
    try{await request(app).get(path).expect(400);expect(queries).not.toHaveBeenCalled();}finally{queries.mockRestore();}
  });
  it.each(['/api/chat/messages','/api/chat/langgraph/message','/api/chat/approve-tool'])('rejects out-of-range body thread ID before SQL: %s',async path=>{
    const queries=jest.spyOn(pool,'query');
    try{
      const body=path.endsWith('/approve-tool')
        ?{threadId:2147483648,requestId:randomUUID(),toolName:'send_outreach_messages',approved:true}
        :{content:'Harmless',threadId:2147483648,requestId:randomUUID()};
      await request(app).post(path).send(body).expect(400);
      expect(queries).not.toHaveBeenCalled();
    }finally{queries.mockRestore();}
  });
  it('retains valid maximum INTEGER identifiers and owner rejection',async()=>{
    const response=await request(app).get('/api/chat/threads/2147483647').expect(200);expect(response.body.id).toBe(2147483647);
    await request(app).get('/api/chat/threads/42/messages?cursor=2147483647').expect(200);
    await request(app).get('/api/chat/threads/99').expect(403);
  });
  it('rejects oversized WS subscription/message thread IDs without creating a turn',async()=>{
    const client=await socket();const response=once(client,'message');client.send(JSON.stringify({type:'subscribe_thread',data:{threadId:2147483648}}));
    const [data]=await response;expect(JSON.parse(String(data))).toMatchObject({type:'error',data:{code:'INVALID_THREAD'}});
    expect(await send(client,randomUUID(),original,2147483648)).toMatchObject({type:'error',data:{code:400,terminal:true}});
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM conversation_requests')).rows[0].count).toBe(0);
  });
  const composedCase=process.env.CONVERSATION_WRAPPER_QA_MODULE?it:it.skip;
  async function composedApp(){
    const modulePath=process.env.CONVERSATION_WRAPPER_QA_MODULE;
    if(!modulePath?.startsWith('/workspace/audit-results/conversations-fixes-pass2-20261023/'))throw new Error('Explicit isolated public-wrapper fixture required');
    const {responseWrapper}=await import(modulePath);
    const composed=express();composed.use(express.json());composed.use(responseWrapper);composed.use('/api/chat',chatRouter);return composed;
  }
  composedCase('composed main chat preserves conflict code and durable receipt without new work',async()=>{
    const key=randomUUID();await seed(key);await staleCache('http',key);const composed=await composedApp();
    const before=(await pool.query('SELECT COUNT(*)::int AS count FROM chat_messages')).rows[0].count;
    const response=await request(composed).post('/api/chat/messages').set('Idempotency-Key',key).send({content:'Changed prompt',threadId:1});
    expect(response.status).toBe(409);expect(response.body).toMatchObject({success:false,code:'request_conflict'});
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM chat_messages')).rows[0].count).toBe(before);
    expect((await pool.query('SELECT status,response FROM conversation_requests')).rows).toEqual([{status:'completed',response:receipt()}]);
    const {processMessage}=await import('../mastra/index.js');expect(processMessage).not.toHaveBeenCalled();
  });
  composedCase('composed main chat replays an ordinary success and stays consistent with WS',async()=>{
    const key=randomUUID();await seed(key);const composed=await composedApp();
    const response=await request(composed).post('/api/chat/langgraph/message').set('Idempotency-Key',key).send({...original,threadId:1});
    expect(response.status).toBe(201);expect(response.body).toMatchObject({success:true,data:receipt()});
    const client=await socket();expect(await send(client,key)).toMatchObject({type:'message_sent',data:{success:true,...receipt()}});
    expect(await send(client,key,{content:'Changed over WS'})).toMatchObject({type:'error',data:{code:'request_conflict',terminal:true}});
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM conversation_requests')).rows[0].count).toBe(1);
  });
});
