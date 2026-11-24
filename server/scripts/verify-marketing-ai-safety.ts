/** Opt-in real PostgreSQL checks. All writes target connection-local temporary tables. */
import assert from 'node:assert/strict';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../models/db.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { CreativeIntelligenceService } from '../services/ads/creative-intelligence/CreativeIntelligenceService.js';
import { AnalyticsIngestionService } from '../services/AnalyticsIngestionService.js';

if (process.env.MARKETING_AI_QA_TEMP_TABLES !== '1' || process.env.NODE_ENV !== 'test')
  throw new Error('Run explicitly with NODE_ENV=test MARKETING_AI_QA_TEMP_TABLES=1.');
const client = new pg.Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER, password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || process.env.DB_DATABASE, ssl: process.env.DB_SSL === 'true' });
const scoped = <T>(work: () => T) => withBusinessScope({ userId: 9, businessProfileId: 7 }, work);
const originalExecute = db.execute;
const previousFlag = process.env.AD_CREATIVE_INTELLIGENCE_ENABLED;
try {
  await client.connect();
  await client.query(`CREATE TEMP TABLE ad_creative_briefs(id integer PRIMARY KEY,user_id integer,revision integer,status text,selected_concept_id text,input jsonb,concepts jsonb);
    CREATE TEMP TABLE chat_threads(id serial PRIMARY KEY,user_id integer,business_id integer,title text,selected_agent text,metadata jsonb,deleted_at timestamp);
    CREATE TEMP TABLE chat_messages(id serial PRIMARY KEY,user_id integer,thread_id integer REFERENCES chat_threads(id),role text,content text,agent_type text,metadata jsonb);
    CREATE TEMP TABLE widget_states(id serial PRIMARY KEY,user_id integer,thread_id integer REFERENCES chat_threads(id),message_id integer REFERENCES chat_messages(id),tool_name text,widget_type text,idempotency_key text UNIQUE,form_values jsonb,status text,agent_type text);
    CREATE TEMP TABLE performance_ad_campaigns(id integer PRIMARY KEY,user_id integer,local_status text,budget_type text,budget_amount numeric,spent_amount numeric,settings jsonb,last_synced_at timestamp DEFAULT NOW());
    CREATE TEMP TABLE ad_provider_resources(id serial PRIMARY KEY,campaign_id integer,user_id integer,platform text,resource_type text,status text,local_key text,provider_resource_id text,provider_resource_name text);
    CREATE TEMP TABLE ad_unit_metrics(campaign_id integer,user_id integer,platform text,target_type text,target_key text,parent_target_key text,provider_resource text,date date,impressions numeric,clicks numeric,spend numeric,reach numeric,conversions numeric,conversion_value numeric,engagements numeric,installs numeric,provider_status text,provider_payload jsonb,updated_at timestamp DEFAULT NOW(),UNIQUE(campaign_id,platform,target_type,target_key,date));
    CREATE TEMP TABLE ad_action_queue(campaign_id integer,user_id integer,platform text,action_type text,idempotency_key text,payload jsonb,metrics_snapshot jsonb,rationale text,budget_impact numeric,business_profile_id integer DEFAULT 7,UNIQUE(business_profile_id,user_id,idempotency_key));`);
  // Fail before executing service code unless every write destination is temporary.
  const tables = ['ad_creative_briefs','chat_threads','chat_messages','widget_states','performance_ad_campaigns','ad_provider_resources','ad_action_queue','ad_unit_metrics'];
  for (const table of tables) assert.equal((await client.query('SELECT relpersistence FROM pg_class WHERE oid=to_regclass($1)', [table])).rows[0].relpersistence, 't');
  process.env.AD_CREATIVE_INTELLIGENCE_ENABLED = 'true';
  const concept = { id: 'qa-concept', title: 'Quiet getaway', format: 'image', headline: 'Take a moment', ctaText: 'Learn more', ctaType: 'learn_more', hook: 'Pause', copyDirection: 'Original copy', visualDirection: 'Illustration', scenes: ['Hills'], requiredAssets: [] };
  await client.query(`INSERT INTO ad_creative_briefs VALUES(7,9,2,'ready','qa-concept',$1,$2)`, [JSON.stringify({ businessFacts: 'QA ONLY — Oro Circle test facts', constraints: 'Draft only', audience: 'Visitors', objective: 'awareness', language: 'English' }), JSON.stringify([concept])]);
  const service = new CreativeIntelligenceService(drizzle(client));
  const review = await scoped(() => service.createDraftReview(9, 7, 2, 'qa-concept'));
  const retry = await scoped(() => service.createDraftReview(9, 7, 2, 'qa-concept'));
  assert.deepEqual(retry, review);
  assert.equal((await client.query('SELECT count(*)::int AS count FROM chat_threads')).rows[0].count, 1);
  const saved = (await client.query('SELECT * FROM widget_states')).rows[0];
  assert.equal(saved.tool_name, 'generate_ad');
  assert.equal(saved.status, 'active');
  assert.equal(saved.form_values.auto_generate_image, false);
  assert.equal(saved.form_values.creative_brief_revision, 2);
  assert.equal((await client.query('SELECT metadata FROM chat_messages')).rows[0].metadata.widgetMessageId, saved.message_id);
  await assert.rejects(scoped(() => service.createDraftReview(9, 7, 1, 'qa-concept')), /changed/);
  await assert.rejects(scoped(() => service.createDraftReview(9, 8, 2, 'qa-concept')), /not found/);
  // A failure after creating a thread must roll back the complete handoff.
  await client.query('UPDATE ad_creative_briefs SET revision=3 WHERE id=7');
  const failing = new CreativeIntelligenceService({ transaction: (work: (tx: unknown) => Promise<unknown>) => drizzle(client).transaction(async tx => work({ execute: async (query: unknown) => {
    const statement = new PgDialect().sqlToQuery(query as never);
    if (statement.sql.includes('INSERT INTO widget_states')) throw new Error('QA simulated persistence failure');
    return tx.execute(query as never);
  } })) });
  await assert.rejects(scoped(() => failing.createDraftReview(9, 7, 3, 'qa-concept')), /QA simulated/);
  assert.equal((await client.query('SELECT count(*)::int AS count FROM chat_threads')).rows[0].count, 1);
  await client.query(`INSERT INTO performance_ad_campaigns(id,user_id,local_status,budget_type,budget_amount,spent_amount,settings) VALUES
    (101,9,'active','lifetime',100,150,'{"importedProviderCampaign":true}'),
    (102,9,'active','daily',100,150,'{}'),(103,9,'active','lifetime',100,150,'{}'),
    (104,9,'active','lifetime',0,150,'{}'),(105,9,'active','lifetime',100,50,'{}');
    INSERT INTO ad_provider_resources(campaign_id,user_id,platform,resource_type,status) SELECT id,user_id,'meta','campaign','active' FROM performance_ad_campaigns;`);
  db.execute = async (query: unknown) => { const statement = new PgDialect().sqlToQuery(query as never); return client.query(statement.sql, statement.params); };
  const ingestion = new AnalyticsIngestionService() as unknown as { enqueueLifetimeCapPauses(): Promise<void> };
  await scoped(() => ingestion.enqueueLifetimeCapPauses());
  await scoped(() => ingestion.enqueueLifetimeCapPauses());
  const actions = (await client.query('SELECT campaign_id FROM ad_action_queue')).rows;
  assert.deepEqual(actions, [{ campaign_id: 103 }]);
  await client.query(`INSERT INTO ad_provider_resources(campaign_id,user_id,platform,resource_type,status,local_key,provider_resource_id) VALUES
    (101,9,'meta','ad_set','active','qa-set','qa-provider-set'),(101,9,'meta','ad','active','qa-ad','qa-provider-ad')`);
  const units = new AnalyticsIngestionService() as unknown as { storeUnitMetric(metric: Record<string, unknown>): Promise<void> };
  const metric = { campaignId:101,userId:9,platform:'meta',date:'2026-11-01',impressions:100,clicks:2,spend:5,conversions:0,conversionValue:0,source:{} };
  await scoped(() => units.storeUnitMetric({...metric,targetType:'ad_set',providerResource:'qa-provider-set'}));
  await scoped(() => units.storeUnitMetric({...metric,targetType:'ad',providerResource:'qa-provider-ad',parentProviderResource:'qa-provider-set'}));
  assert.deepEqual((await client.query('SELECT target_key,parent_target_key FROM ad_unit_metrics ORDER BY target_key')).rows,
    [{target_key:'qa-ad',parent_target_key:'qa-set'},{target_key:'qa-set',parent_target_key:null}]);
  console.log(JSON.stringify({ passed: true, checks: ['real PostgreSQL review persistence','retry idempotency','canonical draft-only form','linked review message','stale revision rejection','ownership rejection','transaction rollback without orphan workspace','imports and daily budgets cannot queue cap pauses','normal lifetime-cap protection retained','cap queue idempotency','ad-set metrics persist without a parent','ad metrics resolve the parent ad set'], tables: 'temporary only; no provider calls' }));
} finally {
  db.execute = originalExecute;
  if (previousFlag === undefined) delete process.env.AD_CREATIVE_INTELLIGENCE_ENABLED; else process.env.AD_CREATIVE_INTELLIGENCE_ENABLED = previousFlag;
  await client.end();
}
