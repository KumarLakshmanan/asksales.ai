/** Opt-in disposable local PostgreSQL: real controllers/models/SQL and migration 299 RLS.
 * Session establishment is a synthetic boundary; no providers or application startup. */
import { beforeAll, afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createBusinessScopedPool } from '../tenancy/scopedPool.js';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { withBusinessScope } from '../tenancy/businessContext.js';

const local = process.env.NOTIFICATIONS_LOCAL_QA === '1' ? describe : describe.skip;
// Deliberately ignore inherited DSNs. This port belongs to the disposable audit container.
const pool = new Pool({ host: '127.0.0.1', port: 55439, user: 'notification_audit', password: 'synthetic-local-only', database: 'notification_audit' });
const database = drizzle(createBusinessScopedPool(pool));
jest.unstable_mockModule('../models/db.js', () => ({ db: database }));
const handlers = await import('../controllers/notificationsController.js');
const adminHandlers = await import('../controllers/adminNotificationController.js');
const models = await import('../models/notifications/functions.js');
const { NotificationService } = await import('../services/NotificationService.js');
const { eventBus } = await import('../events/EventBus.js');
const { closeRedisConnections, getRedisConnection } = await import('../infrastructure/redis.js');
const { bridgeUserToEventBus, unbridgeUserFromEventBus } = await import('../gateway/RealtimeGateway.js');
const { notificationEventConsumer } = await import('../workers/NotificationEventConsumer.js');
const preferences = await import('../controllers/userProfileController.js');
const app = express().use(express.json());
app.use((req, _res, next) => {
  const actor = Number(req.headers['x-fixture-user'] || 9);
  if (actor) req.user = { id: actor } as express.Request['user'];
  withBusinessScope({ userId: actor || 9, businessProfileId: Number(req.headers['x-business-profile-id'] || 101) }, next);
});
app.get('/api/settings/profile/notification-preferences',preferences.getNotificationPreferencesHandler);
app.put('/api/settings/profile/notification-preferences',preferences.updateNotificationPreferencesHandler);
app.get('/api/notifications', handlers.getNotifications);
app.get('/api/notifications/unread', handlers.getUnreadNotifications);
app.get('/api/notifications/unread/count', handlers.getUnreadCount);
app.put('/api/notifications/:id/read', handlers.markNotificationAsRead);
app.put('/api/notifications/read-all', handlers.markAllNotificationsAsRead);
app.delete('/api/notifications/:id', handlers.deleteNotificationById);
app.get('/api/admin/notifications', adminHandlers.getAdminNotificationsHandler);
app.patch('/api/admin/notifications/:id/read', adminHandlers.markReadHandler);
app.delete('/api/admin/notifications/:id', adminHandlers.deleteNotificationHandler);

