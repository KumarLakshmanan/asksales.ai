import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
const root=process.cwd()+'/../qa/governed-remediation-2026-10-23';
let fixtureDb:any, admin:Pool, fixture:Pool, appPool:Pool;
let scopedMode=true, moduleEnabled=true, serial=1000; const maintenanceEnabled=false;
let schemaName=''; const objects=new Map<number,Buffer>(); const traces:any[]=[];
const proxy=new Proxy({}, {get:(_t,k)=>{const value=Reflect.get(fixtureDb,k);return typeof value==='function'?value.bind(fixtureDb):value;}});
jest.unstable_mockModule('../models/db.js',()=>({db:proxy,pgPool:undefined}));
jest.unstable_mockModule('../services/SmartThrottlingService.js',()=>({SmartThrottlingService:{getInstance:()=>({isAllowed:async()=>({allowed:true}),recordRequest:async()=>{}})}}));
jest.unstable_mockModule('../services/subscriptions/service.js',()=>({subscriptions:{access:async()=>({allowed:true})}}));
jest.unstable_mockModule('../models/platformAccess/functions.js',()=>({getMaintenanceSettings:async()=>({enabled:maintenanceEnabled,message:'Synthetic maintenance'}),getEffectiveModuleAccess:async()=>['knowledge_base','storage','support','support_ai','integrations'].map(key=>({key,name:key,enabled:moduleEnabled,status:moduleEnabled?'available':'disabled'}))}));
jest.unstable_mockModule('../services/embeddings/EmbeddingService.js',()=>({embeddingService:{generateEmbedding:async()=>{throw new Error('External embeddings forbidden in audit');}}}));
jest.unstable_mockModule('../services/supportMedia/SupportMediaSafetyService.js',()=>({validateSupportMediaMetadata:()=>({safe:true,reasons:[]}),scanSupportMedia:async({buffer}:any)=>({status:'ready_for_review',normalized:buffer,derivative:buffer,mimeType:'image/jpeg',width:8,height:8,checksum:createHash('sha256').update(buffer).digest('hex'),internalTags:[],scanResults:{scannerUnavailable:true}})}));
const context=await import('../tenancy/businessContext.js'); const billing=await import('../tenancy/billingContext.js');
const storage={
 getFile:async(id:number,userId?:number)=>{const result=await fixtureDb.execute((await import('drizzle-orm')).sql`SELECT * FROM storage_files WHERE id=${id} AND user_id=${userId||9} AND is_deleted=false`);const r=result.rows[0];return r?{...r,id:Number(r.id),userId:Number(r.user_id),mimeType:r.mime_type}:null;},
 downloadFile:async(id:number,userId?:number)=>{const file=await storage.getFile(id,userId);const buffer=objects.get(id);return file&&buffer?{buffer,file}:null;},
 upload:async(buffer:Buffer,o:any)=>{const id=++serial;objects.set(id,buffer);const business=context.currentBusinessScope(),payer=billing.currentBillingScope();traces.push({kind:'object-upload',business,payer});await fixture.query('INSERT INTO storage_files(id,user_id,business_profile_id,is_deleted,mime_type) VALUES($1,$2,$3,false,$4)',[id,o.userId,business?.businessProfileId,o.mimeType]);return {fileId:id,fileSizeBytes:buffer.length,url:`http://127.0.0.1:8189/fixture-object/${id}`};},
 deleteFile:async(id:number)=>{objects.delete(id);return true;}
};
jest.unstable_mockModule('../services/StorageService.js',()=>({StorageLimitError:class extends Error{},storageService:storage}));
const sends:any[]=[];
jest.unstable_mockModule('../services/whatsappApiService.js',()=>({whatsappApiService:{uploadMedia:async()=>({id:'fixture-upload'}),sendMedia:async()=>{sends.push({business:context.currentBusinessScope(),billing:billing.currentBillingScope()});return {messages:[{id:'fixture-receipt'}]};}}}));
jest.unstable_mockModule('../services/instagramGraphApiService.js',()=>({getInstagramApiForUser:async()=>null}));
jest.unstable_mockModule('../services/FacebookMessengerService.js',()=>({getFacebookApiForUser:async()=>null}));
jest.unstable_mockModule('../services/agents/orchestration/SupportAutoReplyService.js',()=>({automaticSupportReplyAllowed:async()=>true,isAutomaticSupportDelivery:()=>true,socialDraftChannel:()=>true,AUTOMATIC_REPLY_DISABLED:'fixture disabled'}));
jest.unstable_mockModule('../services/socialFollowUpService.js',()=>({activateSocialFollowUpForAnchor:async()=>{}}));
// Unrelated settings domains terminate here. In-scope routers, controllers, services, auth,
// business/billing context, scoped pool, SQL and Redis queues remain production code.
const pass=(_q:any,_s:any,next:any)=>next(); const dummy=(_q:any,s:any)=>s.json({success:true,data:[]});
const handlers=(names:string)=>Object.fromEntries(names.split(' ').map(n=>[n,dummy]));
jest.unstable_mockModule('../routes/outreachAssistants.routes.js',()=>({default:express.Router()}));
jest.unstable_mockModule('../controllers/businessStaffController.js',()=>handlers('getBusinessInvitations acceptBusinessStaffInvitation getBusinessStaff addBusinessStaff updateBusinessStaff removeBusinessStaff'));
jest.unstable_mockModule('../controllers/settingsController.js',()=>handlers('getLeadSettings updateLeadSettings getOutreachSettings updateOutreachSettings getUserPreferences updateUserPreferences getIntegrationFollowUpSettings updateIntegrationFollowUpSettings'));
jest.unstable_mockModule('../controllers/userProfileController.js',()=>handlers('getUserProfileHandler updateUserProfileHandler changePasswordHandler getNotificationPreferencesHandler updateNotificationPreferencesHandler'));
jest.unstable_mockModule('../controllers/businessProfilesController.js',()=>handlers('getBusinessProfiles getBusinessProfile createBusinessProfile updateBusinessProfile deleteBusinessProfile archiveBusinessProfile setDefaultBusinessProfile getActiveBusinessCategories'));
jest.unstable_mockModule('../controllers/knowledgeBaseController.js',()=>({...handlers('getKnowledgeBaseEntries getKnowledgeBaseEntry getKnowledgeBaseExtractedText createKnowledgeBaseEntry updateKnowledgeBaseEntry reprocessKnowledgeBaseFile deleteKnowledgeBaseEntry uploadKnowledgeBaseFile createQAEntry'),uploadMiddleware:pass}));
jest.unstable_mockModule('../controllers/knowledgeGovernanceController.js',()=>handlers('listKnowledgeVersions publishKnowledgeVersion quarantineKnowledgeVersion updateKnowledgeDraftScope withdrawKnowledgeEntry testKnowledgeRetrieval createKnowledgeVersionDraft'));
jest.unstable_mockModule('../controllers/adminApiCredentialsController.js',()=>handlers('getApiCredentialsSummary getUserApiCredentials'));
const zschema:any={partial:()=>zschema};
jest.unstable_mockModule('../controllers/autonomousAdsController.js',()=>({...handlers('getAdSettings getAdAutonomySettings updateAdSettings updateAdAutonomySettings'),adSettingsSchema:zschema,adAutonomySettingsSchema:zschema}));
jest.unstable_mockModule('../controllers/storageWorkspaceController.js',()=>handlers('getStorageWorkspace getStorageWorkspaceFiles getStorageWorkspaceFile changeStorageWorkspace getStorageActorFolders getStorageActivity streamStorageFile getStorageThumbnail createStorageDownload redeemStorageDownload'));
const {createBusinessScopedPool}=await import('../tenancy/scopedPool.js');
const {localBusinessFunctions,localBusinessIsolation}=await import('./helpers/localBusinessPostgres.js');
const {usersTable}=await import('../models/users/schema.js');const {companySettings}=await import('../models/companySettings/schema.js');
const {storageFilesTable}=await import('../models/storageFiles/schema.js');
const orchestration=await import('../models/supportOrchestration/schema.js');const outreach=await import('../models/outreachConversations/schema.js');
const settings=(await import('../routes/settings.routes.js')).default;
const signed=(await import('../routes/supportMediaDelivery.routes.js')).default;
const {authenticateToken}=await import('../middleware/auth.js');const {requireModuleAccess,maintenanceModeGate}=await import('../middleware/platformAccess.js');
const {responseWrapper}=await import('../middleware/responseWrapper.js');const {supportDocumentLibrary}=await import('../services/supportDocuments/SupportDocumentLibrary.js');
const app=express();app.use(express.json());app.use('/api',responseWrapper);app.use('/api',maintenanceModeGate);
app.use('/api/settings',settings);app.use('/support-media-delivery',signed);
app.get('/api/knowledge-base',authenticateToken,requireModuleAccess('knowledge_base'),dummy);
const token=(actor=9)=>jwt.sign({userId:actor,email:'synthetic@example.test'},process.env.JWT_SECRET!,{expiresIn:'1h',jwtid:'audit-'+actor});
const hdr=(actor=9,profile=7)=>({Authorization:'Bearer '+token(actor),'X-Business-Profile-Id':String(profile)});
const galleryInput=(title='Synthetic new gallery')=>({title,businessProfileId:null,audience:'customer',allowedChannels:['web','whatsapp','instagram'],rightsCertified:true,certification:{lawfulAuthority:true,customerUsePermitted:true,accuracyConfirmed:true}});
const scoped=<T>(fn:()=>T)=>context.withBusinessScope({userId:9,businessProfileId:7},fn);
const observations:any[]=[]; const observe=(name:string,data:any)=>observations.push({name,...data});
async function table(t:any){const d=getTableConfig(t);await fixture.query(`CREATE TABLE "${d.name}" (${d.columns.map(c=>`"${c.name}" ${c.getSQLType()}${c.primary?' PRIMARY KEY':''}`).join(',')})`);}
async function reset(){
 moduleEnabled=true;scopedMode=true;sends.length=0;traces.length=0;
 await fixture.query(`TRUNCATE support_media_review_audits,support_media_delivery_parts,support_media_retrieval_audits,support_media_asset_embeddings,support_media_assets,support_media_gallery_versions,support_media_galleries,support_document_library,support_approved_documents,support_delivery_outbox,support_admin_audit_logs,outreach_messages,outreach_conversations,handoff_queue RESTART IDENTITY CASCADE;
 INSERT INTO support_media_galleries(id,user_id,business_profile_id,title,audience,usage_scopes,allowed_channels,status) VALUES(2,9,7,'Audit Opal','customer',ARRAY['support_answer'],ARRAY['web','whatsapp','instagram'],'active');
 INSERT INTO support_media_gallery_versions(id,gallery_id,user_id,business_profile_id,version_no,status,content_checksum,rights_certified) VALUES(20,2,9,7,1,'published','${'a'.repeat(64)}',true);
 UPDATE support_media_galleries SET current_published_version_id=20;
 INSERT INTO support_media_assets(id,user_id,business_profile_id,gallery_id,gallery_version_id,storage_file_id,derivative_storage_file_id,evidence_id,name,alt_text,width,height,mime_type,size_bytes,checksum,search_text,publication_state) VALUES(30,9,7,2,20,99,100,'fixture-media-30','Audit Opal','Audit synthetic room',8,8,'image/jpeg',32,'${'a'.repeat(64)}','Audit Opal','published');
 INSERT INTO outreach_conversations(id,user_id,business_profile_id,channel,external_thread_id,automation_mode,status,metadata,total_messages) VALUES(60,9,7,'whatsapp','synthetic-recipient','ai_active','active','{}',0);
 SELECT setval('support_media_galleries_id_seq',2);`);
 await scoped(()=>supportDocumentLibrary.save(9,{title:'Audit synthetic brochure',description:'Synthetic audit only',service:'corporate',storageFileId:250}));
}
const local=process.env.GOVERNED_GALLERY_RECOVERY_QA==='1'?describe:describe.skip;
local('governed gallery recovery: mounted production routes and PostgreSQL',()=>{
 beforeAll(async()=>{
  if(process.env.DB_HOST!=='127.0.0.1'||process.env.DB_PORT!=='5559'||process.env.DB_NAME!=='support_gallery_audit')throw new Error('Exact disposable audit DB required');
  const cfg={host:'127.0.0.1',port:5559,database:'support_gallery_audit',user:'postgres',password:'',connectionTimeoutMillis:5000};
  schemaName='governed_pass_'+randomBytes(8).toString('hex');admin=new Pool({...cfg,max:1});await admin.query('CREATE EXTENSION IF NOT EXISTS vector');await admin.query(`CREATE SCHEMA "${schemaName}"`);
  fixture=new Pool({...cfg,max:5,options:`-c search_path=${schemaName},public,pg_catalog -c timezone=UTC -c app.business_profile_id=7 -c app.current_user_id=9 -c app.business_system=on`});
  await localBusinessFunctions(fixture);await table(usersTable);await table(companySettings);await table(storageFilesTable);
  await fixture.query(`CREATE TABLE business_profile_memberships(id serial PRIMARY KEY,business_profile_id integer,user_id integer,status text,role text);CREATE TABLE business_profile_preferences(user_id integer,default_business_profile_id integer);
   CREATE TABLE billing_organizations(id integer PRIMARY KEY,name text,owner_user_id integer,default_for_user_id integer,billing_eligibility_at timestamptz DEFAULT NOW());
   CREATE TABLE billing_organization_memberships(id serial PRIMARY KEY,organization_id integer,user_id integer,status text,role text);
   INSERT INTO users(id,email,name,is_approved) VALUES(9,'owner@example.test','Synthetic owner',true),(10,'foreign@example.test','Synthetic foreign',true),(11,'staff@example.test','Synthetic staff',true);
   INSERT INTO company_settings(id,user_id,name,company_name,is_default,billing_organization_id) VALUES(7,9,'Audit business','Audit business',true,77),(8,9,'Second business','Second business',false,77),(17,10,'Foreign business','Foreign business',true,78);
   INSERT INTO business_profile_memberships(business_profile_id,user_id,status,role) VALUES(7,11,'active','member');
   INSERT INTO billing_organizations(id,name,owner_user_id) VALUES(77,'Audit payer',9),(78,'Foreign payer',10);
   INSERT INTO billing_organization_memberships(organization_id,user_id,status,role) VALUES(77,9,'active','owner'),(77,11,'active','member'),(78,10,'active','owner');
   CREATE TABLE knowledge_index_versions(id bigint PRIMARY KEY,provider text,model text,dimensions integer,state text);CREATE TABLE knowledge_runtime_settings(id integer,active_index_version_id bigint);
   INSERT INTO storage_files(id,user_id,business_profile_id,is_deleted,mime_type) VALUES(99,9,7,false,'image/jpeg'),(100,9,7,false,'image/jpeg'),(250,9,7,false,'application/pdf'),(251,9,7,false,'application/pdf');`);
  const image=await sharp({create:{width:8,height:8,channels:3,background:'#557799'}}).jpeg().toBuffer();objects.set(99,image);objects.set(100,image);objects.set(250,Buffer.from('%PDF-1.7\nSynthetic fixture\n%%EOF'));objects.set(251,objects.get(250)!);
  for(const m of ['215_create_support_media_gallery','281_support_media_review_workflows','289_support_document_delivery','290_support_document_library','550_support_media_creation_intent'])await (await import('../migrations/'+m+'.js')).up(fixture);
  // @ts-expect-error Production migration is JavaScript.
  const creationMigration=await import('../migrations/550_support_media_creation_intent.js');
  await creationMigration.down(fixture);await creationMigration.up(fixture);
  for(const t of [orchestration.supportAdminAuditLogsTable,orchestration.supportDeliveryOutboxTable,outreach.outreachConversationsTable,outreach.outreachMessagesTable])await table(t);
  await fixture.query(`ALTER TABLE support_delivery_outbox ADD UNIQUE(decision_key);ALTER TABLE support_delivery_outbox ALTER COLUMN attempt_count SET DEFAULT 0;ALTER TABLE support_delivery_outbox ALTER COLUMN max_attempts SET DEFAULT 5;
   CREATE UNIQUE INDEX fixture_delivery_receipt ON outreach_messages(delivery_action_id) WHERE delivery_action_id IS NOT NULL;
   CREATE TABLE handoff_queue(id serial PRIMARY KEY,user_id integer,conversation_id integer,status text,ai_reply_enabled boolean DEFAULT false);
   CREATE TABLE agent_audit_logs(user_id integer,delivery_action_id bigint,delivery_status text,delivery_deferred boolean,provider_message_id text);`);
  for(const name of ['support_approved_documents','support_document_library']){const u=await fixture.query("SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype='u'",[name]);for(const r of u.rows)await fixture.query(`ALTER TABLE ${name} DROP CONSTRAINT "${r.conname}"`);}
  await fixture.query(`ALTER TABLE support_approved_documents ADD UNIQUE(business_profile_id,user_id,storage_file_id,service,checksum);ALTER TABLE support_document_library ADD UNIQUE(business_profile_id,user_id,storage_file_id);`);
  const names=['storage_files','support_approved_documents','support_document_library','support_admin_audit_logs','support_delivery_outbox','outreach_conversations','outreach_messages','handoff_queue','agent_audit_logs','support_media_galleries','support_media_gallery_versions','support_media_assets','support_media_asset_embeddings','support_media_retrieval_audits','support_media_delivery_parts','support_media_review_audits'];
  await localBusinessIsolation(fixture,schemaName,names);
  // Use the production ownership-trigger function, not a weaker null/default-only fixture.
  const migration=await readFile('migrations/299_business_profile_isolation.js','utf8');const sql=migration.match(/await client\.query\(`(CREATE OR REPLACE FUNCTION enforce_business_ownership[\s\S]*?)`\);/)!;await fixture.query(sql[1]);
  for(const name of names)await fixture.query(`CREATE TRIGGER zz_business_ownership BEFORE INSERT OR UPDATE ON ${name} FOR EACH ROW EXECUTE FUNCTION enforce_business_ownership('{"owner_column":"user_id","parent_links":[],"global_read":false}')`);
  await fixture.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schemaName}" TO salesmarketing_business_runtime;GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${schemaName}" TO salesmarketing_business_runtime`);
  appPool=createBusinessScopedPool(new Pool({...cfg,max:6,options:`-c search_path=${schemaName},public,pg_catalog -c timezone=UTC`}));
  const scopedDb=drizzle(appPool),rawDb=drizzle(fixture);fixtureDb=new Proxy({}, {get:(_t,k)=>{const target=scopedMode?scopedDb:rawDb;const value=Reflect.get(target,k);return typeof value==='function'?value.bind(target):value;}});
  await reset();
 },30000);
 afterAll(async()=>{if(observations.length)await writeFile(root+'/evidence/mounted-observations.json',JSON.stringify({observations,traces},null,2));const redis=await import('../infrastructure/redis.js');await redis.closeRedisConnections?.();await appPool?.end();await fixture?.end();if(admin&&/^governed_pass_[a-f0-9]{16}$/.test(schemaName))await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);await admin?.end();});
 it('observes real JWT auth, business/profile and billing identity on mounted uploads',async()=>{
  expect((await request(app).get('/api/settings/support-documents')).status).toBe(401);
  const result=await request(app).get('/api/settings/support-documents').set(hdr());expect(result.status).toBe(200);
  expect((await request(app).get('/api/settings/support-documents').set(hdr(9,17))).status).toBe(403);
  const stored=await request(app).post('/api/settings/storage/files').set({...hdr(11),'X-Billing-Organization-Id':'78'}).attach('file',objects.get(250)!,{filename:'audit.pdf',contentType:'application/pdf'});
  observe('identity-upload',{status:stored.status,body:stored.body,trace:traces.at(-1)});expect(stored.status).toBe(201);expect(traces.at(-1).business).toMatchObject({userId:9,actorUserId:11,businessProfileId:7});expect(traces.at(-1).payer.organizationId).toBe(77);
 });
 it('replays one parent creation after an HTTP response loss',async()=>{
  const key=randomBytes(16).toString('hex'),input=galleryInput('Durable recovery');
  const first=await request(app).post('/api/settings/media-galleries').set({...hdr(),'Idempotency-Key':key}).send(input);
  const retry=await request(app).post('/api/settings/media-galleries').set({...hdr(),'Idempotency-Key':key}).send(input);
  expect(first.status).toBe(201);expect(retry.status).toBe(201);expect(retry.body.data.id).toBe(first.body.data.id);
  expect((await fixture.query('SELECT id FROM support_media_galleries WHERE title=$1',[input.title])).rows).toHaveLength(1);
 });
 it('serializes concurrent parent attempts and conflicts on changed intent',async()=>{
  const key=randomBytes(16).toString('hex'),input=galleryInput('Concurrent recovery');
  const replies=await Promise.all(Array.from({length:6},()=>request(app).post('/api/settings/media-galleries').set({...hdr(),'Idempotency-Key':key}).send(input)));
  expect(replies.every(r=>r.status===201)).toBe(true);expect(new Set(replies.map(r=>r.body.data.id)).size).toBe(1);
  const changed=await request(app).post('/api/settings/media-galleries').set({...hdr(),'Idempotency-Key':key}).send({...input,title:'Changed intent'});
  expect(changed.status).toBe(409);
 });
 it('keeps creation identity separate across selected businesses and refuses destructive rollback',async()=>{
  const key=randomBytes(16).toString('hex'),input=galleryInput('Business recovery');
  const first=await request(app).post('/api/settings/media-galleries').set({...hdr(),'Idempotency-Key':key}).send(input);
  const second=await request(app).post('/api/settings/media-galleries').set({...hdr(9,8),'Idempotency-Key':key}).send(input);
  expect(first.status).toBe(201);expect(second.status).toBe(201);expect(first.body.data.id).not.toBe(second.body.data.id);
  // @ts-expect-error Production migration is JavaScript.
  const migration=await import('../migrations/550_support_media_creation_intent.js');
  await expect(migration.down(fixture)).rejects.toThrow('identities must be preserved');
 });
 it('keeps creation identities scoped to the originating actor',async()=>{
  const key=randomBytes(16).toString('hex'),input=galleryInput('Actor recovery');
  const owner=await request(app).post('/api/settings/media-galleries').set({...hdr(),'Idempotency-Key':key}).send(input);
  const staff=await request(app).post('/api/settings/media-galleries').set({...hdr(11),'Idempotency-Key':key}).send(input);
  expect(owner.status).toBe(201);expect(staff.status).toBe(201);expect(owner.body.data.id).not.toBe(staff.body.data.id);
 });
 (process.env.GOVERNED_BROWSER_HARNESS==='1'?it:it.skip)('serves audit-only browser API through mounted production settings route',async()=>{
  await reset();app.get('/__audit/tokens',(_q,s)=>s.json({owner:token(),staff:token(11)}));
  app.get('/__audit/state',async(_q,s)=>s.json({galleries:(await fixture.query('SELECT id,title,creation_request_key,creation_actor_user_id FROM support_media_galleries ORDER BY id')).rows,documents:(await fixture.query('SELECT id,title,revision FROM support_document_library ORDER BY id')).rows,traces}));
  app.post('/__audit/reset',async(_q,s)=>{await reset();s.json({ok:true});});
  const server=app.listen(8189,'127.0.0.1');await writeFile(root+'/api-ready','ready');
  try{await new Promise<void>((resolve,reject)=>{const end=Date.now()+240000;const poll=async()=>{if(Date.now()>end){reject(new Error('Audit browser deadline'));return;}try{await access(root+'/api-stop');resolve();}catch{setTimeout(()=>void poll(),250);}};void poll();});}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 },260000);
});
