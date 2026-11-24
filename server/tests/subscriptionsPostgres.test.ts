import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { SubscriptionService, type SubscriptionDatabase } from '../services/subscriptions/service.js';
import { assignAdminPlan, revokeAdminPlan } from '../services/subscriptions/adminPlans.js';
import { latestVerifiedLiveWebhook } from '../services/subscriptions/admin.js';
import { RazorpaySubscriptionGateway, SubscriptionError, type ProviderSubscription, type ProviderPayment, type ProviderInvoice } from '../services/subscriptions/gateway.js';
import { SUBSCRIPTION_PLANS, addCalendarMonths, planAmountPaise, type BillingTerm } from '../../shared/subscriptions.js';
import { withBillingScope } from '../tenancy/billingContext.js';

const suite = process.env.SUBSCRIPTIONS_LOCAL_QA === '1' ? describe : describe.skip;
class FakeRazorpay extends RazorpaySubscriptionGateway {
  subs = new Map<string, ProviderSubscription>();
  payments = new Map<string, ProviderPayment>();
  bills = new Map<string, ProviderInvoice>();
  cancelCalls: { id: string; atCycleEnd: boolean }[] = [];
  createCalls = 0;
  uncertainCreate = false;
  constructor(mode = 'live') { super(1,`rzp_${mode}_fixture`,'fixture-secret','fixture-webhook-secret'); }
  override async createSubscription(localId: string, userId: number, planId: string, _term: BillingTerm, startsAt: Date | null, organizationId?: number) {
    const id = `sub_fixture${++this.createCalls}`;
    const sub: ProviderSubscription = {id,plan_id:planId,status:'created',quantity:1,start_at:startsAt ? startsAt.getTime()/1000 : null,current_start:null,current_end:null,notes:{asksales_subscription_id:localId,asksales_user_id:String(userId),...(organizationId ? {asksales_organization_id:String(organizationId)} : {})}};
    this.subs.set(id,sub);
    if (this.uncertainCreate) throw new SubscriptionError('Uncertain create',503,'PROVIDER_UNCERTAIN');
    return sub;
  }
  override async recoverCreation(localId: string) { return [...this.subs.values()].find(sub => sub.notes.asksales_subscription_id===localId) || null; }
  override async getSubscription(id: string) { return structuredClone(this.subs.get(id)!); }
  override async getPayment(id: string) { return structuredClone(this.payments.get(id)!); }
  override async getInvoice(id: string) { return structuredClone(this.bills.get(id)!); }
  override async invoices(id: string) { return [...this.bills.values()].filter(invoice => invoice.subscription_id===id).map(invoice => structuredClone(invoice)); }
  override async cancel(id: string,atCycleEnd: boolean) { this.cancelCalls.push({id,atCycleEnd}); if (!atCycleEnd) this.subs.get(id)!.status='cancelled'; return this.getSubscription(id); }
  charge(id: string, term: BillingTerm, start: Date, slug = 'starter', amountPaise?: number) {
    const sub = this.subs.get(id)!;
    const key = this.payments.size + 1;
    const paymentId = `pay_fixture${key}`; const invoiceId = `inv_fixture${key}`; const orderId = `order_fixture${key}`;
    const amount = amountPaise ?? planAmountPaise(SUBSCRIPTION_PLANS.find(p=>p.slug===slug)!,term);
    sub.status='active'; sub.payment_method='upi'; sub.current_start=start.getTime()/1000; sub.current_end=addCalendarMonths(start,term==='yearly'?12:1).getTime()/1000;
    this.payments.set(paymentId,{id:paymentId,invoice_id:invoiceId,order_id:orderId,amount,currency:'INR',status:'captured',captured:true,method:'upi',amount_refunded:0});
    this.bills.set(invoiceId,{id:invoiceId,subscription_id:id,payment_id:paymentId,order_id:orderId,status:'paid',currency:'INR',amount,amount_paid:amount,amount_due:0,tax_amount:0,billing_start:sub.current_start,billing_end:sub.current_end,paid_at:sub.current_start,short_url:'https://rzp.io/i/fixture',line_items:[{type:'plan',amount,quantity:1}]});
    return {paymentId,signature:crypto.createHmac('sha256','fixture-secret').update(`${paymentId}|${id}`).digest('hex')};
  }
}

