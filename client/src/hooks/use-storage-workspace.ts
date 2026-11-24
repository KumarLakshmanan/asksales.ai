"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  selectedBusinessProfileId,
  subscribeBusinessProfile,
} from "@/lib/business-profile";
import {
  DEFAULT_STORAGE_FILTERS,
  storageFiltersFromUrl,
  storageQuery,
  type StorageFilters,
  type WorkspaceFile,
  type WorkspaceUsage,
} from "@/lib/storage-workspace";

export function useStorageWorkspace() {
  const profile = useSyncExternalStore(
    subscribeBusinessProfile,
    selectedBusinessProfileId,
    () => null,
  );
  const [actor, setActor] = useState<number | null>(null);
  const [filters, setFilters] = useState<StorageFilters>(
    DEFAULT_STORAGE_FILTERS,
  );
  const [ready, setReady] = useState(false);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const client = useQueryClient();
  useEffect(() => {
    try {
      const user = JSON.parse(localStorage.getItem("user") || "null");
      setActor(user?.id || user?.user?.id || null);
    } catch {
      /* Cookie sessions are supported. */
    }
    const sync = () => {
      const value = storageFiltersFromUrl(window.location.search);
      setFilters(value);
      setSearch(value.search);
    };
    sync();
    setReady(true);
    try {
      setViewMode(
        localStorage.getItem("storage:view") === "grid" ? "grid" : "list",
      );
    } catch {
      /* Private browsing can disable storage. */
    }
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const update = useCallback((patch: Partial<StorageFilters>, push = false) => {
    const next = { ...storageFiltersFromUrl(window.location.search), ...patch },
      params = storageQuery(next);
    const url = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
    if (push) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
    setFilters(next);
    if (patch.search !== undefined) setSearch(patch.search);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(
      () => update({ search: search.trim() }),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [search, ready, update]);
  const key = useMemo(
    () => ["storage-workspace", actor, profile] as const,
    [actor, profile],
  );
  const overview = useQuery({
    queryKey: [...key, "overview"],
    queryFn: ({ signal }) =>
      api.get<WorkspaceUsage>("/api/settings/storage/workspace", { signal }),
    enabled: ready,
    staleTime: 30000,
  });
  const files = useInfiniteQuery({
    queryKey: [...key, "files", filters],
    initialPageParam: "",
    queryFn: ({ signal, pageParam }) => {
      const params = storageQuery(filters);
      if (pageParam) params.set("cursor", pageParam);
      return api.get<{
        files: WorkspaceFile[];
        total: number;
        nextCursor: string | null;
      }>(`/api/settings/storage/workspace/files?${params}`, { signal });
    },
    getNextPageParam: (page) => page.nextCursor || undefined,
    enabled: ready && !["activity", "folders"].includes(filters.view),
    staleTime: 15000,
  });
  const folders = useInfiniteQuery({
    queryKey: [...key, "folders", filters.search],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      api.get<{
        folders: Array<{
          folder: string;
          count: number;
          bytes: number;
          newest: string;
        }>;
        total: number;
      }>(
        `/api/settings/storage/workspace/folders?${new URLSearchParams({ search: filters.search, offset: String(pageParam) })}`,
        { signal },
      ),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.folders.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    enabled:
      ready &&
      filters.view === "folders" &&
      filters.category === "actor_output",
    staleTime: 30000,
  });
  const activity = useInfiniteQuery({
    queryKey: [...key, "activity"],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      api.get<{
        events: Array<{
          id: number;
          name: string;
          at: string;
          action: string;
          actor_user_id: number | null;
        }>;
        total: number;
      }>(`/api/settings/storage/workspace/activity?offset=${pageParam}`, {
        signal,
      }),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.events.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    enabled: ready && filters.view === "activity",
    staleTime: 15000,
  });
  const invalidate = useCallback(
    () =>
      Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({
          queryKey: ["storage-workspace-details", key.join(":")],
        }),
      ]),
    [client, key],
  );
  const changeView = (value: "list" | "grid") => {
    setViewMode(value);
    try {
      localStorage.setItem("storage:view", value);
    } catch {
      /* Keep the in-memory preference. */
    }
  };
  const scopeKey = key.join(":");
  return {
    filters,
    update,
    search,
    setSearch,
    viewMode,
    changeView,
    overview,
    files,
    folders,
    activity,
    invalidate,
    scopeKey,
    loadedFiles: files.data?.pages.flatMap((page) => page.files) || [],
    total: files.data?.pages[0]?.total || 0,
  };
}
