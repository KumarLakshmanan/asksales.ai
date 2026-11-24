"use client";

import { useMemo } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import api from "@/lib/api";
import { useDebouncedValue } from "@/hooks/use-debounced-value";

interface TemplatePage<T> {
  templates: T[];
  total: number;
}

interface PaginatedTemplateOptions {
  type: string;
  search: string;
  queryKey: string;
  pageSize?: number;
  retainPreviousSearchResults?: boolean;
}

export function usePaginatedContentTemplates<T>({
  type,
  search,
  queryKey,
  pageSize = 24,
  retainPreviousSearchResults = false,
}: PaginatedTemplateOptions) {
  const debouncedSearch = useDebouncedValue(search.trim(), 250);
  const query = useInfiniteQuery({
    queryKey: [queryKey, type, debouncedSearch],
    // Opt-in libraries keep their locally filtered view and its keyboard
    // controls mounted while a different search key is being fetched.
    placeholderData: retainPreviousSearchResults ? keepPreviousData : undefined,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        type,
        includePredefined: "true",
        limit: String(pageSize),
        offset: String(pageParam),
      });
      if (debouncedSearch) params.set("search", debouncedSearch);
      return api.get<TemplatePage<T>>(`/api/content/templates?${params.toString()}`);
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((total, page) => total + page.templates.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });

  const templates = useMemo(
    () => query.data?.pages.flatMap((page) => page.templates) ?? [],
    [query.data?.pages],
  );

  return {
    ...query,
    templates,
    total: query.data?.pages[0]?.total ?? 0,
    search: debouncedSearch,
  };
}
