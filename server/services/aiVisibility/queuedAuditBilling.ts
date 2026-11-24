import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { currentBusinessScope } from '../../tenancy/businessContext.js';
import { SubscriptionError } from '../subscriptions/gateway.js';

const CANCELLATION_REASON = 'Audit cancelled before starting because organization membership or subscription access is no longer available.';
const PREVIOUS_CANCELLATION_REASON = 'Audit cancelled before starting because access to its billing organization was removed.';

/** An audit can be prepaid while eligible, then lose its subscription before
 * the worker starts. Release its original charge only on a definitive denial;
 * lookup/provider failures remain retryable without cancelling the audit. */
export async function requireQueuedAuditSubscription(userId:number,auditId:number,organizationId:number):Promise<void> {
  const { requireSubscriptionForOperation } = await import('../subscriptions/service.js');
  try {
    await requireSubscriptionForOperation(userId);
  } catch(error) {
    if(error instanceof SubscriptionError && error.status===402 && error.code==='SUBSCRIPTION_REQUIRED') {
      await cancelUnstartedAuditForBilling(userId,auditId,organizationId);
    }
    throw error;
  }
}

/** Release only prepaid, unstarted audit work after its original payer rejects
 * the queued actor. The durable cancellation commits before the refund so a
 * crash can retry settlement without allowing the audit to start again. */
export async function cancelUnstartedAuditForBilling(
  userId: number,
  auditId: number,
  organizationId: number,
): Promise<boolean> {
  return settleQueuedAuditCancellation(userId,auditId,organizationId,true);
}

/** A retry may regain organization access after cancellation but before its
 * refund succeeds. Finish that existing cancellation without cancelling new work. */
export async function resumeCancelledAuditBilling(
  userId: number,
  auditId: number,
  organizationId: number,
): Promise<boolean> {
  return settleQueuedAuditCancellation(userId,auditId,organizationId,false);
}

async function settleQueuedAuditCancellation(userId:number,auditId:number,organizationId:number,allowQueued:boolean):Promise<boolean> {
  const business = currentBusinessScope();
  if (!business || business.userId !== userId) throw new Error('Audit cleanup requires its owning business scope.');
  if (![userId,auditId,organizationId].every(id => Number.isSafeInteger(id) && id > 0)) {
    throw new Error('Invalid queued audit billing identity.');
  }
  const pending = await db.transaction(async (tx: typeof db) => {
    const result = await tx.execute(sql`SELECT id,status,started_at,settled_at,error,billing_mode,
      initial_charge_transaction_id,reservation_transaction_id,actual_credits,reserved_credits
      FROM ai_visibility_audits WHERE id=${auditId} AND user_id=${userId}
      AND business_profile_id=${business.businessProfileId} FOR UPDATE`);
    const audit = result.rows[0];
    if (!audit || audit.started_at || audit.settled_at) return null;
    // Only our durable cancellation can resume a partially completed refund.
    if (!(allowQueued && audit.status === 'queued') && !(audit.status === 'cancelled' && [CANCELLATION_REASON,PREVIOUS_CANCELLATION_REASON].includes(audit.error))) return null;
    const reservation = audit.billing_mode === 'reservation';
    const transactionId = Number(reservation ? audit.reservation_transaction_id : audit.initial_charge_transaction_id) || null;
    if (transactionId) {
      const original = await tx.execute(sql`SELECT organization_id FROM wallet_transactions
        WHERE id=${transactionId} AND user_id=${userId} AND type='deduction'
        AND reference_type='ai_visibility_audit' AND reference_id=${String(auditId)}`);
      if (Number(original.rows[0]?.organization_id) !== organizationId) {
        throw new Error('Queued audit does not match its original billing transaction.');
      }
    } else if (Number(reservation ? audit.reserved_credits : audit.actual_credits) > 0) {
      throw new Error('Prepaid audit has no original transaction available for settlement.');
    }
    await tx.execute(sql`UPDATE ai_visibility_audits SET status='cancelled',cancellation_requested=true,
      error=${CANCELLATION_REASON},completed_at=COALESCE(completed_at,now()),updated_at=now()
      WHERE id=${auditId} AND user_id=${userId} AND business_profile_id=${business.businessProfileId}`);
    await tx.execute(sql`UPDATE ai_visibility_audit_stages SET status='cancelled',error=${CANCELLATION_REASON},
      completed_at=now(),updated_at=now() WHERE audit_id=${auditId} AND user_id=${userId}
      AND business_profile_id=${business.businessProfileId} AND status='pending'`);
    return {transactionId,reservation};
  });
  if (!pending) return false;
  if (pending.transactionId) {
    const { creditService } = await import('../CreditService.js');
    const options = {userId,transactionId:pending.transactionId,description:`AI Visibility audit ${auditId} cancelled before starting`};
    // These methods lock the recorded deduction and refund its recorded wallet.
    // They do not resolve the resource's new billing organization.
    const refund = pending.reservation
      ? await creditService.settleReservation({...options,actualCredits:0})
      : await creditService.refundDeduction(options);
    if (!refund.success) throw new Error(refund.error || 'Queued audit refund failed.');
  }
  await db.execute(sql`UPDATE ai_visibility_audits SET actual_credits=0,settled_at=now(),updated_at=now()
    WHERE id=${auditId} AND user_id=${userId} AND business_profile_id=${business.businessProfileId}
    AND status='cancelled' AND error=${CANCELLATION_REASON} AND settled_at IS NULL`);
  return true;
}
