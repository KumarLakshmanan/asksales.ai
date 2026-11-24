"use client";
import { useEffect, useState } from "react";
import {
  RefreshCw,
  Upload,
  HardDrive,
  Download,
  Tags,
  Trash2,
  RotateCcw,
  ArrowLeft,
  FolderOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useStorageWorkspace } from "@/hooks/use-storage-workspace";
import {
  formatStorageBytes,
  storageCategoryLabel,
  actorFolderName,
  actorRunName,
} from "@/lib/storage";
import {
  DEFAULT_STORAGE_FILTERS,
  downloadStorageFiles,
  storageFileDate,
  type WorkspaceFile,
  type StorageFilters,
} from "@/lib/storage-workspace";
import { StorageUsageSummary } from "@/components/storage/StorageUsageSummary";
import { StorageNavigation } from "@/components/storage/StorageNavigation";
import {
  StorageToolbar,
  storageSelectStyle,
} from "@/components/storage/StorageToolbar";
import {
  StorageFiles,
  type FileAction,
} from "@/components/storage/StorageFiles";
import { StorageUpload } from "@/components/storage/StorageUpload";
import { StoragePreview } from "@/components/storage/StoragePreview";
import { StorageDetails } from "@/components/storage/StorageDetails";
import {
  StorageDialogs,
  type StorageActionRequest,
} from "@/components/storage/StorageDialogs";

