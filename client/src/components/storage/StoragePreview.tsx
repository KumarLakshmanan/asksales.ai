"use client";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { storageFileName, formatStorageBytes } from "@/lib/storage";
import {
  previewable,
  storageBlob,
  type WorkspaceFile,
} from "@/lib/storage-workspace";

/** Quoted cells, escaped quotes, CRLF and embedded newlines are preserved. */
export function previewCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length && rows.length < 51; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell.slice(0, 1000));
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      row.push(cell.slice(0, 1000));
      rows.push(row.slice(0, 20));
      row = [];
      cell = "";
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else cell += char;
  }
  if ((cell || row.length) && rows.length < 51) {
    row.push(cell.slice(0, 1000));
    rows.push(row.slice(0, 20));
  }
  return rows;
}
export function StoragePreview({
  file,
  files,
  close,
  change,
  download,
}: {
  file: WorkspaceFile | null;
  files: WorkspaceFile[];
  close: () => void;
  change: (file: WorkspaceFile) => void;
  download: (file: WorkspaceFile) => void;
}) {
  const [content, setContent] = useState<{
    url?: string;
    text?: string;
    csv?: string[][];
  }>({});
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    let url = "",
      done = false;
    setContent({});
    setError("");
    if (file.fileSizeBytes > 10 * 1024 * 1024) {
      setLoading(false);
      setError(
        "Download this file to view it. Previews support files up to 10 MB.",
      );
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const blob = await storageBlob(file.id, false, controller.signal);
        if (blob.size > 10 * 1024 * 1024)
          throw new Error(
            "This file is too large to preview. Download it instead.",
          );
        if (done) return;
        if (
          /^(image|video|audio)\//.test(file.mimeType || "") ||
          file.mimeType === "application/pdf"
        ) {
          url = URL.createObjectURL(blob);
          setContent({ url });
        } else {
          let text = await blob.text();
          if (done) return;
          if (file.mimeType?.includes("json")) {
            try {
              text = JSON.stringify(JSON.parse(text), null, 2);
            } catch {
              /* Show original text when parsing fails. */
            }
          }
          setContent(
            /csv/.test(file.mimeType || "") ||
              /\.csv$/i.test(storageFileName(file))
              ? { csv: previewCsv(text) }
              : { text: text.slice(0, 100000) },
          );
        }
      } catch (e) {
        if (!done)
          setError(
            e instanceof Error
              ? e.message
              : "This file could not be previewed.",
          );
      } finally {
        if (!done) setLoading(false);
      }
    })();
    return () => {
      done = true;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [file, retry]);
  const available = files.filter(
      (item) => !item.workspace.trashedAt && previewable(item),
    ),
    index = available.findIndex((item) => item.id === file?.id);
  return (
    <Dialog
      open={!!file}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="flex max-h-[90dvh] max-w-4xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b border-border p-5 pr-12">
          <DialogTitle className="truncate">
            {file && storageFileName(file)}
          </DialogTitle>
          <DialogDescription>
            {file &&
              `${formatStorageBytes(file.fileSizeBytes)} · ${file.mimeType}`}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-48 flex-1 overflow-auto bg-muted/15 p-5 sm:min-h-80">
          {loading ? (
            <Skeleton className="h-64 w-full" aria-label="Loading preview" />
          ) : error ? (
            <div role="alert" className="space-y-4 py-10 text-center">
              <p>{error}</p>
              <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>
                Try again
              </Button>
            </div>
          ) : content.csv ? (
            <>
              <p className="mb-3 text-xs text-muted-foreground">
                Preview: up to 50 rows and 20 columns.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      {content.csv[0]?.map((cell, i) => (
                        <th key={i} className="border bg-muted p-3">
                          {cell}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {content.csv.slice(1, 51).map((row, i) => (
                      <tr key={i}>
                        {row.map((cell, j) => (
                          <td
                            key={j}
                            className="max-w-64 break-words border p-3"
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : content.text !== undefined ? (
            <>
              <p className="mb-3 text-xs text-muted-foreground">
                Text preview · first 100,000 characters
              </p>
              <pre className="whitespace-pre-wrap break-words rounded-lg border bg-background p-4 font-mono text-xs leading-6">
                {content.text}
              </pre>
            </>
          ) : content.url && file?.mimeType?.startsWith("image/") ? (
            <img
              src={content.url}
              alt={storageFileName(file)}
              className="mx-auto max-h-[60dvh] object-contain"
            />
          ) : content.url && file?.mimeType === "application/pdf" ? (
            <iframe
              title={`Preview of ${storageFileName(file)}`}
              src={content.url}
              className="h-[60dvh] w-full"
            />
          ) : content.url && file?.mimeType?.startsWith("video/") ? (
            <video
              controls
              src={content.url}
              className="mx-auto max-h-[60dvh]"
            />
          ) : (
            content.url && (
              <audio controls src={content.url} className="w-full" />
            )
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="h-11 w-11 p-0"
              aria-label="Previous file"
              disabled={index <= 0}
              onClick={() => change(available[index - 1])}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              className="h-11 w-11 p-0"
              aria-label="Next file"
              disabled={index < 0 || index >= available.length - 1}
              onClick={() => change(available[index + 1])}
            >
              <ChevronRight />
            </Button>
            <span className="text-xs text-muted-foreground">Loaded files</span>
          </div>
          <Button className="h-11 gap-2" onClick={() => file && download(file)}>
            <Download className="h-4 w-4" />
            Download file
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
