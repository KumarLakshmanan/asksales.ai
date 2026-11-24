"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import {
  deliveredCount, failedCount, reachedCount, waitingCount,
  type BatchCounts, type ReceiptSupport, type RecipientFilter,
} from "../../../../../shared/outreachTracking";
import { formatCount, formatShare, receiptValue } from "./status";

/**
 * The follow-up messages of an outreach, kept apart from the first message so
 * the outreach's own numbers stay one message per recipient.
 */
export function FollowUpsCard({ counts, receiptSupport, onShowRecipients }: {
  counts: BatchCounts;
  receiptSupport: ReceiptSupport;
  onShowRecipients: (filter: RecipientFilter) => void;
}) {
  const reached = reachedCount(counts), delivered = deliveredCount(counts), failed = failedCount(counts), waiting = waitingCount(counts);
  const noReceipts = receiptSupport === "none";
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>Follow-ups</CardTitle>
          <CardDescription>
            {formatCount(counts.total)} follow-up {counts.total === 1 ? "message" : "messages"} to people who didn&apos;t reply to the first one.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => onShowRecipients("all")}>Show follow-up recipients</Button>
      </CardHeader>
      <CardContent>
        <StatGrid columns={3} className="grid-cols-2 lg:grid-cols-5" aria-label="Follow-up summary" role="group">
          <StatCard label="Sent" value={formatCount(reached)} description={`${formatShare(reached, counts.total)} of follow-ups`} />
          <StatCard label="Delivered" value={receiptValue(receiptSupport, delivered)}
            description={noReceipts ? "The channel doesn't report this" : `${formatShare(delivered, reached)} of sent`} />
          <StatCard label="Read" value={receiptValue(receiptSupport, counts.read)}
            description={noReceipts ? "The channel doesn't report this" : `${formatShare(counts.read, delivered)} of delivered`} />
          <StatCard label="Failed" value={formatCount(failed)} tone={failed > 0 ? "destructive" : "neutral"}
            description={failed > 0 ? "Not sent" : "None so far"} />
          <StatCard label="Still waiting" value={formatCount(waiting)} tone={waiting > 0 ? "warning" : "neutral"}
            description={waiting === 0 ? "Nothing left to send" : "Goes out on each follow-up's schedule"} />
        </StatGrid>
      </CardContent>
    </Card>
  );
}
