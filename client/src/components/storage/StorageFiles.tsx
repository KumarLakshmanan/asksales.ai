"use client";
import { useEffect, useRef, useState } from "react";
import {
  Download,
  Eye,
  FileText,
  FileSpreadsheet,
  Image as ImageIcon,
  MoreHorizontal,
  Music,
  Video,
  Info,
  Pencil,
  Tags,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  formatStorageBytes,
  storageCategoryLabel,
  storageFileName,
  storageFileType,
} from "@/lib/storage";
import {
  previewable,
  storageBlob,
  storageFileDate,
  type WorkspaceFile,
} from "@/lib/storage-workspace";

export type FileAction =
  | "details"
  | "preview"
  | "download"
  | "rename"
  | "organize"
  | "trash"
  | "restore"
  | "purge";
function FileIcon({ file }: { file: WorkspaceFile }) {
  const spreadsheet = /csv|spreadsheet|excel/.test(file.mimeType || "");
  const Icon = file.mimeType?.startsWith("image/")
    ? ImageIcon
    : file.mimeType?.startsWith("video/")
      ? Video
      : file.mimeType?.startsWith("audio/")
        ? Music
        : spreadsheet ? FileSpreadsheet : FileText;
  const color = file.mimeType?.startsWith("image/") ? "text-blue-600 dark:text-blue-400"
    : file.mimeType?.startsWith("video/") ? "text-indigo-600 dark:text-indigo-400"
    : file.mimeType?.startsWith("audio/") ? "text-fuchsia-600 dark:text-fuchsia-400"
    : spreadsheet ? "text-emerald-600 dark:text-emerald-400"
    : file.mimeType === "application/pdf" ? "text-red-600 dark:text-red-400" : "text-muted-foreground";
  return <Icon className={`h-5 w-5 ${color}`} aria-hidden />;
}
function Thumbnail({ file }: { file: WorkspaceFile }) {
  const ref = useRef<HTMLDivElement>(null),
    [url, setUrl] = useState("");
  useEffect(() => {
    if (!file.mimeType?.startsWith("image/")) return;
    let objectUrl = "",
      done = false,
      started = false;
    const controller = new AbortController();
    const load = async () => {
      if (started) return;
      started = true;
      try {
        const blob = await storageBlob(file.id, true, controller.signal);
        if (!done) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      } catch {
        /* Fall back to the file icon. */
      }
    };
    const observer =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) {
                void load();
                observer?.disconnect();
              }
            },
            { rootMargin: "100px" },
          )
        : null;
    if (observer && ref.current) observer.observe(ref.current);
    else void load();
    return () => {
      done = true;
      controller.abort();
      observer?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id, file.updatedAt, file.mimeType]);
  return (
    <div
      ref={ref}
      className="flex h-32 items-center justify-center bg-muted/20"
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full object-contain" />
      ) : (
        <FileIcon file={file} />
      )}
    </div>
  );
}
function Actions({
  file,
  action,
  busy,
}: {
  file: WorkspaceFile;
  action: (action: FileAction, file: WorkspaceFile) => void;
  busy: boolean;
}) {
  const trash = !!file.workspace.trashedAt;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-11 w-11 p-0"
          aria-label={`Actions for ${storageFileName(file)}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 rounded-xl p-1.5 shadow-lg">
        <DropdownMenuItem
          className="min-h-11"
          onSelect={() => action("details", file)}
        >
          <Info />
          File details
        </DropdownMenuItem>
        {!trash && (
          <>
            {previewable(file) && (
              <DropdownMenuItem
                className="min-h-11"
                onSelect={() => action("preview", file)}
              >
                <Eye />
                Preview
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className="min-h-11"
              onSelect={() => action("download", file)}
            >
              <Download />
              Download
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11"
              disabled={busy}
              onSelect={() => action("rename", file)}
            >
              <Pencil />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11"
              disabled={busy}
              onSelect={() => action("organize", file)}
            >
              <Tags />
              Tags and collection
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        {trash && (
          <DropdownMenuItem
            className="min-h-11"
            disabled={busy}
            onSelect={() => action("restore", file)}
          >
            <RotateCcw />
            Restore
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          className="min-h-11 text-destructive"
          disabled={busy}
          onSelect={() => action(trash ? "purge" : "trash", file)}
        >
          <Trash2 />
          {trash ? "Delete permanently" : "Move to Trash"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
interface Props {
  files: WorkspaceFile[];
  view: "list" | "grid";
  selected: Set<number>;
  select: (id: number, checked: boolean) => void;
  selectAll: (checked: boolean) => void;
  action: (action: FileAction, file: WorkspaceFile) => void;
  busy: boolean;
}
export function StorageFiles({
  files,
  view,
  selected,
  select,
  selectAll,
  action,
  busy,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null),
    [scroll, setScroll] = useState(0);
  const [columns, setColumns] = useState(1);
  useEffect(() => {
    const resize = () =>
      setColumns(
        window.innerWidth >= 1280 ? 3 : window.innerWidth >= 640 ? 2 : 1,
      );
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const allSelected =
    files.length > 0 &&
    files.slice(0, 200).every((file) => selected.has(file.id));
  const firstFileId = files[0]?.id;
  useEffect(() => {
    setScroll(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [firstFileId, view]);
  // A fixed row height keeps this small window stable while hundreds of loaded
  // results remain available for selection and preview navigation.
  const virtual = view === "list" && files.length > 150;
  const start = virtual
    ? Math.max(0, Math.floor(Math.max(0, scroll - 48) / 72) - 5)
    : 0;
  const end = virtual ? Math.min(files.length, start + 25) : files.length;
  const selection = (file: WorkspaceFile) => (
    <label className="flex h-11 w-11 cursor-pointer items-center justify-center">
      <Checkbox
        checked={selected.has(file.id)}
        onCheckedChange={(value) => select(file.id, value === true)}
        aria-label={`Select ${storageFileName(file)}`}
      />
    </label>
  );
  if (view === "grid") {
    const gridVirtual = files.length > 150;
    const rows = Math.ceil(files.length / columns);
    const firstRow = gridVirtual
      ? Math.max(0, Math.floor(scroll / 352) - 2)
      : 0;
    const lastRow = gridVirtual ? Math.min(rows, firstRow + 6) : rows;
    return (
      <div
        ref={scrollRef}
        onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
        className="max-h-[600px] overflow-y-auto"
      >
        <div
          className="grid grid-cols-1 gap-4 px-4 sm:grid-cols-2 xl:grid-cols-3"
          style={{
            paddingTop: 16 + firstRow * 352,
            paddingBottom: 16 + (rows - lastRow) * 352,
          }}
        >
          {files.slice(firstRow * columns, lastRow * columns).map((file) => (
            <article
              key={file.id}
              className={`h-[336px] min-w-0 overflow-hidden rounded-xl border ${selected.has(file.id) ? "border-primary bg-primary/5" : "border-border"}`}
            >
              <div className="flex items-center justify-between px-2">
                {selection(file)}
                <Actions file={file} action={action} busy={busy} />
              </div>
              <Thumbnail file={file} />
              <div className="space-y-2 p-4">
                <button
                  className="block min-h-11 w-full truncate text-left text-sm font-medium hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                  title={storageFileName(file)}
                  onClick={() => action("details", file)}
                >
                  {storageFileName(file)}
                </button>
                <p className="flex justify-between text-xs text-muted-foreground">
                  <span>{formatStorageBytes(file.fileSizeBytes)}</span>
                  <span>{storageFileType(file)}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {storageCategoryLabel(file.category)} ·{" "}
                  {storageFileDate(file.createdAt)}
                </p>
                {file.workspace.collection && (
                  <p className="truncate text-xs text-primary">
                    {file.workspace.collection}
                  </p>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div
      ref={scrollRef}
      onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
      className="max-h-[600px] overflow-y-auto"
    >
      <table
        className="w-full table-fixed text-left text-sm"
        aria-rowcount={files.length + 1}
      >
        <caption className="sr-only">Storage files</caption>
        <thead className="sticky top-0 z-10 border-b border-border bg-muted text-xs text-muted-foreground">
          <tr className="h-12">
            <th className="w-12 pl-1">
              <label className="flex h-11 w-11 items-center justify-center">
                <Checkbox
                  aria-label={
                    files.length > 200
                      ? "Select first 200 loaded files"
                      : "Select all loaded files"
                  }
                  checked={
                    allSelected ? true : selected.size ? "indeterminate" : false
                  }
                  onCheckedChange={(value) => selectAll(value === true)}
                />
              </label>
            </th>
            <th scope="col" className="px-3 font-medium">
              Name
            </th>
            <th scope="col" className="hidden w-24 font-medium md:table-cell">
              Size
            </th>
            <th scope="col" className="hidden w-32 font-medium xl:table-cell">
              Category
            </th>
            <th scope="col" className="hidden w-28 font-medium lg:table-cell">
              Date added
            </th>
            <th className="w-12">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {start > 0 && (
            <tr aria-hidden>
              <td colSpan={6} style={{ height: start * 72 }} />
            </tr>
          )}
          {files.slice(start, end).map((file, index) => (
            <tr
              key={file.id}
              aria-rowindex={start + index + 2}
              className={`h-[72px] ${selected.has(file.id) ? "bg-primary/5" : "hover:bg-muted/25"}`}
            >
              <td className="pl-1">{selection(file)}</td>
              <td className="px-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="hidden sm:block">
                    <FileIcon file={file} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <button
                      onClick={() => action("details", file)}
                      title={storageFileName(file)}
                      className="block w-full truncate text-left font-medium hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {storageFileName(file)}
                    </button>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {storageFileType(file)}
                      <span className="md:hidden">
                        {" "}
                        · {formatStorageBytes(file.fileSizeBytes)}
                      </span>
                      <span className="xl:hidden">
                        {" "}
                        · {storageCategoryLabel(file.category)}
                      </span>
                      {file.workspace.collection && (
                        <span> · {file.workspace.collection}</span>
                      )}
                    </p>
                  </div>
                </div>
              </td>
              <td className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                {formatStorageBytes(file.fileSizeBytes)}
              </td>
              <td className="hidden truncate text-xs text-muted-foreground xl:table-cell">
                {storageCategoryLabel(file.category)}
              </td>
              <td className="hidden text-xs text-muted-foreground lg:table-cell">
                {storageFileDate(file.createdAt)}
              </td>
              <td>
                <Actions file={file} action={action} busy={busy} />
              </td>
            </tr>
          ))}
          {end < files.length && (
            <tr aria-hidden>
              <td colSpan={6} style={{ height: (files.length - end) * 72 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
