import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { deliverySetupFailure } from '../assistants/CustomerDeliveryGate.js';
import { db } from '../../models/db.js';
import { queueRegistry, QUEUE_NAMES } from '../../queues/index.js';
import { withBusinessScope, withSystemScope } from '../../tenancy/businessContext.js';
import { eventBus, EVENT_CHANNELS } from '../../events/EventBus.js';
import { logger } from '../../utils/logger.js';
import { matchAutomation, renderAutomationText, type AutomationAction, type AutomationContext, type AutomationDefinition, type AutomationEvent } from '../../../shared/crmAutomations.js';
import { automationRuntimeEnabled, automationScope, AutomationConfigurationError } from './AutomationConfiguration.js';
import { AutomationActionError, prepareAutomationDelivery, releaseAutomationReservation, sendAutomationDelivery, startAutomationDelivery, type DeliveryStep } from './AutomationDelivery.js';
import {applyAutomationReceipts} from './AutomationReceipts.js';

const LEASE_SECONDS=300;
export const MAX_AUTOMATION_ATTEMPTS=3;
export const automationRetryDelay=(attempt:number)=>5_000 * 2 ** Math.max(0,attempt-1);
export interface AutomationEventRow {
  id:number;user_id:number;business_profile_id:number;event_type:string;source_key:string;origin:string;
  contact_id?:number;conversation_id?:number;campaign_id?:number;context:AutomationContext;
  occurred_at:Date;prepared_at?:Date;status:string;lease_token?:string;
}
interface RunRow {
  id:number;automation_id:number;automation_name:string;revision:number;event_id:number;status:string;
  definition:AutomationDefinition;context:AutomationContext;contact_id?:number;
}
interface StepRow extends DeliveryStep {step_id:string;position:number;status:string;action_type:string;dispatch_started:boolean;refund_pending:boolean;available_at:Date;result?:Record<string,unknown>}
export interface AutomationEffects {
  prepare:typeof prepareAutomationDelivery;
  start:typeof startAutomationDelivery;
  send:typeof sendAutomationDelivery;
  refund:typeof releaseAutomationReservation;
}
const effects:AutomationEffects={prepare:prepareAutomationDelivery,start:startAutomationDelivery,send:sendAutomationDelivery,refund:releaseAutomationReservation};

async function notify(userId:number,runId:number) {
  const scope=automationScope(userId);
  await eventBus.publish({channel:EVENT_CHANNELS.CRM_AUTOMATION_UPDATED,userId,businessProfileId:scope.businessProfileId,
    timestamp:new Date().toISOString(),data:{runId}}).catch(()=>logger.warn({runId},'CRM automation refresh notification could not be published'));
}

/** PostgreSQL outbox is authoritative; Redis outages and expired queue leases are recoverable. */
export async function dispatchAutomationEvents():Promise<number> {
  return withSystemScope('Dispatch committed CRM automation events',async()=>{
    if (!await automationRuntimeEnabled()) return 0;
    const pending=await db.execute(sql`SELECT id,user_id,business_profile_id,status,dispatch_count FROM crm_automation_events
      WHERE available_at<=now() AND (status='pending' OR status='queued' AND claimed_at < now()-interval '2 minutes'
        OR status='processing' AND claimed_at < now()-${LEASE_SECONDS}*interval '1 second') ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,id LIMIT 100`);
    let dispatched=0;
    for (const row of pending.rows) await withBusinessScope({userId:Number(row.user_id),businessProfileId:Number(row.business_profile_id)},async()=>{
      // A queue backlog is not a lost job. Re-dispatching a waiting job every
      // two minutes creates an unbounded number of copies for the same event.
      if ((row.status==='queued' || row.status==='processing') && Number(row.dispatch_count)>0) {
        const job=await queueRegistry.getQueue(QUEUE_NAMES.CRM_AUTOMATIONS).getJob(`crm-event-${row.id}-${row.dispatch_count}`);
        if (job && ['waiting','prioritized','active','delayed','waiting-children','paused'].includes(await job.getState())) return;
      }
      const claimed=await db.execute(sql`UPDATE crm_automation_events SET status='queued',claimed_at=now(),dispatch_count=dispatch_count+1,lease_token=NULL
        WHERE id=${row.id} AND (status='pending' OR status='queued' AND claimed_at < now()-interval '2 minutes'
          OR status='processing' AND claimed_at < now()-${LEASE_SECONDS}*interval '1 second') RETURNING dispatch_count`);
      if (!claimed.rows.length) return;
      try {
        await queueRegistry.addJob(QUEUE_NAMES.CRM_AUTOMATIONS,'crm-automation-event',{userId:Number(row.user_id),businessProfileId:Number(row.business_profile_id),
          eventId:Number(row.id),createdAt:new Date().toISOString()},{jobId:`crm-event-${row.id}-${claimed.rows[0].dispatch_count}`,attempts:1});
        dispatched++;
      } catch {
        await db.execute(sql`UPDATE crm_automation_events SET status='pending',available_at=now()+interval '15 seconds' WHERE id=${row.id} AND status='queued'`);
        logger.warn({eventId:row.id},'CRM automation event remains in durable outbox after queue failure');
      }
    });
    return dispatched;
  });
}

