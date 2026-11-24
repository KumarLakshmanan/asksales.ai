/** A failure can retain its audit status after reconciliation. Keep it out of
 * the action queue only when that reconciliation still describes this row. */
export function hasCurrentDeliveryReconciliation(action: {
  status: string;
  reconciledAt?: string | null;
  updatedAt?: string | null;
  nextAttemptAt?: string | null;
  leaseExpiresAt?: string | null;
}): boolean {
  if (action.status !== 'failed' || !action.reconciledAt || !action.updatedAt
    || action.nextAttemptAt || action.leaseExpiresAt) return false;
  const reconciled = Date.parse(action.reconciledAt);
  const updated = Date.parse(action.updatedAt);
  return Number.isFinite(reconciled) && Number.isFinite(updated) && updated <= reconciled;
}
