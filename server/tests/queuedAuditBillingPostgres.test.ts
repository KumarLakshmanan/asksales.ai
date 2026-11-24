import { afterAll,beforeAll,beforeEach,describe,expect,it,jest } from '@jest/globals';
import crypto from 'node:crypto';
import { Pool } from 'pg';
import { drizzle,type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { withBusinessScope,currentBusinessScope } from '../tenancy/businessContext.js';
import { withBillingScope,currentBillingScope } from '../tenancy/billingContext.js';
import { calculateSubscriptionAccess } from '../../shared/subscriptions.js';

const suite = process.env.SUBSCRIPTIONS_LOCAL_QA === '1' ? describe : describe.skip;
let database: NodePgDatabase;
jest.unstable_mockModule('../models/db.js',()=>({db:new Proxy({}, {
  get(_target,key) {
    const value=database?.[key as keyof NodePgDatabase];
    return typeof value==='function' ? value.bind(database) : value;
  },
})}));
jest.unstable_mockModule('../services/dashboardCache.js',()=>({invalidateDashboardCache:async()=>{}}));
const { runBusinessJob }=await import('../tenancy/jobBusinessScope.js');
const { cancelUnstartedAuditForBilling,resumeCancelledAuditBilling,requireQueuedAuditSubscription }=await import('../services/aiVisibility/queuedAuditBilling.js');
const { creditService }=await import('../services/CreditService.js');
const { subscriptions }=await import('../services/subscriptions/service.js');

suite('prepaid audit cancellation after original organization membership is revoked',()=>{
  let pool:Pool,admin:Pool,schema:string;
  const payload={userId:2,businessProfileId:21,billingOrganizationId:10,billingActorUserId:2};
  const work=jest.fn<()=>Promise<void>>();
  const cleanup=async(scoped:typeof payload)=>{
    expect(currentBusinessScope()).toMatchObject({userId:2,businessProfileId:21});
    expect(currentBillingScope()).toEqual({organizationId:10,actorUserId:2});
    await cancelUnstartedAuditForBilling(scoped.userId,1,scoped.billingOrganizationId);
  };
  const run=()=>runBusinessJob(payload,work,scoped=>cleanup(scoped as typeof payload));
  const balances=async()=>Object.fromEntries((await pool.query('SELECT organization_id,balance FROM wallets ORDER BY organization_id')).rows.map(row=>[row.organization_id,Number(row.balance)]));

  beforeAll(async()=>{
    if(!['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST||'')) throw new Error('Queued-audit QA requires local PostgreSQL.');
    const config={host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME||process.env.DB_DATABASE,connectionTimeoutMillis:5000};
    admin=new Pool({...config,max:1}); schema=`queued_audit_qa_${crypto.randomBytes(8).toString('hex')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=new Pool({...config,max:6,options:`-c search_path=${schema},pg_catalog -c timezone=UTC`});
    database=drizzle(pool);
    await pool.query(`
      CREATE TABLE users(id integer PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE billing_organizations(id integer PRIMARY KEY,owner_user_id integer);
      CREATE TABLE billing_organization_memberships(organization_id integer,user_id integer,role text,status text);
      CREATE TABLE company_settings(id integer PRIMARY KEY,user_id integer,is_default boolean,billing_organization_id integer);
      CREATE TABLE wallets(id serial PRIMARY KEY,organization_id integer UNIQUE,user_id integer,balance numeric NOT NULL,total_credits_added numeric NOT NULL,total_credits_used numeric NOT NULL,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());
      CREATE TABLE wallet_transactions(id serial PRIMARY KEY,organization_id integer,actor_user_id integer,billing_business_profile_id integer,user_id integer,type text,amount numeric,balance_after numeric,description text,category text,reference_type text,reference_id text,payment_provider text,payment_id text,payment_order_id text,amount_paid numeric,currency text,metadata jsonb,created_at timestamp DEFAULT now());
      CREATE TABLE ai_visibility_audits(id integer PRIMARY KEY,user_id integer,business_profile_id integer,status text,started_at timestamp,settled_at timestamp,error text,billing_mode text,initial_charge_transaction_id integer,reservation_transaction_id integer,actual_credits numeric,reserved_credits numeric,cancellation_requested boolean DEFAULT false,completed_at timestamp,updated_at timestamp DEFAULT now());
      CREATE TABLE ai_visibility_audit_stages(id integer PRIMARY KEY,audit_id integer,user_id integer,business_profile_id integer,status text,error text,completed_at timestamp,updated_at timestamp DEFAULT now());
      INSERT INTO users VALUES(1,NULL),(2,NULL);
      INSERT INTO billing_organizations VALUES(10,1),(20,2);
      INSERT INTO billing_organization_memberships VALUES(10,1,'owner','active'),(10,2,'member','revoked'),(20,2,'owner','active');
      -- This business has moved to organization 20; its queued charge remains in 10.
      INSERT INTO company_settings VALUES(21,2,true,20),(22,2,false,20);
    `);
  });
  afterAll(async()=>{jest.restoreAllMocks();await pool?.end();if(admin&&schema)await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin?.end();});
  beforeEach(async()=>{
    work.mockClear();
    await pool.query("UPDATE billing_organization_memberships SET status='revoked' WHERE organization_id=10 AND user_id=2");
    await pool.query(`TRUNCATE wallets,wallet_transactions,ai_visibility_audits,ai_visibility_audit_stages RESTART IDENTITY;
      INSERT INTO wallets(organization_id,user_id,balance,total_credits_added,total_credits_used) VALUES(10,1,900,1000,100),(20,2,777,777,0);
      INSERT INTO wallet_transactions(organization_id,actor_user_id,billing_business_profile_id,user_id,type,amount,balance_after,description,reference_type,reference_id)
        VALUES(10,2,21,2,'deduction',-100,900,'Prepaid audit','ai_visibility_audit','1');
      INSERT INTO ai_visibility_audits(id,user_id,business_profile_id,status,billing_mode,initial_charge_transaction_id,actual_credits,reserved_credits)
        VALUES(1,2,21,'queued','direct',1,100,0);
      INSERT INTO ai_visibility_audit_stages(id,audit_id,user_id,business_profile_id,status) VALUES(1,1,2,21,'pending');
    `);
  });

  it('blocks execution and refunds only the original organization, once under concurrent retries',async()=>{
    const results=await Promise.allSettled([run(),run(),run()]);
    for(const result of results) expect(result).toMatchObject({status:'rejected',reason:{code:'ORGANIZATION_FORBIDDEN'}});
    expect(work).not.toHaveBeenCalled();
    expect(await balances()).toEqual({10:1000,20:777});
    const audit=(await pool.query('SELECT * FROM ai_visibility_audits WHERE id=1')).rows[0];
    expect(audit).toMatchObject({status:'cancelled',actual_credits:'0',cancellation_requested:true,started_at:null});
    expect(audit.settled_at).not.toBeNull();
    expect((await pool.query("SELECT organization_id,user_id,actor_user_id,billing_business_profile_id FROM wallet_transactions WHERE type='refund'")).rows)
      .toEqual([{organization_id:10,user_id:2,actor_user_id:2,billing_business_profile_id:21}]);
    expect((await pool.query('SELECT status FROM ai_visibility_audit_stages')).rows).toEqual([{status:'cancelled'}]);
  });

  it('also releases a legacy reservation to its recorded organization',async()=>{
    await pool.query("UPDATE ai_visibility_audits SET billing_mode='reservation',reservation_transaction_id=1,initial_charge_transaction_id=NULL,reserved_credits=100,actual_credits=0");
    await expect(run()).rejects.toMatchObject({code:'ORGANIZATION_FORBIDDEN'});
    expect(await balances()).toEqual({10:1000,20:777});
    expect((await pool.query("SELECT reference_type FROM wallet_transactions WHERE type='refund'")).rows).toEqual([{reference_type:'credit_reservation'}]);
  });

  it('cancels and refunds an audit once when its subscription expires before the worker gate',async()=>{
    await pool.query("UPDATE billing_organization_memberships SET status='active' WHERE organization_id=10 AND user_id=2");
    const expired=calculateSubscriptionAccess({enforced:true,launchedAt:new Date('2026-09-01'),userCreatedAt:new Date('2026-09-10'),
      paidFrom:new Date('2026-09-01'),paidThrough:new Date('2026-10-01')},new Date('2026-11-01'));
    expect(expired.allowed).toBe(false);
    const access=jest.spyOn(subscriptions,'access').mockResolvedValue(expired);
    try {
      const gatedRun=()=>runBusinessJob(payload,async scoped=>{
        await requireQueuedAuditSubscription(Number(scoped.userId),1,Number(scoped.billingOrganizationId));
        await work();
      });
      const results=await Promise.allSettled([gatedRun(),gatedRun()]);
      for(const result of results) expect(result).toMatchObject({status:'rejected',reason:{status:402,code:'SUBSCRIPTION_REQUIRED'}});
      expect(work).not.toHaveBeenCalled();
      expect(await balances()).toEqual({10:1000,20:777});
      expect((await pool.query("SELECT organization_id,count(*)::int count FROM wallet_transactions WHERE type='refund' GROUP BY organization_id")).rows)
        .toEqual([{organization_id:10,count:1}]);
      const audit=(await pool.query('SELECT status,settled_at,error FROM ai_visibility_audits WHERE id=1')).rows[0];
      expect(audit.status).toBe('cancelled');expect(audit.settled_at).not.toBeNull();expect(audit.error).toMatch(/subscription access/);
    } finally { access.mockRestore(); }
  });

  it.each(['running','completed','failed'])('does not refund an audit that already started (%s)',async status=>{
    await pool.query('UPDATE ai_visibility_audits SET status=$1,started_at=now()',[status]);
    await expect(run()).rejects.toMatchObject({code:'ORGANIZATION_FORBIDDEN'});
    expect(await balances()).toEqual({10:900,20:777});
    expect((await pool.query('SELECT status FROM ai_visibility_audits')).rows).toEqual([{status}]);
  });

  it('preserves the business boundary while cleaning up an original-wallet charge',async()=>{
    await pool.query('UPDATE ai_visibility_audits SET business_profile_id=22');
    await expect(run()).rejects.toMatchObject({code:'ORGANIZATION_FORBIDDEN'});
    expect(await balances()).toEqual({10:900,20:777});
    expect((await pool.query('SELECT status FROM ai_visibility_audits')).rows).toEqual([{status:'queued'}]);
    await expect(cancelUnstartedAuditForBilling(2,1,10)).rejects.toThrow(/business scope/);
  });

  it('rejects a mismatched original payer before cancelling or refunding anything',async()=>{
    await expect(withBusinessScope({userId:2,businessProfileId:21},()=>withBillingScope({organizationId:20,actorUserId:2},()=>cancelUnstartedAuditForBilling(2,1,20))))
      .rejects.toThrow(/original billing transaction/);
    expect(await balances()).toEqual({10:900,20:777});
    expect((await pool.query('SELECT status FROM ai_visibility_audits')).rows).toEqual([{status:'queued'}]);
  });

  it('retries a failed refund from durable cancellation without executing paid work',async()=>{
    const original=creditService.refundDeduction.bind(creditService);
    const refund=jest.spyOn(creditService,'refundDeduction').mockResolvedValueOnce({success:false,creditsRefunded:0,balanceAfter:900,error:'Temporary refund failure'}).mockImplementation(original);
    await expect(run()).rejects.toThrow('Temporary refund failure');
    expect((await pool.query('SELECT status,settled_at FROM ai_visibility_audits')).rows).toEqual([{status:'cancelled',settled_at:null}]);
    expect(await balances()).toEqual({10:900,20:777});
    await expect(run()).rejects.toMatchObject({code:'ORGANIZATION_FORBIDDEN'});
    expect(await balances()).toEqual({10:1000,20:777});
    expect(work).not.toHaveBeenCalled();
    refund.mockRestore();
  });

  it('finishes a pending refund even if organization access is restored before retry',async()=>{
    const original=creditService.refundDeduction.bind(creditService);
    const refund=jest.spyOn(creditService,'refundDeduction').mockResolvedValueOnce({success:false,creditsRefunded:0,balanceAfter:900,error:'Temporary refund failure'}).mockImplementation(original);
    await expect(run()).rejects.toThrow('Temporary refund failure');
    await pool.query("UPDATE billing_organization_memberships SET status='active' WHERE organization_id=10 AND user_id=2");
    await runBusinessJob(payload,async scoped=>resumeCancelledAuditBilling(Number(scoped.userId),1,Number(scoped.billingOrganizationId)));
    expect(await balances()).toEqual({10:1000,20:777});
    expect((await pool.query('SELECT settled_at IS NOT NULL AS settled FROM ai_visibility_audits')).rows).toEqual([{settled:true}]);
    refund.mockRestore();
  });

  it('does not cancel fresh authorized work while checking for an interrupted refund',async()=>{
    await pool.query("UPDATE billing_organization_memberships SET status='active' WHERE organization_id=10 AND user_id=2");
    const resumed=await runBusinessJob(payload,async scoped=>resumeCancelledAuditBilling(Number(scoped.userId),1,Number(scoped.billingOrganizationId)));
    expect(resumed).toBe(false);
    expect(await balances()).toEqual({10:900,20:777});
    expect((await pool.query('SELECT status FROM ai_visibility_audits')).rows).toEqual([{status:'queued'}]);
  });
});
