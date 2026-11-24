"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import { cn } from "@/lib/utils";
import { formatCount, formatShare } from "./status";

/** The four numbers WhatsApp Manager leads with: sent, delivered, read and failed. */
export interface TrackingTotals {
  /** Messages in the set, sent or not. Omit when only sent messages are known. */
  total?: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
}

/** Sent, delivered, read and failed for everything the filters match. Skeletons hold the space on the first load. */
export function TrackingTotalsGrid({ totals, loading, receiptsReported = true }: {
  totals: TrackingTotals | undefined; loading: boolean; receiptsReported?: boolean;
}) {
  const waiting = !totals && loading;
  const receipt = (value: number) => receiptsReported ? formatCount(value) : undefined;
  return (
    <StatGrid columns={4} aria-label="Totals for these filters">
      <StatCard label="Messages sent" loading={waiting} value={totals ? formatCount(totals.sent) : undefined}
        description={totals?.total !== undefined ? `of ${formatCount(totals.total)} messages` : undefined} />
      <StatCard label="Delivered" loading={waiting} value={totals ? receipt(totals.delivered) : undefined}
        emptyValue="Not reported"
        description={totals && receiptsReported ? `${formatShare(totals.delivered, totals.sent)} of sent` : undefined} />
      <StatCard label="Read" loading={waiting} value={totals ? receipt(totals.read) : undefined}
        emptyValue="Not reported"
        description={totals && receiptsReported ? `${formatShare(totals.read, totals.delivered)} of delivered` : undefined} />
      <StatCard label="Failed" loading={waiting} value={totals ? formatCount(totals.failed) : undefined}
        tone={totals && totals.failed > 0 ? "destructive" : "neutral"}
        description={totals ? `${formatShare(totals.failed, (totals.total ?? totals.sent + totals.failed))} of messages` : undefined} />
    </StatGrid>
  );
}

const time = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });

/**
 * When the numbers were last read, whether they are refreshing on their own,
 * and a button to read them again now.
 */
export function RefreshStatus({ updatedAt, loading, live, onRefresh, className }: {
  updatedAt: number | null; loading: boolean; live: boolean; onRefresh: () => void; className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground", className)}>
      <span className="inline-flex items-center gap-1.5" aria-live="polite">
        {live ? (
          <span className="relative flex size-2" aria-hidden="true">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
        ) : null}
        {loading && updatedAt ? "Updating…" : updatedAt ? `Updated ${time.format(updatedAt)}` : loading ? "Loading…" : null}
        {live && !loading ? <span>· live</span> : null}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={loading} aria-label="Refresh these numbers">
        <RefreshCw className={cn(loading && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
        Refresh
      </Button>
    </div>
  );
}