async function finishRun(userId:number,run:RunRow,status:string,error?:string) {
  const scope=automationScope(userId);
  await db.transaction(async(tx:typeof db)=>{
    const updated=await tx.execute(sql`UPDATE crm_automation_runs SET status=${status},error_message=${error || null},completed_at=now()
      WHERE id=${run.id} AND completed_at IS NULL RETURNING id`);
    if (!updated.rows.length) return;
    if (status==='failed' || status==='cancelled') await tx.execute(sql`UPDATE crm_automation_run_steps SET status='cancelled',completed_at=now()
      WHERE run_id=${run.id} AND status IN ('pending','retry')`);
    if (status!=='skipped') await tx.execute(sql`INSERT INTO crm_automation_logs(user_id,business_profile_id,automation_id,contact_id,action_taken,result,error_message,metadata)
      VALUES(${userId},${scope.businessProfileId},${run.automation_id},${run.contact_id || null},${run.definition.actions.map(action=>action.type).join(', ').slice(0,255)},${status},${error || null},
        ${JSON.stringify({runId:run.id,revision:run.revision,automationName:run.automation_name})}::jsonb)`);
  });
  await notify(userId,run.id);
}

async function completeStep(tx:typeof db,step:StepRow,result:Record<string,unknown>) {
  const changed=await tx.execute(sql`UPDATE crm_automation_run_steps SET status='success',completed_at=now(),error_message=NULL,result=${JSON.stringify(result)}::jsonb,
    provider_message_id=${typeof result.providerMessageId==='string' ? result.providerMessageId : null},provider_status=${typeof result.providerStatus==='string' ? result.providerStatus : null}
    WHERE id=${step.id} AND status='running' RETURNING id`);
  if (!changed.rows.length) return;
  if (result.providerMessageId) await applyAutomationReceipts(step.id,tx);
  if (step.message_id) {
    await tx.execute(sql`UPDATE outreach_messages SET status=COALESCE((SELECT CASE WHEN provider_status IN ('read','delivered','failed','bounced') THEN provider_status END FROM crm_automation_run_steps WHERE id=${step.id}),'sent'),
      provider_call_state='confirmed',provider_message_id=${result.providerMessageId || null},rfc_message_id=${result.rfcMessageId || null},
      external_message_id=${result.providerMessageId || null},waba_message_id=CASE WHEN phone_number_id IS NOT NULL THEN ${result.providerMessageId || null} ELSE NULL END,
      sent_at=now(),confirmed_at=now(),error_message=NULL WHERE id=${step.message_id}`);
    await tx.execute(sql`UPDATE outreach_conversations SET total_messages=COALESCE(total_messages,0)+1,last_message_at=now(),last_message_by='user',
      external_thread_id=COALESCE(${result.providerThreadId || null},external_thread_id),last_message_preview=(SELECT redacted_content FROM outreach_messages WHERE id=${step.message_id}),updated_at=now() WHERE id=${step.conversation_id}`);
  }
}

