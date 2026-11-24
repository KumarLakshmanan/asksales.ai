import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { assertCustomerDeliveryReady, CustomerDeliverySetupError, deliverySetupFailure, throwIfCustomerDeliverySetupRequired, withCustomerDeliveryReceipt } from '../assistants/CustomerDeliveryGate.js';
import type { AssistantProvenance } from '../../../shared/outreachAssistants.js';
import { businessCacheKey } from '../../tenancy/businessContext.js';
import { creditService } from '../CreditService.js';
import { getEffectiveDailyLimit } from '../outreach/QuotaService.js';
import { escapeOutreachHtml } from '../../../shared/outreachCompose.js';
import { assertPublicHttpUrl, fetchPublicHttpUrl } from '../../utils/safeRemoteFetch.js';
import { automationScope, automationWebhookHeaders, renderNotificationAction } from './AutomationConfiguration.js';
import { renderAutomationJson, type AutomationAction, type AutomationContext } from '../../../shared/crmAutomations.js';

export class AutomationActionError extends Error {
  constructor(message: string, public readonly uncertain = false, public readonly transient = false) { super(message); }
}
export interface DeliveryStep {
  id: number; run_id: number; attempts: number; reservation_transaction_id?: number | null;
  prepared?: Record<string, unknown> | null; conversation_id?: number | null; message_id?: number | null;
}
type PreparedNotification = Awaited<ReturnType<typeof renderNotificationAction>>;

