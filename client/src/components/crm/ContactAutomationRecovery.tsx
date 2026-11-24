"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

type Status =
  | "pending"
  | "processing"
  | "completed"
  | "queued"
  | "review_required";
interface Handoff {
  transitionId: number;
  status: Status;
  events: Array<{
    type: string;
    status: Status;
    oldValue: string;
    newValue: string;
  }>;
}
interface Page {
  data: Handoff[];
  pagination: { page: number; totalPages: number };
}
const labels: Record<Status, string> = {
  pending: "Evaluation pending",
  processing: "Evaluation started; completion unconfirmed",
  completed: "Evaluation completed",
  queued: "Queued by the automation engine",
  review_required: "Review required",
};
export function ContactAutomationRecovery({
  contactId,
  scope,
  revision,
  onChanged,
}: {
  contactId: number;
  scope: string;
  revision?: string;
  onChanged: () => Promise<unknown>;
}) {
  const [page, setPage] = useState(1),
    [busy, setBusy] = useState<number | null>(null),
    [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const query = useQuery({
    queryKey: ["crm-automation-handoffs", scope, contactId, revision, page],
    queryFn: ({ signal }) =>
      api.get<Page>(`/api/crm/contacts/${contactId}/automation-handoffs`, {
        signal,
        params: { page, limit: 10 },
      }),
    enabled: contactId > 0,
    retry: false,
  });
  const retry = async (id: number) => {
    if (busy !== null) return;
    setBusy(id);
    setError("");
    try {
      await api.post(
        `/api/crm/contacts/${contactId}/automation-handoffs/${id}/retry`,
        {},
      );
      if (alive.current) {
        await query.refetch();
        await onChanged();
      }
    } catch {
      if (alive.current)
        setError(
          "Recovery status could not be confirmed. Refresh the receipt before trying again.",
        );
    } finally {
      if (alive.current) setBusy(null);
    }
  };
  if (contactId < 0) return null;
  return (
    <section
      aria-label="Automation recovery"
      id="automation-recovery"
      className="space-y-3"
    >
      <h2 className="text-sm font-semibold">Automation recovery</h2>
      {query.error ? (
        <Alert>
          <AlertTitle>Recovery status unavailable</AlertTitle>
          <AlertDescription>
            The contact remains saved. Check status before retrying effects.
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
            >
              Refresh recovery status
            </Button>
          </AlertDescription>
        </Alert>
      ) : query.isPending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading automation receipts…
        </p>
      ) : !query.data?.data.length ? (
        <p className="text-xs text-muted-foreground">
          No recovery receipts for recent manual changes.
        </p>
      ) : (
        query.data.data.map((receipt) => (
          <Alert
            key={receipt.transitionId}
            id={`automation-transition-${receipt.transitionId}`}
          >
            <AlertTitle>
              Saved transition #{receipt.transitionId} ·{" "}
              {labels[receipt.status]}
            </AlertTitle>
            <AlertDescription>
              <ul className="my-2 space-y-1">
                {receipt.events.map((event) => (
                  <li key={event.type}>
                    {event.type === "status_change" ? "Lifecycle" : "Stage"}:{" "}
                    {event.oldValue} → {event.newValue} · {labels[event.status]}
                  </li>
                ))}
              </ul>
              {receipt.events.some((event) => event.status === "pending") && (
                <>
                  <p>
                    Only pending discovery is retried. Completed or started
                    evaluations are preserved.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void retry(receipt.transitionId)}
                  >
                    {busy === receipt.transitionId
                      ? "Checking evaluation…"
                      : "Retry pending evaluation"}
                  </Button>
                </>
              )}
              {receipt.events.some((event) =>
                ["processing", "review_required"].includes(event.status),
              ) && (
                <p>
                  Review this transition’s activity and automation logs before
                  any manual resend. Legacy evaluations may have no automation
                  run.
                </p>
              )}
              <a
                className="ml-2 text-xs underline"
                href={`#automation-transition-${receipt.transitionId}`}
              >
                Link to transition #{receipt.transitionId}
              </a>
            </AlertDescription>
          </Alert>
        ))
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!!query.data?.data.length && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            Refresh recovery status
          </Button>
          {query.data.pagination.totalPages > 1 && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={page === 1 || query.isFetching}
                onClick={() => setPage(page - 1)}
              >
                Previous receipts
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  page >= query.data.pagination.totalPages || query.isFetching
                }
                onClick={() => setPage(page + 1)}
              >
                Next receipts
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