/** Ticket creation and its success checkpoint commit atomically; replay cannot create a second ticket. */
async function executeContactAction(userId:number,run:RunRow,step:StepRow,action:AutomationAction) {
  const scope=automationScope(userId),contactId=Number(run.context.contact?.id || run.contact_id);
  if (!contactId) throw new AutomationActionError('This event has no triggering contact.');
  if (action.type==='update_pipeline_status' || action.type==='update_status') {
    const {crmService}=await import('../CRMService.js');
    const result=action.type==='update_pipeline_status'
      ? await crmService.updatePipelineStatus(userId,contactId,String(action.config.pipelineStatus),{automation:true})
      : await crmService.updateContact(userId,contactId,{status:String(action.config.status)},{automation:true});
    if (!result) throw new AutomationActionError('The triggering contact is unavailable.');
    await db.transaction((tx:typeof db)=>completeStep(tx,step,{contactId}));
    return;
  }
  await db.transaction(async(tx:typeof db)=>{
    await tx.execute(sql`SELECT set_config('app.crm_automation_origin','automation',true)`);
    const checkpoint=await tx.execute(sql`SELECT status,result FROM crm_automation_run_steps WHERE id=${step.id} AND run_id=${run.id} FOR UPDATE`);
    if (checkpoint.rows[0]?.status==='success') {step.result=checkpoint.rows[0].result;return;}
    if (checkpoint.rows[0]?.status!=='running') throw new AutomationActionError('The step is no longer running.');
    const exists=await tx.execute(sql`SELECT id FROM crm_contacts WHERE id=${contactId} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND deleted_at IS NULL FOR UPDATE`);
    if (!exists.rows.length) throw new AutomationActionError('The triggering contact is unavailable.');
    let result:Record<string,unknown>={contactId};
    if (action.type==='create_ticket') {
      const {supportService}=await import('../SupportService.js');
      const ticket=await supportService.createTicket(userId,{contactId,subject:renderAutomationText(String(action.config.subject || 'Auto-generated support ticket'),run.context),
        description:action.config.description ? renderAutomationText(String(action.config.description),run.context) : undefined,
        priority:String(action.config.priority || 'medium'),tags:['automation-created']},{database:tx,deferNotificationWakeup:true});
      result={contactId,ticketId:ticket.id,ticketNumber:ticket.ticketNumber};
    } else if (action.type==='update_tags') {
      await tx.execute(sql`UPDATE crm_contacts SET tags=(SELECT COALESCE(jsonb_agg(DISTINCT v),'[]'::jsonb)
        FROM jsonb_array_elements(COALESCE(tags,'[]'::jsonb)||${JSON.stringify(action.config.tags)}::jsonb) v),updated_at=now() WHERE id=${contactId}`);
      result.tags=action.config.tags;
    } else if (action.type==='remove_tags') {
      await tx.execute(sql`UPDATE crm_contacts SET tags=(SELECT COALESCE(jsonb_agg(v),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(tags,'[]'::jsonb)) v
        WHERE NOT ${JSON.stringify(action.config.tags)}::jsonb @> jsonb_build_array(v)),updated_at=now() WHERE id=${contactId}`);
      result.tags=action.config.tags;
    } else if (action.type==='assign_user') {
      const member=await tx.execute(sql`SELECT 1 FROM business_profile_memberships WHERE business_profile_id=${scope.businessProfileId} AND user_id=${Number(action.config.assignedTo)} AND status='active'`);
      if (!member.rows.length) throw new AutomationActionError('The selected workspace member is unavailable.');
      await tx.execute(sql`UPDATE crm_contacts SET assigned_to=${Number(action.config.assignedTo)},updated_at=now() WHERE id=${contactId}`);
      result.assignedTo=action.config.assignedTo;
    } else throw new AutomationActionError('This action is unsupported.');
    await completeStep(tx,step,result);
    step.result=result;
  });
}

async function prepareRuns(userId:number,event:AutomationEventRow,token:string) {
  const scope=automationScope(userId);
  await db.transaction(async(tx:typeof db)=>{
    const state=await tx.execute(sql`SELECT prepared_at FROM crm_automation_events WHERE id=${event.id} AND lease_token=${token} FOR UPDATE`);
    if (!state.rows.length || state.rows[0].prepared_at) return;
    const rules=await tx.execute(sql`SELECT id,name,definition,revision,priority FROM crm_pipeline_automations WHERE user_id=${userId}
      AND business_profile_id=${scope.businessProfileId} AND is_active AND deleted_at IS NULL
      AND created_at<=${new Date(event.occurred_at).toISOString()}::timestamptz AND trigger_type=${event.event_type} ORDER BY priority DESC,id`);
    const incoming:AutomationEvent={type:event.event_type,sourceKey:event.source_key,occurredAt:new Date(event.occurred_at).toISOString(),origin:event.origin,
      contactId:event.contact_id,conversationId:event.conversation_id,campaignId:event.campaign_id,context:event.context};
    for (const rule of rules.rows) {
      const definition=rule.definition as AutomationDefinition;
      if (!definition || !matchAutomation(definition,incoming).matches) continue;
      const inserted=await tx.execute(sql`INSERT INTO crm_automation_runs(user_id,business_profile_id,automation_id,automation_name,revision,priority,event_id,event_type,contact_id,contact_name,definition,context)
        VALUES(${userId},${scope.businessProfileId},${rule.id},${rule.name},${rule.revision},${rule.priority || 0},${event.id},${event.event_type},${event.contact_id || null},${event.context.contact?.name || null},
          ${JSON.stringify(definition)}::jsonb,${JSON.stringify(event.context)}::jsonb) ON CONFLICT(automation_id,event_id) DO NOTHING RETURNING id`);
      if (!inserted.rows.length) continue;
      for (const [position,action] of definition.actions.entries()) await tx.execute(sql`INSERT INTO crm_automation_run_steps(user_id,business_profile_id,run_id,step_id,position,action_type)
        VALUES(${userId},${scope.businessProfileId},${inserted.rows[0].id},${action.id},${position},${action.type}) ON CONFLICT(run_id,step_id) DO NOTHING`);
    }
    await tx.execute(sql`UPDATE crm_automation_events SET prepared_at=now() WHERE id=${event.id} AND lease_token=${token}`);
  });
}

