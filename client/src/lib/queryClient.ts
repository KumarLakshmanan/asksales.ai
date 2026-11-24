import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { getAuthHeaders } from "./authHeaders";
import { ApiError, getCsrfToken } from "./api-client";
import api from "./api";
import { defaultQueryRetry } from "./queryRetry";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined
): Promise<Response> {
  const headers: Record<string, string> = {
    ...getAuthHeaders(),
    ...(data ? { "Content-Type": "application/json" } : {}),
  };
  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
    const csrf = getCsrfToken();
    if (csrf) headers["X-XSRF-TOKEN"] = csrf;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  <T,>({ on401: unauthorizedBehavior }: { on401: UnauthorizedBehavior }): QueryFunction<T> =>
  async ({ queryKey, signal }) => {
    // Reads go through the shared API client so they get the same transient
    // read retry (network failure, 502/503/504), request deadline, auth and
    // business-profile headers as every other page read. The 401 event stays
    // suppressed to keep this fetcher's contract: it reports the 401 (or
    // returns null) and the caller decides.
    try {
      return await api.get<T>(queryKey.join("/") as string, { signal, suppressUnauthorizedEvent: true });
    } catch (error) {
      if (unauthorizedBehavior === "returnNull" && error instanceof ApiError && error.status === 401) {
        // Same contract as before: callers opting into "returnNull" accept null.
        return null as T;
      }
      throw error;
    }
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: 60_000, // 60 seconds — data refreshes on next focus/mount after 1 min
      // One more attempt for server/network errors; a 4xx answer is final.
      retry: defaultQueryRetry,
    },
    mutations: {
      retry: false,
    },
  },
});
