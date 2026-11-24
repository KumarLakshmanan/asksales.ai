"use client";
import { useState } from "react";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatStorageBytes, storageFileName } from "@/lib/storage";
import type { WorkspaceFile } from "@/lib/storage-workspace";

export type StorageActionRequest = {
  action: "trash" | "restore" | "purge" | "rename" | "organize";
  files: WorkspaceFile[];
};
export function StorageDialogs({
  request,
  busy,
  error,
  close,
  save,
  collections,
}: {
  request: StorageActionRequest | null;
  busy: boolean;
  error: string;
  close: () => void;
  save: (data: {
    name?: string;
    tags?: string[];
    collection?: string;
    acknowledgeReferences?: boolean;
  }) => void;
  collections: string[];
}) {
  const [name, setName] = useState(
    request?.files[0] ? storageFileName(request.files[0]) : "",
  );
  const [tags, setTags] = useState(
    request?.files.length === 1
      ? request.files[0].workspace.tags?.join(", ") || ""
      : "",
  );
  const [collection, setCollection] = useState(
    request?.files.length === 1
      ? request.files[0].workspace.collection || ""
      : "",
  );
  const [acknowledged, setAcknowledged] = useState(false);
  if (!request) return null;
  const { action, files } = request,
    review =
      action === "trash" && files.some((file) => file.dependency.needsReview);
  const title =
    action === "rename"
      ? "Rename file"
      : action === "organize"
        ? "Tags and collection"
        : action === "trash"
          ? `Move ${files.length} ${files.length === 1 ? "file" : "files"} to Trash?`
          : action === "restore"
            ? `Restore ${files.length} files?`
            : `Permanently delete ${files.length} files?`;
  const validTags = tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const valid =
    action === "rename"
      ? !!name.trim() && name.length <= 255 && !/[\x00-\x1f\x7f/\\]/.test(name)
      : action === "organize"
        ? validTags.length <= 10 &&
          validTags.every((tag) => tag.length <= 40) &&
          collection.length <= 80
        : !review || acknowledged;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto rounded-2xl"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader className="pr-5 text-left">
          <DialogTitle className="text-xl leading-7">{title}</DialogTitle>
          <DialogDescription className="pt-1 text-sm leading-6">
            {action === "trash"
              ? "Files can be restored for 30 days. They continue to use storage until permanently removed. Published file links may remain accessible until purge."
              : action === "purge"
                ? "This removes the stored files permanently and cannot be undone."
                : action === "restore"
                  ? "Files will return to their original categories and collections."
                  : action === "organize"
                    ? "Tags help you find files. Collections group related work without moving files. Saving replaces tags and collection on every selected file."
                    : "The display name changes. File contents and type stay the same."}
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs font-medium tabular-nums text-muted-foreground">
          {files.length} selected ·{" "}
          {formatStorageBytes(
            files.reduce((sum, file) => sum + file.fileSizeBytes, 0),
          )}
        </p>
        {action === "rename" && (
          <label className="space-y-2 text-sm">
            File name
            <Input
              value={name}
              maxLength={255}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid && !busy)
                  save({ name: name.trim() });
              }}
            />
          </label>
        )}
        {action === "organize" && (
          <>
            <label className="space-y-2 text-sm">
              Tags
              <Input
                value={tags}
                disabled={busy}
                onChange={(e) => setTags(e.target.value)}
                placeholder="launch, customer research"
              />
              <span className="block text-xs text-muted-foreground">
                Comma-separated. Up to 10 tags, 40 characters each.
              </span>
            </label>
            <label className="space-y-2 text-sm">
              Collection
              <Input
                list="storage-collections"
                value={collection}
                maxLength={80}
                disabled={busy}
                onChange={(e) => setCollection(e.target.value)}
                placeholder="Choose or create a collection"
              />
            </label>
            <datalist id="storage-collections">
              {collections.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          </>
        )}
        {review && (
          <Callout tone="warning" title="Review related work">
            <div className="space-y-3 pt-2">
              <ul className="max-h-36 space-y-2 overflow-auto text-xs">
                {files
                  .filter((file) => file.dependency.needsReview)
                  .map((file) => (
                    <li key={file.id} className="flex items-start gap-3 rounded-lg border border-border/60 bg-card p-3">
                      <FileText className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                      <span className="min-w-0 break-words"><span className="block font-medium">{storageFileName(file)}</span><span className="mt-1 block text-muted-foreground">{file.source?.label || "May be used by other resources"}</span></span>
                    </li>
                  ))}
              </ul>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <Checkbox
                  checked={acknowledged}
                  disabled={busy}
                  onCheckedChange={(value) => setAcknowledged(value === true)}
                />
                I reviewed these resources and understand the impact.
              </label>
            </div>
          </Callout>
        )}
        {!valid && (
          <p className="text-xs text-destructive">
            {review && !acknowledged
              ? "Review related work before continuing."
              : "Check the name, tag limits, and collection length."}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button className="min-h-11 flex-1 rounded-lg sm:flex-none" variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            className="min-h-11 flex-1 rounded-lg sm:flex-none"
            variant={action === "purge" ? "destructive" : "default"}
            disabled={busy || !valid}
            onClick={() =>
              save(
                action === "rename"
                  ? { name: name.trim() }
                  : action === "organize"
                    ? { tags: validTags, collection: collection.trim() }
                    : { acknowledgeReferences: acknowledged },
              )
            }
          >
            {busy
              ? "Saving…"
              : action === "rename"
                ? "Save name"
                : action === "organize"
                  ? "Save organization"
                  : action === "trash"
                    ? "Move to Trash"
                    : action === "restore"
                      ? "Restore files"
                      : "Delete permanently"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