/** Public test seam injects the provider boundary while exercising durable state transitions. */
export async function processAutomationEvent(userId:number,eventId:number,delivery:AutomationEffects=effects):Promise<void> {
  const scope=automationScope(userId),token=randomUUID();
  if (!Number.isSafeInteger(eventId) || eventId<=0) throw new Error('Invalid CRM automation event ID.');
  if (!await automationRuntimeEnabled()) return;
  const claimed=await db.execute(sql`UPDATE crm_automation_events SET status='processing',claimed_at=now(),lease_token=${token}
    WHERE id=${eventId} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND available_at<=now()
      AND (status IN ('pending','queued') OR status='processing' AND claimed_at < now()-${LEASE_SECONDS}*interval '1 second') RETURNING *`);
  if (!claimed.rows.length) return;
  const event=claimed.rows[0] as AutomationEventRow;
  try {
    if (event.origin==='automation') {
      await db.execute(sql`UPDATE crm_automation_events SET status='cancelled',lease_token=NULL WHERE id=${eventId} AND lease_token=${token}`); return;
    }
    await prepareRuns(userId,event,token);
    const result=await db.execute(sql`SELECT * FROM crm_automation_runs WHERE event_id=${eventId} AND status IN ('queued','running','retry') ORDER BY priority DESC,automation_id`);
    for (const run of result.rows as RunRow[]) {
      await db.execute(sql`UPDATE crm_automation_runs SET status='running',started_at=COALESCE(started_at,now()) WHERE id=${run.id}`);
      const steps=await db.execute(sql`SELECT * FROM crm_automation_run_steps WHERE run_id=${run.id} ORDER BY position`);
      let stopped=false;
      for (const step of steps.rows as StepRow[]) {
        const action=run.definition.actions.find(item=>item.id===step.step_id)!;
        if (step.status==='success') {applyStepContext(run,step,action);continue;}
        if (step.status==='running' && step.dispatch_started) {
          await db.execute(sql`UPDATE crm_automation_run_steps SET status='uncertain',error_message='Worker stopped after provider dispatch began.',completed_at=now() WHERE id=${step.id}`);
          if (step.message_id) await db.execute(sql`UPDATE outreach_messages SET status='manual_review',provider_call_state='unknown',manual_review_required=true WHERE id=${step.message_id}`);
          await finishRun(userId,run,'uncertain','Provider acceptance needs reconciliation.');stopped=true;break;
        }
        if (step.refund_pending) {
          await delivery.refund(userId,step);
          await db.execute(sql`UPDATE crm_automation_run_steps SET refund_pending=false,reservation_transaction_id=NULL WHERE id=${step.id}`);
          step.reservation_transaction_id=null;
        }
        const active=await db.execute(sql`SELECT 1 FROM crm_pipeline_automations WHERE id=${run.automation_id} AND is_active AND deleted_at IS NULL`);
        if (!active.rows.length || !await automationRuntimeEnabled()) {
          if (step.reservation_transaction_id) await delivery.refund(userId,step);
          await db.execute(sql`UPDATE crm_automation_run_steps SET status='cancelled',completed_at=now() WHERE id=${step.id}`);
          await finishRun(userId,run,'cancelled','The automation was paused or deleted.');stopped=true;break;
        }
        if (['failed','uncertain','cancelled'].includes(step.status)) {await finishRun(userId,run,step.status);stopped=true;break;}
        if (new Date(step.available_at).getTime()>Date.now()) {
          await deferEvent(eventId,token,run.id,new Date(step.available_at));return;
        }
        await db.execute(sql`UPDATE crm_automation_events SET claimed_at=now() WHERE id=${eventId} AND lease_token=${token}`);
        const updated=await db.execute(sql`UPDATE crm_automation_run_steps SET attempts=attempts+CASE WHEN status IN ('pending','retry') THEN 1 ELSE 0 END,
          status='running',claimed_at=now(),error_message=NULL
          WHERE id=${step.id} AND status IN ('pending','retry','running') RETURNING *`);
        Object.assign(step,updated.rows[0]);
        let dispatched=false;
        try {
          if (action.type==='send_notification' || action.type==='webhook') {
            const prepared=await delivery.prepare(userId,step,action,run.context);
            await delivery.start(userId,step,run.automation_id,prepared);
            dispatched=true;
            const sent=await delivery.send(userId,step,action,prepared);
            await db.transaction((tx:typeof db)=>completeStep(tx,step,sent));
          } else await executeContactAction(userId,run,step,action);
          applyStepContext(run,step,action);
          await notify(userId,run.id);
        } catch(error) {
          // A lost COMMIT response may still have committed the effect and checkpoint.
          const checkpoint=await db.execute(sql`SELECT status,result FROM crm_automation_run_steps WHERE id=${step.id}`);
          if (checkpoint.rows[0]?.status==='success') {step.result=checkpoint.rows[0].result;applyStepContext(run,step,action);continue;}
          const setup = deliverySetupFailure(error);
          const known=Boolean(setup) || error instanceof AutomationActionError || error instanceof AutomationConfigurationError;
          const paused=error instanceof AutomationActionError && error.message==='The automation was paused or deleted.';
          const uncertain=setup ? false : error instanceof AutomationActionError ? error.uncertain : dispatched;
          const transient=error instanceof AutomationActionError ? error.transient : ['40001','40P01','08006','57P01'].includes(String((error as {code?:string;cause?:{code?:string}}).code || (error as {cause?:{code?:string}}).cause?.code));
          const message=setup ? JSON.stringify(setup) : known ? (error as Error).message : uncertain ? 'The provider outcome requires reconciliation.' : 'The action could not be completed.';
          // Refund only definitively unaccepted attempts. Recovery retries this idempotent refund first.
          const retry=!paused && !uncertain && transient && step.attempts<MAX_AUTOMATION_ATTEMPTS;
          const status=paused ? 'cancelled' : uncertain ? 'uncertain' : retry ? 'retry' : 'failed';
          const next=new Date(Date.now()+automationRetryDelay(step.attempts));
          await db.execute(sql`UPDATE crm_automation_run_steps SET status=${status},error_message=${message},dispatch_started=${uncertain},refund_pending=${!uncertain && Boolean(step.reservation_transaction_id)},
            available_at=${next.toISOString()}::timestamptz,completed_at=${retry ? null : new Date().toISOString()}::timestamptz WHERE id=${step.id}`);
          if (step.message_id) await db.execute(sql`UPDATE outreach_messages SET status=${setup ? 'setup_required' : uncertain ? 'manual_review' : retry ? 'pending' : 'failed'},
            provider_call_state=${uncertain ? 'unknown' : 'rejected'},manual_review_required=${uncertain},error_message=${message} WHERE id=${step.message_id}`);
          if (!uncertain) {
            await delivery.refund(userId,step);
            await db.execute(sql`UPDATE crm_automation_run_steps SET refund_pending=false,reservation_transaction_id=NULL WHERE id=${step.id}`);
          }
          if (retry) {await deferEvent(eventId,token,run.id,next);await notify(userId,run.id);return;}
          await finishRun(userId,run,status,message);stopped=true;break;
        }
      }
      if (!stopped) await finishRun(userId,run,'success');
    }
    await db.execute(sql`UPDATE crm_automation_events SET status='completed',lease_token=NULL,claimed_at=NULL WHERE id=${eventId} AND lease_token=${token}`);
  } catch(error) {
    await db.execute(sql`UPDATE crm_automation_events SET status='pending',available_at=now()+interval '15 seconds',lease_token=NULL,error_message='Worker recovery pending.' WHERE id=${eventId} AND lease_token=${token}`);
    throw error;
  }
}

async function deferEvent(eventId:number,token:string,runId:number,at:Date) {
  await db.transaction(async(tx:typeof db)=>{
    await tx.execute(sql`UPDATE crm_automation_runs SET status='retry' WHERE id=${runId}`);
    await tx.execute(sql`UPDATE crm_automation_events SET status='pending',available_at=${at.toISOString()}::timestamptz,lease_token=NULL,claimed_at=NULL WHERE id=${eventId} AND lease_token=${token}`);
  });
}

function applyStepContext(run:RunRow,step:StepRow,action:AutomationAction) {
  if (action.type==='create_ticket' && step.result?.ticketId) run.context.ticket={id:Number(step.result.ticketId),number:String(step.result.ticketNumber),
    subject:renderAutomationText(String(action.config.subject || 'Auto-generated support ticket'),run.context),priority:String(action.config.priority || 'medium')};
}
