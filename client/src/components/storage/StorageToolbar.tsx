"use client";
import { useId } from "react";
import { LayoutGrid, List, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import {
  DEFAULT_STORAGE_FILTERS,
  type StorageFilters,
} from "@/lib/storage-workspace";

export const storageSelectStyle =
  "h-11 min-w-0 rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
export function StorageToolbar({
  filters,
  update,
  search,
  setSearch,
  view,
  changeView,
  advanced,
  toggleAdvanced,
  collections,
}: {
  filters: StorageFilters;
  update: (patch: Partial<StorageFilters>) => void;
  search: string;
  setSearch: (value: string) => void;
  view: "list" | "grid";
  changeView: (value: "list" | "grid") => void;
  advanced: boolean;
  toggleAdvanced: () => void;
  collections: string[];
}) {
  const filtersId = useId();
  const extra = [
    "type",
    "after",
    "before",
    "minSize",
    "maxSize",
    "tag",
    "collection",
  ].filter(
    (key) =>
      filters[key as keyof StorageFilters] !==
      DEFAULT_STORAGE_FILTERS[key as keyof StorageFilters],
  ).length;
  return (
    <div className="space-y-4 border-b border-border p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          aria-label="Search files"
          placeholder={
            filters.view === "folders"
              ? "Search folders…"
              : "Search by file name…"
          }
          value={search}
          onValueChange={setSearch}
          onSearch={(query) => {
            // Clearing applies at once; typed text is applied by the workspace's own debounce.
            if (!query) update({ search: "" });
          }}
          className="h-11"
          wrapperClassName="basis-full sm:basis-56 sm:flex-1"
        />
        {filters.view !== "folders" && (
          <>
            <select
              aria-label="Sort files"
              value={filters.sort}
              onChange={(e) =>
                update({ sort: e.target.value as StorageFilters["sort"] })
              }
              className={storageSelectStyle}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name">Name A–Z</option>
              <option value="size">Largest first</option>
            </select>
            <Button
              variant="outline"
              className={`h-11 gap-2 rounded-lg ${advanced ? "border-primary/30 bg-primary/5 text-primary" : ""}`}
              aria-expanded={advanced}
              aria-controls={advanced ? filtersId : undefined}
              onClick={toggleAdvanced}
            >
              <SlidersHorizontal className="h-4 w-4" />
              Filters{extra > 0 && ` (${extra})`}
            </Button>
            <div
              role="group"
              aria-label="File view"
              className="ml-auto flex rounded-lg border p-1"
            >
              <Button
                aria-label="List view"
                aria-pressed={view === "list"}
                variant={view === "list" ? "secondary" : "ghost"}
                className={`h-11 w-11 rounded-md p-0 ${view === "list" ? "bg-primary/10 text-primary" : ""}`}
                onClick={() => changeView("list")}
              >
                <List className="h-4 w-4" />
              </Button>
              <Button
                aria-label="Grid view"
                aria-pressed={view === "grid"}
                variant={view === "grid" ? "secondary" : "ghost"}
                className={`h-11 w-11 rounded-md p-0 ${view === "grid" ? "bg-primary/10 text-primary" : ""}`}
                onClick={() => changeView("grid")}
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </div>
      {advanced && filters.view !== "folders" && (
        <div id={filtersId} className="grid grid-cols-1 gap-4 rounded-xl border border-border bg-muted/10 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <label className="space-y-2 text-xs">
            File type
            <select
              aria-label="File type"
              className={`${storageSelectStyle} w-full`}
              value={filters.type}
              onChange={(e) => update({ type: e.target.value })}
            >
              <option value="all">All types</option>
              {["image", "video", "audio", "document"].map((type) => (
                <option value={type} key={type}>
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-xs">
            Added from
            <Input
              type="date"
              className="h-11"
              value={filters.after}
              onChange={(e) => update({ after: e.target.value })}
            />
          </label>
          <label className="space-y-2 text-xs">
            Added through
            <Input
              type="date"
              className="h-11"
              value={filters.before}
              onChange={(e) => update({ before: e.target.value })}
            />
          </label>
          <label className="space-y-2 text-xs">
            Tag
            <Input
              className="h-11"
              value={filters.tag}
              maxLength={40}
              placeholder="Exact tag"
              onChange={(e) => update({ tag: e.target.value })}
            />
          </label>
          <label className="space-y-2 text-xs">
            Minimum size (MB)
            <Input
              type="number"
              min="0"
              step="0.1"
              className="h-11"
              value={filters.minSize ? Number(filters.minSize) / 1048576 : ""}
              onChange={(e) =>
                update({
                  minSize: e.target.value
                    ? String(Math.round(Number(e.target.value) * 1048576))
                    : "",
                })
              }
            />
          </label>
          <label className="space-y-2 text-xs">
            Maximum size (MB)
            <Input
              type="number"
              min="0"
              step="0.1"
              className="h-11"
              value={filters.maxSize ? Number(filters.maxSize) / 1048576 : ""}
              onChange={(e) =>
                update({
                  maxSize: e.target.value
                    ? String(Math.round(Number(e.target.value) * 1048576))
                    : "",
                })
              }
            />
          </label>
          <label className="space-y-2 text-xs">
            Collection
            <select
              aria-label="Filter collection"
              className={`${storageSelectStyle} w-full`}
              value={filters.collection}
              onChange={(e) => update({ collection: e.target.value })}
            >
              <option value="">All collections</option>
              {collections.map((collection) => (
                <option key={collection}>{collection}</option>
              ))}
            </select>
          </label>
          <Button
            variant="outline"
            className="h-11 self-end"
            onClick={() =>
              update({
                type: "all",
                after: "",
                before: "",
                tag: "",
                minSize: "",
                maxSize: "",
                collection: "",
              })
            }
          >
            Clear filters
          </Button>
        </div>
      )}
    </div>
  );
}
