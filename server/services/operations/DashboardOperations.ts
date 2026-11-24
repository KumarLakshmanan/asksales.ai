import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {db} from '../../models/db.js';
import {requireBusinessScope} from '../../tenancy/businessContext.js';
import {captureJobBusiness,runBusinessJob,type JobBusinessPayload} from '../../tenancy/jobBusinessScope.js';
import {logger} from '../../utils/logger.js';
import {serializeUtcTimestamp} from '../../utils/supportTimestamp.js';
import {BillingOrganizationError} from '../billing/organizations.js';
import {BusinessLifecycleError} from '../../tenancy/businessLifecycle.js';
import {normalizeCapacityError} from '../billing/entitlements.js';
import type {ContactAnalysisOptions,ContactAnalysisSummary,AnalyzedContactRow} from '../../../shared/contactAnalysis.js';
import type {DashboardOperationResult} from '../../../shared/dashboardOperations.js';
import {analyzeContactWorkbooks,validateContactAnalysisFiles,ContactAnalysisError,type ContactAnalysisFile} from '../contacts/ContactWorkbookAnalysis.js';
import {contactAnalysisOptionsSchema,operationRequestKeySchema,operationIdSchema} from './ContactAnalysisValidation.js';

export type OperationKind='contact_analysis'|'contact_import'|'campaign_export'|'campaign_prepare'|'queue_retry';
export class DashboardOperationError extends Error {constructor(message:string,public readonly status=400){super(message);}}
export interface DashboardOperationRow {
  id:string;user_id:number;business_profile_id:number;parent_id:string|null;kind:OperationKind;
  status:'queued'|'running'|'ready'|'completed'|'failed'|'review'|'cancelled';
  request_key:string;fingerprint:string;origin:JobBusinessPayload;
  payload:Record<string,unknown>;result:Record<string,unknown>|null;processed:number;total:number;cursor:number;
  generation:number;lease_token:string|null;error:string|null;created_at:Date|string;updated_at:Date|string;expires_at:Date|string;
}
const operationInstant=(value:Date|string)=>{
  const instant=serializeUtcTimestamp(value);
  if(!instant)throw new DashboardOperationError('The saved operation timestamp is invalid.',503);
  return instant;
};
export function operationLink(row:Pick<DashboardOperationRow,'id'|'kind'>) {
  if(row.kind==='queue_retry')return `/dashboard/outreach/retries?operationId=${row.id}`;
  if(row.kind==='campaign_prepare')return `/dashboard/outreach/prepared/${row.id}`;
  return row.kind==='campaign_export' ? `/dashboard/outreach/reports?operationId=${row.id}` : `/dashboard/crm/import/analyze?operationId=${row.id}`;
}
export function dashboardOperationView(row:DashboardOperationRow) {
  const summary=row.kind==='contact_analysis' ? row.result as unknown as ContactAnalysisSummary|null : null;
  const title=row.kind==='contact_analysis' ? 'Contact analysis' : row.kind==='contact_import' ? 'Contact import' : row.kind==='campaign_prepare' ? 'Prepared outreach' : 'Campaign export';
  const card:DashboardOperationResult={title,status:row.status,checkedAt:operationInstant(row.updated_at),businessProfileId:row.business_profile_id,operation:{id:row.id,kind:row.kind},
    progress:{completed:row.processed,total:row.total},
    description:row.error || (row.kind==='contact_analysis' ? 'Preview your audience before changing the CRM.' : undefined),
    ...(summary ? {metrics:[{label:'Unique contacts',value:summary.totals.uniqueContacts},{label:'Phone entries',value:summary.totals.uniquePhoneEntries},{label:'Ready to import',value:summary.totals.readyContacts}]} : {}),
    actions:[{label:row.kind==='contact_analysis' ? 'View analysis' : 'View operation',href:operationLink(row)},
      ...(row.kind==='contact_import' && row.parent_id ? [{label:'View source analysis',href:`/dashboard/crm/import/analyze?operationId=${row.parent_id}`}] : []),{label:'Open contacts',href:'/dashboard/crm/contacts'}],
  };
  return {id:row.id,parentId:row.parent_id,kind:row.kind,status:row.status,processed:row.processed,total:row.total,cursor:row.cursor,
    result:row.result,error:row.error,createdAt:operationInstant(row.created_at),updatedAt:operationInstant(row.updated_at),expiresAt:operationInstant(row.expires_at),
    links:{operation:operationLink(row),contacts:'/dashboard/crm/contacts'},card};
}
export async function ownedDashboardOperation(id:string,kinds?:OperationKind[],database=db,includePayload=true) {
  const {userId,businessProfileId:business}=requireBusinessScope();
  if(!operationIdSchema.safeParse(id).success) throw new DashboardOperationError('Operation not found.',404);
  const projection=includePayload ? sql`*` : sql`id,user_id,business_profile_id,parent_id,kind,status,result,processed,total,cursor,error,created_at,updated_at,expires_at`;
  const result=await database.execute(sql`SELECT ${projection} FROM dashboard_operations WHERE id=${id}::uuid AND user_id=${userId} AND business_profile_id=${business}`);
  const row=result.rows[0] as DashboardOperationRow|undefined;
  if(!row || (kinds && !kinds.includes(row.kind))) throw new DashboardOperationError('Operation not found.',404);
  return row;
}
export async function dashboardOperationStatus(id:string,kinds:OperationKind[]) {
  return dashboardOperationView(await ownedDashboardOperation(id,kinds,db,false));
}
function assertLive(row:DashboardOperationRow) {
  if(Date.parse(operationInstant(row.expires_at))<=Date.now()) throw new DashboardOperationError('These staged files have expired. Upload them again to create a fresh analysis.',410);
}
export async function listDashboardOperations(kinds:OperationKind[]) {
  const {userId,businessProfileId:business}=requireBusinessScope();
  const result=await db.execute(sql`SELECT id,business_profile_id,parent_id,kind,status,NULL::jsonb AS result,result->'totals' AS analysis_totals,
    processed,total,cursor,error,created_at,updated_at,expires_at FROM dashboard_operations WHERE user_id=${userId} AND business_profile_id=${business}
    AND kind=ANY(${sql.param(kinds)}::text[]) ORDER BY created_at DESC LIMIT 50`);
  return result.rows.map((row:DashboardOperationRow & {analysis_totals?:unknown})=>({...dashboardOperationView(row),analysisTotals:row.analysis_totals || null}));
}

