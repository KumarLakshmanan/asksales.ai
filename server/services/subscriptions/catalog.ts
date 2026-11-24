import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../models/db.js';
import { LIMIT_DEFINITIONS, UNLIMITED_LIMITS, type SubscriptionPlan, type SubscriptionCatalog, type PlanLimits } from '../../../shared/subscriptions.js';
import { RazorpaySubscriptionGateway, SubscriptionError } from './gateway.js';
import type { Executor, SubscriptionDatabase } from './service.js';

type CatalogStatus = 'draft' | 'published' | 'retired';
type PlanRow = {version:number;slug:string;name:string;description:string;monthly_amount_paise:number;yearly_amount_paise:number;monthly_credits:number;limits:PlanLimits;sort_order:number;featured:boolean;finder_min_score:number;finder_max_score:number|null};
const query = async <T>(executor: Executor, statement: ReturnType<typeof sql>) => (await executor.execute(statement)).rows as T[];
export function catalogPlan(row: PlanRow): SubscriptionPlan {
  return {version:row.version,slug:row.slug,name:row.name,description:row.description,
    monthlyRupees:row.monthly_amount_paise/100,yearlyRupees:row.yearly_amount_paise/100,monthlyCredits:row.monthly_credits,
    limits:{...UNLIMITED_LIMITS,...row.limits},sortOrder:row.sort_order,featured:row.featured,
    finderMinScore:row.finder_min_score,finderMaxScore:row.finder_max_score};
}
export async function getCatalog(version?: number, executor: Executor = db): Promise<SubscriptionCatalog> {
  if(version===undefined) {
    const [settings]=await query<{published_catalog_version:number}>(executor,sql`SELECT published_catalog_version FROM subscription_settings WHERE id=1`);
    version=settings?.published_catalog_version;
  }
  if(!version) throw new SubscriptionError('Pricing is unavailable. Please try again.',503,'CATALOG_UNAVAILABLE');
  const plans=await query<PlanRow>(executor,sql`SELECT * FROM subscription_plans WHERE version=${version} ORDER BY sort_order,slug`);
  if(!plans.length) throw new SubscriptionError('Pricing is unavailable. Please try again.',503,'CATALOG_UNAVAILABLE');
  return {version,currency:'INR',taxInclusive:true,plans:plans.map(catalogPlan)};
}
export async function catalogAdminState() {
  const catalogs=await query<{version:number;status:CatalogStatus;created_at:string;published_at:string|null}>(db,sql`SELECT * FROM subscription_catalogs ORDER BY version DESC`);
  const published=await getCatalog();
  return {publishedVersion:published.version,catalogs:await Promise.all(catalogs.map(async c=>({...c,...await getCatalog(c.version)})))};
}
export async function createCatalogDraft(adminId:number) {
  return db.transaction(async(tx:Executor)=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(73031,1)`);
    const [latest]=await query<{version:number}>(tx,sql`SELECT COALESCE(max(version),0)+1 version FROM subscription_catalogs`);
    const source=await getCatalog(undefined,tx);
    await tx.execute(sql`INSERT INTO subscription_catalogs(version,status,created_by) VALUES(${latest.version},'draft',${adminId})`);
    await tx.execute(sql`INSERT INTO subscription_plans(version,slug,name,monthly_amount_paise,yearly_amount_paise,monthly_credits,description,limits,sort_order,featured,finder_min_score,finder_max_score)
      SELECT ${latest.version},slug,name,monthly_amount_paise,yearly_amount_paise,monthly_credits,description,limits,sort_order,featured,finder_min_score,finder_max_score FROM subscription_plans WHERE version=${source.version}`);
    await audit(tx,adminId,'catalog_draft_created',{version:latest.version,source:source.version});
    return {...await getCatalog(latest.version,tx),status:'draft'};
  });
}
const amount=z.number().positive().max(20_000_000).refine(n=>Math.abs(n*100-Math.round(n*100))<0.00001,'Use at most two decimal places');
const limitsSchema=z.object(Object.fromEntries(LIMIT_DEFINITIONS.map(({key})=>[key,z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()])) as Record<keyof PlanLimits,z.ZodNullable<z.ZodNumber>>).strict().superRefine((limits,ctx)=>{
  if(limits.businessProfiles!==limits.workspaces) ctx.addIssue({code:'custom',path:['workspaces'],message:'Business workspaces must match the business profile allowance.'});
});
const planSchema=z.object({version:z.number().int().positive().optional(),slug:z.string().regex(/^[a-z][a-z0-9_-]{0,49}$/),name:z.string().trim().min(1).max(80),description:z.string().trim().max(240),monthlyRupees:amount,yearlyRupees:amount,monthlyCredits:z.number().int().positive().max(2_000_000_000),limits:limitsSchema,sortOrder:z.number().int().nonnegative().max(1000),featured:z.boolean(),finderMinScore:z.number().int().nonnegative().max(100),finderMaxScore:z.number().int().nonnegative().max(100).nullable()}).strict();
export const catalogInput=z.object({plans:z.array(planSchema).min(1).max(12)}).strict().superRefine(({plans},ctx)=>{
  if(new Set(plans.map(p=>p.slug)).size!==plans.length) ctx.addIssue({code:'custom',message:'Plan slugs must be unique'});
  if(plans.filter(p=>p.featured).length>1) ctx.addIssue({code:'custom',message:'Choose one recommended plan'});
  const sorted=[...plans].sort((a,b)=>a.finderMinScore-b.finderMinScore);
  let next=0;
  for(const [index,p] of sorted.entries()) {
    if(p.finderMinScore!==next || (p.finderMaxScore!==null&&p.finderMaxScore<p.finderMinScore) || (p.finderMaxScore===null&&index!==sorted.length-1)) ctx.addIssue({code:'custom',message:'Finder ranges must cover every score without gaps or overlap'});
    next=(p.finderMaxScore??100)+1;
  }
  if(sorted.at(-1)?.finderMaxScore!==null) ctx.addIssue({code:'custom',message:'The last finder range must have no upper limit'});
});
async function audit(executor:Executor,adminId:number|null,action:string,details:Record<string,unknown>) {
  await executor.execute(sql`INSERT INTO subscription_audit(admin_id,action,details) VALUES(${adminId},${action},${JSON.stringify(details)}::jsonb)`);
}
export async function saveCatalogDraft(adminId:number,version:number,input:unknown) {
  const {plans}=catalogInput.parse(input);
  if(plans.some(plan=>plan.version!==undefined&&plan.version!==version)) throw new SubscriptionError('The draft version changed. Reload before saving.',409,'CATALOG_CHANGED');
  await db.transaction(async(tx:Executor)=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(73031,1)`);
    const [catalog]=await query<{status:CatalogStatus}>(tx,sql`SELECT status FROM subscription_catalogs WHERE version=${version} FOR UPDATE`);
    if(catalog?.status!=='draft') throw new SubscriptionError('Create a draft to edit published prices.',409);
    await tx.execute(sql`DELETE FROM subscription_provider_plans WHERE version=${version}`);
    await tx.execute(sql`DELETE FROM subscription_plans WHERE version=${version}`);
    for(const p of plans) await tx.execute(sql`INSERT INTO subscription_plans(version,slug,name,description,monthly_amount_paise,yearly_amount_paise,monthly_credits,limits,sort_order,featured,finder_min_score,finder_max_score)
      VALUES(${version},${p.slug},${p.name},${p.description},${Math.round(p.monthlyRupees*100)},${Math.round(p.yearlyRupees*100)},${p.monthlyCredits},${JSON.stringify(p.limits)}::jsonb,${p.sortOrder},${p.featured},${p.finderMinScore},${p.finderMaxScore})`);
    await audit(tx,adminId,'catalog_draft_saved',{version,plans});
  });
  return {...await getCatalog(version),status:'draft'};
}
/** Called while the catalog lock is held. Retrying recovers matching provider plans. */
export async function provisionCatalog(executor:Executor,version:number,credentialId:number,gateway:RazorpaySubscriptionGateway) {
  const catalog=await getCatalog(version,executor);
  for(const plan of catalog.plans) for(const term of ['monthly','yearly'] as const) {
    const existing=await query(executor,sql`SELECT provider_plan_id FROM subscription_provider_plans WHERE credential_id=${credentialId} AND version=${version} AND slug=${plan.slug} AND term=${term}`);
    if(existing.length) continue;
    const name=`AskSales ${plan.name} ${term} v${version}`;
    const amount=Math.round((term==='monthly'?plan.monthlyRupees:plan.yearlyRupees)*100);
    const provider=await gateway.findExistingPlan(name,term,amount)||await gateway.createPlan(name,term,amount);
    await executor.execute(sql`INSERT INTO subscription_provider_plans(credential_id,version,slug,term,provider_plan_id) VALUES(${credentialId},${version},${plan.slug},${term},${provider.id})`);
  }
}
export async function publishCatalog(adminId:number,version:number,database:SubscriptionDatabase=db,gatewayFactory=RazorpaySubscriptionGateway.forCredential) {
  await database.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(73031,1)`);
    const [catalog]=await query<{status:CatalogStatus}>(tx,sql`SELECT status FROM subscription_catalogs WHERE version=${version} FOR UPDATE`);
    if(catalog?.status!=='draft') throw new SubscriptionError('Only a draft catalog can be published.',409);
    const plans=await getCatalog(version,tx); catalogInput.parse({plans:plans.plans});
    const [settings]=await query<{credential_id:number|null;enforced:boolean}>(tx,sql`SELECT credential_id,enforced FROM subscription_settings WHERE id=1`);
    if(!settings?.credential_id) throw new SubscriptionError('Select payment credentials before publishing.',409);
    const gateway=await gatewayFactory(settings.credential_id);
    if(!gateway.active||!gateway.hasWebhookSecret||(settings.enforced&&gateway.mode!=='live')) throw new SubscriptionError('Payment credentials and webhook must be ready before publication.',409);
    await provisionCatalog(tx,version,settings.credential_id,gateway);
    await tx.execute(sql`UPDATE subscription_catalogs SET status='retired' WHERE status='published'`);
    await tx.execute(sql`UPDATE subscription_catalogs SET status='published',published_at=now() WHERE version=${version}`);
    await tx.execute(sql`UPDATE subscription_settings SET published_catalog_version=${version},updated_by=${adminId},updated_at=now() WHERE id=1`);
    await audit(tx,adminId,'catalog_published',{version});
  });
  return catalogAdminState();
}
export async function retireCatalog(adminId:number,version:number) {
  await db.transaction(async(tx:Executor)=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(73031,1)`);
    const active=await getCatalog(undefined,tx);
    if(active.version===version) throw new SubscriptionError('Publish a replacement before retiring the current catalog.',409);
    const result=await tx.execute(sql`UPDATE subscription_catalogs SET status='retired' WHERE version=${version} AND status<>'retired' RETURNING version`);
    if(!result.rows.length) throw new SubscriptionError('Catalog unavailable or already retired.',409);
    await audit(tx,adminId,'catalog_retired',{version});
  });
  return catalogAdminState();
}
