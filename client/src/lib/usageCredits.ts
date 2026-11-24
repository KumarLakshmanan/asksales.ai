/**
 * Usage rows (credit_event_logs) come in three kinds:
 * - a charge: positive credits, shown as a debit ("-5")
 * - a refund reversal: negative credits, shown as a credit back ("+5 refunded")
 * - a free action: 0 credits, shown as "Free"
 */
export function usageCredits(creditsUsed: string | number | null | undefined): {
  label: string;
  kind: "charge" | "refund" | "free";
  className: string;
} {
  const value = Number(creditsUsed) || 0;
  if (value < 0) {
    return { label: `+${Math.abs(value).toLocaleString()} refunded`, kind: "refund", className: "text-emerald-700 dark:text-emerald-400" };
  }
  if (value === 0) return { label: "Free", kind: "free", className: "text-muted-foreground" };
  return { label: `-${value.toLocaleString()}`, kind: "charge", className: "text-red-700 dark:text-red-400" };
}
