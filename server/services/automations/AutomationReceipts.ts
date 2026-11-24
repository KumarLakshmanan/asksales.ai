import {sql} from 'drizzle-orm';
import {db} from '../../models/db.js';
import {requireBusinessScope} from '../../tenancy/businessContext.js';
import {eventBus,EVENT_CHANNELS} from '../../events/EventBus.js';

export async function notifyAutomationReceiptUpdate(userId:number):Promise<void> {
  const scope=requireBusinessScope();
  if (scope.userId!==userId) return;
  await eventBus.publish({channel:EVENT_CHANNELS.CRM_AUTOMATION_UPDATED,userId,businessProfileId:scope.businessProfileId,
    timestamp:new Date().toISOString(),data:{receipt:true}}).catch(()=>undefined);
}

/** Called only inside the verified provider callback's persisted business scope. */
export async function recordAutomationReceipt(userId:number,input:{channel:'email'|'whatsapp'|'sms';accountId:string;messageId:string;status:string;occurredAt?:Date;recipient?:string},executor:Pick<typeof db,'execute'>=db):Promise<number> {
  const scope=requireBusinessScope();
  if (scope.userId!==userId || !input.accountId || !input.messageId || !['sent','accepted','delivered','read','failed','bounced'].includes(input.status)) return 0;
  // Mixed schema rollout must not interrupt legacy delivery callbacks.
  const ready=await executor.execute(sql`SELECT to_regclass('crm_automation_receipts') IS NOT NULL AS ready`);
  if (!ready.rows[0]?.ready) return 0;
  await executor.execute(sql`INSERT INTO crm_automation_receipts(user_id,business_profile_id,channel,provider_account_id,provider_message_id,status,occurred_at)
    VALUES(${userId},${scope.businessProfileId},${input.channel},${input.accountId},${input.messageId},${input.status},${(input.occurredAt || new Date()).toISOString()}::timestamptz)
    ON CONFLICT(business_profile_id,user_id,channel,provider_account_id,provider_message_id,status) DO NOTHING`);
  const result=await executor.execute(sql`UPDATE crm_automation_run_steps SET provider_status=CASE
    WHEN ${input.status}='read' THEN 'read' WHEN ${input.status}='delivered' AND COALESCE(provider_status,'')<>'read' THEN 'delivered'
    WHEN ${input.status} IN ('failed','bounced') AND COALESCE(provider_status,'') NOT IN ('delivered','read') THEN 'failed' ELSE COALESCE(provider_status,'accepted') END
    WHERE user_id=${userId} AND business_profile_id=${scope.businessProfileId} AND channel=${input.channel} AND provider_account_id=${input.accountId} AND provider_message_id=${input.messageId}
      AND (${!input.recipient} OR regexp_replace(COALESCE(prepared->>'recipient',''),'[^0-9]','','g')=${String(input.recipient || '').replace(/\D/g,'')}) RETURNING id`);
  if (result.rows.length && executor===db) await notifyAutomationReceiptUpdate(userId);
  return result.rows.length;
}

/** Delivery callbacks can arrive before the send response has been checkpointed. */
export async function applyAutomationReceipts(stepId:number,executor:Pick<typeof db,'execute'>=db):Promise<void> {
  await executor.execute(sql`UPDATE crm_automation_run_steps step SET provider_status=(SELECT receipt.status FROM crm_automation_receipts receipt
    WHERE receipt.user_id=step.user_id AND receipt.business_profile_id=step.business_profile_id AND receipt.channel=step.channel
      AND receipt.provider_account_id=step.provider_account_id AND receipt.provider_message_id=step.provider_message_id
    ORDER BY CASE receipt.status WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'failed' THEN 2 WHEN 'bounced' THEN 2 ELSE 1 END DESC LIMIT 1)
    WHERE step.id=${stepId} AND EXISTS(SELECT 1 FROM crm_automation_receipts receipt WHERE receipt.user_id=step.user_id AND receipt.business_profile_id=step.business_profile_id
      AND receipt.channel=step.channel AND receipt.provider_account_id=step.provider_account_id AND receipt.provider_message_id=step.provider_message_id)`);
}
