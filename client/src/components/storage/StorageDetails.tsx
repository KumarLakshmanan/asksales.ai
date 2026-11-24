"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Download, Eye, Tags, FileText, Link2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  formatStorageBytes,
  storageCategoryLabel,
  storageFileName,
} from "@/lib/storage";
import {
  previewable,
  storageFileDate,
  type WorkspaceFile,
} from "@/lib/storage-workspace";
import type { FileAction } from "./StorageFiles";

export function StorageDetails({
  file,
  close,
  scope,
  businessName,
  action,
}: {
  file: WorkspaceFile | null;
  close: () => void;
  scope: string;
  businessName?: string;
  action: (action: FileAction, file: WorkspaceFile) => void;
}) {
  const details = useQuery({
    queryKey: ["storage-workspace-details", scope, file?.id],
    enabled: !!file,
    queryFn: ({ signal }) =>
      api.get<WorkspaceFile>(
        `/api/settings/storage/workspace/files/${file!.id}`,
        { signal },
      ),
    staleTime: 0,
  });
  const current = details.data || file;
  return (
    <Sheet open={!!file} onOpenChange={(open) => { if (!open) close(); }}>
      <SheetContent className="w-full overflow-y-auto bg-card p-5 sm:max-w-[560px] sm:p-7">
        <SheetHeader className="flex-row items-start gap-3 space-y-0 text-left">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><FileText className="h-6 w-6" aria-hidden /></span>
          <div className="min-w-0 pr-5">
            <SheetTitle className="break-words text-xl leading-7">{current && storageFileName(current)}</SheetTitle>
            <SheetDescription className="mt-1">File details and related work</SheetDescription>
          </div>
        </SheetHeader>
        {current && (
          <div className="mt-6 space-y-5">
            {details.isError && (
              <Callout tone="danger">
                Details could not be refreshed.{" "}
                <button className="underline" onClick={() => void details.refetch()}>Try again</button>
              </Callout>
            )}
            {!current.workspace.trashedAt && (
              <div className="flex flex-wrap gap-2">
                <Button className="h-11 gap-2 rounded-lg" onClick={() => action("download", current)}><Download className="h-4 w-4" aria-hidden />Download</Button>
                {previewable(current) && (
                  <Button variant="outline" className="h-11 gap-2 rounded-lg" onClick={() => action("preview", current)}><Eye className="h-4 w-4" aria-hidden />Preview</Button>
                )}
                <Button variant="outline" className="h-11 gap-2 rounded-lg" onClick={() => action("organize", current)}><Tags className="h-4 w-4" aria-hidden />Organize</Button>
              </div>
            )}
            <section className="rounded-xl border border-border p-4 sm:p-5">
              <h3 className="mb-5 text-sm font-semibold">File information</h3>
              <dl className="grid grid-cols-[90px_minmax(0,1fr)] gap-x-4 gap-y-4 text-sm sm:grid-cols-[110px_minmax(0,1fr)]">
                <dt className="text-muted-foreground">Size</dt><dd className="tabular-nums">{formatStorageBytes(current.fileSizeBytes)}</dd>
                <dt className="text-muted-foreground">Type</dt><dd className="break-all">{current.mimeType || "Unknown"}</dd>
                <dt className="text-muted-foreground">Category</dt><dd className="break-words">{storageCategoryLabel(current.category)}</dd>
                <dt className="text-muted-foreground">Business</dt><dd className="break-words">{current.businessProfileId ? businessName || "Selected business" : "Legacy file — profile not recorded"}</dd>
                <dt className="text-muted-foreground">Added</dt><dd>{storageFileDate(current.createdAt)}</dd>
                <dt className="text-muted-foreground">Updated</dt><dd>{storageFileDate(current.updatedAt)}</dd>
                <dt className="text-muted-foreground">Collection</dt><dd className="break-words">{current.workspace.collection || "None"}</dd>
                <dt className="text-muted-foreground">Tags</dt>
                <dd className="flex min-w-0 flex-wrap gap-1.5">
                  {current.workspace.tags?.length ? current.workspace.tags.map(tag => <span key={tag} className="max-w-full break-words rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{tag}</span>) : "None"}
                </dd>
                {current.workspace.trashedAt && <><dt className="text-muted-foreground">In Trash since</dt><dd>{storageFileDate(current.workspace.trashedAt)}</dd></>}
              </dl>
            </section>
            <section className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4 sm:p-5">
              <h3 className="flex items-center gap-2 text-sm font-semibold"><Link2 className="h-4 w-4 text-primary" aria-hidden />Related work</h3>
              <p className="text-sm leading-6 text-muted-foreground">{current.dependency.message}</p>
              {current.source ? (
                <>
                  {current.source.href ? (
                    <Link href={current.source.href} className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary hover:underline">Open {current.source.label}<ExternalLink className="h-4 w-4" aria-hidden /></Link>
                  ) : <p className="text-sm">Source: {current.source.label}</p>}
                  {current.referenceId && <p className="break-all border-t border-primary/10 pt-3 text-xs text-muted-foreground">Reference: {current.referenceId}</p>}
                </>
              ) : <p className="text-xs text-muted-foreground">No source link is recorded for this file.</p>}
            </section>
            <section className="rounded-xl border border-border p-4 sm:p-5">
              <h3 className="text-sm font-semibold">Recent file activity</h3>
              <ul className="ml-1 mt-4 space-y-4 border-l border-primary/20 pl-5">
                <li className="relative text-sm"><span aria-hidden className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full bg-primary/50" />Uploaded<span className="mt-1 block text-xs text-muted-foreground">{storageFileDate(current.createdAt)}</span></li>
                {[...(current.workspace.events || [])].reverse().map((event, index) => (
                  <li key={index} className="relative text-sm"><span aria-hidden className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full bg-primary/50" />{event.action.replace(/_/g, " ")}<span className="mt-1 block text-xs text-muted-foreground">{storageFileDate(event.at)} · Member #{event.actorUserId}</span></li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