/** Enqueue only the immutable recorded authority; the worker revalidates it. */
export async function enqueueDashboardOperation(row:DashboardOperationRow) {
  if(row.status!=='queued') return;
  const origin=await captureJobBusiness({...row.origin},{requireOriginatingIdentity:true});
  await runBusinessJob(origin,async()=>{
    const {queueRegistry,QUEUE_NAMES}=await import('../../queues/index.js');
    await queueRegistry.initialize();
    await queueRegistry.addJob(QUEUE_NAMES.GENERAL,'dashboard-operation',{
      ...origin,userId:row.user_id,businessProfileId:row.business_profile_id,type:'dashboard-operation',operationId:row.id,
      createdAt:new Date().toISOString(),
    },{jobId:`dashboard-operation-${row.id}-${row.generation}`,attempts:3,backoff:{type:'exponential',delay:5000},removeOnComplete:{age:86400},removeOnFail:{age:604800}});
  });
}
async function dispatchOrKeepQueued(row:DashboardOperationRow) {
  try {await enqueueDashboardOperation(row);} catch(error) {
    if(error instanceof BillingOrganizationError || error instanceof BusinessLifecycleError) {
      const held=await db.execute(sql`UPDATE dashboard_operations SET status='review',error=${error.message},updated_at=now()
        WHERE id=${row.id}::uuid AND user_id=${row.user_id} AND business_profile_id=${row.business_profile_id} AND status='queued' RETURNING *`);
      return dashboardOperationView((held.rows[0] || row) as DashboardOperationRow);
    }
    // SQL is the outbox. Recovery dispatches it again; do not lose an accepted upload.
    logger.warn({operationId:row.id},'[DashboardOperations] Queue unavailable; durable operation awaits recovery');
  }
  return dashboardOperationView(row);
}
export async function createContactAnalysis(files:ContactAnalysisFile[],options:ContactAnalysisOptions,requestKey:string) {
  const {userId,businessProfileId:business}=requireBusinessScope();
  validateContactAnalysisFiles(files);options=contactAnalysisOptionsSchema.parse(options);requestKey=operationRequestKeySchema.parse(requestKey);
  const hashes=files.map(file=>createHash('sha256').update(file.buffer).digest('hex'));
  const fingerprint=createHash('sha256').update(JSON.stringify([hashes,options])).digest('hex');
  const origin=await captureJobBusiness({userId,businessProfileId:business});
  const row=await db.transaction(async(tx:typeof db)=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(740331,${business})`);
    const prior=await tx.execute(sql`SELECT * FROM dashboard_operations WHERE user_id=${userId} AND business_profile_id=${business} AND request_key=${requestKey}`);
    if(prior.rows[0]) {
      if(prior.rows[0].fingerprint!==fingerprint) throw new DashboardOperationError('This request key belongs to different files or mapping options.',409);
      return prior.rows[0] as DashboardOperationRow;
    }
    const id=randomUUID();
    const created=await tx.execute(sql`INSERT INTO dashboard_operations(id,user_id,business_profile_id,kind,request_key,fingerprint,origin,payload,total)
      VALUES(${id}::uuid,${userId},${business},'contact_analysis',${requestKey},${fingerprint},${JSON.stringify(origin)}::jsonb,${JSON.stringify({options})}::jsonb,${files.length}) RETURNING *`);
    for(const [index,file] of files.entries()) {
      const input=await tx.execute(sql`INSERT INTO dashboard_operation_inputs(id,user_id,business_profile_id,hash,bytes,expires_at)
        VALUES(${randomUUID()}::uuid,${userId},${business},${hashes[index]},${file.buffer},${operationInstant(created.rows[0].expires_at)}::timestamptz)
        ON CONFLICT(business_profile_id,user_id,hash) DO UPDATE SET expires_at=GREATEST(dashboard_operation_inputs.expires_at,EXCLUDED.expires_at) RETURNING id`);
      await tx.execute(sql`INSERT INTO dashboard_operation_files(id,user_id,business_profile_id,operation_id,name,hash,ordinal,input_id)
        VALUES(${randomUUID()}::uuid,${userId},${business},${id}::uuid,${file.name},${hashes[index]},${index},${input.rows[0].id}::uuid)`);
    }
    return created.rows[0] as DashboardOperationRow;
  });
  return dispatchOrKeepQueued(row);
}
export async function analysisRows(id:string,{status,after=0,pageSize=50}:{status?:AnalyzedContactRow['status'];after?:number;pageSize?:number}={}) {
  const row=await ownedDashboardOperation(id,['contact_analysis']);assertLive(row);
  const {userId,businessProfileId:business}=requireBusinessScope();
  const result=await db.execute(sql`SELECT ordinal,data FROM dashboard_contact_rows WHERE operation_id=${id}::uuid AND user_id=${userId} AND business_profile_id=${business}
    AND ordinal>${after} ${status ? sql`AND status=${status}` : sql``} ORDER BY ordinal LIMIT ${pageSize+1}`);
  const page=result.rows.slice(0,pageSize);
  return {items:page.map((row:{data:AnalyzedContactRow})=>row.data),nextCursor:result.rows.length>pageSize ? Number(page[page.length-1].ordinal) : null};
}
export async function reviseContactAnalysis(id:string,options:ContactAnalysisOptions,requestKey:string) {
  const parent=await ownedDashboardOperation(id,['contact_analysis']);assertLive(parent);
  if(parent.status!=='ready') throw new DashboardOperationError('Wait for the analysis to finish before revising it.',409);
  const {userId,businessProfileId:business}=requireBusinessScope();
  const files=await db.execute(sql`SELECT file.name,input.bytes FROM dashboard_operation_files file JOIN dashboard_operation_inputs input
    ON input.id=file.input_id AND input.user_id=file.user_id AND input.business_profile_id=file.business_profile_id
    WHERE file.operation_id=${id}::uuid AND file.user_id=${userId} AND file.business_profile_id=${business} ORDER BY file.ordinal`);
  return createContactAnalysis(files.rows.map((file:{name:string;bytes:Buffer})=>({name:file.name,buffer:file.bytes})),options,requestKey);
}
export async function createContactImport(analysisId:string,requestKey:string) {
  requestKey=operationRequestKeySchema.parse(requestKey);
  const analysis=await ownedDashboardOperation(analysisId,['contact_analysis']);assertLive(analysis);
  if(analysis.status!=='ready') throw new DashboardOperationError('Wait for the contact analysis to finish before importing.',409);
  const {userId,businessProfileId:business}=requireBusinessScope(),origin=await captureJobBusiness({userId,businessProfileId:business});
  const row=await db.transaction(async(tx:typeof db)=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(740331,${business})`);
    const existing=await tx.execute(sql`SELECT * FROM dashboard_operations WHERE user_id=${userId} AND business_profile_id=${business} AND request_key=${requestKey}`);
    if(existing.rows[0]) {
      if(existing.rows[0].kind!=='contact_import' || existing.rows[0].parent_id!==analysisId) throw new DashboardOperationError('This import request key belongs to another operation.',409);
      return existing.rows[0] as DashboardOperationRow;
    }
    const data=await tx.execute(sql`SELECT data FROM dashboard_contact_rows WHERE operation_id=${analysisId}::uuid AND user_id=${userId} AND business_profile_id=${business} AND status='ready' ORDER BY ordinal`);
    const records=data.rows.map(({data}:{data:AnalyzedContactRow})=>({...Object.fromEntries(Object.entries(data.contact).filter(([,value])=>value)),
      _sourceFile:data.fileName,_sourceSheet:data.sheetName,_sourceRow:String(data.rowNumber),_analysisId:analysisId}));
    if(!records.length) throw new DashboardOperationError('No contacts are ready to import. Correct the flagged rows or worksheet mappings first.');
    const mapping=Object.fromEntries(['firstName','lastName','email','phone','company','role','notes','website','linkedinUrl'].map(field=>[field,field]));
    const payload={rows:records,mapping,fileName:`Analyzed contacts ${analysisId}`,defaultCountry:(analysis.payload.options as ContactAnalysisOptions).defaultCountry};
    const fingerprint=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const result=await tx.execute(sql`INSERT INTO dashboard_operations(id,user_id,business_profile_id,parent_id,kind,request_key,fingerprint,origin,payload,total)
      VALUES(${randomUUID()}::uuid,${userId},${business},${analysisId}::uuid,'contact_import',${requestKey},${fingerprint},${JSON.stringify(origin)}::jsonb,${JSON.stringify(payload)}::jsonb,${records.length}) RETURNING *`);
    return result.rows[0] as DashboardOperationRow;
  });
  return dispatchOrKeepQueued(row);
}
/** Compatibility for a large CSV whose column mapping the user already
 * reviewed in the original importer. The row ledger remains authoritative. */
