import {afterAll,beforeAll,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {drizzle,type NodePgDatabase} from 'drizzle-orm/node-postgres';
import {sql} from 'drizzle-orm';
import {withBusinessScope} from '../tenancy/businessContext.js';
import {messageProviderCode} from '../services/outreach/OutreachDeliveryState.js';
import {installReportingFixture} from './helpers/outreachReportingFixture.js';
import type {ToolContext} from '../mastra/tools/toolRegistry.js';
let client: Client,database: NodePgDatabase;
const run = process.env.OUTREACH_QUEUE_LOCAL_QA === '1' ? describe : describe.skip;
jest.unstable_mockModule('../models/db.js',()=>({db:new Proxy({},{get(_target,key){
  const value=Reflect.get(database,key);return typeof value==='function' ? value.bind(database) : value;
}})}));
const {getCampaignReport,campaignReportStats} = await import('../services/outreach/CampaignReportingService.js');
const {getOutreachQueueOverview} = await import('../services/outreach/QueueOverview.js');
const {getCampaignCustomers,getCampaignHistory} = await import('../services/outreach/CustomerEngagementService.js');
jest.unstable_mockModule('../services/agents/WebSocketEmitter',()=>({webSocketEmitter:{emit:jest.fn()}}));
const {executeAnalyticsQuery} = await import('../mastra/tools/executors/analyticsExecutor.js');
const read = (filters: unknown={})=>withBusinessScope({userId:991,businessProfileId:1},()=>getCampaignReport(991,filters));
run('shared campaign reporting with real PostgreSQL',()=>{
  beforeAll(async()=>{
    const url=process.env.OUTREACH_QA_DATABASE_URL;
    if(!url || !['127.0.0.1','localhost'].includes(new URL(url).hostname) || new URL(url).pathname!='/implementation_synthetic') throw new Error('Explicit isolated fixture required');
    client=new Client({connectionString:url});await client.connect();
    await client.query('SET search_path TO pg_temp,pg_catalog');database=drizzle(client);
    await installReportingFixture(client);
  });
  afterAll(async()=>{await client?.end();});
  beforeEach(async()=>{
    await client.query(`TRUNCATE outreach_messages,outreach_conversations,outreach_jobs,sent_messages,outreach_campaigns,chat_threads,leads,crm_contacts,crm_contact_channel_identities,sales_outcome_events,campaign_crm_contacts,crm_contact_imports,crm_contact_import_details,campaign_lead_imports,campaign_lead_import_members;
      INSERT INTO outreach_conversations(id,user_id,lead_id,channel,provider_account_id,business_profile_id) VALUES
        (1,991,7,'whatsapp','phone-1',1),(2,991,8,'whatsapp','phone-1',1),(3,991,7,'whatsapp','phone-2',1),(4,991,7,'whatsapp','phone-1',2),(5,992,7,'whatsapp','phone-1',1);
      INSERT INTO outreach_campaigns VALUES(11,991,1,'Offer','{"threadId":21}'),(12,991,2,'Other business','{}');
      INSERT INTO chat_threads VALUES(21,991,1,'Offer workspace',NULL),(22,991,2,'Other workspace',NULL);
      INSERT INTO leads(id,user_id,campaign_data) VALUES(7,991,'{}'),(8,991,'{}');
      INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,created_at,sent_at,external_message_id,campaign_id) VALUES
        (1,991,1,'outbound','outreach','sent','2026-10-01','2026-10-01','wamid-1',11),
        (2,991,2,'outbound','outreach','delivered','2026-10-01','2026-10-01','wamid-2',11);
      INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,created_at,metadata,error_message) VALUES
        (3,991,2,'outbound','follow_up','pending','2026-10-02','{"outreachQueue":{"reason":"provider_limit","nextAttemptAt":"2026-11-03T00:00:00Z"}}','Cooldown'),
        (4,991,1,'outbound','outreach','failed','2026-10-02','{}','Invalid recipient');
      INSERT INTO outreach_messages(id,user_id,conversation_id,business_profile_id,direction,message_kind,status) VALUES
        (50,991,4,2,'outbound','outreach','sent'),(51,992,5,1,'outbound','outreach','sent');
    `);
  });
  it('reconciles provider acceptance, receipts, failures, retries and audience scope',async()=>{
    const report=await read({messageKind:'all'});
    expect(report.counts).toMatchObject({total:4,accepted:2,delivered:1,awaitingConfirmation:1,queued:1,retrying:1,failed:1});
    expect(report.uniqueRecipients).toBe(2);expect(report.nextAttemptAt).toBe('2026-11-03T00:00:00Z');
    expect(report.failures).toEqual([{channel:'whatsapp',code:null,reason:'Invalid recipient',count:1}]);
    expect((await read()).counts.total).toBe(3);
    const queue=await withBusinessScope({userId:991,businessProfileId:1},()=>getOutreachQueueOverview(991));
    expect(queue.channels).toEqual(report.channels);
    expect(campaignReportStats(report,'30d')).toMatchObject({totalSent:2,delivered:1,byStatus:{sent:2,pending:1,failed:1}});
    expect(campaignReportStats(report)).toMatchObject({totalSent:2,totalMessages:4});
  });
  it('shows a WhatsApp retry code only while that retry is pending, not on a later different failure',async()=>{
    // Retried for 131049, then the last attempt failed before reaching WhatsApp.
    await client.query(`UPDATE outreach_messages SET metadata='{"outreachQueue":{"reason":"provider_limit","providerCode":131049}}',
      error_message='The confirmed official provider account is not ready or no longer matches.' WHERE id=4`);
    // Still queued for the same limit: the code explains it.
    await client.query(`INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,created_at,metadata,error_message) VALUES
      (5,991,2,'outbound','outreach','pending','2026-10-03','{"outreachQueue":{"reason":"provider_limit","providerCode":131049,"nextAttemptAt":"2026-11-04T00:00:00Z"}}','Meta marketing limit reached.')`);
    const report=await read({messageKind:'all'});
    expect(report.failures).toEqual([{channel:'whatsapp',code:null,reason:'The confirmed official provider account is not ready or no longer matches.',count:1}]);
    const rows=await database.execute(sql`SELECT id,${messageProviderCode} AS code FROM outreach_messages m WHERE id IN(4,5) ORDER BY id`);
    expect(rows.rows).toEqual([{id:4,code:null},{id:5,code:'131049'}]);
    // A failure receipt's own code is shown while its text is still the error, and not after.
    await client.query(`UPDATE outreach_messages SET error_message='Message undeliverable',
      metadata=metadata||'{"providerFailure":{"code":"131026","message":"Message undeliverable"}}' WHERE id=4`);
    expect((await read({messageKind:'all'})).failures).toEqual([{channel:'whatsapp',code:'131026',reason:'Message undeliverable',count:1}]);
    await client.query(`UPDATE outreach_messages SET error_message='Insufficient credits. Please recharge your wallet.' WHERE id=4`);
    expect((await read({messageKind:'all'})).failures).toEqual([{channel:'whatsapp',code:null,reason:'Insufficient credits. Please recharge your wallet.',count:1}]);
  });
  it('keeps separate prepared campaigns distinct even when they use the same imported audience',async()=>{
    const first=randomUUID(),other=randomUUID(),foreign=randomUUID();
    await client.query(`INSERT INTO dashboard_operations(id,user_id,business_profile_id,kind,result) VALUES($1,991,1,'campaign_prepare','{"name":"Offer A"}'),($2,991,1,'campaign_prepare','{"name":"Offer B"}'),($3,991,2,'campaign_prepare','{"name":"Foreign offer"}')`,[first,other,foreign]);
    await client.query(`UPDATE outreach_messages SET metadata=jsonb_build_object('outreachCreation',jsonb_build_object('delivery',jsonb_build_object('preparedOutreachId',$1::text))) WHERE id=1`,[first]);
    await client.query(`UPDATE outreach_messages SET metadata=jsonb_build_object('outreachCreation',jsonb_build_object('delivery',jsonb_build_object('preparedOutreachId',$1::text))) WHERE id=2`,[other]);
    expect((await read({preparedOutreachId:first})).counts).toMatchObject({total:1,accepted:1,delivered:0});
    expect((await read({preparedOutreachId:other})).counts).toMatchObject({total:1,accepted:1,delivered:1});
    expect((await read({preparedOutreachId:first})).links.campaign).toBe(`/dashboard/outreach/prepared/${first}`);
    await expect(read({preparedOutreachId:foreign})).rejects.toThrow('not available');
    await client.query('DELETE FROM dashboard_operations WHERE id=ANY($1::uuid[])',[[first,other,foreign]]);
  });
  it('gives the dashboard and real agent executor the same filtered snapshot',async()=>{
    const result=await withBusinessScope({userId:991,businessProfileId:1},()=>executeAnalyticsQuery({query_type:'outreach',outreach_filters:{campaignId:11}},{userId:991,threadId:21} as ToolContext));
    expect(result.success).toBe(true);
    const expected=await read({workspaceId:21,campaignId:11});
    expect(result.output.data.report.counts).toEqual(expected.counts);
    expect(result.output.data.report.engagement).toEqual(expected.engagement);
    expect(result.output.data.report.links.report).toBe(expected.links.report);
  });
  it('uses exact projection links and preserves late receipt evidence without reviving rejected sends',async()=>{
    await client.query(`INSERT INTO outreach_jobs(id,user_id,lead_id,channel,status,external_message_id) VALUES(1,991,7,'whatsapp','sent','wamid-1');
      INSERT INTO sent_messages(id,user_id,lead_id,channel,status,message_id,outreach_message_id,delivered_at,sent_at) VALUES
        (1,991,7,'whatsapp','delivered','wamid-1',1,'2026-10-02','2026-10-01'),
        (2,991,7,'whatsapp','sent','failed-receipt',4,NULL,'2026-10-02');`);
    const report=await read();expect(report.counts).toMatchObject({total:3,accepted:2,delivered:2,awaitingConfirmation:0,failed:1});
    await client.query(`UPDATE sent_messages SET business_profile_id=2 WHERE id=1; UPDATE outreach_jobs SET business_profile_id=2 WHERE id=1`);
    expect((await read()).counts.delivered).toBe(1);
  });
  it('counts an older Gmail send record once when it names its email message, even under a CRM contact',async()=>{
    const before=(await read({messageKind:'all'})).counts.total;
    // The conversation is keyed by its CRM contact, the send record by its lead, and the channels are spelled differently.
    await client.query(`INSERT INTO crm_contacts(id,user_id,business_profile_id,lead_id) VALUES(80,991,1,NULL);
      INSERT INTO outreach_conversations(id,user_id,channel,provider_account_id,lead_id,crm_contact_id) VALUES(8,991,'email','me@example.com',NULL,80);
      INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,created_at,sent_at,external_message_id) VALUES
        (30,991,8,'outbound','outreach','sent','2026-10-05','2026-10-05','<msg-30@mail>');
      INSERT INTO sent_messages(id,user_id,lead_id,channel,status,message_id,outreach_message_id,sent_at,follow_up_step) VALUES
        (5,991,9,'gmail','sent','<msg-30@mail>',30,'2026-10-05',1);`);
    expect((await read({messageKind:'all'})).counts.total).toBe(before+1);
    // Without the stored link, a provider ID alone does not join different customers.
    await client.query(`UPDATE sent_messages SET outreach_message_id=NULL WHERE id=5`);
    expect((await read({messageKind:'all'})).counts.total).toBe(before+2);
  });
  it('does not deduplicate distinct recipients sharing a provider identity in bad legacy data',async()=>{
    await client.query(`INSERT INTO sent_messages(id,user_id,lead_id,channel,status,message_id,sent_at) VALUES(1,991,8,'whatsapp','sent','wamid-1','2026-10-01')`);
    expect((await read()).counts.total).toBe(4);
  });
  it('preserves count-only tracking evidence and excludes reply markers from before the send',async()=>{
    await client.query(`INSERT INTO sent_messages(id,user_id,lead_id,channel,status,message_id,outreach_message_id,sent_at,open_count,click_count,reply_received_at) VALUES
      (1,991,7,'whatsapp','sent','wamid-1',1,'2026-10-01',1,1,'2026-09-30');`);
    const report=await read();expect(report.counts).toMatchObject({accepted:2,delivered:2,opened:1,clicked:1});
    expect(report.engagement.respondingCustomers).toBe(0);
    await client.query(`UPDATE sent_messages SET reply_received_at='2026-10-02' WHERE id=1`);
    expect((await read()).engagement.respondingCustomers).toBe(1);
  });
  it('matches replies by recipient, channel, receiving account and send time',async()=>{
    await client.query(`INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,message_type,created_at,is_ai_generated) VALUES
      (10,991,1,'inbound','reply','received','text','2026-10-02',false),
      (11,991,1,'inbound','reply','received','button','2026-10-03',false),
      (12,991,1,'inbound','reply','received','interactive','2026-10-03',false),
      (13,991,1,'outbound','reply','sent','text','2026-10-03',true),
      (14,991,3,'inbound','reply','received','text','2026-10-03',false),
      (15,991,2,'inbound','reply','received','text','2026-09-30',false),
      (16,991,1,'outbound','reply','draft','text','2026-10-04',true),
      (17,991,1,'outbound','reply','failed','text','2026-10-04',true),
      (18,991,1,'outbound','reply','sent','text','2026-10-01',true);`);
    await client.query(`UPDATE outreach_messages SET metadata='{"nativeSelection":{"kind":"list_reply"}}' WHERE id=12`);
    const report=await read();expect(report.engagement).toMatchObject({respondingCustomers:1,inboundResponses:3,typedReplies:1,quickReplies:1,menuSelections:1,assistantReplies:1,responseRate:50,callButtonClicks:null});
    expect(report.channels[0].respondingCustomers).toBe(1);
  });
  it('filters campaign IDs separately from workspace membership and merged import contacts',async()=>{
    await client.query(`INSERT INTO crm_contacts VALUES(70,991,1,NULL,71),(71,991,1,7,NULL);
      INSERT INTO campaign_lead_imports VALUES(30,991,1,21,'audience.xlsx');
      INSERT INTO campaign_lead_import_members VALUES(30,991,1,99,99,70);
      INSERT INTO campaign_crm_contacts VALUES(991,1,71,21);
      INSERT INTO crm_contact_imports VALUES(31,991,1,'crm.xlsx');
      INSERT INTO crm_contact_import_details VALUES(31,1,71,'warning');`);
    expect((await read({campaignId:11})).counts.total).toBe(2);
    expect((await read({workspaceId:21})).counts.total).toBe(3);
    expect((await read({importId:30,importSource:'campaign'})).counts.total).toBe(2);
    expect((await read({importId:31,importSource:'crm'})).counts.total).toBe(2);
    expect((await read({accountId:'phone-2'})).counts.total).toBe(0);
    expect((await read({from:'2026-10-01T00:00:00Z',to:'2026-10-02T00:00:00Z'})).counts.total).toBe(2);
    await expect(read({workspaceId:22})).rejects.toThrow('not found');
    await expect(read({campaignId:12})).rejects.toThrow('not available');
    await expect(read({importId:999,importSource:'crm'})).rejects.toThrow('not available');
    await expect(read({importId:30})).rejects.toThrow();
  });
  it('reconciles CRM merge chains and temporary provider leads without merging unrelated customers',async()=>{
    await client.query(`INSERT INTO crm_contacts(id,user_id,business_profile_id,lead_id,merged_into_contact_id,deleted_at,first_name,phone)
      VALUES(70,991,1,7,71,now(),'Retired',NULL),(71,991,1,NULL,72,now(),'Retired again',NULL),(72,991,1,8,NULL,NULL,'Guest','+919000000001');
      INSERT INTO crm_contact_channel_identities VALUES(991,1,72,99),(991,2,72,100);
      INSERT INTO outreach_conversations(id,user_id,channel,provider_account_id,lead_id) VALUES(6,991,'whatsapp','phone-1',99),(7,991,'whatsapp','phone-2',99);
      INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,message_type,metadata,content,created_at) VALUES
        (20,991,6,'inbound','reply','received','text','{}','Can I book?','2026-10-03'),
        (21,991,6,'inbound','reply','received','interactive','{"nativeSelection":{"kind":"button_reply","title":"Book now"}}','Book now','2026-10-03'),
        (22,991,6,'inbound','reply','received','interactive','{"nativeSelection":{"kind":"list_reply","title":"Two nights"}}','Two nights','2026-10-04'),
        (23,991,7,'inbound','reply','received','text','{}','Another account','2026-10-03');
      INSERT INTO crm_contact_imports VALUES(31,991,1,'merged audience.xlsx');
      INSERT INTO crm_contact_import_details VALUES(31,1,70,'success');`);
    const report=await read();expect(report.uniqueRecipients).toBe(1);expect(report.engagement).toMatchObject({respondingCustomers:1,typedReplies:1,quickReplies:1,menuSelections:1,responseRate:100});
    // Historical import membership follows the canonical customer through both merges.
    const imported=await read({importSource:'crm',importId:31});expect(imported.uniqueRecipients).toBe(1);expect(imported.counts.total).toBe(3);
    const customers=await withBusinessScope({userId:991,businessProfileId:1},()=>getCampaignCustomers(991,{},{}));
    expect(customers.total).toBe(1);expect(customers.items[0]).toMatchObject({key:'contact:72',contactId:72,name:'Guest',messages:3,responded:true,quickReplies:1,menuSelections:1});
  });
  it('shows typed, native, tracked-link and verified booking evidence with paged protected history',async()=>{
    await client.query(`UPDATE outreach_messages SET content='Offer',metadata='{"clicks":[{"link":"https://example.test/booking","timestamp":"2026-10-04T00:00:00Z"}]}' WHERE id=1;
      INSERT INTO outreach_messages(id,user_id,conversation_id,direction,message_kind,status,message_type,metadata,content,redacted_content,created_at) VALUES
        (20,991,1,'inbound','reply','received','text','{}','Email is guest@example.test',NULL,'2026-10-03'),
        (21,991,1,'inbound','reply','received','interactive','{"nativeSelection":{"kind":"button_reply","title":"Book now"}}','Book now',NULL,'2026-10-04');
      INSERT INTO sales_outcome_events VALUES(1,991,1,'outreach',1,'booking_confirmed',true,'2026-10-05'),(2,991,1,'outreach',1,'booking_confirmed',false,'2026-10-05'),(3,991,2,'outreach',1,'booking_confirmed',true,'2026-10-05');`);
    const result=await withBusinessScope({userId:991,businessProfileId:1},()=>getCampaignCustomers(991,{},{respondedOnly:true,pageSize:1}));
    expect(result.total).toBe(1);expect(result.items[0]).toMatchObject({key:'lead:7',typedReplies:1,quickReplies:1,trackedLinkClicks:1,verifiedBookingActions:1});
    expect(result.availability.callButtonClicks).toBe('unavailable');
    const first=await withBusinessScope({userId:991,businessProfileId:1},()=>getCampaignHistory(991,{},{customerKey:'lead:7',pageSize:2}));
    expect(first.items.map(item=>item.id)).toEqual(['message-1','message-4']);expect(first.nextCursor).toBeTruthy();
    const second=await withBusinessScope({userId:991,businessProfileId:1},()=>getCampaignHistory(991,{},{customerKey:'lead:7',pageSize:2,after:first.nextCursor}));
    expect(second.items.map(item=>item.id)).toEqual(['message-20','message-21']);expect(second.items[0].content).not.toContain('guest@example.test');expect(second.items[1].selection).toEqual({kind:'button_reply',title:'Book now'});
    await expect(withBusinessScope({userId:991,businessProfileId:1},()=>getCampaignHistory(991,{},{after:'malformed'}))).rejects.toThrow('cursor is invalid');
  });
});
