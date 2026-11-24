"use client";
import { FileBox, FolderOpen, History, Trash2, HardDrive, Image, Video, Music, FileText, Palette, BookOpen, Workflow, Paperclip, Users, Layers, type LucideIcon } from "lucide-react";
import { storageCategoryLabel } from "@/lib/storage";
import {
  DEFAULT_STORAGE_FILTERS,
  type StorageFilters,
  type WorkspaceUsage,
} from "@/lib/storage-workspace";
import { storageSelectStyle } from "./StorageToolbar";

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  image: Image, video: Video, audio: Music, document: FileText,
  content_asset: Layers, brand_asset: Palette, knowledge_base: BookOpen,
  actor_output: Workflow, support_media: Paperclip, lead_import: Users,
  general: FileBox,
};

export function StorageNavigation({
  filters,
  usage,
  navigate,
}: {
  filters: StorageFilters;
  usage?: WorkspaceUsage;
  navigate: (patch: Partial<StorageFilters>) => void;
}) {
  const destinations = [
    {
      key: "files",
      label: "All files",
      icon: FileBox,
      count: usage?.activeCount,
    },
    { key: "folders", label: "Folders", icon: FolderOpen, count: undefined },
    {
      key: "cleanup",
      label: "Clean up storage",
      icon: HardDrive,
      count: undefined,
    },
    { key: "trash", label: "Trash", icon: Trash2, count: usage?.trashCount },
    { key: "activity", label: "Activity", icon: History, count: undefined },
  ] as const;
  const value = filters.category
    ? `category:${filters.category}`
    : filters.view;
  const choose = (key: string) =>
    navigate({
      ...DEFAULT_STORAGE_FILTERS,
      ...(key.startsWith("category:")
        ? {
            category: key.slice(9),
            view: key === "category:actor_output" ? "folders" : "files",
          }
        : { view: key as StorageFilters["view"] }),
    });
  return (
    <>
      <div className="rounded-xl border border-border bg-card p-4 xl:hidden">
        <label className="sr-only" htmlFor="storage-destination">
          Browse storage
        </label>
        <select
          id="storage-destination"
          className={`${storageSelectStyle} w-full`}
          value={value}
          onChange={(e) => choose(e.target.value)}
        >
          {destinations.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
          {usage?.breakdown.map((item) => (
            <option key={item.category} value={`category:${item.category}`}>
              {storageCategoryLabel(item.category)}
            </option>
          ))}
        </select>
      </div>
      <aside
        aria-label="Storage folders"
        className="hidden rounded-2xl border border-border bg-card p-3 xl:block"
      >
        <p className="px-3 py-3 text-xs text-muted-foreground">File library</p>
        {destinations.map((item) => (
          <button
            key={item.key}
            onClick={() => choose(item.key)}
            aria-current={value === item.key ? "page" : undefined}
            aria-label={
              item.count === undefined
                ? item.label
                : `${item.label}, ${item.count} files`
            }
            className={`mb-1 flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring ${value === item.key ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted"}`}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">{item.label}</span>
            {item.count !== undefined && (
              <span className="font-mono text-xs">{item.count}</span>
            )}
          </button>
        ))}
        <p className="mb-2 mt-4 border-t px-3 pt-4 text-xs text-muted-foreground">
          Categories
        </p>
        {usage?.breakdown.map((item) => {
          const Icon = CATEGORY_ICONS[item.category] || FileBox;
          return (
          <button
            key={item.category}
            onClick={() => choose(`category:${item.category}`)}
            aria-current={
              value === `category:${item.category}` ? "page" : undefined
            }
            aria-label={`${storageCategoryLabel(item.category)}, ${item.count} files`}
            className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring ${value === `category:${item.category}` ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate" title={storageCategoryLabel(item.category)}>
              {storageCategoryLabel(item.category)}
            </span>
            <span className="font-mono text-xs">{item.count}</span>
          </button>
          );
        })}
      </aside>
    </>
  );
}
