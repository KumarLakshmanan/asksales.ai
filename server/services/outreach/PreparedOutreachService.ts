import {createHash,randomUUID} from 'node:crypto';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {z} from 'zod';
import {db} from '../../models/db.js';
import {leadsTable} from '../../models/leads/schema.js';
import {requireBusinessScope} from '../../tenancy/businessContext.js';
import {captureJobBusiness} from '../../tenancy/jobBusinessScope.js';
import {ownedDashboardOperation,DashboardOperationError,type DashboardOperationRow} from '../operations/DashboardOperations.js';
import {operationRequestKeySchema} from '../operations/ContactAnalysisValidation.js';
import {creationImportPredicate} from './CreationImportSources.js';
import {getCreationTemplates,resolveCreationAccount} from './CreationService.js';
import {INBOX_CHANNELS} from '../../../shared/outreachInbox.js';
import type {PreparedOutreach,PreparedOutreachComposer} from '../../../shared/preparedOutreach.js';
import {serializeUtcTimestamp} from '../../utils/supportTimestamp.js';
const values=z.record(z.string().max(120),z.string().max(4000)).refine(v=>Object.keys(v).length<=40,'Choose at most 40 template values.');
const audience=z.union([
  z.object({importOperationId:z.string().uuid()}).strict(),
  z.object({source:z.enum(['crm','campaign']),importId:z.number().int().positive()}).strict(),
]);
export const preparedOutreachSchema=z.object({
  name:z.string().trim().min(1).max(160),audience,channel:z.enum(INBOX_CHANNELS),
  providerAccountId:z.string().min(1).max(255).optional(),senderId:z.number().int().positive().optional(),
  templateId:z.string().min(1).max(255).optional(),templateValues:values.default({}),
  body:z.string().max(50000).default(''),subject:z.string().max(500).optional(),
  scheduledFor:z.string().datetime({offset:true}).optional(),threadId:z.number().int().positive().optional(),
  followUps:z.array(z.object({delayMinutes:z.number().int().positive().max(129600),templateId:z.string().min(1).max(255).optional(),
    templateValues:values.default({}),message:z.string().max(50000).default(''),subject:z.string().max(500).default('')}).strict()).max(10).default([]),
  requestKey:operationRequestKeySchema,
}).strict().superRefine((input,ctx)=>{
  if(input.channel==='whatsapp' && !input.templateId)ctx.addIssue({code:'custom',path:['templateId'],message:'Choose the approved WhatsApp template.'});
  if(input.channel==='email' && !input.senderId)ctx.addIssue({code:'custom',path:['senderId'],message:'Choose the exact email sender.'});
  if(input.channel!=='email' && !input.providerAccountId)ctx.addIssue({code:'custom',path:['providerAccountId'],message:'Choose the exact sending account.'});
  if(input.channel!=='whatsapp' && !input.body.trim())ctx.addIssue({code:'custom',path:['body'],message:'Provide the message to review.'});
  if(input.channel==='email' && !input.subject?.trim())ctx.addIssue({code:'custom',path:['subject'],message:'Provide the email subject.'});
  let previous=0;input.followUps.forEach((step,index)=>{
    if(step.delayMinutes<=previous)ctx.addIssue({code:'custom',path:['followUps',index,'delayMinutes'],message:'Follow-up delays must increase.'});previous=step.delayMinutes;
    if(input.channel==='whatsapp' ? !step.templateId : !step.message.trim())ctx.addIssue({code:'custom',path:['followUps',index],message:'Complete the follow-up template or message.'});
  });
});
type Input=z.infer<typeof preparedOutreachSchema>;
const instant=(value:Date|string)=>serializeUtcTimestamp(value)!;
// A browser object URL cannot survive reopening a saved campaign. The Meta
// media ID remains the delivery reference; do not persist a broken preview.
const savedValues=(input:Record<string,string>)=>Object.fromEntries(Object.entries(input).filter(([key,value])=>key!=='mediaPreview' || !value.startsWith('blob:')));
function view(row:DashboardOperationRow):PreparedOutreach {
  if(Date.parse(instant(row.expires_at))<=Date.now() || !row.payload.draft)throw new DashboardOperationError('This prepared outreach expired. Prepare a fresh review.',410);
  const data=row.payload as unknown as Pick<PreparedOutreach,'name'|'audience'|'draft'|'warnings'>;
  const launched=typeof row.result?.launchReviewHash==='string';
  return {id:row.id,businessProfileId:row.business_profile_id,createdAt:instant(row.created_at),expiresAt:instant(row.expires_at),...data,
    ...(launched ? {launch:{submittedAt:String(row.result!.submittedAt),status:row.result!.launchReceipt ? 'submitted' as const : 'processing' as const,
      ...(row.result!.launchReceipt ? {receipt:row.result!.launchReceipt as Record<string,unknown>} : {})}} : {}),
    card:{title:data.name,status:'review',checkedAt:instant(row.created_at),businessProfileId:row.business_profile_id,
      description:'The saved audience, account, message and follow-ups will open in the outreach composer for a fresh recipient review.',
      metrics:[{label:'Selected recipients',value:data.audience.count},{label:'Follow-ups',value:data.draft.followUps[data.draft.channel]?.steps.length || 0}],
      actions:[{label:'Review campaign',href:`/dashboard/outreach/prepared/${row.id}`},{label:'View report',href:`/dashboard/outreach/reports?preparedOutreachId=${row.id}`},{label:'Open contacts',href:'/dashboard/crm/contacts'}]}};
}
export async function getPreparedOutreach(id:string) {return view(await ownedDashboardOperation(id,['campaign_prepare']));}
/** The first confirmed review is bound in SQL as well as Redis. Refreshes and
 * cache loss cannot turn edits to an already submitted draft into a new batch. */
