/** Local-only, real Razorpay TEST-mode checkout acceptance harness.
 * Run: pnpm --dir server exec tsx scripts/verify-subscriptions.ts
 * Never accepts live credentials. Creates two non-login QA accounts in the local DB.
 */
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import http from 'node:http';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { SUBSCRIPTION_PLANS, SUBSCRIPTION_CATALOG_VERSION, planAmountPaise } from '../../shared/subscriptions.js';
dotenv.config({path:'.env.development',quiet:true});
dotenv.config({path:'.env',override:true,quiet:true});

async function main() {
  if (!['localhost','127.0.0.1','::1'].includes(process.env.DB_HOST || '')) throw new Error('This harness requires a local database.');
  const { decryptValue } = await import('../services/SecretsManager.js');
  const { decryptSensitiveIntegrationConfig, encryptSensitiveIntegrationConfig } = await import('../utils/integrationSecrets.js');
  const { SubscriptionService } = await import('../services/subscriptions/service.js');
  const { RazorpaySubscriptionGateway } = await import('../services/subscriptions/gateway.js');
  const pool = new Pool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME||process.env.DB_DATABASE});
  const candidates = (await pool.query("SELECT id,api_key,api_secret,is_encrypted,config FROM admin_api_credentials WHERE platform='razorpay' AND is_active=true")).rows;
  const credential = candidates.map(c=>({...c,key:c.is_encrypted?decryptValue(c.api_key):c.api_key,secret:c.is_encrypted?decryptValue(c.api_secret):c.api_secret})).find(c=>c.key.startsWith('rzp_test_'));
  if (!credential) throw new Error('An active encrypted test credential is required.');
  const config = (decryptSensitiveIntegrationConfig(credential.config) || {}) as Record<string,unknown>;
  const webhookSecret = String(config.subscriptionWebhookSecret || crypto.randomBytes(32).toString('hex'));
  const gateway = new RazorpaySubscriptionGateway(credential.id,credential.key,credential.secret,webhookSecret);
  const subscriptions = new SubscriptionService(drizzle(pool) as unknown as import('../services/subscriptions/service.js').SubscriptionDatabase,async()=>gateway);
  const settings = await subscriptions.settings();
  if (settings.enforced) throw new Error('Disable enforcement before running test checkout.');
  if (!config.subscriptionWebhookSecret) await pool.query('UPDATE admin_api_credentials SET config=$1,updated_at=now() WHERE id=$2',[JSON.stringify(encryptSensitiveIntegrationConfig({...config,subscriptionWebhookSecret:webhookSecret,subscriptionWebhookUpdatedAt:new Date().toISOString()})),credential.id]);
  await pool.query('UPDATE subscription_settings SET credential_id=$1,updated_at=now() WHERE id=1',[credential.id]);
  for (const plan of SUBSCRIPTION_PLANS) for (const term of ['monthly','yearly'] as const) {
    const found = await pool.query('SELECT provider_plan_id FROM subscription_provider_plans WHERE credential_id=$1 AND version=$2 AND slug=$3 AND term=$4',[credential.id,SUBSCRIPTION_CATALOG_VERSION,plan.slug,term]);
    if (found.rowCount) continue;
    const name = `AskSales ${plan.name} ${term} v${SUBSCRIPTION_CATALOG_VERSION}`;
    const amount = planAmountPaise(plan,term);
    const remote = await gateway.findExistingPlan(name,term,amount) || await gateway.createPlan(name,term,amount);
    await pool.query('INSERT INTO subscription_provider_plans(credential_id,version,slug,term,provider_plan_id) VALUES($1,$2,$3,$4,$5)',[credential.id,SUBSCRIPTION_CATALOG_VERSION,plan.slug,term,remote.id]);
  }
  await pool.query("INSERT INTO subscription_audit(action,details) VALUES('local_test_setup',$1)",[JSON.stringify({credentialId:credential.id,mode:'test'})]);
  const checkouts: Record<string,{userId:number;subscriptionId:string;keyId:string}> = {};
  for(const term of ['monthly','yearly'] as const) {
    const email=`subscription-qa-${term}@asksales.invalid`;
    const user = (await pool.query(`INSERT INTO users(email,name,password,is_verified,is_setup_complete,is_approved)
      VALUES($1,$2,'!subscription-qa-account',false,true,true) ON CONFLICT(email) DO UPDATE SET deleted_at=NULL RETURNING id`,[email,`Subscription QA (${term})`])).rows[0];
    const checkout=await subscriptions.start(user.id,'starter',term);
    if(checkout.mode!=='test') throw new Error('Refusing a non-test checkout.');
    checkouts[term]={userId:user.id,subscriptionId:checkout.subscriptionId,keyId:checkout.keyId};
  }
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url||'/', 'http://127.0.0.1');
    const term=url.searchParams.get('term')||'monthly';
    const checkout=checkouts[term];
    if(!checkout) {res.writeHead(404);res.end();return;}
    try {
      if(req.method==='POST' && url.pathname==='/verify') {
        const chunks:Buffer[]=[]; for await(const chunk of req) {chunks.push(Buffer.from(chunk)); if(Buffer.concat(chunks).length>8192) throw new Error('Request too large');}
        const claim=JSON.parse(Buffer.concat(chunks).toString());
        const state=await subscriptions.verify(checkout.userId,checkout.subscriptionId,claim.razorpay_payment_id,claim.razorpay_signature);
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({verifiedPlanCharges:state.charges.length,status:state.subscription?.status,mode:state.mode}));return;
      }
      if(req.method==='POST' && url.pathname==='/refresh') {
        const state=await subscriptions.refresh(checkout.userId);
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({verifiedPlanCharges:state.charges.length,status:state.subscription?.status,mode:state.mode}));return;
      }
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><title>AskSales subscription TEST checkout</title></head><body style="font:18px system-ui;max-width:650px;margin:80px auto;padding:24px"><h1>Razorpay TEST: ${term}</h1><p>This is a test-mode Starter subscription. No real payment.</p><p>${term==='monthly'?'₹100 each month':'₹960 yearly, 1,000 credits each month'}</p><button id="pay" style="padding:14px 24px">Authorize test subscription</button><button id="refresh" style="padding:14px 24px">Refresh verification</button><pre id="result" style="white-space:pre-wrap"></pre><script src="https://checkout.razorpay.com/v1/checkout.js"></script><script>
      const show=result=>document.getElementById('result').textContent=JSON.stringify(result,null,2);
      const pay=new Razorpay({key:${JSON.stringify(checkout.keyId)},subscription_id:${JSON.stringify(checkout.subscriptionId)},name:'AskSales TEST',description:${JSON.stringify(`Starter ${term} test`)},prefill:{name:'Subscription QA',email:'billing-qa@example.test',contact:'9000090000'},handler:async response=>show(await(await fetch('/verify?term=${term}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(response)})).json())});
      document.getElementById('pay').onclick=()=>pay.open();document.getElementById('refresh').onclick=async()=>show(await(await fetch('/refresh?term=${term}',{method:'POST'})).json());
      </script></body></html>`);
    } catch(error) {
      res.writeHead(500,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:error instanceof Error && error.name==='SubscriptionError' ? error.message : 'Verification needs reconciliation'}));
    }
  });
  server.listen(3118,'127.0.0.1',()=>console.log(JSON.stringify({testCheckoutReady:true,monthly:'http://127.0.0.1:3118/?term=monthly',yearly:'http://127.0.0.1:3118/?term=yearly',credentialId:credential.id})));
}
main().catch(error=>{console.error(JSON.stringify({error: error.name, code: error.code || error.cause?.code, message: String(error.message).split('\n')[0].slice(0,240)}));process.exit(1);});
