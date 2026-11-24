"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";

type Params = Record<string, string | number | boolean | null | undefined>;

export interface TrackingQuery<T> {
  /** Stays on screen while a new filter or page loads, so tables dim instead of emptying. */
  data: T | undefined;
  loading: boolean;
  error: string;
  /** True when the server said the record does not exist in this business. */
  notFound: boolean;
  /** When `data` last arrived. */
  updatedAt: number | null;
  refetch: () => void;
}

interface State<T> { endpoint: string | null; key: string | null; data?: T; error: string; notFound?: boolean; loading: boolean; updatedAt: number | null }

const cleanParams = (params: Params) =>
  Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""));

/**
 * Loads one message-tracking endpoint. Pass `null` as the endpoint to wait.
 * `refreshMs` re-reads quietly while the tab is visible, for an outreach that
 * is still sending; `shouldRefresh` stops that once the data says nothing is
 * left to change.
 */
export function useTrackingQuery<T>(
  endpoint: string | null, params: Params = {}, refreshMs: number | false = false, shouldRefresh?: (data: T) => boolean,
): TrackingQuery<T> {
  const query = JSON.stringify(cleanParams(params));
  const key = endpoint ? `${endpoint}?${query}` : null;
  const [state, setState] = useState<State<T>>({ endpoint: null, key: null, error: "", loading: Boolean(endpoint), updatedAt: null });
  const request = useRef(0);
  const inFlight = useRef(0);

  const load = useCallback((quiet: boolean) => {
    if (!endpoint || !key) return;
    const version = ++request.current;
    inFlight.current = version;
    if (!quiet) setState(current => ({
      endpoint, key, error: "", loading: true,
      // Data from another endpoint (a different outreach) must never show under this one.
      data: current.endpoint === endpoint ? current.data : undefined,
      updatedAt: current.endpoint === endpoint ? current.updatedAt : null,
    }));
    api.get<T>(endpoint, { params: JSON.parse(query) as Params }).then(
      data => { if (version === request.current) setState({ endpoint, key, data, error: "", loading: false, updatedAt: Date.now() }); },
      (reason: unknown) => {
        // A failed background refresh keeps the last good numbers on screen.
        if (version !== request.current || quiet) return;
        setState({ endpoint, key, data: undefined, loading: false, updatedAt: null,
          notFound: reason instanceof ApiError && reason.status === 404,
          error: reason instanceof Error && reason.message ? reason.message : "This could not be loaded. Try again." });
      },
    ).finally(() => { if (inFlight.current === version) inFlight.current = 0; });
  }, [endpoint, key, query]);

  useEffect(() => {
    load(false);
    return () => { request.current++; };
  }, [load]);

  const latest = useRef<{ data?: T; shouldRefresh?: (data: T) => boolean }>({});
  useEffect(() => { latest.current = { data: state.endpoint === endpoint ? state.data : undefined, shouldRefresh }; });

  useEffect(() => {
    if (!refreshMs || !key) return;
    const timer = window.setInterval(() => {
      const { data, shouldRefresh: wanted } = latest.current;
      // A quiet refresh must not supersede a load still running, or a read
      // slower than the interval keeps the card loading indefinitely.
      if (inFlight.current) return;
      if (document.visibilityState === "visible" && (!wanted || (data !== undefined && wanted(data)))) load(true);
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [refreshMs, key, load]);

  const refetch = useCallback(() => load(false), [load]);
  const current = state.key === key;
  return {
    data: state.endpoint === endpoint ? state.data : undefined,
    loading: current ? state.loading : Boolean(endpoint),
    error: current ? state.error : "",
    notFound: current && Boolean(state.notFound),
    updatedAt: state.endpoint === endpoint ? state.updatedAt : null,
    refetch,
  };
}
