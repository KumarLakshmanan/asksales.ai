import {afterAll,beforeAll,beforeEach,describe,expect,it,jest} from '@jest/globals';
import {Pool} from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import crypto from 'node:crypto';
const suite=process.env.SUBSCRIPTIONS_LOCAL_QA==='1'?describe:describe.skip;
let pool:Pool,admin:Pool,schema:string,fixture:any;
const dbProxy=new Proxy({},{get:(_target,key)=>{const member=fixture?.[key];return typeof member==='function'?member.bind(fixture):member;}});
jest.unstable_mockModule('../models/db.js',()=>({db:dbProxy}));
const {normalizeBillingCredentialError,assertBillingCredentialMutation}=await import('../services/subscriptions/credentialPolicy.js');
const {updateAdminCredential,getAdminCredentialById}=await import('../models/adminApiCredentials/functions.js');
const {encryptValue,decryptValue}=await import('../services/SecretsManager.js');
suite('billing credential integrity with synthetic local PostgreSQL',()=>{
  beforeAll(async()=>{
    if(!['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST||''))throw new Error('Local QA database required');
    const config={host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,database:process.env.DB_NAME,password:process.env.DB_PASSWORD};
    admin=new Pool({...config,max:1});schema=`credential_qa_${crypto.randomBytes(6).toString('hex')}`;await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({...config,max:5,options:`-c search_path=${schema},pg_catalog`});fixture=drizzle(pool);
    await pool.query(`CREATE TABLE admin_api_credentials(id integer PRIMARY KEY,platform text,name text,api_key text,api_secret text,is_encrypted boolean DEFAULT false,is_active boolean DEFAULT true,priority text DEFAULT 'normal',config jsonb DEFAULT '{}',last_used_at timestamp,usage_count text DEFAULT '0',deactivation_reason text,deactivated_at timestamp,last_validated_at timestamp,validation_status text,validation_message text,rotated_at timestamp,rotated_by integer,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());
      CREATE TABLE subscription_settings(id integer PRIMARY KEY,enforced boolean,credential_id integer);
      CREATE TABLE subscription_provider_plans(credential_id integer);
      CREATE TABLE billing_subscriptions(credential_id integer);
      CREATE TABLE users(id integer PRIMARY KEY);
      CREATE TABLE billing_organizations(id integer PRIMARY KEY);
      CREATE TABLE business_scope_accounts(table_name text PRIMARY KEY);
      CREATE FUNCTION app_business_system() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION app_billing_organization_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULL::integer $$;
      CREATE FUNCTION app_billing_actor_user_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULL::integer $$;`);
    // @ts-expect-error custom JavaScript migration.
    await (await import('../migrations/342_subscription_credential_integrity.js')).up(pool);
    const originPath='../migrations/344_wallet_recharge_order_origins.js';
    const origins:{up(client:Pool):Promise<void>}=await import(originPath);
    await origins.up(pool);
  });
  beforeEach(async()=>{
    await pool.query('TRUNCATE wallet_recharge_order_origins,subscription_settings,subscription_provider_plans,billing_subscriptions,admin_api_credentials');
    await pool.query("INSERT INTO admin_api_credentials(id,platform,name,api_key,api_secret) VALUES(1,'razorpay','Fixture','synthetic-live-key','synthetic-secret'),(2,'razorpay','Second','synthetic-other-key','synthetic-secret'),(3,'openai','AI','synthetic-ai','synthetic-secret'); INSERT INTO subscription_settings VALUES(1,true,1)");
  });
  afterAll(async()=>{await pool?.end();if(schema)await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin?.end();});
  it.each(["api_key='new'","api_secret='new'","config='{}'::jsonb || '{\"subscriptionWebhookSecret\":\"new\"}'::jsonb","is_active=false","platform='custom_ai'"] )('rejects generic sensitive update %s during enforcement',async update=>{
    let error:unknown;try{await pool.query(`UPDATE admin_api_credentials SET ${update} WHERE id=1`);}catch(e){error=e;}
    expect(normalizeBillingCredentialError(error)).toMatchObject({status:409,code:'BILLING_CREDENTIAL_ENFORCED'});
  });
  it('rejects deletion and selected credential retargeting while enforced; permits labels and unrelated providers',async()=>{
    await expect(pool.query('DELETE FROM admin_api_credentials WHERE id=1')).rejects.toMatchObject({code:'P0001'});
    await expect(pool.query('UPDATE subscription_settings SET credential_id=2')).rejects.toMatchObject({code:'P0001'});
    await pool.query("UPDATE admin_api_credentials SET name='Reviewed label',priority='high' WHERE id=1; UPDATE admin_api_credentials SET api_secret='other' WHERE id=3");
    expect((await pool.query('SELECT name FROM admin_api_credentials WHERE id=1')).rows[0].name).toBe('Reviewed label');
  });
  it('preserves historical provider identity after disabling enforcement, allowing secret rotation',async()=>{
    await pool.query('UPDATE subscription_settings SET enforced=false; INSERT INTO subscription_provider_plans VALUES(1)');
    await expect(pool.query("UPDATE admin_api_credentials SET api_key='new-account' WHERE id=1")).rejects.toMatchObject({code:'P0001',detail:'{"code":"BILLING_CREDENTIAL_IDENTITY"}'});
    await expect(pool.query('DELETE FROM admin_api_credentials WHERE id=1')).rejects.toMatchObject({detail:'{"code":"BILLING_CREDENTIAL_HISTORY"}'});
    await pool.query("UPDATE admin_api_credentials SET api_secret='rotated',is_active=false WHERE id=1");
    await expect(assertBillingCredentialMutation({id:1,platform:'razorpay',apiKey:'synthetic-live-key'},{apiKey:'new-account'})).rejects.toMatchObject({code:'BILLING_CREDENTIAL_IDENTITY'});
  });
  it('allows new independent credentials to change identity before any provider history exists',async()=>{
    await pool.query("UPDATE admin_api_credentials SET api_key='new-test-identity' WHERE id=2");
    await expect(assertBillingCredentialMutation({id:2,platform:'razorpay',apiKey:'new-test-identity'},{apiKey:'another'})).resolves.toBeUndefined();
  });
  it('keeps unchanged encrypted identity stable during a permitted secret-only rotation',async()=>{
    const key=encryptValue('synthetic-live-key'),secret=encryptValue('old-secret');
    await pool.query('UPDATE subscription_settings SET enforced=false');
    await pool.query('UPDATE admin_api_credentials SET api_key=$1,api_secret=$2,is_encrypted=true WHERE id=1',[key,secret]);
    await pool.query('INSERT INTO billing_subscriptions VALUES(1)');
    await updateAdminCredential(1,{apiSecret:'rotated-synthetic-secret'});
    const stored=(await pool.query('SELECT api_key,api_secret FROM admin_api_credentials WHERE id=1')).rows[0];
    expect(stored.api_key).toBe(key);expect(decryptValue(stored.api_secret)).toBe('rotated-synthetic-secret');
    expect((await getAdminCredentialById(1))?.apiKey).toBe('synthetic-live-key');
  });
  it('serializes a credential toggle behind enforcement and rejects it after the transition',async()=>{
    await pool.query('UPDATE subscription_settings SET enforced=false');
    const locker=await pool.connect();await locker.query('BEGIN');
    try {
      await locker.query('SELECT id FROM subscription_settings WHERE id=1 FOR UPDATE');
      const toggle=pool.query('UPDATE admin_api_credentials SET is_active=false WHERE id=1');
      // Attach rejection handler before releasing the lock; no unhandled promise.
      const result=toggle.then(()=>null,e=>e);
      await locker.query('UPDATE subscription_settings SET enforced=true WHERE id=1');await locker.query('COMMIT');
      expect(normalizeBillingCredentialError(await result)).toMatchObject({code:'BILLING_CREDENTIAL_ENFORCED'});
      expect((await pool.query('SELECT is_active FROM admin_api_credentials WHERE id=1')).rows[0].is_active).toBe(true);
    } finally {await locker.query('ROLLBACK');locker.release();}
  });
});
