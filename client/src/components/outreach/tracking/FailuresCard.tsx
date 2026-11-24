"use client";

import { useEffect, useRef } from "react";
import { useTrackingQuery } from "@/hooks/use-outreach-tracking";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { OutreachFailureReason } from "../../../../../shared/outreachTracking";
import { failureExplanation, formatCount } from "./status";

interface FailuresCardProps {
  batchId: string;
  /** Failed, expired and needs-attention messages, from the summary. Zero skips the request. */
  problemCount: number;
  onShowRecipients: () => void;
  refreshVersion: number;
}

export function FailuresCard({ batchId, problemCount, onShowRecipients, refreshVersion }: FailuresCardProps) {
  const failures = useTrackingQuery<OutreachFailureReason[]>(problemCount > 0 ? `/api/outreach/batches/${batchId}/failures` : null);
  const { refetch } = failures;
  // Reload on the page's Refresh button and whenever the number of problems moves. The first load is the hook's own.
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) refetch();
    mounted.current = true;
  }, [refreshVersion, problemCount, refetch]);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <CardTitle>Why messages failed</CardTitle>
          <CardDescription>The reasons recorded for messages that failed, expired or need your attention.</CardDescription>
        </div>
        {problemCount > 0 ? <Button variant="outline" size="sm" onClick={onShowRecipients}>Show these recipients</Button> : null}
      </CardHeader>
      <CardContent>
        {problemCount === 0 ? (
          <p className="text-sm text-muted-foreground">No failures so far.</p>
        ) : failures.error ? (
          <Callout tone="danger" actions={<Button variant="outline" size="sm" onClick={failures.refetch}>Try again</Button>}>
            We couldn&apos;t load the failure reasons.
          </Callout>
        ) : !failures.data ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading failure reasons">
            <Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" />
          </div>
        ) : failures.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No failures so far.</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {failures.data.map(failure => {
              const explanation = failureExplanation(failure.providerCode, failure.reason);
              return (
                <li key={`${failure.providerCode}:${failure.reason}`} className="flex gap-4 p-3 text-sm">
                  <p className="w-16 shrink-0 text-right text-base font-semibold tabular-nums">{formatCount(failure.count)}</p>
                  <div className="min-w-0 flex-1">
                    <p className="break-words">{explanation}</p>
                    {explanation !== failure.reason || failure.providerCode ? (
                      <p className="mt-1 break-words text-xs text-muted-foreground">
                        {failure.providerCode ? `Provider code ${failure.providerCode}` : null}
                        {failure.providerCode && explanation !== failure.reason ? " · " : null}
                        {explanation !== failure.reason ? failure.reason : null}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
