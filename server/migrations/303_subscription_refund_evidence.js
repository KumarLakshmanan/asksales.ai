/** Preserve completed deposits while recording provider refunds and stopping
 * the unpaid remainder of their subscription credit schedule. */
export async function up(db) {
  await db.query(`
    ALTER TABLE subscription_charges
      ADD COLUMN refund_amount_paise integer NOT NULL DEFAULT 0,
      ADD COLUMN refund_observed_at timestamptz,
      ADD CONSTRAINT subscription_charge_refund_amount CHECK(refund_amount_paise>=0 AND refund_amount_paise<=amount_paise);
    ALTER TABLE subscription_credit_grants
      ADD COLUMN cancelled_at timestamptz,
      ADD COLUMN cancellation_reason text,
      ADD CONSTRAINT subscription_grant_not_cancelled_and_granted CHECK(cancelled_at IS NULL OR granted_at IS NULL);
    DROP INDEX subscription_credit_grants_due;
    CREATE INDEX subscription_credit_grants_due ON subscription_credit_grants(due_at)
      WHERE granted_at IS NULL AND cancelled_at IS NULL;
  `);
}

export async function down() {
  throw new Error('Subscription refund evidence and cancelled deposits must be preserved. Use a reviewed forward migration.');
}

// Preflight must refuse this batch before any down SQL executes.
export const irreversible = true;
