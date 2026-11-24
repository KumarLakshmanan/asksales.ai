"use client";

import { useState } from "react";
import { Download, FileText } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

export interface WidgetDocument { id: number; title: string }

export function parseWidgetDocuments(metadata: unknown): WidgetDocument[] {
  if (!metadata || typeof metadata !== "object") return [];
  const documents = (metadata as { documents?: unknown }).documents;
  return Array.isArray(documents) ? documents.filter((item): item is WidgetDocument =>
    Boolean(item) && Number.isSafeInteger(item.id) && item.id > 0 && typeof item.title === "string").slice(0, 5) : [];
}

export function WidgetDocumentCard({ document, apiBase, token, sessionId, sessionToken, messageId }: {
  document: WidgetDocument; apiBase: string; token: string; sessionId: number; sessionToken: string; messageId: number;
}) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    if (downloading) return;
    setDownloading(true); setError(null);
    try {
      const response = await fetch(`${apiBase}/api/support-widget/session/${sessionId}/messages/${messageId}/documents/${document.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, sessionToken }), cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(response.status === 404 || response.status === 401
          ? "This PDF is no longer available, or your chat has expired. Please ask for the current brochure."
          : "The PDF could not be downloaded. Please try again.");
      }
      if (!response.headers.get("content-type")?.includes("application/pdf")) throw new Error("The PDF could not be downloaded. Please try again.");
      const url = URL.createObjectURL(await response.blob());
      const link = window.document.createElement("a");
      link.href = url;
      link.download = `${document.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 180)}.pdf`;
      window.document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The PDF could not be downloaded. Please try again.");
    } finally { setDownloading(false); }
  }

  return <div className="mt-2 rounded-xl border border-border bg-background p-3">
    <div className="flex items-start gap-2.5">
      <FileText className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-medium leading-snug">{document.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">PDF document</p>
      </div>
    </div>
    <button type="button" onClick={() => void download()} disabled={downloading}
      aria-label={`Download ${document.title} (PDF)`}
      className="mt-3 flex min-h-10 w-full items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
      {downloading ? <Spinner size="sm" label={null} /> : <Download className="h-4 w-4" aria-hidden="true" />}
      {downloading ? "Downloading…" : "Download PDF"}
    </button>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
  </div>;
}