export async function createLargeCsvImport(records:Array<Record<string,string>>,mapping:Record<string,string>,fileName:string) {
  const {userId,businessProfileId:business}=requireBusinessScope();
  const payload={rows:records,mapping,fileName},fingerprint=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const origin=await captureJobBusiness({userId,businessProfileId:business}),key=`csv-import-${fingerprint}`;
  const row=await db.transaction(async(tx:typeof db)=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(740331,${business})`);
    const prior=await tx.execute(sql`SELECT * FROM dashboard_operations WHERE user_id=${userId} AND business_profile_id=${business} AND request_key=${key}`);
    if(prior.rows[0])return prior.rows[0] as DashboardOperationRow;
    const created=await tx.execute(sql`INSERT INTO dashboard_operations(id,user_id,business_profile_id,kind,request_key,fingerprint,origin,payload,total)
      VALUES(${randomUUID()}::uuid,${userId},${business},'contact_import',${key},${fingerprint},${JSON.stringify(origin)}::jsonb,${JSON.stringify(payload)}::jsonb,${records.length}) RETURNING *`);
    return created.rows[0] as DashboardOperationRow;
  });
  return dispatchOrKeepQueued(row);
}
export async function resumeDashboardOperation(id:string,kinds:OperationKind[]) {
  const {userId,businessProfileId:business}=requireBusinessScope(),row=await ownedDashboardOperation(id,kinds);assertLive(row);
  if(!['failed','review','queued'].includes(row.status)) return dashboardOperationView(row);
  const result=await db.execute(sql`UPDATE dashboard_operations SET status='queued',generation=generation+1,error=NULL,updated_at=now()
    WHERE id=${id}::uuid AND user_id=${userId} AND business_profile_id=${business} AND status IN('failed','review','queued') RETURNING *`);
  return dispatchOrKeepQueued((result.rows[0] || row) as DashboardOperationRow);
}

async function saveCheckpoint(row:DashboardOperationRow,token:string,values:{cursor:number;processed:number;total:number;status?:DashboardOperationRow['status'];result?:unknown}) {
  const result=await db.execute(sql`UPDATE dashboard_operations SET cursor=${values.cursor},processed=${values.processed},total=${values.total},
    status=${values.status || 'running'},result=COALESCE(${values.result===undefined ? null : JSON.stringify(values.result)}::jsonb,result),
    lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=${row.id}::uuid AND user_id=${row.user_id}
    AND business_profile_id=${row.business_profile_id} AND lease_token=${token}::uuid AND status='running' RETURNING id`);
  if(!result.rows.length) throw new DashboardOperationError('The operation lease changed. Another worker will continue it.',409);
}
export async function processDashboardOperation(data:JobBusinessPayload & {operationId:string}) {
  const row=await ownedDashboardOperation(data.operationId);assertLive(row);
  for(const field of ['userId','businessProfileId','businessActorUserId','billingOrganizationId','billingActorUserId'] as const)
    if(row.origin[field]!==data[field]) throw new DashboardOperationError('Operation authority does not match its recorded origin.',403);
  return runBusinessJob(row.origin,async()=>{
    const token=randomUUID();
    const claim=await db.execute(sql`UPDATE dashboard_operations SET status='running',lease_token=${token}::uuid,lease_until=now()+interval '5 minutes',updated_at=now()
      WHERE id=${row.id}::uuid AND user_id=${row.user_id} AND business_profile_id=${row.business_profile_id}
        AND (status='queued' OR (status='running' AND lease_until<now())) RETURNING *`);
    if(!claim.rows.length) return {status:row.status};
    try {
      if(row.kind==='contact_analysis') {
        const files=await db.execute(sql`SELECT file.name,input.bytes FROM dashboard_operation_files file JOIN dashboard_operation_inputs input
          ON input.id=file.input_id AND input.user_id=file.user_id AND input.business_profile_id=file.business_profile_id
          WHERE file.operation_id=${row.id}::uuid AND file.user_id=${row.user_id} AND file.business_profile_id=${row.business_profile_id} ORDER BY file.ordinal`);
        const analysis=analyzeContactWorkbooks(files.rows.map((file:{name:string;bytes:Buffer})=>({name:file.name,buffer:file.bytes})),row.payload.options as ContactAnalysisOptions);
        for(let offset=0;offset<analysis.rows.length;offset+=250) {
          const batch=analysis.rows.slice(offset,offset+250);
          await db.execute(sql`INSERT INTO dashboard_contact_rows(user_id,business_profile_id,operation_id,row_key,ordinal,status,data) VALUES
            ${sql.join(batch.map((record,index)=>sql`(${row.user_id},${row.business_profile_id},${row.id}::uuid,${record.key},${offset+index+1},${record.status},${JSON.stringify(record)}::jsonb)`),sql`,`)}
            ON CONFLICT(operation_id,row_key) DO UPDATE SET status=EXCLUDED.status,data=EXCLUDED.data`);
          await saveCheckpoint(row,token,{cursor:offset+batch.length,processed:offset+batch.length,total:analysis.rows.length});
        }
        await saveCheckpoint(row,token,{cursor:analysis.rows.length,processed:analysis.rows.length,total:analysis.rows.length,status:'ready',result:analysis.summary});
      } else if(row.kind==='contact_import') {
        const {crmService}=await import('../CRMService.js');
        const {beginCrmImport}=await import('../CrmImportLedger.js');
        const records=row.payload.rows as Array<Record<string,string>>;
        const ledger=await beginCrmImport(row.user_id,records,row.payload.mapping as Record<string,string>,String(row.payload.fileName));
        await db.execute(sql`UPDATE dashboard_operations SET payload=jsonb_set(payload,'{importId}',${String(ledger.id)}::jsonb) WHERE id=${row.id}::uuid
          AND user_id=${row.user_id} AND business_profile_id=${row.business_profile_id} AND lease_token=${token}::uuid`);
        // Commit visible progress and renew the lease before a slow set of
        // identity resolutions can outlive the five-minute worker lease.
        const checkpointSize=25;
        for(let cursor=Number(claim.rows[0].cursor || 0);cursor<records.length;cursor+=checkpointSize) {
          const progress=await crmService.importContactsFromCSV(row.user_id,records,row.payload.mapping as Record<string,string>,String(row.payload.fileName),{
            startIndex:cursor,batchSize:checkpointSize,...(row.parent_id ? {phoneCountry:row.payload.defaultCountry==='IN' ? 'IN' as const : 'none' as const} : {}),
          });
          const next=Math.min(cursor+checkpointSize,records.length);
          await saveCheckpoint(row,token,{cursor:next,processed:next,total:records.length,status:next===records.length ? 'completed' : 'running',result:progress});
        }
      } else if(row.kind==='queue_retry') {
        const {processOutreachRetryPreview}=await import('../outreach/OutreachRetryService.js');
        await processOutreachRetryPreview(claim.rows[0] as DashboardOperationRow,token,values=>saveCheckpoint(row,token,values));
      } else if(row.kind==='campaign_export') {
        const {processCampaignExport}=await import('../outreach/CampaignExportService.js');
        await processCampaignExport(claim.rows[0] as DashboardOperationRow,token,values=>saveCheckpoint(row,token,values));
      } else throw new DashboardOperationError('Unsupported operation processor.',409);
      return {id:row.id,status:'completed'};
    } catch(error) {
      const retryable=error instanceof Error && error.constructor.name==='CrmImportInterruptedError';
      const capacity=normalizeCapacityError(error);
      await db.execute(sql`UPDATE dashboard_operations SET status=${error instanceof ContactAnalysisError ? 'failed' : retryable ? 'queued' : 'review'},error=${capacity?.message || (error instanceof ContactAnalysisError || error instanceof DashboardOperationError ? error.message : row.kind==='campaign_export' ? 'Report generation stopped. Its saved snapshot and completed files are preserved. Resume to continue.' : row.kind==='queue_retry' ? 'Retry recovery stopped. Saved recovery receipts are preserved; resume to continue.' : 'Processing stopped. Committed import receipts are preserved; resume this operation to continue.')},
        lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=${row.id}::uuid AND user_id=${row.user_id} AND business_profile_id=${row.business_profile_id}
        AND lease_token=${token}::uuid AND status='running'`);
      throw error;
    }
  });
}

/** Runs inside the existing per-business cron framework. No ambient owner is
 * used to replace the originating actor of an accepted operation. */
export async function recoverDashboardOperations() {
  const {userId,businessProfileId:business}=requireBusinessScope();
  await db.execute(sql`UPDATE dashboard_operations SET status='cancelled',error='Staged data expired. Upload the files again.',updated_at=now()
    WHERE user_id=${userId} AND business_profile_id=${business} AND expires_at<now() AND status IN('queued','running') AND (lease_until IS NULL OR lease_until<now())`);
  const expired=await db.execute(sql`SELECT id FROM dashboard_operations WHERE user_id=${userId} AND business_profile_id=${business} AND expires_at<now() AND purged_at IS NULL AND status NOT IN('queued','running')`);
  for(const row of expired.rows) await db.transaction(async(tx:typeof db)=>{
    await tx.execute(sql`DELETE FROM dashboard_operation_files WHERE operation_id=${row.id}::uuid AND user_id=${userId} AND business_profile_id=${business}`);
    await tx.execute(sql`DELETE FROM dashboard_contact_rows WHERE operation_id=${row.id}::uuid AND user_id=${userId} AND business_profile_id=${business}`);
    await tx.execute(sql`UPDATE dashboard_operations SET artifact_input_id=NULL,payload='{}'::jsonb,result=result#-'{options,rows}',purged_at=now()
      WHERE id=${row.id}::uuid AND user_id=${userId} AND business_profile_id=${business}`);
  });
  await db.execute(sql`DELETE FROM dashboard_operation_inputs input WHERE input.user_id=${userId} AND input.business_profile_id=${business}
    AND input.expires_at<=now() AND NOT EXISTS(SELECT 1 FROM dashboard_operation_files file WHERE file.input_id=input.id)
    AND NOT EXISTS(SELECT 1 FROM dashboard_operations operation WHERE operation.artifact_input_id=input.id)`);
  const stale=await db.execute(sql`UPDATE dashboard_operations SET status='queued',lease_token=NULL,lease_until=NULL,generation=generation+1,updated_at=now()
    WHERE user_id=${userId} AND business_profile_id=${business} AND expires_at>now()
      AND ((status='running' AND lease_until<now()) OR (status='queued' AND updated_at<now()-interval '2 minutes')) RETURNING *`);
  for(const row of stale.rows) await dispatchOrKeepQueued(row as DashboardOperationRow);
  return {recovered:stale.rows.length};
}
