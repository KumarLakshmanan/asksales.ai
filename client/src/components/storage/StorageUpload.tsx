"use client";
import { useEffect, useRef, useState } from "react";
import { Upload, X, RotateCcw, CheckCircle2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { businessProfileHeaders } from "@/lib/business-profile";
import { formatStorageBytes } from "@/lib/storage";

type UploadItem = {
  id: string;
  file: File;
  status: "queued" | "uploading" | "done" | "failed" | "cancelled";
  progress: number;
  attempts: number;
  settling?: boolean;
  error?: string;
};
const ACCEPT =
  ".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv,.json,.docx,.xlsx,.mp3,.wav,.mp4,.webm";
export function StorageUpload({
  open,
  close,
  saved,
  status,
}: {
  open: boolean;
  close: () => void;
  saved: () => Promise<unknown>;
  status: (pending: number) => void;
}) {
  const [items, setItems] = useState<UploadItem[]>([]),
    [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    controllers = useRef(new Map<string, AbortController>()),
    running = useRef(false);
  const mounted = useRef(true),
    savedRef = useRef(saved),
    headers = useRef(businessProfileHeaders());
  useEffect(() => {
    savedRef.current = saved;
  }, [saved]);
  useEffect(() => {
    mounted.current = true;
    const activeControllers = controllers.current;
    return () => {
      mounted.current = false;
      activeControllers.forEach((controller) => controller.abort());
    };
  }, []);
  const patch = (id: string, changes: Partial<UploadItem>) =>
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    );
  const add = (files: FileList | File[]) => {
    setItems((current) => [
      ...current,
      ...Array.from(files)
        .slice(0, Math.max(0, 100 - current.length))
        .map((file) => {
          const valid =
            file.size > 0 &&
            file.size <= 25 * 1024 * 1024 &&
            ACCEPT.split(",").some((extension) =>
              file.name.toLowerCase().endsWith(extension),
            );
          return {
            id: crypto.randomUUID(),
            file,
            status: valid ? ("queued" as const) : ("failed" as const),
            progress: 0,
            attempts: 0,
            error: valid
              ? undefined
              : "Choose a supported, non-empty file up to 25 MB.",
          };
        }),
    ]);
  };
  useEffect(() => {
    if (running.current || !items.some((item) => item.status === "queued"))
      return;
    running.current = true;
    const work = async () => {
      const next = items.find((item) => item.status === "queued");
      if (!next) return;
      const controller = new AbortController();
      controllers.current.set(next.id, controller);
      patch(next.id, {
        status: "uploading",
        attempts: next.attempts + 1,
        error: undefined,
      });
      try {
        if (next.attempts === 0) {
          const allowance = await api.get<{
            allowed: boolean;
            reason?: string;
          }>(`/api/settings/storage/check-upload?size=${next.file.size}`, {
            signal: controller.signal,
            headers: headers.current,
          });
          if (!allowance.allowed)
            throw new Error(
              allowance.reason ||
                "Not enough storage. Empty Trash or review your plan.",
            );
        }
        // A retry must first let the server resolve the existing receipt. A
        // completed upload can have consumed the last remaining capacity.
        const form = new FormData();
        form.append("file", next.file);
        await api.postForm("/api/settings/storage/files", form, {
          signal: controller.signal,
          headers: { ...headers.current, "X-Storage-Upload-Id": next.id },
          onUploadProgress: (progress) => {
            if (mounted.current) patch(next.id, { progress });
          },
        });
        if (mounted.current) {
          patch(next.id, { status: "done", progress: 100 });
          await savedRef.current();
        }
      } catch (error) {
        if (mounted.current)
          patch(next.id, {
            status: controller.signal.aborted ? "cancelled" : "failed",
            error: controller.signal.aborted
              ? "Cancelled. Refresh to check whether the server completed this upload."
              : error instanceof Error
                ? error.message
                : "Upload failed. Try again.",
          });
      } finally {
        controllers.current.delete(next.id);
        running.current = false;
        if (mounted.current) patch(next.id, { settling: false });
      }
    };
    void work();
  }, [items]);
  const cancel = (id: string) => {
    const controller = controllers.current.get(id);
    controller?.abort();
    patch(id, {
      status: "cancelled",
      settling: !!controller,
      error: "Upload cancelled.",
    });
  };
  const pending = items.filter((item) =>
    ["queued", "uploading"].includes(item.status),
  ).length;
  useEffect(() => {
    status(pending);
  }, [pending, status]);
  const busy = pending > 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogContent className="flex max-h-[90dvh] max-w-3xl flex-col gap-5 rounded-2xl">
        <DialogHeader className="shrink-0 pr-5 text-left">
          <DialogTitle className="text-2xl leading-8">Upload files</DialogTitle>
          <DialogDescription className="pt-1 leading-6">
            Files are added to the selected business. Up to 25 MB per file and
            100 files per queue. Closing this panel keeps uploads running.
          </DialogDescription>
        </DialogHeader>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          aria-label="Choose files to upload"
          onChange={(event) => {
            if (event.target.files) add(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            add(event.dataTransfer.files);
          }}
          className={`flex min-h-32 shrink-0 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 focus-visible:ring-2 focus-visible:ring-ring ${dragging ? "border-primary bg-primary/10" : "border-primary/30 bg-primary/[0.025]"}`}
        >
          <Upload className="h-8 w-8 text-primary" aria-hidden />
          <span className="text-sm font-medium">
            Drop files here or choose files
          </span>
          <span className="text-xs text-muted-foreground">
            Images, documents, spreadsheets, audio, and video
          </span>
        </button>
        <div className="min-h-0 space-y-2 overflow-y-auto" aria-label="Upload queue">
          {items.length > 0 && <p className="pb-1 text-sm font-semibold" role="status">{items.length} {items.length === 1 ? "file" : "files"}</p>}
          {items.map((item) => (
            <div key={item.id} className="flex items-start gap-3 rounded-xl border border-border p-3 sm:p-4">
              <FileText className="mt-1 h-5 w-5 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-sm font-medium"
                  title={item.file.name}
                >
                  {item.file.name}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatStorageBytes(item.file.size)} ·{" "}
                  {item.status === "uploading"
                    ? item.progress < 100
                      ? `${item.progress}% uploaded`
                      : "Saving file…"
                    : item.status}
                </p>
                {item.status === "uploading" && (
                  <progress
                    className="mt-2 h-2 w-full accent-primary"
                    max={100}
                    value={item.progress}
                    aria-label={`Upload progress for ${item.file.name}`}
                  />
                )}
                {item.error && (
                  <p role="status" className="mt-2 text-xs text-destructive">
                    {item.error}
                  </p>
                )}
              </div>
              {item.status === "done" ? (
                <span className="mt-2 flex shrink-0 items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-5 w-5" aria-label="Uploaded" /><span className="hidden sm:inline">Upload complete</span></span>
              ) : ["failed", "cancelled"].includes(item.status) ? (
                <Button
                  variant="outline"
                  className="h-11 shrink-0 gap-1.5 rounded-lg px-2 sm:px-3"
                  aria-label={`Retry ${item.file.name}`}
                  disabled={
                    item.settling ||
                    !item.file.size ||
                    item.file.size > 25 * 1024 * 1024
                  }
                  onClick={() =>
                    patch(item.id, {
                      status: "queued",
                      progress: 0,
                      error: undefined,
                    })
                  }
                >
                  <RotateCcw className="h-4 w-4" aria-hidden />Retry
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="h-11 shrink-0 gap-1.5 rounded-lg px-2 sm:px-3"
                  aria-label={`Cancel ${item.file.name}`}
                  onClick={() => cancel(item.id)}
                >
                  <X className="h-4 w-4" aria-hidden />Cancel
                </Button>
              )}
            </div>
          ))}
        </div>
        <div className="flex shrink-0 flex-wrap justify-between gap-3 border-t border-border pt-4">
          <Button
            variant="outline"
            className="min-h-11 rounded-lg"
            disabled={busy || !items.length}
            onClick={() => setItems([])}
          >
            Clear finished queue
          </Button>
          <Button className="min-h-11 rounded-lg" onClick={close}>Close panel</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