export default function StoragePage() {
  const workspace = useStorageWorkspace();
  return <StorageWorkspace key={workspace.scopeKey} workspace={workspace} />;
}
function StorageWorkspace({
  workspace: w,
}: {
  workspace: ReturnType<typeof useStorageWorkspace>;
}) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [upload, setUpload] = useState(false),
    [advanced, setAdvanced] = useState(false);
  const [details, setDetails] = useState<WorkspaceFile | null>(null),
    [preview, setPreview] = useState<WorkspaceFile | null>(null);
  const [request, setRequest] = useState<StorageActionRequest | null>(null),
    [busy, setBusy] = useState(false),
    [actionError, setActionError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [pendingUploads, setPendingUploads] = useState(0);
  const { filters, loadedFiles, total } = w,
    usage = w.overview.data;
  useEffect(() => {
    setSelected(new Set());
  }, [filters]);
  const navigate = (patch: Partial<StorageFilters>) => w.update(patch, true);
  const selectedFiles = loadedFiles.filter((file) => selected.has(file.id));
  const download = async (files: WorkspaceFile[]) => {
    try {
      await downloadStorageFiles(files.map((file) => file.id));
    } catch (error) {
      toast({
        title: "Download failed",
        description: error instanceof Error ? error.message : "Try again.",
        variant: "destructive",
      });
    }
  };
  const action = (value: FileAction, file: WorkspaceFile) => {
    if (value === "details") setDetails(file);
    else if (value === "preview") {
      setDetails(null);
      setPreview(file);
    } else if (value === "download") void download([file]);
    else {
      setDetails(null);
      setActionError("");
      setRequest({ action: value, files: [file] });
    }
  };
  const save = async (data: {
    name?: string;
    tags?: string[];
    collection?: string;
    acknowledgeReferences?: boolean;
  }) => {
    if (!request || busy) return;
    setBusy(true);
    setActionError("");
    try {
      const result = await api.post<{ affected: number }>(
        "/api/settings/storage/workspace/actions",
        {
          action: request.action,
          fileIds: request.files.map((file) => file.id),
          ...data,
        },
      );
      toast({
        title:
          request.action === "trash"
            ? `${result.affected} files moved to Trash`
            : request.action === "restore"
              ? `${result.affected} files restored`
              : request.action === "purge"
                ? `${result.affected} files permanently deleted`
                : request.action === "rename"
                  ? "File renamed"
                  : "File organization saved",
      });
      setRequest(null);
      setSelected(new Set());
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "This operation failed. Refresh and try again.",
      );
    } finally {
      await w.invalidate();
      setBusy(false);
    }
  };
  const bulk = (value: StorageActionRequest["action"]) => {
    setActionError("");
    setRequest({ action: value, files: selectedFiles });
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      await w.invalidate();
    } finally {
      setRefreshing(false);
    }
  };
  const heading =
    filters.view === "trash"
      ? "Trash"
      : filters.view === "cleanup"
        ? "Clean up storage"
        : filters.view === "activity"
          ? "Activity"
          : filters.folder
            ? actorFolderName(filters.folder)
            : filters.view === "folders"
              ? filters.category === "actor_output"
                ? "Actor runs"
                : "Folders"
              : filters.category
                ? storageCategoryLabel(filters.category)
                : filters.collection || "All files";
  const error =
    filters.view === "activity"
      ? w.activity.isError
      : filters.view === "folders" && filters.category === "actor_output"
        ? w.folders.isError
        : filters.view === "folders"
          ? w.overview.isError
          : w.files.isError;
  const loading =
    filters.view === "activity"
      ? w.activity.isPending
      : filters.view === "folders" && filters.category === "actor_output"
        ? w.folders.isPending
        : filters.view === "folders"
          ? w.overview.isPending
          : w.files.isPending;
  const pageQuery =
    filters.view === "activity"
      ? w.activity
      : filters.view === "folders"
        ? w.folders
        : w.files;
  return (
    <div className="mx-auto w-full max-w-screen-2xl space-y-5 px-4 py-5 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-[1_1_22rem] items-start gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><HardDrive className="h-6 w-6" aria-hidden /></span>
          <div className="min-w-0"><h1 className="text-3xl font-semibold tracking-tight">Storage</h1><p className="mt-1.5 text-sm leading-6 text-muted-foreground">Manage files, review related work, and keep your workspace organized.</p></div>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="h-11 gap-2 rounded-lg"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw
                className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
            <Button className="h-11 gap-2 rounded-lg" onClick={() => setUpload(true)}>
              <Upload className="h-4 w-4" />
              {pendingUploads ? `Uploads (${pendingUploads})` : "Upload files"}
            </Button>
        </div>
      </header>
      <StorageUsageSummary
        usage={usage}
        loading={w.overview.isPending}
        error={w.overview.isError}
        retry={() => void w.overview.refetch()}
      />
      <section
        aria-label="File manager"
        className="grid min-h-[480px] gap-4 xl:grid-cols-[208px_minmax(0,1fr)]"
      >
        <StorageNavigation
          filters={filters}
          usage={usage}
          navigate={navigate}
        />
        <div className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card">
          <div className="space-y-3 px-4 pt-5 sm:px-5">
            {filters.folder && (
              <Button
                variant="ghost"
                className="h-11 gap-2 px-0"
                onClick={() =>
                  navigate({
                    ...DEFAULT_STORAGE_FILTERS,
                    view: "folders",
                    category: "actor_output",
                  })
                }
              >
                <ArrowLeft className="h-4 w-4" />
                Actor runs
              </Button>
            )}
            <h2 className="text-lg font-semibold">{heading}</h2>
            <p className="text-xs leading-5 text-muted-foreground">
              {filters.view === "trash"
                ? "Restore files within 30 days. Permanently deleting files frees capacity; published links may remain accessible until then."
                : filters.view === "cleanup"
                  ? "These are review candidates. A missing source link does not prove a file is unused."
                  : filters.view === "activity"
                    ? "Uploads and the most recent 100 recorded actions per file for the selected business."
                    : filters.folder
                      ? `Run ${actorRunName(filters.folder)}`
                      : "Files belong to the selected business profile. Storage capacity is shared across the organization."}
            </p>
            {filters.view === "cleanup" && (
              <select
                aria-label="Cleanup candidates"
                className={`${storageSelectStyle} w-full sm:w-auto`}
                value={filters.cleanup}
                onChange={(e) =>
                  w.update({
                    cleanup: e.target.value as StorageFilters["cleanup"],
                    sort: "size",
                  })
                }
              >
                <option value="large">Large files (5 MB and above)</option>
                <option value="old">Generated assets older than 90 days</option>
                <option value="unlinked">No recorded source link</option>
              </select>
            )}
            {filters.view === "folders" &&
              filters.category === "actor_output" && (
                <Button
                  variant="outline"
                  className="h-11"
                  onClick={() =>
                    navigate({
                      ...DEFAULT_STORAGE_FILTERS,
                      category: "actor_output",
                    })
                  }
                >
                  Browse all actor files
                </Button>
              )}
          </div>
          {filters.view !== "activity" && (
            <StorageToolbar
              filters={filters}
              update={w.update}
              search={w.search}
              setSearch={w.setSearch}
              view={w.viewMode}
              changeView={w.changeView}
              advanced={advanced}
              toggleAdvanced={() => setAdvanced(!advanced)}
              collections={usage?.collections || []}
            />
          )}
          {selectedFiles.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-2 border-b border-border bg-primary/5 px-4 py-3 sm:px-5"
              role="region"
              aria-label="Selected files"
            >
              <p className="mr-auto text-sm font-medium tabular-nums">
                {selectedFiles.length} selected ·{" "}
                {formatStorageBytes(
                  selectedFiles.reduce((n, file) => n + file.fileSizeBytes, 0),
                )}
              </p>
              {filters.view === "trash" ? (
                <>
                  <Button
                    variant="outline"
                    className="h-11 gap-2"
                    disabled={busy}
                    onClick={() => bulk("restore")}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Restore selected
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 text-destructive"
                    disabled={busy}
                    onClick={() => bulk("purge")}
                  >
                    Delete permanently
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    className="h-11 gap-2"
                    onClick={() => void download(selectedFiles)}
                  >
                    <Download className="h-4 w-4" />
                    Download ZIP
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 gap-2"
                    disabled={busy}
                    onClick={() => bulk("organize")}
                  >
                    <Tags className="h-4 w-4" />
                    Organize
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 gap-2"
                    disabled={busy}
                    onClick={() => bulk("trash")}
                  >
                    <Trash2 className="h-4 w-4" />
                    Move to Trash
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                className="h-11"
                onClick={() => setSelected(new Set())}
              >
                Clear selection
              </Button>
            </div>
          )}
          <div className="min-w-0 flex-1">
            {loading ? (
              <div
                className="space-y-4 p-5"
                role="status"
                aria-label="Loading files"
              >
                {[1, 2, 3, 4].map((n) => (
                  <Skeleton className="h-14 w-full" key={n} />
                ))}
              </div>
            ) : error ? (
              <div role="alert" className="space-y-4 p-8 text-center">
                <p>Files could not be loaded.</p>
                <Button variant="outline" onClick={() => void refresh()}>
                  Try again
                </Button>
              </div>
            ) : filters.view === "activity" ? (
              <ul className="max-h-[600px] divide-y overflow-y-auto">
                {w.activity.data?.pages
                  .flatMap((page) => page.events)
                  .map((event, index) => (
                    <li
                      key={`${event.id}:${event.at}:${index}`}
                      className="flex flex-wrap justify-between gap-2 px-5 py-4"
                    >
                      <div className="min-w-0">
                        <p className="break-words text-sm">{event.name}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {event.action.replace(/_/g, " ")} ·{" "}
                          {event.actor_user_id
                            ? `Member #${event.actor_user_id}`
                            : "Uploader not recorded"}
                        </p>
                      </div>
                      <time className="text-xs text-muted-foreground">
                        {storageFileDate(event.at)}
                      </time>
                    </li>
                  ))}
                {!w.activity.data?.pages[0]?.total && (
                  <li className="p-8 text-center text-sm text-muted-foreground">
                    No file activity yet.
                  </li>
                )}
              </ul>
            ) : filters.view === "folders" ? (
              <div className="grid gap-3 p-5 sm:grid-cols-2 2xl:grid-cols-3">
                {filters.category === "actor_output"
                  ? w.folders.data?.pages
                      .flatMap((page) => page.folders)
                      .map((run) => (
                        <button
                          key={run.folder}
                          className="space-y-3 rounded-lg border p-4 text-left hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() =>
                            navigate({
                              ...DEFAULT_STORAGE_FILTERS,
                              category: "actor_output",
                              folder: run.folder,
                            })
                          }
                        >
                          <FolderOpen className="h-5 w-5 text-primary" />
                          <p className="break-words text-sm font-medium">
                            {actorFolderName(run.folder)}
                          </p>
                          <p className="break-words text-xs text-muted-foreground">
                            {actorRunName(run.folder)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {run.count} files · {formatStorageBytes(run.bytes)}
                          </p>
                        </button>
                      ))
                  : usage?.breakdown
                      .filter((item) =>
                        storageCategoryLabel(item.category)
                          .toLowerCase()
                          .includes(w.search.toLowerCase()),
                      )
                      .map((item) => (
                        <button
                          key={item.category}
                          className="space-y-3 rounded-lg border p-4 text-left hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() =>
                            navigate({
                              ...DEFAULT_STORAGE_FILTERS,
                              category: item.category,
                              view:
                                item.category === "actor_output"
                                  ? "folders"
                                  : "files",
                            })
                          }
                        >
                          <FolderOpen className="h-5 w-5 text-primary" />
                          <p className="text-sm font-medium">
                            {storageCategoryLabel(item.category)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {item.count} files ·{" "}
                            {formatStorageBytes(item.bytes)}
                          </p>
                        </button>
                      ))}
                {(filters.category === "actor_output"
                  ? !w.folders.data?.pages[0]?.total
                  : !usage?.breakdown.some((item) =>
                      storageCategoryLabel(item.category)
                        .toLowerCase()
                        .includes(w.search.toLowerCase()),
                    )) && (
                  <p className="col-span-full py-10 text-center text-sm text-muted-foreground">
                    No folders found. Browse all files or upload files to get
                    started.
                  </p>
                )}
              </div>
            ) : loadedFiles.length ? (
              <StorageFiles
                files={loadedFiles}
                view={w.viewMode}
                selected={selected}
                busy={busy}
                select={(id, checked) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked && next.size < 200) next.add(id);
                    else if (!checked) next.delete(id);
                    return next;
                  })
                }
                selectAll={(checked) =>
                  setSelected(
                    checked
                      ? new Set(
                          loadedFiles.slice(0, 200).map((file) => file.id),
                        )
                      : new Set(),
                  )
                }
                action={action}
              />
            ) : (
              <div className="space-y-4 px-5 py-16 text-center">
                <h3 className="text-sm font-medium">
                  {filters.view === "trash"
                    ? "Trash is empty"
                    : filters.view === "cleanup"
                      ? "No files match these cleanup criteria"
                      : "No matching files"}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {filters.view === "trash"
                    ? "Files you move to Trash appear here for 30 days."
                    : "Adjust the filters or upload files to the selected business."}
                </p>
                {filters.view !== "trash" && (
                  <Button
                    variant="outline"
                    onClick={() => navigate(DEFAULT_STORAGE_FILTERS)}
                  >
                    Browse all files
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4 text-xs text-muted-foreground">
            <span role="status">
              {filters.view === "folders"
                ? filters.category === "actor_output"
                  ? `${w.folders.data?.pages.reduce((n, p) => n + p.folders.length, 0) || 0} of ${w.folders.data?.pages[0]?.total || 0} runs`
                  : "Folders in selected business"
                : filters.view === "activity"
                  ? `${w.activity.data?.pages.reduce((n, p) => n + p.events.length, 0) || 0} of ${w.activity.data?.pages[0]?.total || 0} events`
                  : `Showing ${loadedFiles.length} of ${total} files`}
            </span>
            {pageQuery.hasNextPage && (
              <Button
                variant="outline"
                className="h-11"
                disabled={pageQuery.isFetchingNextPage || error}
                onClick={() => void pageQuery.fetchNextPage()}
              >
                {pageQuery.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            )}
            <span>Up to 200 files per bulk action</span>
          </div>
        </div>
      </section>
      <StorageUpload
        open={upload}
        close={() => setUpload(false)}
        saved={w.invalidate}
        status={setPendingUploads}
      />
      <StorageDetails
        file={details}
        scope={w.scopeKey}
        businessName={usage?.businessName}
        close={() => setDetails(null)}
        action={action}
      />
      <StoragePreview
        file={preview}
        files={loadedFiles}
        close={() => setPreview(null)}
        change={setPreview}
        download={(file) => void download([file])}
      />
      {request && (
        <StorageDialogs
          key={`${request.action}:${request.files.map((file) => file.id).join(",")}`}
          request={request}
          busy={busy}
          error={actionError}
          close={() => setRequest(null)}
          save={(data) => void save(data)}
          collections={usage?.collections || []}
        />
      )}
    </div>
  );
}
