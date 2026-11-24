import {afterAll,beforeAll,describe,expect,it,jest} from '@jest/globals';
import {Client} from 'pg';
import {drizzle,type NodePgDatabase} from 'drizzle-orm/node-postgres';
import {getTableColumns} from 'drizzle-orm';
import {leadsTable} from '../models/leads/schema.js';
import {withBusinessScope} from '../tenancy/businessContext.js';
import {installReportingFixture} from './helpers/outreachReportingFixture.js';
import type {ToolContext} from '../mastra/tools/toolRegistry.js';
const connectionString=process.env.ANALYTICS_QA_DATABASE_URL;
const postgres=connectionString ? describe : describe.skip;
let client:Client,database:NodePgDatabase;
jest.unstable_mockModule('../models/db.js',()=>({db:new Proxy({},{get(_target,key){const value=Reflect.get(database,key);return typeof value==='function' ? value.bind(database) : value;}})}));
jest.unstable_mockModule('../services/agents/WebSocketEmitter',()=>({webSocketEmitter:{emit:jest.fn()}}));
const {executeAnalyticsQuery}=await import('../mastra/tools/executors/analyticsExecutor.js');
const context={userId:7,threadId:226} as ToolContext;
const query=(input:Parameters<typeof executeAnalyticsQuery>[0],ctx=context)=>withBusinessScope({userId:7,businessProfileId:1},()=>executeAnalyticsQuery(input,ctx));
postgres('campaign analytics against isolated native fixtures',()=>{
  beforeAll(async()=>{
    if(!connectionString || !['127.0.0.1','localhost'].includes(new URL(connectionString).hostname) || new URL(connectionString).pathname!='/implementation_synthetic')throw new Error('Explicit isolated loopback analytics database required');
    client=new Client({connectionString});await client.connect();await client.query('SET search_path TO pg_temp,pg_catalog');
    await installReportingFixture(client);
    // Match the model without copying public tables, defaults or sequences.
    const columns=Object.values(getTableColumns(leadsTable)).map(column=>`"${column.name}" ${column.getSQLType()}`).join(',');
    await client.query(`DROP TABLE leads;CREATE TEMP TABLE leads(${columns});CREATE TEMP TABLE icp_profiles(id int,user_id int,thread_id int);
      INSERT INTO icp_profiles VALUES(10,7,226),(11,99,226);
      INSERT INTO leads(id,user_id,business_profile_id,source,status,prompt_id,campaign_data) VALUES
        (1,7,1,'linkedin','new',NULL,'{"threadId":226}'),(2,7,1,'google_maps','qualified',10,NULL),(3,7,1,'linkedin','new',NULL,'{"threadId":999}'),
        (4,99,1,'linkedin','new',NULL,'{"threadId":226}'),(5,7,1,'linkedin','new',11,NULL);
      INSERT INTO chat_threads VALUES(226,7,1,'Current workspace',NULL),(999,7,1,'Other workspace',NULL);
      INSERT INTO outreach_campaigns(id,user_id,name,settings) VALUES(20,7,'Current campaign','{"threadId":226}'),(21,7,'Other campaign','{"threadId":999}'),(22,99,'Other owner','{"threadId":226}');
      INSERT INTO sent_messages(id,user_id,lead_id,channel,message,sent_at,status,campaign_id,delivery_status,is_reply) VALUES
        (1,7,1,'email','qa',NOW(),'sent',20,'pending',false),(2,7,1,'email','qa',NOW(),'delivered',20,'delivered',false),
        (3,7,1,'email','qa',NOW(),'queued',20,'pending',false),(4,7,1,'email','qa',NOW(),'failed',20,'failed',false),
        (5,7,1,'email','qa',NOW(),'sent',21,'pending',false),(6,99,4,'email','qa',NOW(),'delivered',22,'delivered',false),
        (7,7,1,'email','qa',NOW(),'sent',20,'pending',true),(8,7,1,'email','qa',NOW(),'sent',22,'pending',false),(9,7,1,'email','qa',NOW(),'sent',NULL,'pending',false);`);
    database=drizzle(client);
  });
  afterAll(async()=>{await client?.end();});
  it('counts only owned leads associated by conversation or owned ICP',async()=>{
    expect(await query({query_type:'lead'})).toMatchObject({success:true,output:{scope:'current_campaign',data:{totalLeads:2}}});
  });
  it('does not fall back to account leads for an empty conversation',async()=>{
    expect(await query({query_type:'lead'},{...context,threadId:888})).toMatchObject({success:true,output:{data:{totalLeads:0}}});
  });
  it('uses an exact campaign filter and receipt-aware shared reporting',async()=>{
    expect(await query({query_type:'outreach',outreach_filters:{campaignId:20}})).toMatchObject({success:true,output:{data:{totalSent:2,delivered:1,byChannel:{email:2},report:{counts:{total:4,accepted:2,delivered:1,awaitingConfirmation:1,queued:1,failed:1}}}}});
  });
  it('keeps explicit account-wide lead reporting available without mixing owners',async()=>{
    expect(await query({query_type:'lead',scope:'all_owned'})).toMatchObject({success:true,output:{scope:'all_owned',data:{totalLeads:4}}});
  });
});
