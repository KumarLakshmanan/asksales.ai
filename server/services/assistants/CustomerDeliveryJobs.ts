import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { currentBusinessScope, withBusinessScope } from '../../tenancy/businessContext.js';
import type { AssistantProvenance } from '../../../shared/outreachAssistants.js';
import { assertCustomerDeliveryReady, assertCustomerDeliveryRuntime, CustomerDeliverySetupError, deliverySetupFailure, withCustomerDeliveryReceipt } from './CustomerDeliveryGate.js';

type Payload = Record<string, any>;
const SEND_JOBS = new Set(['send_email', 'send_sms', 'send_follow_up_email', 'send_follow_up_sms',
  'send_follow_up_social', 'send_outreach_message', 'start_outreach_campaign']);
export const isCustomerDeliveryJob = (name: string) => SEND_JOBS.has(name);

async function identity(name: string, data: Payload) {
  const userId = Number(data.userId);
  const channel = name.includes('email') ? 'email' : name.includes('sms') ? 'sms' : String(data.channel || '').replace(/^gmail$/, 'email');
  assertCustomerDeliveryRuntime(channel);
  const scope = currentBusinessScope();
  if (!scope || scope.userId !== userId || (data.businessProfileId && data.businessProfileId !== scope.businessProfileId))
    throw new CustomerDeliverySetupError('business_scope_required', 'The queued delivery does not match its persisted business. Review its original account.');
  let senderId = Number(data.senderId) || undefined;
  let accountId = String(data.providerAccountId || data.phoneNumberId || '');
  let originalSenderId: number | undefined;
  // Persisted conversations and follow-up anchors override mutable UI/default selections.
  const conversationId = Number(data.conversationId);
  if (conversationId > 0) {
    const result = await db.execute(sql`SELECT channel,provider_account_id,
      (SELECT m.metadata->'outreachCreation'->'delivery'->>'senderId' FROM outreach_messages m WHERE m.conversation_id=c.id
        AND m.user_id=c.user_id AND m.direction='outbound' AND m.metadata->'outreachCreation' IS NOT NULL ORDER BY m.id LIMIT 1) AS original_sender_id
      FROM outreach_conversations c WHERE c.id=${conversationId} AND c.user_id=${userId} AND c.business_profile_id=${scope.businessProfileId}`);
    const row = result.rows[0];
    if (!row || String(row.channel).replace(/^gmail$/, 'email') !== channel || (accountId && accountId !== row.provider_account_id))
      throw new CustomerDeliverySetupError('account_changed', 'The queued conversation account changed. Review its assistant assignment before sending.');
    accountId = String(row.provider_account_id || '');
    originalSenderId = Number(row.original_sender_id) || undefined;
  }
  if (data.isFollowUp && channel === 'email') {
    const { getConfiguredFollowUpDeliveryBinding } = await import('../outreach/ConfiguredFollowUpDeliveryService.js');
    const original = await getConfiguredFollowUpDeliveryBinding(userId, 'email', Number(data.followUpOriginMessageId), Number(data.leadId), String(data.to || data.recipientEmail || ''));
    if (senderId && senderId !== original.senderId)
      throw new CustomerDeliverySetupError('account_changed', 'The follow-up sender changed. Review its original account assignment.');
    senderId = original.senderId;
  }
  if (channel === 'email') {
    const { getById, getDefault } = await import('../../models/emailSenders/functions.js');
    const sender = senderId ? await getById(userId, senderId) : !accountId ? await getDefault(userId) : undefined;
    if (sender) {
      if ((originalSenderId && originalSenderId !== sender.id) || (accountId && ![sender.email.toLowerCase(), sender.email.split('@')[1]?.toLowerCase()].includes(accountId.toLowerCase())))
        throw new CustomerDeliverySetupError('account_changed', 'The queued email sender does not match the original conversation account. Review its exact assignment.');
      senderId = sender.id; accountId = sender.email.toLowerCase();
    }
    else if (!accountId.includes('@'))
      throw new CustomerDeliverySetupError('account_required', 'The exact email sender is unresolved. Select an assigned, verified sender before queueing.');
  }
  // A queued Meta-approved template does not need the assistant's AI model.
  const approvedTemplate = channel === 'whatsapp' && typeof data.templateName === 'string' && data.templateName.trim() !== '';
  return { userId, channel, accountId, senderId, ...(approvedTemplate ? { approvedTemplate } : {}) };
}

export async function admitCustomerDeliveryJob<T extends Payload>(name: string, data: T): Promise<T & { customerDeliveryAssistant?: AssistantProvenance }> {
  if (!isCustomerDeliveryJob(name)) return data;
  const scope = currentBusinessScope();
  const check = async () => {
    const resolved = await identity(name, data);
    const provenance = await assertCustomerDeliveryReady({ ...resolved, expected: data.customerDeliveryAssistant });
    return { ...data, ...(resolved.senderId ? { senderId: resolved.senderId } : {}), customerDeliveryAssistant: provenance };
  };
  if (scope) return check();
  if (!Number.isSafeInteger(data.businessProfileId) || !Number.isSafeInteger(data.userId))
    throw new CustomerDeliverySetupError('business_scope_required', 'The queued delivery has no persisted business. Review it before sending.');
  return withBusinessScope({ userId: data.userId, businessProfileId: data.businessProfileId, actorUserId: data.businessActorUserId }, check);
}

/** No legacy queue may acquire a new assignment merely because setup later changes. */
export async function runCustomerDeliveryJob<T>(name: string, data: Payload, work: () => Promise<T>): Promise<T> {
  if (!isCustomerDeliveryJob(name)) return work();
  if (data.customerDeliveryStatus === 'setup_required' || data.customerDeliverySetup)
    throw new CustomerDeliverySetupError('queued_setup_review_required', 'This message was held for assistant setup. Prepare a newly reviewed delivery; changing setup cannot release the held job.');
  const receipt = data.customerDeliveryAssistant as AssistantProvenance | undefined;
  if (!receipt)
    throw new CustomerDeliverySetupError('queued_setup_review_required', 'This unsent queued message has no reviewed assistant assignment. Review and queue it again after setup; automatic replay is blocked.');
  const resolved = await identity(name, data);
  await assertCustomerDeliveryReady({ ...resolved, expected: receipt });
  return withCustomerDeliveryReceipt(receipt, work);
}

export async function holdCustomerDeliveryJob(data: Payload, error: unknown) {
  const failure = deliverySetupFailure(error);
  if (!failure) return;
  const ids = [data.messageId, data.followUpMessageId, data.socialFollowUpMessageId].map(Number).filter(n => Number.isSafeInteger(n) && n > 0);
  for (const id of new Set(ids)) {
    await db.execute(sql`UPDATE outreach_messages SET status='setup_required',error_message=${failure.error},
      metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('customerDeliverySetup',${JSON.stringify(failure)}::jsonb),updated_at=NOW()
      WHERE id=${id} AND user_id=${Number(data.userId)} AND direction='outbound'
        AND status IN ('pending','queued','scheduled','failed','sending')
        AND COALESCE(provider_call_state,'not_started')='not_started' AND COALESCE(manual_review_required,false)=false`);
  }
}
