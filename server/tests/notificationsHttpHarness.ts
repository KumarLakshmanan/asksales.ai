/** Local-only browser harness: real notification HTTP/models, PostgreSQL RLS,
 * NotificationService, Redis EventBus and RealtimeGateway. Only session/shell
 * establishment is synthetic. Never start against inherited application DSNs. */
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Pool } from 'pg';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { bridgeUserToEventBus, unbridgeUserFromEventBus } from '../gateway/RealtimeGateway.js';
import { eventBus } from '../events/EventBus.js';
import { NotificationService } from '../services/NotificationService.js';
import * as handlers from '../controllers/notificationsController.js';
import { getNotificationPreferencesHandler, updateNotificationPreferencesHandler } from '../controllers/userProfileController.js';
if (process.env.NOTIFICATIONS_LOCAL_QA !== '1' || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55439' || process.env.DB_NAME !== 'notification_audit' || process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '56379') throw new Error('Disposable notification fixture settings required');
const fixture = new Pool({host:'127.0.0.1',port:55439,user:'notification_audit',password:'synthetic-local-only',database:'notification_audit'});
const app = express().use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:3319');res.setHeader('Access-Control-Allow-Credentials','true');
  res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type,X-Business-Profile-Id');res.setHeader('Access-Control-Allow-Methods','GET,PUT,POST,DELETE,OPTIONS');
  if(req.method==='OPTIONS') return res.sendStatus(204);next();
}).use(express.json());
const server = createServer(app);
const sockets = new WebSocketServer({server,path:'/api/agents/progress'});
let allowed=true;
await eventBus.initialize();
sockets.on('connection',async ws=>{
  if (!allowed) return ws.close(1008,'Fixture access removed');
  await bridgeUserToEventBus(9,ws,101,async()=>allowed);
  ws.send(JSON.stringify({type:'connected',data:{userId:9}}));
  ws.on('close',()=>{void unbridgeUserFromEventBus(9,ws);});
});
app.post('/__fixture/notify',async(req,res)=>{
  const saved=await withBusinessScope({userId:9,businessProfileId:101},()=>NotificationService.notify(9,String(req.body.title||'Live fixture'),'Synthetic event','info',{actionUrl:'/dashboard/leads'}));
  res.json({saved});
});
app.post('/__fixture/access', (req,res)=>{allowed=req.body.allowed===true;res.json({allowed});});
app.post('/__fixture/reset',async(_req,res)=>{
  allowed=true;
  await fixture.query(`BEGIN; SET LOCAL app.business_system='on'; TRUNCATE notifications RESTART IDENTITY; UPDATE users SET notification_preferences='{}' WHERE id=9;
    INSERT INTO notifications(user_id,business_profile_id,title,message,type,action_url,created_at)
    SELECT 9,101,'Notice '||n||CASE WHEN n=45 THEN ' '||repeat('L',160) ELSE '' END,CASE WHEN n=45 THEN repeat('LongFixtureTitle',20) ELSE 'Synthetic message' END,
    CASE WHEN n%2=0 THEN 'success' ELSE 'info' END,'/dashboard/leads','2026-10-23 10:00:00' FROM generate_series(1,45)n; COMMIT;`);
  res.json({ok:true});
});
app.use('/api/notifications',(req,res,next)=>{
  if(!allowed) return res.status(403).json({error:'Fixture business access removed'});
  req.user={id:9} as express.Request['user'];
  return withBusinessScope({userId:9,businessProfileId:101},next);
});
app.use('/api/settings/profile/notification-preferences',(req,_res,next)=>{
  req.user={id:9} as express.Request['user'];
  return withBusinessScope({userId:9,businessProfileId:101},next);
});
app.get('/api/settings/profile/notification-preferences',getNotificationPreferencesHandler);
app.put('/api/settings/profile/notification-preferences',updateNotificationPreferencesHandler);
app.get('/api/notifications',handlers.getNotifications);
app.get('/api/notifications/unread',handlers.getUnreadNotifications);
app.get('/api/notifications/unread/count',handlers.getUnreadCount);
app.put('/api/notifications/:id/read',handlers.markNotificationAsRead);
app.put('/api/notifications/read-all',handlers.markAllNotificationsAsRead);
app.delete('/api/notifications/:id',handlers.deleteNotificationById);
server.listen(4319,'127.0.0.1',()=>{console.log('Notification audit fixture listening on 127.0.0.1:4319');});
