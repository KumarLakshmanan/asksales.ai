"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { creatorSessionScope } from "@/lib/creator-session";
import { subscribeBusinessProfile } from "@/lib/business-profile";
import { RefreshCw } from "lucide-react";

interface ChannelQueue {
  channel: string;
  accepted: number;
  delivered: number;
  queued: number;
  processing: number;
  retrying: number;
  failed: number;
  review: number;
  nextAttemptAt: string | null;
  waiting: Array<{
    id: string;
    reason: string | null;
    nextAttemptAt: string | null;
    error: string | null;
  }>;
}
const labels: Record<string, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  instagram: "Instagram",
  facebook: "Facebook Messenger",
  sms: "SMS",
};
function time(value: string | null) {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString()
    : "As capacity becomes available";
}

export function OutreachQueue() {
  const scope = useSyncExternalStore(subscribeBusinessProfile, creatorSessionScope, () => "anonymous");
  return <ScopedOutreachQueue key={scope} />;
}

function ScopedOutreachQueue() {
  const [data, setData] = useState<{
    channels: ChannelQueue[];
    checkedAt: string;
  } | null>(null);
  const [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const load = () => {
      // Skip hidden tabs and never stack a second read on one still running.
      if (document.hidden || inFlight) return;
      inFlight = true;
      void api
        .get<{ channels: ChannelQueue[]; checkedAt: string }>(
          "/api/outreach-conversations/queue",
          { signal: controller.signal },
        )
        .then((result) => {
          if (!Array.isArray(result?.channels))
            throw new Error("Invalid queue response");
          if (!controller.signal.aborted) {
            setData(result);
            setError("");
          }
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError("The queue could not be refreshed.");
        })
        .finally(() => { inFlight = false; });
    };
    load();
    document.addEventListener("visibilitychange", load);
    const timer = setInterval(load, 30_000);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [refresh]);
  return (
    <section
      id="outreach-queue"
      className="workspace-panel space-y-3 rounded-lg border bg-card p-4"
      aria-label="Outreach queue"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Outreach queue</h2>
          <p className="text-xs text-muted-foreground">
            All outreach and follow-ups · refreshes every 30 seconds
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
        {data?.checkedAt && <p className="text-[11px] text-muted-foreground">Snapshot: {new Date(data.checkedAt).toLocaleString()}</p>}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRefresh((n) => n + 1)}
        >
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          Refresh queue
        </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}{" "}
          {data
            ? "Showing the previous snapshot."
            : "Retry to load current counts."}
        </p>
      )}
      {!data ? (
        !error && (
          <p role="status" className="text-sm">
            Loading queue…
          </p>
        )
      ) : (
        <div className="overflow-x-auto">
          <table className="workspace-table w-full min-w-[800px] text-left text-xs">
            <caption className="sr-only">
              Provider acceptance, confirmed delivery and pending outreach by
              channel
            </caption>
            <thead>
              <tr>
                {[
                  "Channel",
                  "Accepted",
                  "Delivered",
                  "Queued",
                  "Sending",
                  "Retrying",
                  "Failed",
                  "Needs review",
                  "Next attempt",
                ].map((label) => (
                  <th
                    key={label}
                    className="whitespace-nowrap border-b p-2 font-medium"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.keys(labels).map((channel) => {
                const row = data.channels.find(
                  (item) => item.channel === channel,
                );
                return (
                  <tr key={channel}>
                    <th
                      scope="row"
                      className="whitespace-nowrap p-2 font-medium"
                    >
                      {labels[channel]}
                    </th>
                    {(
                      [
                        "accepted",
                        "delivered",
                        "queued",
                        "processing",
                        "retrying",
                        "failed",
                        "review",
                      ] as const
                    ).map((key) => (
                      <td key={key} className="p-2 tabular-nums">
                        {key === 'review' && (row?.[key] ?? 0) > 0 ? <span className="rounded border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-800 dark:text-amber-200">{row?.[key]}</span> : row?.[key] ?? 0}
                      </td>
                    ))}
                    <td className="whitespace-nowrap p-2">
                      {row?.queued ? time(row.nextAttemptAt) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="border-t bg-muted/40 font-semibold"><tr><th scope="row" className="p-2">TOTAL</th>{(['accepted','delivered','queued','processing','retrying','failed','review'] as const).map(key => <td key={key} className="p-2 tabular-nums">{data.channels.reduce((sum, row) => sum + row[key], 0)}</td>)}<td className="p-2">—</td></tr></tfoot>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Delivered is included in accepted. Retrying is included in queued.
        Provider acceptance does not guarantee delivery. A provider cooldown or
        the app’s daily allowance can delay sending; expired messaging windows
        and permanent errors require review.
      </p>
      {data?.channels.some((row) => row.waiting.some(item => item.reason)) && (
        <details className="rounded-lg border px-3 py-2" open>
          <summary className="cursor-pointer text-xs font-medium">
            Why messages are waiting
          </summary>
          <ul className="mt-2 space-y-2 text-xs">
            {data.channels.flatMap((row) =>
              row.waiting
                .filter((item) => item.reason)
                .map((item) => (
                  <li key={item.id} className="rounded border-b px-2 py-1.5 last:border-0">
                    {labels[row.channel] || row.channel} ·{" "}
                    {item.reason === "daily_allowance"
                      ? "Daily sending allowance reached"
                      : "Provider cooldown"}{" "}
                    · Next attempt: {time(item.nextAttemptAt)}
                  </li>
                )),
            )}
          </ul>
        </details>
      )}
    </section>
  );
}
