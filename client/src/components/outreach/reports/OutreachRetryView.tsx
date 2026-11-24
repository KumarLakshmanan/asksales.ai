"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { RotateCw } from "lucide-react";
import api from "@/lib/api";
import { creatorSessionScope } from "@/lib/creator-session";
import {
  selectedBusinessProfileId,
  subscribeBusinessProfile,
} from "@/lib/business-profile";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "@/components/ui/page-header";
import { OperationResultCard } from "@/components/operations/OperationResultCard";
import {
  campaignReportUrl,
  type CampaignReportFilters,
} from "../../../../../shared/campaignReporting";
import type { OutreachRetryPreview } from "../../../../../shared/outreachRetries";
const date = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "When the worker next runs";
export function OutreachRetryView() {
  const scope = useSyncExternalStore(
    subscribeBusinessProfile,
    creatorSessionScope,
    () => "anonymous",
  );
  return <RetryWorkspace key={scope} scope={scope} />;
}
function RetryWorkspace({ scope }: { scope: string }) {
  const params = useSearchParams(),
    [preview, setPreview] = useState<OutreachRetryPreview>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const [filters] = useState(
    () =>
      Object.fromEntries(
        [
          "workspaceId",
          "campaignId",
          "preparedOutreachId",
          "importId",
          "importSource",
          "channel",
          "accountId",
          "from",
          "to",
          "messageKind",
        ].flatMap((key) => (params.get(key) ? [[key, params.get(key)]] : [])),
      ) as unknown as CampaignReportFilters,
  );
  const [initialId] = useState(params.get("operationId"));
  const current = () => creatorSessionScope() === scope;
  function accept(value: OutreachRetryPreview) {
    if (!current()) return;
    if (value.businessProfileId !== selectedBusinessProfileId())
      throw new Error(
        "Select the original business to open this retry review.",
      );
    setPreview(value);
  }
  useEffect(() => {
    if (!initialId) return;
    const controller = new AbortController();
    api
      .get<OutreachRetryPreview>(
        `/api/outreach/retries/${encodeURIComponent(initialId)}`,
        { signal: controller.signal },
      )
      .then((value) => {
        if (!controller.signal.aborted) accept(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted && current())
          setError(
            reason instanceof Error
              ? reason.message
              : "Retry review unavailable.",
          );
      });
    return () => controller.abort();
    // This workspace remounts when the authenticated business changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialId, scope]);
  useEffect(() => {
    if (!preview || !["queued", "running"].includes(preview.status)) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        api
          .get<OutreachRetryPreview>(`/api/outreach/retries/${preview.id}`, {
            signal: controller.signal,
          })
          .then(accept)
          .catch((reason) => {
            if (!controller.signal.aborted && current())
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Progress unavailable; refresh to check it.",
              );
          }),
      2000,
    );
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, scope]);
  async function run(apply = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      accept(
        apply && preview
          ? await api.post<OutreachRetryPreview>(
              `/api/outreach/retries/${preview.id}/apply`,
              { fingerprint: preview.fingerprint, confirmed: true },
            )
          : await api.post<OutreachRetryPreview>(
              "/api/outreach/retries/preview",
              filters,
            ),
      );
      setConfirmed(false);
    } catch (reason) {
      if (current())
        setError(
          reason instanceof Error
            ? reason.message
            : "Retry review unavailable.",
        );
    } finally {
      if (current()) setBusy(false);
    }
  }
  const expired =
    !!preview && Date.parse(preview.reviewExpiresAt) <= Date.now();
  async function resume() {
    if(busy || !preview)return;setBusy(true);setError('');
    try {accept(await api.post<OutreachRetryPreview>(`/api/outreach/retries/${preview.id}/resume`,{}));}
    catch(reason) {if(current())setError(reason instanceof Error ? reason.message : 'Retry recovery could not be resumed.');}
    finally {if(current())setBusy(false);}
  }
  return (
    <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <PageHeader
        icon={RotateCw}
        title="Outreach retry review"
        subtitle="Recover existing delivery intents with their original recipients, account, consent and provider cooldowns."
      />
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" asChild>
          <Link href={campaignReportUrl(preview?.filters || filters)}>
            Open campaign report
          </Link>
        </Button>
        <Button
          onClick={() => void run()}
          disabled={
            busy ||
            (!!preview && ["queued", "running"].includes(preview.status))
          }
        >
          {busy
            ? "Checking…"
            : preview
              ? "Create fresh preview"
              : "Preview eligible retries"}
        </Button>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {!preview && (
        <p className="text-sm text-muted-foreground">
          The preview uses the report filters in this link. Open the campaign
          report to change the audience, account or dates. Previewing does not
          send messages.
        </p>
      )}
      {preview && (
        <>
          <OperationResultCard result={preview.card} />
          <div className="rounded-xl border bg-card p-5">
            <h2 className="font-semibold">Why messages can or cannot retry</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {preview.counts.selected.toLocaleString()} selected messages.
              Review checked {date(preview.checkedAt)}. Confirmation expires{" "}
              {date(preview.reviewExpiresAt)}.
            </p>
            <ul className="mt-4 space-y-3">
              {preview.reasons.map((reason) => (
                <li
                  key={reason.reason}
                  className="rounded-md bg-muted p-3 text-sm"
                >
                  <strong>{reason.count.toLocaleString()}</strong> ·{" "}
                  {reason.reason}
                  {reason.nextAttemptAt && (
                    <p className="mt-1 text-muted-foreground">
                      Next attempt no earlier than {date(reason.nextAttemptAt)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
          {preview.status === "ready" && (
            <section className="space-y-4 rounded-xl border bg-card p-5">
              <label className="flex items-start gap-3 text-sm">
                <Checkbox
                  checked={confirmed}
                  onCheckedChange={(value) => setConfirmed(value === true)}
                  disabled={busy || !preview.counts.eligible || expired}
                />
                <span>
                  I confirm recovery of these{" "}
                  {preview.counts.eligible.toLocaleString()} eligible existing
                  intents. Saved cooldowns stay in force, and changed or expired
                  messages will be excluded.
                </span>
              </label>
              {expired && (
                <p role="status" className="text-sm text-amber-700">
                  This preview expired. Create a fresh preview before
                  confirming.
                </p>
              )}
              <Button
                disabled={
                  busy || !confirmed || !preview.counts.eligible || expired
                }
                onClick={() => void run(true)}
              >
                Confirm eligible retries
              </Button>
            </section>
          )}
          {preview.status === "completed" && (
            <p role="status" className="rounded-xl border p-4 text-sm">
              {preview.counts.registered.toLocaleString()} existing intents
              registered for queue recovery;{" "}
              {preview.counts.changed.toLocaleString()} changed or no longer
              eligible. Open the campaign report for current sending and
              delivery counts.
            </p>
          )}
          {['review','failed'].includes(preview.status) && <Button disabled={busy} onClick={()=>void resume()}>Resume retry recovery</Button>}
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-left text-sm">
              <caption className="p-4 text-left font-medium">
                First {preview.items.length} selected records; totals above
                include the complete selection
              </caption>
              <thead>
                <tr>
                  {["Message", "Channel", "State", "Retry decision"].map(
                    (value) => (
                      <th key={value} className="p-3 font-medium">
                        {value}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {preview.items.map((item) => (
                  <tr key={item.id} className="border-t">
                    <td className="whitespace-nowrap p-3">{item.id}</td>
                    <td className="p-3">{item.channel}</td>
                    <td className="p-3">{item.state}</td>
                    <td className="min-w-60 p-3">{item.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
