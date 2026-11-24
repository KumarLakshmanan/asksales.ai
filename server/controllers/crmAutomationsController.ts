import type {Request,Response} from 'express';
import {sql} from 'drizzle-orm';
import {db} from '../models/db.js';
import {businessOwnerUserId} from '../tenancy/businessContext.js';
import {automationService} from '../services/AutomationService.js';
import {AutomationConfigurationError,automationScope,getAutomationCatalog,previewAutomation} from '../services/automations/AutomationConfiguration.js';
import {isRecord,validateAutomationDefinition,type AutomationDefinition,type AutomationEvent} from '../../shared/crmAutomations.js';
import {logger} from '../utils/logger.js';

type Handler=(req:Request,res:Response,userId:number)=>Promise<unknown>;
function scopedHandler(handler:Handler) { return async(req:Request,res:Response)=>{
  try {
    const userId=businessOwnerUserId(req);
    if (!userId) return res.status(401).json({error:'Unauthorized'});
    automationScope(userId);
    return await handler(req,res,userId);
  } catch(error) {
    if (error instanceof AutomationConfigurationError) return res.status(error.status).json({error:error.message});
    logger.error({err:error},'CRM automation request failed');
    return res.status(500).json({error:'The automation request could not be completed.'});
  }
}; }
export const getCatalog=scopedHandler(async(_req,res,userId)=>res.json({success:true,data:await getAutomationCatalog(userId)}));
export const getAutomation=scopedHandler(async(req,res,userId)=>{
  const automation=await automationService.getAutomation(userId,Number(req.params.id));
  return automation ? res.json({success:true,data:automation}) : res.status(404).json({error:'Automation not found'});
});
export const testAutomation=scopedHandler(async(req,res,userId)=>{
  const definition=req.body?.definition;
  const errors=validateAutomationDefinition(definition);
  if (errors.length) throw new AutomationConfigurationError(errors.join(' '));
  const event=req.body?.event;
  if (!isRecord(event) || typeof event.type!=='string' || !isRecord(event.context) || JSON.stringify(event).length>30_000) {
    throw new AutomationConfigurationError('Provide a sample event and its context.');
  }
  return res.json({success:true,data:await previewAutomation(userId,definition as AutomationDefinition,event as unknown as AutomationEvent)});
});
const runSelection=sql`id,automation_id AS "automationId",automation_name AS "automationName",revision,event_type AS "eventType",contact_id AS "contactId",
  contact_name AS "contactName",status,error_message AS "errorMessage",created_at AS "createdAt",completed_at AS "completedAt"`;
export const getRuns=scopedHandler(async(req,res,userId)=>{
  const scope=automationScope(userId),id=Number(req.params.id);
  const exists=await db.execute(sql`SELECT 1 FROM crm_pipeline_automations WHERE id=${id} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId}`);
  if (!exists.rows.length) return res.status(404).json({error:'Automation not found'});
  const requestedLimit=req.query.limit===undefined ? 25 : Number(req.query.limit);
  const requestedCursor=req.query.cursor===undefined ? null : Number(req.query.cursor);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit<1 || requestedLimit>100
    || (requestedCursor!==null && (!Number.isSafeInteger(requestedCursor) || requestedCursor<1 || requestedCursor>2147483647))) {
    throw new AutomationConfigurationError('Choose a valid history page.');
  }
  const limit=requestedLimit;
  const cursorClause=requestedCursor===null ? sql`` : sql`AND id<${requestedCursor}`;
  const runs=await db.execute(sql`SELECT ${runSelection} FROM crm_automation_runs WHERE automation_id=${id} AND user_id=${userId}
    AND business_profile_id=${scope.businessProfileId} ${cursorClause} ORDER BY id DESC LIMIT ${limit+1}`);
  const page=runs.rows.slice(0,limit);
  return res.json({success:true,data:{runs:page,nextCursor:runs.rows.length>limit ? page.at(-1)?.id : null}});
});
export const getRun=scopedHandler(async(req,res,userId)=>{
  const scope=automationScope(userId),runId=Number(req.params.runId);
  const run=await db.execute(sql`SELECT ${runSelection} FROM crm_automation_runs WHERE id=${runId} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId}`);
  if (!run.rows.length) return res.status(404).json({error:'Run not found'});
  const steps=await db.execute(sql`SELECT id,step_id AS "stepId",position,action_type AS "actionType",status,attempts,error_message AS "errorMessage",result,
    provider_message_id AS "providerMessageId",provider_status AS "providerStatus",completed_at AS "completedAt"
    FROM crm_automation_run_steps WHERE run_id=${runId} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId} ORDER BY position`);
  return res.json({success:true,data:{...run.rows[0],steps:steps.rows}});
});
