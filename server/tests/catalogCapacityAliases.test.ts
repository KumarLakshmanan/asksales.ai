/** Catalog-write regression tests; no provider calls.
 * PostgreSQL work is opt-in and confined to one random schema in a disposable local QA DB.
 */
import {afterAll,beforeAll,describe,expect,it,jest} from '@jest/globals';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {fileURLToPath} from 'node:url';

const source=fileURLToPath(new URL('../../',import.meta.url));
jest.unstable_mockModule('../models/db.js',()=>({db:{},pgPool:undefined}));
const {catalogInput,catalogPlan}=await import('../services/subscriptions/catalog.js');
const {SUBSCRIPTION_PLANS}=await import('../../shared/subscriptions.js');
const input=structuredClone(SUBSCRIPTION_PLANS);
input[0].limits.businessProfiles=2;
input[0].limits.workspaces=2;

describe('catalog alias validation on new writes',()=>{
  it.each([[5,1],[1,5],[null,1],[1,null],[null,0],[0,null],[5,0],[0,5]] as Array<[number|null,number|null]>)('rejects divergent %s / %s',(businessProfiles,workspaces)=>{
    const plans=structuredClone(SUBSCRIPTION_PLANS);Object.assign(plans[0].limits,{businessProfiles,workspaces});
    const parsed=catalogInput.safeParse({plans});expect(parsed.success).toBe(false);
    if(parsed.success)throw new Error('Divergent capacity aliases were accepted');
    expect(parsed.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({code:'custom',path:['plans',0,'limits','workspaces']})]));
  });
  it.each([null,0,1,5,Number.MAX_SAFE_INTEGER])('retains matching aliases %s',value=>{
    const plans=structuredClone(SUBSCRIPTION_PLANS);Object.assign(plans[0].limits,{businessProfiles:value,workspaces:value});
    expect(catalogInput.parse({plans}).plans[0].limits).toMatchObject({businessProfiles:value,workspaces:value});
  });
  it.each([NaN,Infinity,-1,0.5])('retains existing field validation %s',value=>{
    const plans=structuredClone(SUBSCRIPTION_PLANS);Object.assign(plans[0].limits,{businessProfiles:value,workspaces:value});
    expect(catalogInput.safeParse({plans}).success).toBe(false);
  });
  it('keeps historical row mapping readable without rewriting divergent limits',()=>{
    const plan=SUBSCRIPTION_PLANS[0],limits={...plan.limits,businessProfiles:5,workspaces:1};
    const mapped=catalogPlan({version:1,slug:plan.slug,name:plan.name,description:plan.description,monthly_amount_paise:plan.monthlyRupees*100,yearly_amount_paise:plan.yearlyRupees*100,monthly_credits:plan.monthlyCredits,limits,sort_order:plan.sortOrder,featured:plan.featured,finder_min_score:plan.finderMinScore,finder_max_score:plan.finderMaxScore});
    expect(mapped.limits).toMatchObject({businessProfiles:5,workspaces:1});expect(limits.workspaces).toBe(1);
  });
});