export async function claimPreparedOutreachLaunch(id:string,reviewHash:string) {
  if(!/^[a-f0-9]{64}$/.test(reviewHash))throw new DashboardOperationError('Invalid outreach review identity.');
  const scope=requireBusinessScope();
  return db.transaction(async(tx:typeof db)=>{
    const locked=await tx.execute(sql`SELECT * FROM dashboard_operations WHERE id=${id}::uuid AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND kind='campaign_prepare' FOR UPDATE`);
    const row=locked.rows[0] as DashboardOperationRow|undefined;
    if(!row)throw new DashboardOperationError('Prepared outreach not found.',404);view(row);
    if(row.result?.launchReviewHash && row.result.launchReviewHash!==reviewHash)throw new DashboardOperationError('This prepared campaign was already submitted with a different review. Open its report before preparing another send.',409);
    if(row.result?.launchReceipt)return row.result.launchReceipt as Record<string,unknown>;
    await tx.execute(sql`UPDATE dashboard_operations SET result=COALESCE(result,'{}'::jsonb)||${JSON.stringify({launchReviewHash:reviewHash,submittedAt:row.result?.submittedAt || new Date().toISOString()})}::jsonb,updated_at=now()
      WHERE id=${id}::uuid AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}`);
    return null;
  });
}
export async function recordPreparedOutreachLaunch(id:string,reviewHash:string,receipt:Record<string,unknown>) {
  const scope=requireBusinessScope();
  await db.execute(sql`UPDATE dashboard_operations SET result=jsonb_set(result,'{launchReceipt}',${JSON.stringify(receipt)}::jsonb),updated_at=now()
    WHERE id=${id}::uuid AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND kind='campaign_prepare' AND result->>'launchReviewHash'=${reviewHash}`);
}
/** Saves a configuration only. All delivery still enters the existing reviewed
 * batch admission with fresh recipient, template, consent and runtime checks. */