local('account notification actual HTTP/PostgreSQL', () => {
  beforeAll(async () => {
    const { rows } = await pool.query('SELECT current_database() AS name');
    if (rows[0].name !== 'notification_audit') throw new Error('Disposable audit database required');
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
      CREATE TABLE users(id serial PRIMARY KEY, notification_preferences jsonb NOT NULL DEFAULT '{}', updated_at timestamp DEFAULT now());
      CREATE TABLE admins(id serial PRIMARY KEY);
      CREATE TABLE company_settings(id serial PRIMARY KEY,user_id int REFERENCES users(id),name text,company_name text,is_default boolean,legacy_company_profile_id int);
      CREATE TABLE notifications(id serial PRIMARY KEY,user_id int REFERENCES users(id),title text NOT NULL,message text NOT NULL,type text NOT NULL DEFAULT 'info',action_url text,read boolean NOT NULL DEFAULT false,created_at timestamp NOT NULL DEFAULT now(),updated_at timestamp NOT NULL DEFAULT now());
      CREATE TABLE system_alerts(id serial PRIMARY KEY,user_id int REFERENCES users(id),ticket_id int,title text,message text,type varchar(50) DEFAULT 'info',severity varchar(50) DEFAULT 'medium',read boolean DEFAULT false,metadata jsonb DEFAULT '{}',created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());
      CREATE TABLE outreach_settings(id serial PRIMARY KEY,user_id int REFERENCES users(id),slack_webhook_url text);
      CREATE TABLE admin_notifications(id serial PRIMARY KEY,admin_id int REFERENCES admins(id),title text NOT NULL,message text NOT NULL,type text NOT NULL DEFAULT 'info',category text NOT NULL DEFAULT 'general',read boolean NOT NULL DEFAULT false,created_at timestamp NOT NULL DEFAULT now(),updated_at timestamp NOT NULL DEFAULT now());
      INSERT INTO users(id) VALUES(9),(10); INSERT INTO admins(id) VALUES(9),(10);
      INSERT INTO company_settings VALUES(101,9,'Fixture A','Fixture A',true,NULL),(102,9,'Fixture B','Fixture B',false,NULL),(103,10,'Other','Other',true,NULL);`);
    // @ts-expect-error Custom runner uses JS migrations.
    const migration = await import('../migrations/299_business_profile_isolation.js');
    const client = await pool.connect();
    try { await client.query('BEGIN'); await migration.up(client); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    process.env.REDIS_HOST='127.0.0.1';process.env.REDIS_PORT='56379';delete process.env.REDIS_PASSWORD;
    await eventBus.initialize();
  }, 30000);
  beforeEach(async () => {
    await pool.query(`BEGIN; SET LOCAL app.business_system='on'; TRUNCATE notifications,admin_notifications,system_alerts RESTART IDENTITY; UPDATE users SET notification_preferences='{}';
      INSERT INTO notifications(user_id,business_profile_id,title,message,type,read,created_at)
      SELECT 9,101,'Notice '||n,'Fixture','info',false,'2026-10-23 10:00:00' FROM generate_series(1,45) n;
      INSERT INTO notifications(user_id,business_profile_id,title,message,type) VALUES(9,102,'Other profile','Fixture','warning'),(10,103,'Other owner','Fixture','error');
      INSERT INTO admin_notifications(admin_id,title,message) VALUES(9,'Admin fixture','Fixture'),(10,'Other admin','Fixture'); COMMIT;`);
  });
  afterAll(async () => { await notificationEventConsumer.stop(); await eventBus.close(); await closeRedisConnections(); await pool.end(); });

  it.each(['type[]=info','type[bad]=info','unread[]=true','page[]=1','limit[]=20','page=9007199254740991&limit=100','page=1e2','limit=0x10'])('rejects malformed account query %s', async query => {
    expect((await request(app).get(`/api/notifications?${query}`)).status).toBe(400);
  });
  it.each(['1junk','1.5','1e0','2147483648'])('rejects malformed admin ID %s without mutating ID 1', async id => {
    expect((await request(app).patch(`/api/admin/notifications/${id}/read`)).status).toBe(400);
    expect((await request(app).delete(`/api/admin/notifications/${id}`)).status).toBe(400);
    expect((await pool.query('SELECT read FROM admin_notifications WHERE id=1')).rows[0]?.read).toBe(false);
  });
  it.each(['garbage','0','101','2.5','20junk','limit[]=20'])('rejects malformed admin limit %s', async value => {
    const query = value.includes('=') ? value : `limit=${value}`;
    expect((await request(app).get(`/api/admin/notifications?${query}`)).status).toBe(400);
  });
  it('filters matching rows/counts and isolates users and selected profiles', async () => {
    const response = await request(app).get('/api/notifications?type=info&unread=true&limit=20');
    expect(response.status).toBe(200); expect(response.body.items).toHaveLength(20);
    expect(response.body.pagination.total).toBe(45); expect(response.body.unreadCount).toBe(45);
    expect(response.body.items.every((row: {userId:number;businessProfileId:number})=>row.userId===9&&row.businessProfileId===101)).toBe(true);
    expect((await request(app).get('/api/notifications').set('x-fixture-user','0')).status).toBe(401);
    expect((await request(app).put('/api/notifications/47/read')).status).toBe(404);
    expect((await request(app).delete('/api/notifications/46')).status).toBe(404);
    expect((await request(app).patch('/api/admin/notifications/2/read')).status).toBe(404);
    expect((await request(app).delete('/api/admin/notifications/2')).status).toBe(404);
    expect((await request(app).get('/api/admin/notifications')).body.data.notifications.every((row:{adminId:number})=>row.adminId===9)).toBe(true);
    expect((await request(app).get('/api/notifications').set('x-business-profile-id','102')).body.items[0].title).toBe('Other profile');
  });
  it('pages equal timestamps deterministically and continues after a deleted anchor', async () => {
    const first = (await request(app).get('/api/notifications?limit=20')).body;
    expect(first.items.map((row: {id:number})=>row.id)).toEqual(Array.from({length:20},(_,i)=>45-i));
    expect(typeof first.pagination.nextCursor).toBe('string');
    // Deletion in the loaded window and a new item must not shift the continuation.
    expect((await request(app).delete('/api/notifications/45')).status).toBe(200);
    expect((await request(app).delete('/api/notifications/26')).status).toBe(200);
    await withBusinessScope({userId:9,businessProfileId:101},()=>models.createNotification({userId:9,title:'New arrival',message:'Fixture'}));
    const second = (await request(app).get('/api/notifications').query({limit:20,cursor:first.pagination.nextCursor})).body;
    expect(second.items.map((row: {id:number})=>row.id)).toEqual(Array.from({length:20},(_,i)=>25-i));
    const third = (await request(app).get('/api/notifications').query({limit:20,cursor:second.pagination.nextCursor})).body;
    expect(third.items.map((row: {id:number})=>row.id)).toEqual([5,4,3,2,1]);
    expect(third.pagination.hasMore).toBe(false);
  });
  it('rejects malformed or filter-mismatched continuation cursors', async () => {
    const first=(await request(app).get('/api/notifications?limit=20')).body;
    expect((await request(app).get('/api/notifications?cursor=garbage')).status).toBe(400);
    expect((await request(app).get('/api/notifications').query({unread:'true',cursor:first.pagination.nextCursor})).status).toBe(400);
  });

  it('preserves PostgreSQL microseconds at a continuation boundary', async () => {
    await pool.query(`BEGIN; SET LOCAL app.business_system='on'; UPDATE notifications SET created_at='2026-10-23 10:00:00.123456' WHERE business_profile_id=101; COMMIT;`);
    const first=(await request(app).get('/api/notifications?limit=20')).body;
    const second=(await request(app).get('/api/notifications').query({limit:20,cursor:first.pagination.nextCursor})).body;
    expect(second.items.map((row:{id:number})=>row.id)).toEqual(Array.from({length:20},(_,i)=>25-i));
  });
  it('reconciles simultaneous reads and deletion without resurrection or count drift', async () => {
    const [read,deleted]=await Promise.all([request(app).put('/api/notifications/45/read'),request(app).delete('/api/notifications/45')]);
    expect([200,404]).toContain(read.status);expect(deleted.status).toBe(200);
    const response=(await request(app).get('/api/notifications')).body;
    expect(response.pagination.total).toBe(44);expect(response.unreadCount).toBe(44);
    expect((await request(app).put('/api/notifications/45/read')).status).toBe(404);
    await request(app).put('/api/notifications/read-all');
    expect((await request(app).get('/api/notifications?unread=true')).body.pagination.total).toBe(0);
    expect((await request(app).get('/api/notifications?unread=false')).body.pagination.total).toBe(44);
  });
  it('prunes the 90-day and 1000-item working set without touching another profile', async () => {
    await pool.query(`BEGIN; SET LOCAL app.business_system='on'; TRUNCATE notifications RESTART IDENTITY;
      INSERT INTO notifications(user_id,business_profile_id,title,message,created_at)
      SELECT 9,101,'Retention '||n,'Fixture',now()-interval '1 day' FROM generate_series(1,1005)n;
      INSERT INTO notifications(user_id,business_profile_id,title,message,created_at) VALUES(9,101,'Old unread','Fixture',now()-interval '91 days'),(9,102,'Other profile old','Fixture',now()-interval '91 days'); COMMIT;`);
    await withBusinessScope({userId:9,businessProfileId:101},()=>models.createNotification({userId:9,title:'New retained',message:'Fixture'}));
    const rows=await pool.query('SELECT business_profile_id,count(*)::int AS count FROM notifications GROUP BY 1 ORDER BY 1');
    expect(rows.rows).toEqual([{business_profile_id:101,count:1000},{business_profile_id:102,count:1}]);
    expect((await pool.query("SELECT id FROM notifications WHERE title='Old unread'")).rowCount).toBe(0);
  });
  it('honors lead/campaign opt-outs while retaining in-app notices when email is disabled', async () => {
    expect((await request(app).put('/api/settings/profile/notification-preferences').send({leadAlerts:'false'})).status).toBe(400);
    const saved=await request(app).put('/api/settings/profile/notification-preferences').send({leadAlerts:false,campaignUpdates:false,emailNotifications:false});
    expect(saved.status).toBe(200);
    await withBusinessScope({userId:9,businessProfileId:101},async()=>{
      await NotificationService.leadsGenerated(9,2);await NotificationService.campaignCreated(9,'Synthetic');
      expect(await NotificationService.notify(9,'Account alert','Fixture','info',{actionUrl:'https://example.test'})).toBe(true);
    });
    const data=(await request(app).get('/api/notifications')).body;
    expect(data.pagination.total).toBe(46);expect(data.items[0].actionUrl).toBeNull();
    expect((await request(app).get('/api/settings/profile/notification-preferences')).body.leadAlerts).toBe(false);
  });
  it('sends persisted support-boundary notices once through real Redis and survives broker loss', async () => {
    await notificationEventConsumer.start();
    let eventResolve!:(value:unknown)=>void;
    const received=new Promise(resolve=>{eventResolve=resolve;});
    await eventBus.subscribeToUser(9,event=>{eventResolve(event);},'fixture-delivery');
    await withBusinessScope({userId:9,businessProfileId:101},()=>NotificationService.ticketCreated(9,'SYN-1','Synthetic boundary'));
    const event=await received as {businessProfileId:number;data:{notification:{title:string}}};
    expect(event.businessProfileId).toBe(101);expect(event.data.notification.title).toBe('Support Ticket Created');
    expect((await pool.query('SELECT count(*)::int AS count FROM system_alerts')).rows[0].count).toBe(0);
    await eventBus.onWebSocketDisconnect('fixture-delivery');
    // Real broker connection closed: persistence remains authoritative and non-blocking.
    getRedisConnection().disconnect();
    expect(await withBusinessScope({userId:9,businessProfileId:101},()=>NotificationService.notify(9,'Broker down','Fixture'))).toBe(true);
    expect((await request(app).get('/api/notifications')).body.items[0].title).toBe('Broker down');
    await getRedisConnection().connect();
  });
  it('delivers to two real sockets, keeps the remaining tab after disconnect, and rechecks permission', async () => {
    const wss=new WebSocketServer({host:'127.0.0.1',port:0});await once(wss,'listening');
    const port=(wss.address() as {port:number}).port;let allowed=true;
    const serverSockets:WebSocket[]=[];
    wss.on('connection',async ws=>{serverSockets.push(ws);await bridgeUserToEventBus(9,ws,101,async()=>allowed);ws.send('ready');});
    const a=new WebSocket(`ws://127.0.0.1:${port}`),b=new WebSocket(`ws://127.0.0.1:${port}`);
    try {
      await Promise.all([once(a,'message'),once(b,'message')]);
      // Exercise the real idle reaper without a minute-long delay.
      const clock=jest.spyOn(Date,'now').mockReturnValue(Date.now()+120000);
      (eventBus as unknown as {reapStaleHandlers:()=>void}).reapStaleHandlers();clock.mockRestore();
      const messages=Promise.all([once(a,'message'),once(b,'message')]);
      await eventBus.publish({channel:'events:notification',userId:9,businessProfileId:102,timestamp:new Date().toISOString(),data:{notification:{id:998}}});
      await eventBus.publish({channel:'events:notification',userId:9,businessProfileId:101,timestamp:new Date().toISOString(),data:{notification:{id:999}}});
      for(const [raw] of await messages) { const event=JSON.parse(String(raw));expect(event.type).toBe('events:notification');expect(event.data.notification.id).toBe(999); }
      a.close();await once(a,'close');await unbridgeUserFromEventBus(9,serverSockets[0]);
      const remaining=once(b,'message');
      await eventBus.publish({channel:'events:notification',userId:9,businessProfileId:101,timestamp:new Date().toISOString(),data:{notification:{id:1000}}});
      expect(JSON.parse(String((await remaining)[0])).data.notification.id).toBe(1000);
      allowed=false;const closed=once(b,'close');
      await eventBus.publish({channel:'events:notification',userId:9,businessProfileId:101,timestamp:new Date().toISOString(),data:{notification:{id:1001}}});
      expect((await closed)[0]).toBe(1008);
    } finally {
      a.terminate();b.terminate();for(const ws of serverSockets) await unbridgeUserFromEventBus(9,ws);
      await new Promise<void>(resolve=>wss.close(()=>resolve()));
    }
  },10000);

  const sharedRepro=process.env.NOTIFICATIONS_SHARED_REPRO==='1'?it:it.skip;
  sharedRepro('[coordination] concurrent preference patches retain both opt-outs', async () => {
    const locker=await pool.connect();await locker.query('BEGIN');await locker.query('SELECT id FROM users WHERE id=9 FOR UPDATE');
    const lead=request(app).put('/api/settings/profile/notification-preferences').send({leadAlerts:false}).then(response=>response);
    const campaign=request(app).put('/api/settings/profile/notification-preferences').send({campaignUpdates:false}).then(response=>response);
    try {
      const deadline=Date.now()+2000;
      for(;;) {
        const waiting=await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname='notification_audit' AND wait_event_type='Lock'");
        if(waiting.rows[0].count>=2) break;
        if(Date.now()>deadline) throw new Error('Both real preference writes did not reach the row lock');
        await new Promise(resolve=>setTimeout(resolve,10));
      }
    } finally {await locker.query('COMMIT');locker.release();}
    expect((await lead).status).toBe(200);expect((await campaign).status).toBe(200);
    const saved=(await request(app).get('/api/settings/profile/notification-preferences')).body;
    expect(saved).toMatchObject({leadAlerts:false,campaignUpdates:false});
  });

  it('orders admin timestamp ties by descending ID', async () => {
    await pool.query("TRUNCATE admin_notifications RESTART IDENTITY; INSERT INTO admin_notifications(admin_id,title,message) SELECT 9,'Admin '||n,'Fixture' FROM generate_series(1,5)n");
    const response=await request(app).get('/api/admin/notifications?limit=5');
    expect(response.body.data.notifications.map((row:{id:number})=>row.id)).toEqual([5,4,3,2,1]);
  });

});