const postgresSuite=process.env.CATALOG_ALIAS_LOCAL_QA==='1'?describe:describe.skip;
postgresSuite('matching aliases at the actual PostgreSQL capacity boundary',()=>{
  let admin:pg.Pool,pool:pg.Pool;
  const schema=`catalog_alias_qa_${randomBytes(6).toString('hex')}`;
  const database=process.env.ALIAS_QA_DB_NAME||process.env.DB_NAME||'salesmarketing_tenant_remediation_qa_20261023';
  function actual(file:string,name:string){
    const text=readFileSync(`${source}/server/migrations/${file}`,'utf8');
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const found=text.match(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION ${escaped}\\([\\s\\S]*?END \\$\\$;`));
    if(!found)throw new Error(`Missing actual function ${name} in ${file}`);
    return found[0];
  }
  beforeAll(async()=>{
    if(!/^[a-z][a-z0-9_]*qa[a-z0-9_]*$/.test(database))throw new Error('A disposable local QA database name is required');
    const config={host:'127.0.0.1',port:55432,user:'postgres',password:'',database,max:1,connectionTimeoutMillis:5000};
    admin=new pg.Pool(config);
    const identity=(await admin.query('SELECT current_database() name,host(inet_server_addr()) address')).rows[0];
    expect(identity).toEqual({name:database,address:'127.0.0.1'});
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new pg.Pool({...config,options:`-c search_path=${schema},pg_catalog -c timezone=UTC`});
    await pool.query(`
      CREATE TABLE billing_organizations(id integer PRIMARY KEY,owner_user_id integer);
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,billing_organization_id integer);
      CREATE TABLE subscription_settings(id integer PRIMARY KEY,capacity_enforced boolean);
      CREATE TABLE subscription_plans(version integer,slug text,limits jsonb);
      CREATE TABLE billing_subscriptions(id text PRIMARY KEY,version integer,slug text,mode text);
      CREATE TABLE subscription_charges(subscription_id text,organization_id integer,period_start timestamptz,refund_amount_paise integer);
      CREATE TABLE billing_admin_plan_terms(organization_id integer,version integer,slug text,starts_at timestamptz,ends_at timestamptz,cancelled_at timestamptz);
      CREATE TABLE storage_plans(id integer PRIMARY KEY,max_storage_bytes bigint,is_default boolean);
      CREATE TABLE storage_quotas(user_id integer,plan_id integer,max_storage_bytes bigint);
      CREATE TABLE billing_capacity_items(source_table text,source_id text,resource_key text,identity_key text,
        organization_id integer,business_profile_id integer,workspace_id integer,amount bigint,
        PRIMARY KEY(source_table,source_id,resource_key,identity_key));
      CREATE TABLE billing_capacity_totals(organization_id integer,resource_key text,usage bigint,updated_at timestamptz DEFAULT now(),
        PRIMARY KEY(organization_id,resource_key));
      CREATE FUNCTION billing_capacity_authorize(integer) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
      INSERT INTO billing_organizations VALUES(901,901);
      INSERT INTO subscription_settings VALUES(1,true);
      INSERT INTO billing_subscriptions VALUES('synthetic-live-starter',2,'starter','live');
      INSERT INTO subscription_charges VALUES('synthetic-live-starter',901,now()-interval '1 day',0);
    `);
    const validated=catalogInput.parse({plans:input}).plans[0];
    await pool.query('INSERT INTO subscription_plans VALUES(2,$1,$2::jsonb)',[validated.slug,JSON.stringify(validated.limits)]);
    await pool.query(actual('340_live_capacity_plan_retention.js','billing_capacity_plan'));
    await pool.query(actual('302_organization_capacity.js','billing_assert_capacity'));
    await pool.query(actual('302_organization_capacity.js','billing_capacity_units'));
    await pool.query('ALTER FUNCTION billing_capacity_units(text,jsonb) RENAME TO billing_capacity_units_v302');
    await pool.query(actual('304_business_profile_memberships.js','billing_capacity_units'));
    await pool.query('ALTER FUNCTION billing_capacity_units(text,jsonb) RENAME TO billing_capacity_units_before_modern');
    await pool.query(actual('341_modern_resource_capacity.js','billing_capacity_units'));
    for(const name of ['billing_capacity_apply_deltas','billing_sync_capacity','billing_transfer_profile_capacity','billing_capacity_resource_trigger']){
      // Actual functions' explicit production search_path is retargeted only to the random synthetic schema.
      await pool.query(actual('302_organization_capacity.js',name).replaceAll('SET search_path=public,pg_catalog',`SET search_path=${schema},pg_catalog`));
    }
    await pool.query('CREATE TRIGGER zz_billing_capacity AFTER INSERT OR UPDATE OR DELETE ON company_settings FOR EACH ROW EXECUTE FUNCTION billing_capacity_resource_trigger()');
  },30000);
  afterAll(async()=>{
    await pool?.end();
    if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
  });
  it('enforces equal aliases below, at and above capacity atomically',async()=>{
    await pool.query('INSERT INTO company_settings VALUES(1,901,901)');
    expect((await pool.query('SELECT resource_key,usage::int FROM billing_capacity_totals ORDER BY resource_key')).rows).toEqual([{resource_key:'businessProfiles',usage:1},{resource_key:'workspaces',usage:1}]);
    await pool.query('INSERT INTO company_settings VALUES(2,901,901)');
    expect((await pool.query('SELECT resource_key,usage::int FROM billing_capacity_totals ORDER BY resource_key')).rows).toEqual([{resource_key:'businessProfiles',usage:2},{resource_key:'workspaces',usage:2}]);
    await expect(pool.query('INSERT INTO company_settings VALUES(3,901,901)')).rejects.toMatchObject({code:'P0001'});
    expect((await pool.query('SELECT count(*)::int count FROM company_settings')).rows[0].count).toBe(2);
    expect((await pool.query('SELECT resource_key,usage::int FROM billing_capacity_totals ORDER BY resource_key')).rows).toEqual([{resource_key:'businessProfiles',usage:2},{resource_key:'workspaces',usage:2}]);
  });
});