export async function prepareOutreach(input:Input):Promise<PreparedOutreach> {
  input=preparedOutreachSchema.parse(input);
  const scope=requireBusinessScope(),fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const prior=await db.execute(sql`SELECT * FROM dashboard_operations WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND request_key=${input.requestKey}`);
  if(prior.rows[0]) {
    if(prior.rows[0].kind!=='campaign_prepare' || prior.rows[0].fingerprint!==fingerprint)throw new DashboardOperationError('This request key belongs to a different preparation.',409);
    return view(prior.rows[0] as DashboardOperationRow);
  }
  if(input.scheduledFor && (Date.parse(input.scheduledFor)<Date.now()+60000 || Date.parse(input.scheduledFor)>Date.now()+90*86400000))throw new DashboardOperationError('Schedule outreach between one minute and 90 days from now.');
  if(input.threadId) {
    const {assertOwnedCampaignThread}=await import('../CampaignWorkspaceService.js');await assertOwnedCampaignThread(scope.userId,input.threadId);
  }
  let source:'crm'|'campaign',importId:number;
  if('importOperationId' in input.audience) {
    const imported=await ownedDashboardOperation(input.audience.importOperationId,['contact_import'],undefined,false);
    if(imported.status!=='completed' || !Number.isSafeInteger(imported.result?.importId))throw new DashboardOperationError('Wait for the contact import to complete before preparing outreach.',409);
    source='crm';importId=Number(imported.result!.importId);
  } else ({source,importId}=input.audience);
  const batch=await db.execute(sql`SELECT file_name FROM ${source==='crm' ? sql`crm_contact_imports` : sql`campaign_lead_imports`}
    WHERE id=${importId} AND user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId}`);
  if(!batch.rows[0])throw new DashboardOperationError('Imported audience not found.',404);
  const {account,binding}=await resolveCreationAccount(scope.userId,input.channel,{providerAccountId:input.providerAccountId,senderId:input.senderId});
  if(!binding || (input.providerAccountId && account.providerAccountId!==input.providerAccountId))throw new DashboardOperationError('The selected sending account is unavailable. Select a connected account.',409);
  const templates=input.channel==='whatsapp' ? await getCreationTemplates(scope.userId,account.providerAccountId) : [];
  for(const id of input.channel==='whatsapp' ? [input.templateId,...input.followUps.map(step=>step.templateId)] : [])
    if(!templates.some(template=>template.id===id))throw new DashboardOperationError('A selected WhatsApp template is no longer approved for this account. Choose it again.',409);
  const audienceRows=await db.select({id:leadsTable.id}).from(leadsTable).where(and(eq(leadsTable.userId,scope.userId),eq(leadsTable.businessProfileId,scope.businessProfileId),
    isNull(leadsTable.deletedAt),creationImportPredicate(scope.userId,{source,importId}))).orderBy(leadsTable.id);
  const leadIds=audienceRows.map((row:{id:number})=>row.id);
  if(!leadIds.length)throw new DashboardOperationError('This import has no available linked contacts. Open the import results to review it.',409);
  const draft:PreparedOutreachComposer={channel:input.channel,leadIds,...(input.threadId ? {threadId:input.threadId} : {}),
    accountId:account.id,providerAccountId:account.providerAccountId,body:input.channel==='whatsapp' ? '' : input.body,subject:input.subject,
    templateId:input.templateId,templateValues:savedValues(input.templateValues),whatsappMode:'template',optInConfirmed:false,
    sendWhen:input.scheduledFor ? 'later' : 'now',scheduledFor:input.scheduledFor,
    followUps:{[input.channel]:{enabled:input.followUps.length>0,steps:input.followUps.map(step=>({id:randomUUID(),delayValue:step.delayMinutes,delayUnit:'minutes',
      templateId:step.templateId || '',templateValues:savedValues(step.templateValues),message:step.message,subject:step.subject}))}}};
  const payload={name:input.name,audience:{source,importId,name:String(batch.rows[0].file_name),count:leadIds.length},draft,
    warnings:[...(!account.ready ? [account.reason || 'The sending account needs attention.'] : []),...(input.channel==='whatsapp' ? ['Confirm recipient consent in the composer before sending.'] : [])]};
  const origin=await captureJobBusiness({userId:scope.userId,businessProfileId:scope.businessProfileId});
  const row=await db.transaction(async(tx:typeof db)=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(740331,${scope.businessProfileId})`);
    const result=await tx.execute(sql`INSERT INTO dashboard_operations(id,user_id,business_profile_id,kind,status,request_key,fingerprint,origin,payload,result,total,processed)
      VALUES(${randomUUID()}::uuid,${scope.userId},${scope.businessProfileId},'campaign_prepare','ready',${input.requestKey},${fingerprint},${JSON.stringify(origin)}::jsonb,${JSON.stringify(payload)}::jsonb,
        ${JSON.stringify({name:input.name,channel:input.channel,recipientCount:leadIds.length})}::jsonb,${leadIds.length},${leadIds.length})
      ON CONFLICT(business_profile_id,user_id,request_key) DO NOTHING RETURNING *`);
    const saved=result.rows[0] || (await tx.execute(sql`SELECT * FROM dashboard_operations WHERE user_id=${scope.userId} AND business_profile_id=${scope.businessProfileId} AND request_key=${input.requestKey}`)).rows[0];
    if(saved.kind!=='campaign_prepare' || saved.fingerprint!==fingerprint)throw new DashboardOperationError('This request key belongs to a different preparation.',409);
    return saved as DashboardOperationRow;
  });
  return view(row);
}