/** Persist contact delivery intent once. Fixed recipients never enter the CRM/lead resolver. */
async function prepareContactHistory(userId: number, contactId: number, step: DeliveryStep, rendered: PreparedNotification) {
  const scope = automationScope(userId);
  return db.transaction(async (tx: typeof db) => {
    await tx.execute(sql`SELECT set_config('app.crm_automation_origin','automation',true)`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${businessCacheKey(`automation-contact:${contactId}`)}))`);
    const current = await tx.execute(sql`SELECT message_id,conversation_id FROM crm_automation_run_steps WHERE id=${step.id} FOR UPDATE`);
    if (current.rows[0]?.message_id) return {messageId:Number(current.rows[0].message_id),conversationId:Number(current.rows[0].conversation_id)};
    const result = await tx.execute(sql`SELECT * FROM crm_contacts WHERE id=${contactId} AND user_id=${userId}
      AND business_profile_id=${scope.businessProfileId} AND deleted_at IS NULL FOR UPDATE`);
    const contact = result.rows[0];
    if (!contact) throw new AutomationActionError('The triggering contact is unavailable.');
    let leadId = contact.lead_id;
    if (leadId) {
      const linked = await tx.execute(sql`SELECT id FROM leads WHERE id=${leadId} AND user_id=${userId} AND deleted_at IS NULL`);
      if (!linked.rows.length) throw new AutomationActionError('The contact’s linked lead is unavailable.');
    } else {
      const matches = await tx.execute(sql`SELECT id FROM leads WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND deleted_at IS NULL
        AND ((${Boolean(contact.email)} AND lower(email)=lower(${contact.email || ''})) OR (${Boolean(contact.phone)} AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=${String(contact.phone || '').replace(/\D/g,'')})) LIMIT 2`);
      if (matches.rows.length > 1) throw new AutomationActionError('Several leads match this contact. Link the correct lead before sending.');
      leadId = matches.rows[0]?.id;
      if (!leadId) {
        const created = await tx.execute(sql`INSERT INTO leads(user_id,business_profile_id,uuid,source,first_name,last_name,full_name,email,phone,status)
          VALUES(${userId},${scope.businessProfileId},gen_random_uuid(),'crm_sync',${contact.first_name},${contact.last_name},${[contact.first_name,contact.last_name].filter(Boolean).join(' ')},${contact.email},${contact.phone},'new') RETURNING id`);
        leadId = created.rows[0].id;
      }
      await tx.execute(sql`UPDATE crm_contacts SET lead_id=${leadId},updated_at=now() WHERE id=${contactId}`);
    }
    // Each email send starts a new provider thread; keep the stored thread ID tied to that send.
    const found = rendered.channel === 'email' ? null : await tx.execute(sql`SELECT id FROM outreach_conversations WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId}
      AND lead_id=${leadId} AND channel=${rendered.channel} AND COALESCE(provider_account_id,'')=${rendered.accountId}
      AND session_ended_at IS NULL AND status NOT IN ('closed','unsubscribed','opted_out') ORDER BY id DESC LIMIT 1`);
    let conversationId = found?.rows[0]?.id;
    if (!conversationId) {
      const conversation = await tx.execute(sql`INSERT INTO outreach_conversations(user_id,business_profile_id,lead_id,crm_contact_id,channel,
        provider_account_id,lead_name,lead_email,subject,metadata) VALUES(${userId},${scope.businessProfileId},${leadId},${contactId},${rendered.channel},
        ${rendered.accountId},${[contact.first_name,contact.last_name].filter(Boolean).join(' ')},${contact.email},${'subject' in rendered ? rendered.subject : null},'{"origin":"crm_automation"}'::jsonb) RETURNING id`);
      conversationId = conversation.rows[0].id;
    }
    const {redactPiiWithStableTokens} = await import('../agents/orchestration/PrivacyVaultService.js');
    const redacted = redactPiiWithStableTokens(rendered.message,{userId,conversationId:Number(conversationId)}).redactedText;
    const message = await tx.execute(sql`INSERT INTO outreach_messages(user_id,business_profile_id,conversation_id,direction,content,redacted_content,
      subject,status,provider_account_id,phone_number_id,is_automatic,message_kind,idempotency_key,metadata)
      VALUES(${userId},${scope.businessProfileId},${conversationId},'outbound',${rendered.message},${redacted},${'subject' in rendered ? rendered.subject : null},'pending',
        ${rendered.accountId},${rendered.channel === 'whatsapp' ? rendered.accountId : null},true,'reply',${`crm-automation-step-${step.id}`},
        ${JSON.stringify({origin:'crm_automation',automationRunId:step.run_id,automationStepId:step.id})}::jsonb) RETURNING id`);
    const messageId = Number(message.rows[0].id);
    await tx.execute(sql`UPDATE crm_automation_run_steps SET conversation_id=${conversationId},message_id=${messageId} WHERE id=${step.id}`);
    return {messageId,conversationId:Number(conversationId)};
  });
}

export async function prepareAutomationDelivery(userId: number, step: DeliveryStep, action: AutomationAction, context: AutomationContext) {
  const scope = automationScope(userId);
  if (action.type === 'webhook') {
    await assertPublicHttpUrl(String(action.config.url));
    return {kind:'webhook',url:String(action.config.url),body:renderAutomationJson(action.config.body,context)};
  }
  // Recheck current account/template readiness even when resuming a persisted, unsent intent.
  const current = await renderNotificationAction(userId,action,context,true);
  const rendered = step.prepared as unknown as PreparedNotification | undefined || current;
  const accountId = rendered.channel === 'email' ? (await import('../../models/emailSenders/functions.js')).getById : undefined;
  const sender = accountId ? await accountId(userId, Number('senderId' in rendered ? rendered.senderId : 0)) : undefined;
  if (step.prepared && !(step.prepared as Record<string, unknown>).customerDeliveryAssistant)
    throw new CustomerDeliverySetupError('queued_setup_review_required', 'This automation message has no reviewed assistant assignment. Review it after setup.');
  const assistant = await assertCustomerDeliveryReady({ userId, channel: rendered.channel, accountId: sender?.email || rendered.accountId,
    expected: (step.prepared as Record<string, unknown> | undefined)?.customerDeliveryAssistant as AssistantProvenance | undefined });
  Object.assign(rendered, { customerDeliveryAssistant: assistant });
  const { requireSubscriptionForOperation } = await import('../subscriptions/service.js');
  await requireSubscriptionForOperation(userId);
  const { SmartThrottlingService } = await import('../SmartThrottlingService.js');
  const throttle = SmartThrottlingService.getInstance();
  const slot = await throttle.isAllowed(rendered.channel,userId,rendered.accountId);
  if (!slot.allowed) throw new AutomationActionError(slot.reason || 'The sender rate limit has been reached.',false,true);
  if ((action.config.recipient as {mode?:string})?.mode === 'contact') {
    const history = await prepareContactHistory(userId,Number(context.contact?.id),step,rendered);
    step.message_id=history.messageId; step.conversation_id=history.conversationId;
  }
  await db.execute(sql`UPDATE crm_automation_run_steps SET prepared=${JSON.stringify(rendered)}::jsonb,channel=${rendered.channel},provider_account_id=${rendered.accountId}
    WHERE id=${step.id} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId}`);
  // WhatsApp accounts billed through our Meta credit line pay the admin-set
  // company-billed fee; Meta's message cost is reserved when the message is sent.
  const eventKey = rendered.channel === 'whatsapp'
    ? await (await import('../whatsapp/WhatsAppBillingService.js')).whatsappOutreachFeeKey(userId, rendered.accountId || undefined)
    : `outreach_${rendered.channel}`;
  const reservation = await creditService.deductOnceForResource({userId,eventKey,service:`crm_automation_${rendered.channel}`,
    referenceType:'crm_automation_step',referenceId:`${step.id}-attempt-${step.attempts}`,description:`CRM automation ${rendered.channel} notification`,
    metadata:{runId:step.run_id,stepId:step.id}});
  if (!reservation.success) throw new AutomationActionError(reservation.error || 'Insufficient notification credits.');
  step.reservation_transaction_id=reservation.transactionId;
  await db.execute(sql`UPDATE crm_automation_run_steps SET reservation_transaction_id=${reservation.transactionId || null} WHERE id=${step.id}`);
  return rendered;
}

/** Same advisory quota lock as Outreach, including fixed-recipient deliveries with no inbox message. */
export async function startAutomationDelivery(userId: number, step: DeliveryStep, automationId: number, prepared: Record<string, unknown>): Promise<void> {
  const scope=automationScope(userId), channel=String(prepared.channel || '');
  if (channel) {
    const receipt = prepared.customerDeliveryAssistant as AssistantProvenance | undefined;
    if (!receipt) throw new CustomerDeliverySetupError('queued_setup_review_required', 'Review this automation assistant assignment before delivery.');
    await assertCustomerDeliveryReady({ userId, channel, accountId: receipt.accountId, expected: receipt });
  }
  const limit=channel ? await getEffectiveDailyLimit(userId,channel) : 0;
  await db.transaction(async (tx: typeof db) => {
    await tx.execute(sql`SELECT id FROM crm_pipeline_automations WHERE id=${automationId} FOR SHARE`);
    const active=await tx.execute(sql`SELECT 1 FROM crm_pipeline_automations WHERE id=${automationId} AND user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND is_active AND deleted_at IS NULL`);
    if (!active.rows.length) throw new AutomationActionError('The automation was paused or deleted.');
    // Claim the provider boundary before checking quota. A second worker can neither
    // clear this checkpoint nor dispatch the same step during lease recovery.
    const claimed=await tx.execute(sql`UPDATE crm_automation_run_steps SET dispatch_started=true
      WHERE id=${step.id} AND status='running' AND dispatch_started=false RETURNING id`);
    if (!claimed.rows.length) throw new AutomationActionError('Another worker may have started this provider call. Check delivery before retrying.',true);
    if (channel) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${businessCacheKey(`outreach-daily:${userId}:${channel}`)}))`);
      const counts=await tx.execute(sql`SELECT
        (SELECT count(*) FROM outreach_messages m JOIN outreach_conversations c ON c.id=m.conversation_id WHERE c.user_id=${userId} AND c.channel IN (${channel},CASE WHEN ${channel}='email' THEN 'gmail' ELSE ${channel} END)
          AND m.direction='outbound' AND ((m.status IN ('sent','delivered','read') AND m.sent_at >= date_trunc('day',now() AT TIME ZONE 'UTC'))
            OR (m.provider_call_state IN ('started','unknown') AND m.send_claimed_at >= date_trunc('day',now() AT TIME ZONE 'UTC'))))
        +(SELECT count(*) FROM crm_automation_run_steps WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND channel=${channel}
          AND id<>${step.id} AND message_id IS NULL AND dispatch_started AND status IN ('running','success','uncertain') AND claimed_at >= date_trunc('day',now())) AS count`);
      if (Number(counts.rows[0].count) >= limit) throw new AutomationActionError('The daily notification limit has been reached.');
    }
    // Durable checkpoint commits before any provider call. A crash beyond it is uncertain.
    if (step.message_id) await tx.execute(sql`UPDATE outreach_messages SET status='sending',provider_call_state='started',send_claimed_at=now(),send_attempt_count=send_attempt_count+1 WHERE id=${step.message_id}`);
  });
}

