"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Download } from "lucide-react";
import api, { buildApiUrl } from "@/lib/api";
import { getAuthHeaders } from "@/lib/authHeaders";
import { creatorSessionScope } from "@/lib/creator-session";
import {
  selectedBusinessProfileId,
  subscribeBusinessProfile,
} from "@/lib/business-profile";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { OperationResultCard } from "@/components/operations/OperationResultCard";
import type {
  CampaignExportOperation,
  CampaignExportFormat,
} from "../../../../../shared/campaignExports";
import { fetchWithReadRetry } from "@/lib/api-client";
const labels: Record<CampaignExportFormat, string> = {
  pdf: "PDF report",
  docx: "Word document",
  xlsx: "Excel workbook",
  html: "Conversation history",
};
export function CampaignExportView({ id }: { id: string }) {
  const scope = useSyncExternalStore(
    subscribeBusinessProfile,
    creatorSessionScope,
    () => "anonymous",
  );
  return <ExportWorkspace key={`${scope}:${id}`} scope={scope} id={id} />;
}
function ExportWorkspace({ scope, id }: { scope: string; id: string }) {
  const [operation, setOperation] = useState<CampaignExportOperation>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await api.get<CampaignExportOperation>(
          `/api/outreach/reports/exports/${id}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted || creatorSessionScope() !== scope)
          return;
        if (result.businessProfileId !== selectedBusinessProfileId())
          throw new Error("Select the original business to open this report.");
        setOperation(result);
        setError("");
        if (["queued", "running"].includes(result.status))
          timer = setTimeout(load, 2500);
      } catch (reason) {
        if (!controller.signal.aborted && creatorSessionScope() === scope)
          setError(
            reason instanceof Error
              ? reason.message
              : "Saved report unavailable.",
          );
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, scope, refresh]);
  async function download(format: CampaignExportFormat) {
    if (busy || !operation) return;
    setBusy(format);
    setError("");
    try {
      const response = await fetchWithReadRetry(
        buildApiUrl(`/api/outreach/reports/exports/${id}/download/${format}`),
        {
          headers: getAuthHeaders(),
          credentials: "include",
          cache: "no-store",
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(
          body?.error || `Download unavailable (HTTP ${response.status}).`,
        );
      }
      const blob = await response.blob();
      if (creatorSessionScope() !== scope) return;
      const mime = response.headers.get("Content-Type")?.split(";")[0];
      const expected = {
        pdf: "application/pdf",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        html: "text/html",
      };
      if (mime !== expected[format] || !blob.size)
        throw new Error(
          "The server did not return the expected report file. Retry the download.",
        );
      const file = operation.files.find((file) => file.format === format);
      if (!file) throw new Error("This file is not ready yet.");
      const url = URL.createObjectURL(blob),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      if (creatorSessionScope() === scope)
        setError(
          reason instanceof Error ? reason.message : "Download unavailable.",
        );
    } finally {
      if (creatorSessionScope() === scope) setBusy("");
    }
  }
  async function resume() {
    if (busy) return;
    setBusy("resume");
    setError("");
    try {
      const result = await api.post<CampaignExportOperation>(
        `/api/outreach/reports/exports/${id}/resume`,
        {},
      );
      if (creatorSessionScope() === scope) {
        setOperation(result);
        setRefresh((value) => value + 1);
      }
    } catch (reason) {
      if (creatorSessionScope() === scope)
        setError(
          reason instanceof Error
            ? reason.message
            : "The report could not be resumed.",
        );
    } finally {
      if (creatorSessionScope() === scope) setBusy("");
    }
  }
  return (
    <main className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <PageHeader
        icon={Download}
        title="Saved campaign report"
        subtitle="Download matching report formats from one immutable snapshot."
      />
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/30 p-4 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {!operation && !error && <p role="status">Loading report progress…</p>}
      {operation && (
        <>
          <OperationResultCard result={operation.card} />
          {operation.snapshotAt && (
            <p className="text-sm text-muted-foreground">
              Snapshot {new Date(operation.snapshotAt).toLocaleString()} ·
              Expires {new Date(operation.expiresAt).toLocaleString()}
            </p>
          )}
          <section
            className="grid gap-3 sm:grid-cols-2"
            aria-label="Report downloads"
          >
            {Object.entries(labels).map(([value, label]) => {
              const format = value as CampaignExportFormat,
                file = operation.files.find((file) => file.format === format);
              return (
                <div
                  key={format}
                  className="flex items-center justify-between gap-4 rounded-xl border bg-card p-4"
                >
                  <div>
                    <h2 className="text-sm font-medium">{label}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {file
                        ? `${Math.ceil(file.bytes / 1024).toLocaleString()} KB · ready`
                        : "Preparing this format…"}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!file || !!busy}
                    onClick={() => void download(format)}
                  >
                    {busy === format ? "Downloading…" : "Download"}
                  </Button>
                </div>
              );
            })}
          </section>
          {["review", "failed"].includes(operation.status) && (
            <Button onClick={() => void resume()} disabled={!!busy}>
              {busy === "resume" ? "Resuming…" : "Resume report generation"}
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => setRefresh((value) => value + 1)}
            disabled={!!busy}
          >
            Refresh status
          </Button>
          <p className="text-xs text-muted-foreground">
            PDF and Word summarize the snapshot. Excel contains the complete
            customer rows and protected conversation text; the HTML history
            opens offline with no external resources. Live delivery counts may
            change after this snapshot.
          </p>
        </>
      )}
    </main>
  );
}
