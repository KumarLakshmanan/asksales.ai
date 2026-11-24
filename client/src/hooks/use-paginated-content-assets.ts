"use client";

import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import api from "@/lib/api";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { uniqueById } from "@/lib/uniqueById";

interface AssetPage<T> {
  assets: T[];
  total: number;
}

interface PaginatedAssetOptions {
  type: string;
  search: string;
  queryKey: string;
  pageSize?: number;
}

export function usePaginatedContentAssets<T extends { id: number | string }>({
  type,
  search,
  queryKey,
  pageSize = 24,
}: PaginatedAssetOptions) {
  const debouncedSearch = useDebouncedValue(search.trim(), 250);
  const query = useInfiniteQuery({
    queryKey: [queryKey, type, debouncedSearch],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        type,
        paginated: "true",
        limit: String(pageSize),
        offset: String(pageParam),
      });
      if (debouncedSearch) params.set("search", debouncedSearch);
      return api.get<AssetPage<T>>(`/api/content/assets?${params.toString()}`);
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((total, page) => total + page.assets.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });

  // Offset pages can overlap when rows change between page requests (a pending
  // video completes, a refetch after delete). Render each saved asset once.
  const assets = useMemo(
    () => uniqueById(query.data?.pages.flatMap((page) => page.assets) ?? []),
    [query.data?.pages],
  );

  return {
    ...query,
    assets,
    total: query.data?.pages[0]?.total ?? 0,
    search: debouncedSearch,
  };
}