export async function sendAutomationDelivery(userId: number, step: DeliveryStep, action: AutomationAction, prepared: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (action.type === 'webhook') return sendOwnedAutomationDelivery(userId, step, action, prepared);
  const receipt = prepared.customerDeliveryAssistant as AssistantProvenance | undefined;
  if (!receipt) throw new CustomerDeliverySetupError('queued_setup_review_required', 'Review this automation assistant assignment before delivery.');
  await assertCustomerDeliveryReady({ userId, channel: String(prepared.channel), accountId: receipt.accountId, expected: receipt });
  return withCustomerDeliveryReceipt(receipt, () => sendOwnedAutomationDelivery(userId, step, action, prepared));
}

async function sendOwnedAutomationDelivery(userId: number, step: DeliveryStep, action: AutomationAction, prepared: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (action.type === 'webhook') {
    try {
      const {response}=await fetchPublicHttpUrl(String(prepared.url),{method:'POST',headers:{...automationWebhookHeaders(action),
        'Content-Type':'application/json','Idempotency-Key':businessCacheKey(`crm-automation-step-${step.id}`)},body:JSON.stringify(prepared.body),signal:AbortSignal.timeout(15_000)},0);
      await response.body?.cancel();
      if (!response.ok) throw new AutomationActionError(`Webhook returned HTTP ${response.status}.`,response.status>=500,response.status===429);
      return {httpStatus:response.status};
    } catch(error) {
      if (error instanceof AutomationActionError) throw error;
      throw new AutomationActionError('The webhook outcome is uncertain. Reconcile the receiver before retrying.',true);
    }
  }
  const p=prepared as unknown as PreparedNotification;
  const { SmartThrottlingService }=await import('../SmartThrottlingService.js');
  try {
    const slot=await SmartThrottlingService.getInstance().claimRequest(p.channel,userId,p.accountId);
    if (!slot.allowed) throw new AutomationActionError(slot.reason || 'The sender rate limit has been reached.',false,true);
  }
  catch(error) {
    if (error instanceof AutomationActionError) throw error;
    throw new AutomationActionError('Sender rate limits could not be checked. Retry shortly.',false,true);
  }
  try {
    let receipt:string | undefined;
    let emailThread:string|undefined,rfcMessageId:string|undefined;
    if (p.channel==='email') {
      const {emailService}=await import('../emailService.js');
      const result=await emailService.sendEmailWithUserCredentials(userId,{to:p.recipient,subject:String('subject' in p ? p.subject || '' : ''),
        html:escapeOutreachHtml(p.message).replace(/\n/g,'<br>'),text:p.message,skipConversationLog:true,skipCreditDeduction:true,idempotencyKey:`crm-automation-step-${step.id}`},p.senderId);
      throwIfCustomerDeliverySetupRequired(result);
      receipt=result.providerMessageId || result.messageId;
      emailThread=result.threadId;rfcMessageId=result.rfcMessageId;
      if (!result.success || !receipt) throw new AutomationActionError('Email acceptance could not be confirmed. Check the sender before retrying.',
        result.outcomeUncertain!==false && result.deliveryAttempted!==false || result.success && !receipt,result.retryable===true);
    } else if (p.channel==='sms') {
      const {sendSMS}=await import('../smsService.js');
      const result=await sendSMS(userId,p.recipient,p.message,'flowId' in p ? p.flowId : undefined,p.accountId);
      receipt=result.messageId;
      if (!result.success || !receipt) throw new AutomationActionError(result.error || 'SMS acceptance could not be confirmed.',result.outcomeUncertain===true || result.success && !receipt,result.retryable===true);
    } else {
      const {whatsappApiService}=await import('../whatsappApiService.js');
      const result=await whatsappApiService.sendTemplate({userId,to:p.recipient.replace(/^\+/,''),phoneNumberId:p.accountId,
        templateName:String('templateName' in p ? p.templateName || '' : ''),language:String('language' in p ? p.language || '' : ''),components:'components' in p ? p.components || [] : []});
      receipt=result?.messages?.[0]?.id;
      if (!receipt) throw new AutomationActionError('WhatsApp acceptance could not be confirmed. Check delivery before retrying.',true);
    }
    return {recipient:p.recipient,channel:p.channel,providerMessageId:receipt,providerStatus:'accepted',...(emailThread ? {providerThreadId:emailThread} : {}),...(rfcMessageId ? {rfcMessageId} : {})};
  } catch(error) {
    if (deliverySetupFailure(error)) throw error;
    if (error instanceof AutomationActionError) throw error;
    const evidence=error as {outcomeUncertain?:boolean;deliveryAttempted?:boolean;status?:number;response?:{status?:number};code?:number};
    const providerStatus=evidence.status || evidence.response?.status || 0;
    const definitive=providerStatus<500 && (evidence.outcomeUncertain===false || evidence.deliveryAttempted===false);
    throw new AutomationActionError(definitive ? 'The notification provider rejected the request.' : 'Provider acceptance is uncertain. Reconcile delivery before retrying.',
      !definitive,providerStatus===429 || [4,17,32,130429,131048].includes(evidence.code || 0));
  }
}

export async function releaseAutomationReservation(userId:number,step:DeliveryStep):Promise<void> {
  if (!step.reservation_transaction_id) return;
  const result=await creditService.refundDeduction({userId,transactionId:step.reservation_transaction_id,description:'CRM automation notification was not accepted'});
  if (!result.success) throw new Error('Automation notification refund requires recovery.');
}
