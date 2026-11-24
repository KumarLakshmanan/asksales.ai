import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Client } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';
// @ts-expect-error JavaScript migrations are loaded by the custom runner.
const migration=await import('../migrations/319_review_historical_campaign_deliveries.js');
const local=process.env.CAMPAIGN_DELIVERY_LOCAL_QA==='1'?describe:describe.skip;
let client:Client,database:NodePgDatabase,schema:string;
let failInsert=false;
jest.unstable_mockModule('../models/db.js',()=>({db:{
  execute:(query:SQL)=>database.execute(query),
  transaction:(work:(tx:unknown)=>Promise<unknown>)=>database.transaction(tx=>work({execute:(query:SQL)=>{
    if (failInsert && query.queryChunks.some(chunk=>JSON.stringify(chunk).includes('INSERT INTO outreach_jobs'))) throw new Error('Fixture insert failure');
    return tx.execute(query);
  }})),
}}));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js',()=>({LLMProviderFactory:{}}));
jest.unstable_mockModule('../services/emailService.js',()=>({emailService:{sendPersonalizedEmail:jest.fn()}}));
jest.unstable_mockModule('../services/smsService.js',()=>({sendSMS:jest.fn()}));
jest.unstable_mockModule('../services/CreditService.js',()=>({creditService:{}}));
jest.unstable_mockModule('../models/sentMessages/functions.js',()=>({SentMessageModel:{}}));
jest.unstable_mockModule('../utils/logger.js',()=>({logger:{info:jest.fn(),warn:jest.fn(),error:jest.fn()}}));
const timing=jest.fn<any>((date?:string)=>date?new Date(date):undefined);
jest.unstable_mockModule('../services/outreach/CreationService.js',()=>({
  validateOutreachTiming:timing,
  resolveCreationAccount:async(_user:number,channel:string)=>({account:{ready:true,senderId:channel==='email'?7:undefined,providerAccountId:channel==='email'?'mailbox':'sms-account',label:channel==='email'?'sales@example.test':channel},binding:{credentialId:77}}),
  getCreationRecipients:async(user:number,channel:string,_selection:unknown,query:{ids:number[]})=>{
    const result=await client.query('SELECT * FROM leads WHERE user_id=$1 AND business_profile_id=101 AND id=ANY($2::integer[]) ORDER BY id',[user,query.ids]);
    return {recipients:result.rows.map(lead=>({id:lead.id,name:'Ada',firstName:'Ada',lastName:'Lovelace',company:lead.company,email:lead.email,phone:lead.phone,recipient:channel==='email'?lead.email:lead.phone,eligible:!lead.opted_out,reason:lead.opted_out?'Opted out':null}))};
  },
}));
const {prepareCampaignDelivery}=await import('../services/outreach/CampaignDeliveryService.js');
const {OutreachAgent}=await import('../services/agents/OutreachAgent.js');
const {reconcileOutreachJobCampaign}=await import('../services/outreach/OutreachJobCampaignService.js');
const scope=<T>(work:()=>T)=>withBusinessScope({userId:12,businessProfileId:101},work);
const accounts={email:{senderId:7},sms:{providerAccountId:'sms-account'}};
local('reviewed campaign delivery using owned isolated PostgreSQL fixtures',()=>{
  beforeAll(async()=>{
    dotenv.config({path:resolve(process.cwd(),'.env.development'),override:true,quiet:true});
    if (!['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST || '')) throw new Error('Local PostgreSQL only.');
    client=new Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT || 5432),database:process.env.DB_NAME || process.env.DB_DATABASE,user:process.env.DB_USER,password:process.env.DB_PASSWORD || '',connectionTimeoutMillis:5000});
    await client.connect(); schema=`campaign_review_${randomBytes(8).toString('hex')}`;
    await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET search_path=${schema},pg_catalog`); database=drizzle(client);
    await client.query(`CREATE TABLE outreach_campaigns(id integer PRIMARY KEY,user_id integer,business_profile_id integer,campaign_type text,status text,settings jsonb,lead_list_ids integer[],start_date timestamp,is_active boolean,launched_at timestamp,completed_at timestamp,created_at timestamp DEFAULT NOW(),updated_at timestamp,messages_sent integer,messages_delivered integer,messages_failed integer);
      CREATE TABLE outreach_sequences(id integer PRIMARY KEY,user_id integer,business_profile_id integer,sequence_type text,steps jsonb);
      CREATE TABLE leads(id integer PRIMARY KEY,user_id integer,business_profile_id integer,email text,phone text,company text,opted_out boolean DEFAULT false,deleted_at timestamp);
      CREATE TABLE outreach_jobs(id serial PRIMARY KEY,user_id integer,business_profile_id integer DEFAULT 101,campaign_id integer,lead_id integer,sequence_step_id integer,channel text,recipient_email text,recipient_phone text,scheduled_for timestamp,subject text,message_body text,max_attempts integer,attempts integer DEFAULT 0,metadata jsonb,status text DEFAULT 'pending',external_message_id text,sent_at timestamp,error text,updated_at timestamp);
      CREATE UNIQUE INDEX campaign_lead_step ON outreach_jobs(campaign_id,lead_id,sequence_step_id) WHERE campaign_id IS NOT NULL;
      CREATE TABLE sent_messages(id integer,user_id integer,campaign_id integer,lead_id integer,message_id text,is_reply boolean,status text,delivery_status text,delivered_at timestamp,bounced_at timestamp);
    `);
  },30000);
  afterAll(async()=>{if(client&&schema)await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await client?.end();});
  beforeEach(async()=>{
    failInsert=false; await client.query('TRUNCATE outreach_campaigns,outreach_sequences,outreach_jobs,leads,sent_messages RESTART IDENTITY');
    await client.query(`INSERT INTO outreach_campaigns(id,user_id,business_profile_id,campaign_type,status,settings,lead_list_ids,is_active) VALUES(9,12,101,'both','draft','{"sequenceIds":[5,6]}',ARRAY[73,74],false);
      INSERT INTO outreach_sequences VALUES(5,12,101,'email','[{"day":0,"subject":"Hello","body":"Hi {{first_name}}"},{"day":3,"body":"Follow up"}]'),(6,12,101,'sms','[{"day":0,"message":"Hi {{first_name}}"}]');
      INSERT INTO leads(id,user_id,business_profile_id,email,phone,company) VALUES(73,12,101,'ada@example.test','919876543210','Engines'),(74,12,101,'grace@example.test','919876543211','Engines');`);
  });
  it('atomically persists all email and SMS jobs without step collisions and never launches the same draft twice',async()=>{
    const plan=await scope(()=>prepareCampaignDelivery(12,9,accounts));
    const agent=new OutreachAgent();
    expect(await scope(()=>agent.scheduleCampaign(9,new Date(),{accounts,reviewHash:plan.reviewHash}))).toBe(true);
    expect((await client.query('SELECT channel,COUNT(*)::integer AS count FROM outreach_jobs GROUP BY channel ORDER BY channel')).rows).toEqual([{channel:'email',count:4},{channel:'sms',count:2}]);
    await expect(scope(()=>agent.scheduleCampaign(9,new Date(),{accounts,reviewHash:plan.reviewHash}))).rejects.toThrow(/Only a draft/);
    expect((await client.query('SELECT COUNT(*)::integer AS count FROM outreach_jobs')).rows[0].count).toBe(6);
    expect(await scope(()=>reconcileOutreachJobCampaign(9,12))).toMatchObject({total:6,pending:6,status:'queued'});
    await client.query("UPDATE outreach_jobs SET status='sent',external_message_id='fixture-'||id");
    expect(await scope(()=>reconcileOutreachJobCampaign(9,12))).toMatchObject({sent:6,status:'completed'});
  });
  it('rolls back the campaign claim when queue persistence fails and rejects changed personalized review',async()=>{
    const plan=await scope(()=>prepareCampaignDelivery(12,9,accounts)); const agent=new OutreachAgent();
    failInsert=true;
    await expect(scope(()=>agent.scheduleCampaign(9,new Date(),{accounts,reviewHash:plan.reviewHash}))).rejects.toThrow(/Fixture insert failure/);
    expect((await client.query('SELECT status FROM outreach_campaigns WHERE id=9')).rows[0].status).toBe('draft');
    expect((await client.query('SELECT COUNT(*)::integer AS count FROM outreach_jobs')).rows[0].count).toBe(0);
    failInsert=false; await client.query("UPDATE leads SET company='Changed' WHERE id=73");
    // Company is part of the recipient snapshot only when used in content.
    await client.query(`UPDATE outreach_sequences SET steps='[{"day":0,"body":"Hello {{company_name}}"}]' WHERE id=5`);
    await expect(scope(()=>agent.scheduleCampaign(9,new Date(),{accounts,reviewHash:plan.reviewHash}))).rejects.toThrow(/information changed/);
  });
  it('requires a fresh delivery review if the automatic reply policy changes',async()=>{
    const plan=await scope(()=>prepareCampaignDelivery(12,9,accounts));
    await client.query(`UPDATE outreach_campaigns SET settings=settings || '{"replyPolicy":{"autoSend":true}}'::jsonb WHERE id=9`);
    await expect(scope(()=>new OutreachAgent().scheduleCampaign(9,new Date(),{accounts,reviewHash:plan.reviewHash})))
      .rejects.toThrow(/changed/i);
    expect((await client.query('SELECT COUNT(*)::integer AS count FROM outreach_jobs')).rows[0].count).toBe(0);
  });
  it('pauses historical unreviewed pending campaigns while preserving sent/inflight statuses and receipts',async()=>{
    await client.query(`UPDATE outreach_campaigns SET status='running',is_active=true;
      INSERT INTO outreach_jobs(user_id,business_profile_id,campaign_id,lead_id,sequence_step_id,channel,status,external_message_id,metadata) VALUES
      (12,101,9,73,1,'email','pending',NULL,'{}'),(12,101,9,73,2,'email','sent','retained-receipt','{}'),(12,101,9,74,1,'email','processing',NULL,'{}'),
      (12,102,9,74,2,'sms','pending',NULL,'{"deliveryReview":{"version":1}}');`);
    await client.query('BEGIN'); try {await migration.up(client);await migration.up(client);await migration.down(client);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}
    expect((await client.query('SELECT status,settings,is_active FROM outreach_campaigns WHERE id=9')).rows[0]).toMatchObject({status:'paused',is_active:false,settings:{accountReviewRequired:true}});
    const rows=(await client.query('SELECT status,external_message_id,metadata FROM outreach_jobs ORDER BY id')).rows;
    expect(rows.map(row=>row.status)).toEqual(['pending','sent','processing','pending']);
    expect(rows[0].metadata).toMatchObject({manualReviewRequired:true,accountReviewRequired:true}); expect(rows[1].external_message_id).toBe('retained-receipt'); expect(rows[2].metadata).toEqual({}); expect(rows[3].metadata).toEqual({deliveryReview:{version:1}});
    expect((await client.query("SELECT current_setting('app.business_system',true) AS value")).rows[0].value).not.toBe('on');
  });
});
