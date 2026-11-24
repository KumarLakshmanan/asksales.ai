import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { requireBusinessScope } from '../../tenancy/businessContext.js';

export interface PaymentEvidence {
  bookingId: number;
  paymentId: string;
  amountMinor: number;
  currency: string;
  occurredAt: string;
  source: 'razorpay' | 'manual';
  refundId?: string;
}

export type PaymentEvidenceExecutor = Pick<typeof db, 'execute'>;

/** A verified capture or audited receipt is the only source of received revenue.
 * The same gateway payment/refund identity can be replayed without double counting.
 * A supplied transaction owns all booking validation and ledger writes; this helper
 * neither opens another transaction nor commits the caller's work. */
export async function recordPaymentEvidence(evidence: PaymentEvidence, tx?: PaymentEvidenceExecutor): Promise<void> {
  const scope=requireBusinessScope();
  if (!Number.isSafeInteger(evidence.bookingId) || evidence.bookingId<1 || !evidence.paymentId || evidence.paymentId.length>230
    || !Number.isSafeInteger(evidence.amountMinor) || evidence.amountMinor<=0 || !/^[A-Z]{3}$/.test(evidence.currency)
    || !Number.isFinite(Date.parse(evidence.occurredAt))) throw new Error('Invalid payment evidence.');
  if (evidence.refundId && !/^[\w-]{3,230}$/.test(evidence.refundId)) throw new Error('Invalid refund identity.');
  const kind=evidence.refundId?'payment_refunded':'payment_captured';
  const sourceKey=evidence.refundId?`${evidence.source}:refund:${evidence.refundId}`:`${evidence.source}:capture:${evidence.paymentId}`;
  const minor = BigInt(evidence.amountMinor);
  const amount = `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`;
  const record = async (tx: PaymentEvidenceExecutor): Promise<void> => {
  const result=await tx.execute(sql`SELECT b.id,b.user_id,b.business_profile_id,b.currency,b.payment_id,b.status,
    c.id AS conversation_id,c.channel,c.crm_contact_id
    FROM bookings b LEFT JOIN outreach_conversations c ON c.id=b.outreach_conversation_id AND c.business_profile_id=b.business_profile_id
    WHERE b.id=${evidence.bookingId} AND b.business_profile_id=${scope.businessProfileId} AND b.user_id=${scope.userId} LIMIT 1 FOR UPDATE OF b`);
  const booking=result.rows[0];
  if (!booking || String(booking.currency).toUpperCase()!==evidence.currency) throw new Error('Payment currency or booking mismatch.');
  if (evidence.source==='razorpay' && String(booking.payment_id)!==evidence.paymentId)
    throw new Error('Gateway payment does not match the booking.');
  const loadReceipt = () => tx.execute(sql`SELECT booking_id,kind,payment_id,currency,evidence,verified,
      amount=${amount}::numeric AS amount_matches FROM sales_outcome_events
      WHERE business_profile_id=${scope.businessProfileId} AND source_key=${sourceKey} LIMIT 1`);
  const assertReplay = (row: Record<string, unknown> | undefined): void => {
    if (!row || Number(row.booking_id)!==evidence.bookingId) {
      throw new Error('Payment identity belongs to a different booking.');
    }
    if (row.kind!==kind || row.payment_id!==evidence.paymentId || row.currency!==evidence.currency
      || row.evidence!==evidence.source || row.verified!==true || row.amount_matches!==true) {
      throw new Error('Payment identity was replayed with different evidence.');
    }
  };
  const existing=await loadReceipt();
  if (existing.rows.length) {
    // Exact historical receipts remain replayable after booking cancellation.
    assertReplay(existing.rows[0]);
    return;
  }
  if (evidence.refundId) {
    if (String(booking.payment_id)!==evidence.paymentId) throw new Error('Refund payment does not match the booking.');
    // The booking lock serializes refunds; PostgreSQL NUMERIC keeps the balance
    // exact for values such as a 0.30 capture and successive 0.10/0.20 refunds.
    const remaining=await tx.execute(sql`SELECT COALESCE(SUM(CASE WHEN kind='payment_captured'
        THEN amount ELSE -amount END),0) >= ${amount}::numeric AS sufficient FROM sales_outcome_events
      WHERE business_profile_id=${scope.businessProfileId} AND booking_id=${evidence.bookingId}
        AND kind IN ('payment_captured','payment_refunded') AND payment_id=${evidence.paymentId}
        AND currency=${evidence.currency} AND verified=true`);
    if (remaining.rows[0]?.sufficient!==true) {
      throw new Error('Refund exceeds verified payment.');
    }
  } else if (booking.status!=='confirmed') throw new Error('Payment is not attached to a confirmed booking.');
  const inserted = await tx.execute(sql`INSERT INTO sales_outcome_events
    (business_profile_id,user_id,actor_user_id,source_key,kind,contact_id,booking_id,conversation_kind,conversation_id,
      channel,amount,currency,evidence,payment_id,verified,occurred_at)
    VALUES (${scope.businessProfileId},${scope.userId},${scope.actorUserId||scope.userId},${sourceKey},${kind},
      ${booking.crm_contact_id?Number(booking.crm_contact_id):null},${evidence.bookingId},
      ${booking.conversation_id?'outreach':null},${booking.conversation_id?Number(booking.conversation_id):null},
      ${booking.conversation_id?String(booking.channel):'unattributed'},${amount}::numeric,${evidence.currency},
      ${evidence.source},${evidence.paymentId},true,${new Date(evidence.occurredAt)}) ON CONFLICT DO NOTHING RETURNING booking_id`);
  if (!inserted.rows.length) {
    // Different booking locks do not serialize the same receipt/source identity.
    // A competing insert may win after the earlier replay lookup returned empty.
    const winner = await loadReceipt();
    assertReplay(winner.rows[0]);
  }
  };
  if (tx) await record(tx);
  else await db.transaction(record);
}
