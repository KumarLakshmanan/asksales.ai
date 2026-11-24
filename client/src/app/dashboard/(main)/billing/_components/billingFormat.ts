import { getBillingReferenceMeta } from "./billingMetadata";

/** Types and display helpers shared by the billing spend views. */

export interface ReferenceGroup {
  referenceType: string;
  referenceId: string;
  totalCredits: number;
  eventCount: number;
  lastUsed: string;
  description: string;
  title: string | null;
}

export interface EventLog {
  id: number;
  eventKey: string;
  creditsUsed: string;
  balanceAfter: string;
  description: string | null;
  service: string | null;
  apiProvider: string | null;
  apiCostCents: number | null;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatCredits(val: number): string {
  if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`;
  if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
  return val.toLocaleString();
}

export function formatApiCost(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(cents / 100);
}

/** The display title for a spend reference: its title, its description, or "<type label> #<id>". */
export function getRefTitle(ref: ReferenceGroup): string {
  if (ref.title) return ref.title;
  if (ref.description) return ref.description;
  const meta = getBillingReferenceMeta(ref.referenceType);
  return `${meta.label} #${ref.referenceId}`;
}

/** A stable key for a spend reference. */
export function getRefKey(ref: ReferenceGroup): string {
  return `${ref.referenceType}:${ref.referenceId}`;
}
