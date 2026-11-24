"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import api from "@/lib/api";
import { sanitizeEmailPreviewHtml } from "@/lib/contentTemplateRendering";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

interface TemplateVersion {
  id: number;
  version: number;
  createdAt: string;
  snapshot: {
    name?: string;
    type?: string;
    subject?: string | null;
    content?: string;
    htmlContent?: string | null;
    variables?: string[];
    isApproved?: boolean;
    category?: string | null;
    description?: string | null;
  };
}

export function TemplateVersionHistory({ templateId, templateName }: { templateId: number; templateName: string }) {
  const [open, setOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const { data: versions = [], isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["content-template-versions", templateId],
    queryFn: () => api.get<TemplateVersion[]>(`/api/content/templates/${templateId}/versions`),
    enabled: open,
    staleTime: 0,
    retry: false,
  });
  const ordered = [...versions].sort((first, second) => second.version - first.version);
  const selected = ordered.find((item) => item.version === selectedVersion) || ordered[0];

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setSelectedVersion(null); }}>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Version history for ${templateName}`} title="Version history">
          <History className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Version history — {templateName}</DialogTitle>
          <DialogDescription>Inspect saved copies of this reusable template. Viewing a version does not change or publish it.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div role="status" className="flex items-center gap-2 py-8"><Spinner size="sm" label={null} /> Loading saved versions…</div>
        ) : isError ? (
          <div role="alert" className="space-y-3 py-6">
            <p>Version history could not be loaded. Check your connection and try again.</p>
            <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>Retry</Button>
          </div>
        ) : !selected ? (
          <p className="py-6 text-sm text-muted-foreground">No saved versions are available for this template.</p>
        ) : (
          <div className="grid min-w-0 gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
            <nav aria-label="Saved template versions" className="flex gap-2 overflow-auto sm:max-h-[60vh] sm:flex-col">
              {ordered.map((item, index) => (
                <button key={item.id} type="button" aria-pressed={item.version === selected.version} onClick={() => setSelectedVersion(item.version)} className={`shrink-0 rounded-md border p-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${item.version === selected.version ? "border-primary bg-primary/5" : "border-border hover:bg-muted"}`}>
                  <span className="font-medium">Version {item.version}{index === 0 ? " · Latest" : ""}</span>
                  <time dateTime={item.createdAt} className="mt-1 block text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</time>
                </button>
              ))}
            </nav>
            <section aria-label={`Version ${selected.version} snapshot`} className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">{selected.snapshot.name || templateName}</h3>
                <Badge variant="outline">{selected.snapshot.isApproved ? "Approved" : "Needs approval"}</Badge>
                {selected.snapshot.type && <Badge variant="secondary">{selected.snapshot.type}</Badge>}
              </div>
              {selected.snapshot.subject && <p className="text-sm"><span className="font-medium">Subject: </span>{selected.snapshot.subject}</p>}
              {selected.snapshot.description && <p className="text-sm text-muted-foreground">{selected.snapshot.description}</p>}
              {selected.snapshot.variables?.length ? <p className="break-words text-xs text-muted-foreground">Variables: {selected.snapshot.variables.join(", ")}</p> : null}
              <pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/20 p-4 font-mono text-xs leading-6">{selected.snapshot.content || "No text content"}</pre>
              {selected.snapshot.type === "email" && selected.snapshot.htmlContent && (
                <details className="rounded-md border p-3">
                  <summary className="cursor-pointer text-sm font-medium">Email HTML preview</summary>
                  <iframe title={`Email preview for version ${selected.version}`} sandbox="" srcDoc={sanitizeEmailPreviewHtml(selected.snapshot.htmlContent)} className="mt-3 h-80 w-full border-0 bg-white" />
                </details>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