suite('subscription ledger with isolated PostgreSQL and fake Razorpay', () => {
  let pool: Pool; let admin: Pool; let schema: string; let service: SubscriptionService; let gateway: FakeRazorpay;
  const organizations = new Map<number, number>();
  let now = new Date('2026-10-01T00:00:00Z');
  beforeAll(async () => {
    // Explicit QA connection variables win over local development configuration.
    dotenv.config({path:'.env.development',quiet:true}); dotenv.config({path:'.env',quiet:true});
    if (!['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST || '')) throw new Error('Subscription QA requires local PostgreSQL.');
    const config={host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME||process.env.DB_DATABASE,connectionTimeoutMillis:5000};
    admin=new Pool({...config,max:1}); schema=`subscriptions_qa_${crypto.randomBytes(8).toString('hex')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool=new Pool({...config,max:6,options:`-c search_path=${schema},pg_catalog -c timezone=UTC`});
    await pool.query(`CREATE TABLE users(id integer PRIMARY KEY,email text UNIQUE NOT NULL,name varchar(255) NOT NULL,created_at timestamp NOT NULL,is_approved boolean NOT NULL,is_setup_complete boolean NOT NULL,is_verified boolean NOT NULL DEFAULT true,deleted_at timestamptz);
      CREATE TABLE admins(id integer PRIMARY KEY); CREATE TABLE admin_api_credentials(id integer PRIMARY KEY);
      INSERT INTO admins VALUES(1); INSERT INTO admin_api_credentials VALUES(1);
      INSERT INTO users(id,email,name,created_at,is_approved,is_setup_complete) VALUES
        (1,'owner@example.test','Owner','2026-09-10',true,true),(2,'member@example.test','Member','2026-09-10',true,true),(3,'pending@example.test','Pending','2026-09-10',false,false);
      CREATE TABLE wallets(id serial PRIMARY KEY,user_id integer UNIQUE REFERENCES users(id),balance numeric(12,2) NOT NULL DEFAULT 0,total_credits_added numeric(12,2) NOT NULL DEFAULT 0,total_credits_used numeric(12,2) NOT NULL DEFAULT 0,updated_at timestamptz DEFAULT now());
      CREATE TABLE wallet_transactions(id serial PRIMARY KEY,user_id integer,type text,amount numeric,balance_after numeric,description text,category text,reference_type text,reference_id text,payment_provider text,payment_id text,currency text,metadata jsonb);
      CREATE TABLE wallet_recharge_claims(id serial PRIMARY KEY,user_id integer NOT NULL REFERENCES users(id));
      CREATE TABLE credit_event_logs(id serial PRIMARY KEY,user_id integer NOT NULL REFERENCES users(id),business_profile_id integer);
      CREATE TABLE company_settings(id serial PRIMARY KEY,user_id integer NOT NULL REFERENCES users(id),name text,updated_at timestamptz DEFAULT now());
      CREATE TABLE ai_visibility_workspaces(id serial PRIMARY KEY,owner_user_id integer NOT NULL REFERENCES users(id),name text,status text DEFAULT 'active',updated_at timestamptz DEFAULT now());
      CREATE TABLE ai_visibility_projects(id serial PRIMARY KEY,user_id integer NOT NULL REFERENCES users(id),business_profile_id integer REFERENCES company_settings(id),workspace_id integer REFERENCES ai_visibility_workspaces(id));
      CREATE TABLE business_scope_accounts(table_name text PRIMARY KEY);
      CREATE FUNCTION app_business_profile_id() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.business_profile_id',true),'')::integer $$;`);
    // @ts-expect-error migrations are JavaScript modules.
    const migration = await import('../migrations/298_pricing_subscriptions.js');
    await migration.up(pool);
    // Exercise the actual organization and catalog migrations. Capacity has its
    // own runtime/RLS suite; this fixture exposes only static entitlement data.
    // @ts-expect-error migrations are JavaScript modules.
    const organizationMigration = await import('../migrations/300_billing_organizations.js');
    // @ts-expect-error migrations are JavaScript modules.
    const catalogMigration = await import('../migrations/301_organization_subscription_catalog.js');
    // @ts-expect-error migrations are JavaScript modules.
    const refundMigration = await import('../migrations/303_subscription_refund_evidence.js');
    // @ts-expect-error migrations are JavaScript modules.
    const adminPlanMigration = await import('../migrations/308_admin_plan_assignments.js');
    await organizationMigration.up(pool);
    await catalogMigration.up(pool);
    await refundMigration.up(pool);
    await adminPlanMigration.up(pool);
    await pool.query(`CREATE FUNCTION billing_capacity_authorize(org integer) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
      CREATE FUNCTION billing_organization_entitlements(org integer) RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM billing_organizations WHERE id=org) THEN RAISE EXCEPTION 'Organization unavailable' USING ERRCODE='42501'; END IF;
        RETURN '{"limits":{},"usage":{},"enforced":false,"catalogVersion":2}'::jsonb;
      END $$;
      UPDATE subscription_catalogs SET status=CASE WHEN version=2 THEN 'published' ELSE 'retired' END;
      UPDATE subscription_settings SET published_catalog_version=2;`);
    for(const row of (await pool.query('SELECT id,default_for_user_id FROM billing_organizations')).rows) organizations.set(row.default_for_user_id,row.id);
    for(const row of (await pool.query('SELECT version,slug FROM subscription_plans')).rows) for(const term of ['monthly','yearly']) {
      await pool.query('INSERT INTO subscription_provider_plans(credential_id,version,slug,term,provider_plan_id) VALUES(1,$1,$2,$3,$4)',[row.version,row.slug,term,`plan_v${row.version}_${row.slug}${term}`]);
    }
    jest.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw new Error('Network denied in subscription fixture');});
  },30000);
  afterAll(async()=>{jest.restoreAllMocks(); await pool?.end(); if(admin&&schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin?.end();});
  beforeEach(async()=>{
    await pool.query('TRUNCATE billing_admin_plan_credit_grants,billing_admin_plan_terms,subscription_credit_grants,subscription_charges,subscription_accounts,subscription_webhook_events,billing_subscriptions,subscription_audit,wallet_transactions,wallets RESTART IDENTITY CASCADE');
    await pool.query("DELETE FROM billing_organization_memberships WHERE role<>'owner'");
    await pool.query("UPDATE subscription_settings SET enforced=true,launched_at='2026-09-01',credential_id=1,published_catalog_version=2");
    now=new Date('2026-10-01T00:00:00Z'); gateway=new FakeRazorpay();
    service=new SubscriptionService(drizzle(pool) as unknown as SubscriptionDatabase, async()=>gateway,()=>now);
  });
  async function paid(term: BillingTerm='monthly') {
    const checkout=await service.start(1,'starter',term,2);
    const claim=gateway.charge(checkout.subscriptionId,term,now);
    await service.verify(1,checkout.subscriptionId,claim.paymentId,claim.signature);
    return {checkout,claim};
  }
  async function balance(userId=1) { return Number((await pool.query('SELECT balance FROM wallets WHERE organization_id=$1',[organizations.get(userId)])).rows[0]?.balance || 0); }
  async function webhookEvent(event:string,payload:Record<string,unknown>,eventId:string) {
    const raw=Buffer.from(JSON.stringify({event,payload}));
    const signature=crypto.createHmac('sha256','fixture-webhook-secret').update(raw).digest('hex');
    return service.webhook(1,raw,signature,eventId);
  }
  function providerRefund(paymentId:string,amountPaise:number) {
    const payment=gateway.payments.get(paymentId)!;
    payment.amount_refunded=amountPaise;
    payment.status=amountPaise===payment.amount?'refunded':'captured';
  }

  it('matches database catalog to the published UI catalog',async()=>{
    for(const plan of SUBSCRIPTION_PLANS) {
      const row=(await pool.query('SELECT * FROM subscription_plans WHERE version=2 AND slug=$1',[plan.slug])).rows[0];
      expect([row.monthly_amount_paise,row.yearly_amount_paise,row.monthly_credits]).toEqual([planAmountPaise(plan,'monthly'),planAmountPaise(plan,'yearly'),plan.monthlyCredits]);
    }
  });
  it('deposits administrator plan credits once per month without a provider charge',async()=>{
    const organizationId=organizations.get(1)!;
    const termId=crypto.randomUUID();
    const end=addCalendarMonths(now,12);
    await pool.query(`INSERT INTO billing_admin_plan_terms
      (id,organization_id,admin_id,version,slug,term,starts_at,ends_at,reason)
      VALUES($1,$2,1,2,'growth','yearly',$3,$4,'Reviewed complimentary plan')`,
      [termId,organizationId,now,end]);
    for(let month=0;month<12;month++) await pool.query(`INSERT INTO billing_admin_plan_credit_grants
      (term_id,month_index,due_at,credits) VALUES($1,$2,$3,15000)`,
      [termId,month,addCalendarMonths(now,month)]);
    await Promise.all([service.grantAdminDueCredits(organizationId),service.grantAdminDueCredits(organizationId)]);
    expect(await balance()).toBe(15000);
    expect((await pool.query("SELECT count(*) FROM wallet_transactions WHERE reference_type='admin_plan_grant'")).rows[0].count).toBe('1');
    expect(await service.access(1)).toMatchObject({reason:'admin_grant',allowed:true,canTopUp:true});
    expect((await service.state(1)).subscription).toMatchObject({source:'admin',plan:'growth',term:'yearly',paymentMethod:null});
    expect((await pool.query('SELECT count(*) FROM subscription_charges')).rows[0].count).toBe('0');
    now=addCalendarMonths(now,2);
    await Promise.all([service.grantAdminDueCredits(organizationId),service.grantAdminDueCredits(organizationId)]);
    expect(await balance()).toBe(45000);
    await pool.query('UPDATE billing_admin_plan_terms SET cancelled_at=$2 WHERE id=$1',[termId,now]);
    await pool.query('UPDATE billing_admin_plan_credit_grants SET cancelled_at=$2 WHERE term_id=$1 AND granted_at IS NULL',[termId,now]);
    now=addCalendarMonths(now,3);
    await service.grantAdminDueCredits(organizationId);
    expect(await balance()).toBe(45000);
  });
  it('catches up a credit deposit due before an administrator plan ended',async()=>{
    const organizationId=organizations.get(1)!;
    const started=addCalendarMonths(now,-2);
    const ended=addCalendarMonths(now,-1);
    const cancelled=new Date(started.getTime()+24*60*60*1000);
    const termId=crypto.randomUUID();
    await pool.query(`INSERT INTO billing_admin_plan_terms
      (id,organization_id,admin_id,version,slug,term,starts_at,ends_at,cancelled_at,reason)
      VALUES($1,$2,1,2,'starter','monthly',$3,$4,$5,'Past due credit reconciliation')`,
      [termId,organizationId,started,ended,cancelled]);
    await pool.query(`INSERT INTO billing_admin_plan_credit_grants(term_id,month_index,due_at,credits)
      VALUES($1,0,$2,5000)`, [termId,started]);
    expect(await service.grantAdminDueCredits()).toBe(1);
    expect(await balance()).toBe(5000);
    expect(await service.grantAdminDueCredits()).toBe(0);
  });
  it('assigns, downgrades and ends a complimentary plan with durable audit evidence',async()=>{
    const organizationId=organizations.get(1)!;
    const assigned=await assignAdminPlan(1,organizationId,{
      catalogVersion:2,plan:'growth',term:'yearly',timing:'now',reason:'Approved launch grant',
    },service.database,service);
    expect(assigned.current).toMatchObject({source:'admin',plan:'growth'});
    expect(await balance()).toBe(15000);
    const downgraded=await assignAdminPlan(1,organizationId,{
      catalogVersion:2,plan:'starter',term:'monthly',timing:'now',reason:'Customer requested a smaller plan',
    },service.database,service);
    expect(downgraded.current).toMatchObject({source:'admin',plan:'starter'});
    expect(await balance()).toBe(20000);
    expect((await pool.query('SELECT count(*) FROM billing_admin_plan_credit_grants WHERE cancelled_at IS NOT NULL')).rows[0].count).toBe('11');
    await revokeAdminPlan(1,organizationId,'active','Complimentary period ended',service.database,service);
    expect(await balance()).toBe(20000);
    expect((await pool.query("SELECT action FROM subscription_audit WHERE organization_id=$1 AND action LIKE 'admin_plan_%' ORDER BY id",[organizationId])).rows.map(row=>row.action))
      .toEqual(['admin_plan_assigned','admin_plan_assigned','admin_plan_ended']);
    expect((await pool.query('SELECT count(*) FROM subscription_charges')).rows[0].count).toBe('0');
  });
  it('uses an administrator assignment for capacity limits',async()=>{
    const organizationId=organizations.get(1)!;
    await pool.query(`INSERT INTO billing_admin_plan_terms
      (id,organization_id,admin_id,version,slug,term,starts_at,ends_at,reason)
      VALUES($1,$2,1,2,'growth','monthly',now()-interval '1 minute',now()+interval '1 month','Capacity QA')`,
      [crypto.randomUUID(),organizationId]);
    expect((await pool.query('SELECT billing_capacity_plan($1) AS plan',[organizationId])).rows[0].plan)
      .toMatchObject({catalogVersion:2,planSlug:'growth',limits:{businessProfiles:5}});
  });
  it('schedules an admin plan after a verified paid term and stops mandate renewal',async()=>{
    const organizationId=organizations.get(1)!;
    const {checkout}=await paid();
    await expect(assignAdminPlan(1,organizationId,{
      catalogVersion:2,plan:'growth',term:'monthly',timing:'now',reason:'Reviewed request',
    },service.database,service)).rejects.toMatchObject({code:'PAID_TERM_ACTIVE'});
    const scheduled=await assignAdminPlan(1,organizationId,{
      catalogVersion:2,plan:'growth',term:'monthly',timing:'at_term_end',reason:'Reviewed request',
    },service.database,service);
    expect(scheduled.pending).toMatchObject({source:'admin',plan:'growth',status:'scheduled'});
    expect(scheduled.current).toMatchObject({source:'razorpay',plan:'starter'});
    expect(scheduled.adminTerms[0].startsAt).toBe(addCalendarMonths(now,1).toISOString());
    expect(gateway.cancelCalls).toEqual([{id:checkout.subscriptionId,atCycleEnd:true}]);
    expect(await balance()).toBe(5000);
  });
  it('requires approval and isolates checkout verification by account',async()=>{
    await expect(service.start(3,'starter','monthly',2)).rejects.toMatchObject({status:403});
    const {checkout,claim}=await paid();
    await expect(service.verify(2,checkout.subscriptionId,claim.paymentId,claim.signature)).rejects.toMatchObject({status:404});
    expect(await balance()).toBe(5000);
  });
  it('rejects stale prices before creating a payment mandate',async()=>{
    await expect(service.start(1,'starter','monthly',1)).rejects.toMatchObject({status:409,code:'CATALOG_CHANGED'});
    expect(gateway.createCalls).toBe(0);
    expect((await pool.query('SELECT id FROM billing_subscriptions')).rowCount).toBe(0);
  });
  it('keeps legacy billing membership from granting business access',async()=>{
    const organizationId=organizations.get(1)!;
    await pool.query("INSERT INTO billing_organization_memberships(organization_id,user_id,email,role,status) VALUES($1,2,'member@example.test','member','active')",[organizationId]);
    await expect(withBillingScope({organizationId,actorUserId:2},()=>service.start(2,'starter','monthly',2)))
      .rejects.toMatchObject({status:403,code:'ORGANIZATION_FORBIDDEN'});
    await pool.query("UPDATE billing_organization_memberships SET role='billing_admin' WHERE organization_id=$1 AND user_id=2",[organizationId]);
    await expect(withBillingScope({organizationId,actorUserId:2},()=>service.start(2,'starter','monthly',2)))
      .rejects.toMatchObject({status:403,code:'ORGANIZATION_FORBIDDEN'});
    const checkout=await service.start(1,'starter','monthly',2);
    expect(gateway.subs.get(checkout.subscriptionId)?.notes).toMatchObject({asksales_user_id:'1',asksales_organization_id:String(organizationId)});
    const claim=gateway.charge(checkout.subscriptionId,'monthly',now);
    await service.verify(1,checkout.subscriptionId,claim.paymentId,claim.signature);
    expect(await balance(1)).toBe(5000);
    expect(await balance(2)).toBe(0);
    expect((await pool.query('SELECT user_id,organization_id FROM subscription_charges')).rows).toEqual([{user_id:1,organization_id:organizationId}]);
    await expect(service.verify(2,checkout.subscriptionId,claim.paymentId,claim.signature)).rejects.toMatchObject({status:404});
  });
  it('preserves a legacy mandate without organization notes and its original credit price',async()=>{
    const localId=crypto.randomUUID(),organizationId=organizations.get(1)!;
    const provider=await gateway.createSubscription(localId,1,'plan_v1_startermonthly','monthly',null);
    await pool.query(`INSERT INTO billing_subscriptions(id,user_id,organization_id,organization_bound,credential_id,mode,version,slug,term,provider_plan_id,provider_id,status)
      VALUES($1,1,$2,false,1,'live',1,'starter','monthly','plan_v1_startermonthly',$3,'created')`,[localId,organizationId,provider.id]);
    await pool.query('INSERT INTO subscription_accounts(user_id,organization_id,current_subscription_id) VALUES(1,$1,$2)',[organizationId,localId]);
    const claim=gateway.charge(provider.id,'monthly',now,'starter',10000);
    await service.verify(1,provider.id,claim.paymentId,claim.signature);
    expect(await balance()).toBe(1000);
    expect((await service.state(1)).subscription).toMatchObject({version:1,plan:'starter'});
    expect((await pool.query('SELECT monthly_credits FROM subscription_charges')).rows).toEqual([{monthly_credits:1000}]);
  });
  it('rejects an organization-bound mandate whose provider ownership notes changed',async()=>{
    const checkout=await service.start(1,'starter','monthly',2);
    const claim=gateway.charge(checkout.subscriptionId,'monthly',now);
    gateway.subs.get(checkout.subscriptionId)!.notes.asksales_organization_id=String(organizations.get(2));
    await expect(service.verify(1,checkout.subscriptionId,claim.paymentId,claim.signature)).rejects.toMatchObject({code:'CHARGE_MISMATCH'});
    expect(await balance()).toBe(0);
  });
  it('does not allow changing or appending rows in a published catalog',async()=>{
    await expect(pool.query("UPDATE subscription_plans SET monthly_credits=1 WHERE version=2 AND slug='starter'"))
      .rejects.toMatchObject({code:'23514'});
    await expect(pool.query("INSERT INTO subscription_plans(version,slug,name,monthly_amount_paise,yearly_amount_paise,monthly_credits) VALUES(2,'injected','Injected',100,1000,10)"))
      .rejects.toMatchObject({code:'23514'});
  });
  it('requires a processed event for a managed live subscription before launch',async()=>{
    const {checkout}=await paid();
    await pool.query(`INSERT INTO subscription_webhook_events
      (credential_id,event_id,event_type,body_hash,provider_subscription_id,received_at,processed_at)
      VALUES(1,'evt_launch','subscription.charged','fixture',$1,$2,NULL)`,[checkout.subscriptionId,now]);
    expect(await latestVerifiedLiveWebhook(service.database,1,now)).toBeNull();
    await pool.query("UPDATE subscription_webhook_events SET processed_at=received_at");
    expect((await latestVerifiedLiveWebhook(service.database,1,now))?.received_at.toISOString()).toBe(now.toISOString());
    await pool.query("UPDATE billing_subscriptions SET mode='test'");
    expect(await latestVerifiedLiveWebhook(service.database,1,now)).toBeNull();
    await pool.query("UPDATE billing_subscriptions SET mode='live'");
    await pool.query("UPDATE subscription_webhook_events SET provider_subscription_id='sub_unmanaged'");
    expect(await latestVerifiedLiveWebhook(service.database,1,now)).toBeNull();
  });
  it('requires fresh webhook delivery after the credential or secret changes',async()=>{
    const {checkout}=await paid();
    await pool.query(`INSERT INTO subscription_webhook_events
      (credential_id,event_id,event_type,body_hash,provider_subscription_id,received_at,processed_at)
      VALUES(1,'evt_before_rotation','subscription.charged','fixture',$1,$2,$2)`,[checkout.subscriptionId,now]);
    const changedAt=new Date(now.getTime()+1000);
    expect(await latestVerifiedLiveWebhook(service.database,1,changedAt)).toBeNull();
    const deliveredAt=new Date(changedAt.getTime()+1000);
    await pool.query(`INSERT INTO subscription_webhook_events
      (credential_id,event_id,event_type,body_hash,provider_subscription_id,received_at,processed_at)
      VALUES(1,'evt_after_rotation','subscription.charged','fixture-new',$1,$2,$2)`,[checkout.subscriptionId,deliveredAt]);
    expect((await latestVerifiedLiveWebhook(service.database,1,changedAt))?.received_at.toISOString()).toBe(deliveredAt.toISOString());
  });
  it.each(['monthly','yearly'] as const)('grants %s deposits once under concurrent verify, cron and webhook replays',async term=>{
    const {checkout,claim}=await paid(term);
    const raw=Buffer.from(JSON.stringify({event:'subscription.charged',payload:{subscription:{entity:gateway.subs.get(checkout.subscriptionId)},payment:{entity:{id:claim.paymentId}}}}));
    const signature=crypto.createHmac('sha256','fixture-webhook-secret').update(raw).digest('hex');
    await Promise.all([service.verify(1,checkout.subscriptionId,claim.paymentId,claim.signature),service.webhook(1,raw,signature,'evt_fixture'),service.webhook(1,raw,signature,'evt_fixture'),service.grantDueCredits()]);
    expect(await balance()).toBe(5000);
    expect((await pool.query('SELECT * FROM wallet_transactions')).rowCount).toBe(1);
    expect((await service.state(1)).access.reason).toBe('paid');
  });
  it('deposits annual credits monthly after cancellation and retains the wallet after access ends',async()=>{
    await paid('yearly'); expect(await balance()).toBe(5000);
    await service.cancel(1); expect(gateway.cancelCalls[0].atCycleEnd).toBe(true);
    now=new Date('2027-03-01T00:00:00Z'); await Promise.all([service.grantDueCredits(),service.grantDueCredits()]);
    expect(await balance()).toBe(30000);
    now=new Date('2027-10-01T00:00:00Z'); await service.grantDueCredits();
    expect(await balance()).toBe(60000); expect((await service.access(1)).allowed).toBe(false);
  });
  it.each([{label:'partial',amount:10000},{label:'full',amount:480000}])('retains deposited rollover and cancels future annual grants after a $label refund',async({amount})=>{
    const {claim}=await paid('yearly');
    now=new Date('2026-11-01T00:00:00Z');await service.grantDueCredits();
    expect(await balance()).toBe(10000);
    providerRefund(claim.paymentId,amount);
    const payload={refund:{entity:{id:'rfnd_fixture',payment_id:claim.paymentId,status:'processed'}}};
    await webhookEvent('refund.processed',payload,'evt_refund');
    await Promise.all([webhookEvent('refund.processed',payload,'evt_refund'),webhookEvent('refund.processed',payload,'evt_refund_duplicate')]);
    expect((await service.access(1)).allowed).toBe(false);
    const state=await service.state(1);
    expect(state.nextDepositAt).toBeNull();expect(state.subscription?.paidThrough).toBeNull();
    expect(state.charges[0]).toMatchObject({refundAmountPaise:amount,refundObservedAt:now.toISOString()});
    expect((await pool.query('SELECT count(*) FILTER (WHERE granted_at IS NOT NULL)::int granted,count(*) FILTER (WHERE cancelled_at IS NOT NULL)::int cancelled FROM subscription_credit_grants')).rows)
      .toEqual([{granted:2,cancelled:10}]);
    now=new Date('2027-10-01T00:00:00Z');await Promise.all([service.grantDueCredits(),service.grantDueCredits()]);
    expect(await balance()).toBe(10000);
    expect((await pool.query("SELECT * FROM subscription_audit WHERE action='subscription_refund_reconciled'")).rowCount).toBe(1);
    expect((await pool.query('SELECT * FROM wallet_transactions')).rowCount).toBe(2);
  });
  it('recovers a refund-only webhook through the provider invoice before a charge was recorded',async()=>{
    const checkout=await service.start(1,'starter','yearly',2);
    const claim=gateway.charge(checkout.subscriptionId,'yearly',now);
    providerRefund(claim.paymentId,480000);
    await webhookEvent('refund.processed',{refund:{entity:{payment_id:claim.paymentId,status:'processed'}}},'evt_early_refund');
    expect(await balance()).toBe(0);expect((await service.access(1)).allowed).toBe(false);
    expect((await pool.query('SELECT refund_amount_paise FROM subscription_charges')).rows).toEqual([{refund_amount_paise:480000}]);
    expect((await pool.query('SELECT count(*)::int count FROM subscription_credit_grants WHERE cancelled_at IS NOT NULL')).rows).toEqual([{count:12}]);
    expect((await pool.query('SELECT provider_subscription_id,processed_at IS NOT NULL AS processed FROM subscription_webhook_events')).rows)
      .toEqual([{provider_subscription_id:checkout.subscriptionId,processed:true}]);
  });
  it('recognizes payment-only refund events and never reduces previously recorded refund evidence',async()=>{
    const {claim}=await paid('yearly');
    providerRefund(claim.paymentId,10000);
    await webhookEvent('payment.refunded',{payment:{entity:{id:claim.paymentId}}},'evt_partial_payment_refund');
    providerRefund(claim.paymentId,480000);
    await webhookEvent('payment.refunded',{payment:{entity:{id:claim.paymentId}}},'evt_full_payment_refund');
    providerRefund(claim.paymentId,10000);
    await webhookEvent('payment.refunded',{payment:{entity:{id:claim.paymentId}}},'evt_stale_payment_snapshot');
    expect((await pool.query('SELECT refund_amount_paise FROM subscription_charges')).rows).toEqual([{refund_amount_paise:480000}]);
    expect((await pool.query("SELECT * FROM subscription_audit WHERE action='subscription_refund_reconciled'")).rowCount).toBe(2);
    expect(await balance()).toBe(5000);expect((await service.access(1)).allowed).toBe(false);
  });
  it('keeps unconfirmed provider refunds retryable instead of trusting the webhook amount',async()=>{
    const {claim}=await paid('yearly');
    const payload={refund:{entity:{payment_id:claim.paymentId,status:'processed',amount:480000}},payment:{entity:{id:claim.paymentId,amount_refunded:480000}}};
    await expect(webhookEvent('refund.processed',payload,'evt_not_confirmed')).rejects.toMatchObject({code:'REFUND_CONFIRMATION_PENDING'});
    expect((await pool.query('SELECT refund_amount_paise FROM subscription_charges')).rows).toEqual([{refund_amount_paise:0}]);
    expect((await pool.query('SELECT processed_at FROM subscription_webhook_events')).rows).toEqual([{processed_at:null}]);
    providerRefund(claim.paymentId,480000);
    await webhookEvent('refund.processed',payload,'evt_not_confirmed');
    expect((await pool.query('SELECT sync_error FROM billing_subscriptions')).rows).toEqual([{sync_error:null}]);
    expect((await service.access(1)).allowed).toBe(false);expect(await balance()).toBe(5000);
  });
  it('rejects a refund payment associated with a different managed organization',async()=>{
    const first=await paid('yearly');
    const checkout=await service.start(2,'starter','yearly',2);
    const second=gateway.charge(checkout.subscriptionId,'yearly',now);
    await service.verify(2,checkout.subscriptionId,second.paymentId,second.signature);
    providerRefund(second.paymentId,480000);
    await expect(webhookEvent('refund.processed',{
      subscription:{entity:gateway.subs.get(first.checkout.subscriptionId)},
      refund:{entity:{payment_id:second.paymentId,status:'processed'}},
    },'evt_mismatched_org')).rejects.toMatchObject({code:'CHARGE_MISMATCH'});
    expect(await balance()).toBe(5000);expect(await balance(2)).toBe(5000);
    expect((await pool.query('SELECT count(*)::int count FROM subscription_charges WHERE refund_amount_paise>0')).rows).toEqual([{count:0}]);
  });
  it('checks a long-cancelled yearly mandate before issuing its next monthly deposit',async()=>{
    const {checkout,claim}=await paid('yearly');
    await service.cancel(1);gateway.subs.get(checkout.subscriptionId)!.status='cancelled';
    await pool.query("UPDATE billing_subscriptions SET status='cancelled',updated_at=now()-interval '30 days',last_synced_at=now()");
    providerRefund(claim.paymentId,480000);now=new Date('2026-11-01T00:00:00Z');
    await service.runScheduled();
    expect(await balance()).toBe(5000);expect((await service.access(1)).allowed).toBe(false);
    expect((await pool.query('SELECT count(*)::int count FROM subscription_credit_grants WHERE cancelled_at IS NOT NULL')).rows).toEqual([{count:11}]);
  });
  it('keeps rollover across renewals and handles delayed historical payments without extending time twice',async()=>{
    const {checkout,claim}=await paid();
    await pool.query('UPDATE wallets SET balance=700,total_credits_used=4300 WHERE user_id=1');
    now=new Date('2026-11-01T00:00:00Z'); const renewal=gateway.charge(checkout.subscriptionId,'monthly',now);
    await service.verify(1,checkout.subscriptionId,renewal.paymentId,renewal.signature);
    await service.verify(1,checkout.subscriptionId,claim.paymentId,claim.signature);
    expect(await balance()).toBe(5700); expect((await service.state(1)).subscription?.paidThrough).toBe('2026-12-01T00:00:00.000Z');
  });
  it('gives failed renewal access grace without creating unpaid credits',async()=>{
    const {checkout}=await paid(); gateway.subs.get(checkout.subscriptionId)!.status='pending';
    now=new Date('2026-11-02T00:00:00Z'); await service.refresh(1);
    expect((await service.access(1)).reason).toBe('payment_grace'); expect(await balance()).toBe(5000);
    now=new Date('2026-11-08T00:00:00Z'); expect((await service.access(1)).allowed).toBe(false);
  });
  it('keeps renewal grace when an authorized next-cycle plan change fails to charge',async()=>{
    await paid();
    const replacement=await service.start(1,'growth','monthly',2);
    gateway.subs.get(replacement.subscriptionId)!.status='authenticated';
    await service.refresh(1);
    now=new Date('2026-11-02T00:00:00Z');
    gateway.subs.get(replacement.subscriptionId)!.status='pending';
    await service.refresh(1);
    expect(await service.access(1)).toMatchObject({allowed:true,reason:'payment_grace',accessUntil:'2026-11-08T00:00:00.000Z',canTopUp:false});
    expect(await balance()).toBe(5000);
    await service.cancel(1,'pending');
    expect((await service.access(1)).allowed).toBe(false);
  });
  it('treats mandate authorization as unpaid and cancels the old mandate only after replacement authorization',async()=>{
    const {checkout}=await paid();
    const replacement=await service.start(1,'growth','yearly',2);
    expect(gateway.cancelCalls).toHaveLength(0);
    gateway.subs.get(replacement.subscriptionId)!.status='authenticated';
    await service.refresh(1);
    expect(gateway.cancelCalls).toEqual([{id:checkout.subscriptionId,atCycleEnd:true}]);
    expect(await balance()).toBe(5000);
    expect((await service.state(1)).subscription?.plan).toBe('starter');
    now=new Date('2026-11-01T00:00:00Z'); const claim=gateway.charge(replacement.subscriptionId,'yearly',now,'growth');
    await service.verify(1,replacement.subscriptionId,claim.paymentId,claim.signature);
    expect((await service.state(1)).subscription?.plan).toBe('growth'); expect(await balance()).toBe(20000);
  });
  it('recovers an uncertain creation before allowing another mandate',async()=>{
    gateway.uncertainCreate=true;
    await expect(service.start(1,'starter','monthly',2)).rejects.toMatchObject({code:'PROVIDER_UNCERTAIN'});
    await expect(service.start(1,'starter','monthly',2)).rejects.toMatchObject({code:'CHECKOUT_PENDING'});
    expect(gateway.createCalls).toBe(1); await service.refresh(1);
    expect((await service.start(1,'starter','monthly',2)).subscriptionId).toBe('sub_fixture1');
  });
  it('never adds simulated test deposits to a real wallet or grants paid live access',async()=>{
    gateway=new FakeRazorpay('test'); await pool.query('UPDATE subscription_settings SET enforced=false');
    await paid('yearly'); expect(await balance()).toBe(0);
    expect((await pool.query('SELECT simulated FROM subscription_credit_grants WHERE granted_at IS NOT NULL')).rows).toEqual([{simulated:true}]);
    expect((await service.access(1)).reason).toBe('rollout_pending');
    await service.cancel(1); expect(gateway.cancelCalls[0].atCycleEnd).toBe(false);
  });  it('regression: a pending replacement must not grant an unreconciled refunded annual charge',async()=>{
    const original=await paid('yearly');
    const replacement=await service.start(1,'growth','monthly',2);
    gateway.subs.get(replacement.subscriptionId)!.status='authenticated';
    await service.refresh(1);
    expect(await balance()).toBe(5000);
    // The refund exists at the fake provider but its webhook was not received.
    // At the next deposit date refresh reconciles the newer pending mandate first.
    providerRefund(original.claim.paymentId,480000);
    now=new Date('2026-11-01T00:00:00Z');
    await service.refresh(1);
    const grants=(await pool.query('SELECT month_index,granted_at IS NOT NULL AS granted,cancelled_at IS NOT NULL AS cancelled FROM subscription_credit_grants ORDER BY month_index')).rows;
    const refund=(await pool.query('SELECT refund_amount_paise FROM subscription_charges WHERE payment_id=$1',[original.claim.paymentId])).rows[0];
    expect(refund.refund_amount_paise).toBe(480000);
    expect(grants.filter(row=>row.cancelled)).toHaveLength(11);
    // Only the original October deposit remains after the provider refund.
    expect(await balance()).toBe(5000);
  });
  it('regression: an approved workspace billing admin can subscribe without personal owner approval',async()=>{
    // Personal user 3 is verified but has no independent owner setup/approval.
    // Invite acceptance gives staff access without changing those personal flags.
    await pool.query('ALTER TABLE company_settings ADD COLUMN company_name text, ADD COLUMN business_name text');
    await pool.query('CREATE TABLE business_profile_memberships(id serial PRIMARY KEY,business_profile_id integer,user_id integer,role text,status text)');
    const organizationId=organizations.get(1)!;
    const profile=(await pool.query("INSERT INTO company_settings(user_id,name,billing_organization_id) VALUES(1,'Approved owner workspace',$1) RETURNING id",[organizationId])).rows[0];
    await pool.query("INSERT INTO business_profile_memberships(business_profile_id,user_id,role,status) VALUES($1,3,'billing_admin','active')",[profile.id]);
    const scope={organizationId,actorUserId:3,businessProfileId:profile.id,businessOwnerUserId:1};
    const {requireBillingRole}=await import('../services/billing/organizations.js');
    const authorized=await withBillingScope(scope,()=>requireBillingRole(3,organizationId,service.database));
    let actual:Record<string,unknown>={};
    try { actual={...(await withBillingScope(scope,()=>service.start(3,'starter','monthly',2)))}; }
    catch(error) { actual={status:(error as SubscriptionError).status,message:(error as Error).message}; }
    expect(authorized.canManageBilling).toBe(true);
    // Expected parity with the UI's approved owner workspace eligibility.
    expect(actual).toHaveProperty('subscriptionId');
  });
  it('does not let unresolved creation intents starve a captured payment',async()=>{
    // All business writes happen in this suite's synthetic, disposable local schema.
    await pool.query('UPDATE users SET is_approved=true,is_setup_complete=true WHERE id=3');
    for(let userId=4;userId<=31;userId++) await pool.query(`INSERT INTO users
      (id,email,name,created_at,is_approved,is_setup_complete) VALUES($1,$2,$3,'2026-09-10',true,true)`,
      [userId,`starvation-${userId}@example.test`,`Starvation fixture ${userId}`]);
    gateway.uncertainCreate=true;
    for(let userId=1;userId<=30;userId++) {
      await expect(service.start(userId,'starter','monthly',2)).rejects.toMatchObject({code:'PROVIDER_UNCERTAIN'});
      // Model the request timing out before the provider accepted it: no object exists.
      gateway.subs.delete(`sub_fixture${gateway.createCalls}`);
    }
    gateway.uncertainCreate=false;
    const checkout=await service.start(31,'starter','monthly',2);
    gateway.charge(checkout.subscriptionId,'monthly',now);
    await pool.query("UPDATE billing_subscriptions SET last_synced_at='2026-09-01T00:00:00Z' WHERE user_id=31");
    const recoveredIds:string[]=[];
    const originalRecover=gateway.recoverCreation.bind(gateway);
    gateway.recoverCreation=async(localId:string)=>{recoveredIds.push(localId);return originalRecover(localId);};
    const first=await service.runScheduled();
    const second=await service.runScheduled();
    const orphanState=(await pool.query('SELECT count(*)::integer count FROM billing_subscriptions WHERE provider_id IS NULL AND last_synced_at IS NULL')).rows[0];
    const recorded=(await pool.query('SELECT count(*)::integer count FROM subscription_charges WHERE user_id=31')).rows[0];
    expect(first).toMatchObject({attempted:30,reconciled:0,pending:30,errors:0});
    expect(second).toMatchObject({attempted:1,reconciled:1,pending:0,errors:0});
    expect(orphanState.count).toBe(0);
    expect(recoveredIds).toHaveLength(30);
    expect(new Set(recoveredIds).size).toBe(30);
    const unresolved=(await pool.query("SELECT count(*)::int count FROM billing_subscriptions WHERE provider_id IS NULL AND status='creating' AND sync_error='CREATION_RECOVERY_PENDING'")).rows[0];
    expect(unresolved.count).toBe(30);
    // After two batches of 30, the captured 31st subscription must have been visited.
    expect(recorded.count).toBe(1);
  });

  it('keeps no-object recovery pending and later recovers the original mandate',async()=>{
    gateway.uncertainCreate=true;
    await expect(service.start(1,'starter','monthly',2)).rejects.toMatchObject({code:'PROVIDER_UNCERTAIN'});
    const original=gateway.subs.get('sub_fixture1')!;gateway.subs.delete(original.id);
    expect(await service.runScheduled()).toMatchObject({attempted:1,reconciled:0,pending:1,errors:0});
    expect((await pool.query('SELECT provider_id,status,sync_error FROM billing_subscriptions')).rows[0]).toMatchObject({provider_id:null,status:'creating',sync_error:'CREATION_RECOVERY_PENDING'});
    gateway.subs.set(original.id,original);
    await pool.query("UPDATE billing_subscriptions SET last_synced_at=now()-interval '16 minutes'");
    expect(await service.runScheduled()).toMatchObject({attempted:1,reconciled:1,pending:0,errors:0});
    expect((await pool.query('SELECT provider_id,sync_error FROM billing_subscriptions')).rows[0]).toEqual({provider_id:original.id,sync_error:null});
    expect(gateway.createCalls).toBe(1);expect(await balance()).toBe(0);
  });

});
