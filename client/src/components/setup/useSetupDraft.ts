"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { trackSetupEvent } from "@/lib/setup-analytics";
import api, { ApiError } from "@/lib/api";

export interface SetupDraftRecord<T> {
  data: T;
  step: number;
  revision: number;
  updatedAt: string;
}
export interface SetupDraftBootstrap<T> {
  draft: SetupDraftRecord<T> | null;
  error?: string;
}
export type SetupDraftStatus = "loading" | "saving" | "saved" | "local" | "error" | "conflict";
export type SetupDraftHandle<T = unknown> = (() => Promise<void>) & {
  ready: boolean;
  status: SetupDraftStatus;
  savedAt: string | null;
  conflictKind: "draft" | "source" | null;
  discard: () => Promise<void>;
  error: string;
  retry: () => Promise<void>;
  reload: () => Promise<void>;
  flush: (value?: { data: T; step: number; sourceVersion?: number }) => Promise<void>;
};

const endpoint = (remoteKey: string) => `/api/setup/drafts/${encodeURIComponent(remoteKey)}`;
const recent = (value: unknown) => Number(value) > Date.now() - 30 * 24 * 60 * 60 * 1000;

function localDraft<T>(storageKey: string): SetupDraftRecord<T> | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(storageKey) || "null");
    if (!raw?.data || !recent(raw.updatedAt)) return null;
    // v1 toolkit drafts and the original workspace drafts remain recoverable.
    return {
      data: raw.version ? raw.data : raw,
      step: Number(raw.step) || 1,
      revision: Number(raw.revision) || 0,
      updatedAt: new Date(Number(raw.updatedAt)).toISOString(),
    };
  } catch { return null; }
}

/** Server copies are authoritative across devices; only compatible pending edits resume locally. */
export async function loadSetupDraft<T>(storageKey: string, remoteKey: string): Promise<SetupDraftBootstrap<T>> {
  const local = localDraft<T>(storageKey);
  try {
    const response = await api.get<{ draft: SetupDraftRecord<T> | null }>(endpoint(remoteKey));
    const server = response?.draft || null;
    if (local && local.revision === (server?.revision || 0) && (!server || Date.parse(local.updatedAt) > Date.parse(server.updatedAt))) {
      return { draft: local };
    }
    // A local draft with a revision but no server copy was cleared on another device.
    return { draft: server || (local?.revision === 0 ? local : null) };
  } catch (failure) {
    return { draft: local, error: failure instanceof Error ? failure.message : "Your saved draft could not be loaded." };
  }
}

/** Debounced, serial server saves with compare-and-swap revisions and an offline tab copy. */
export function useSetupDraft<T>({ storageKey, remoteKey, ready, data, step, restore, maxStep = 6, bootstrap, sourceVersion }: {
  storageKey: string;
  remoteKey?: string;
  ready: boolean;
  data: T;
  step: number;
  restore: (data: T, step: number) => void;
  maxStep?: number;
  bootstrap?: SetupDraftBootstrap<T>;
  sourceVersion?: number;
}): SetupDraftHandle<T> {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<SetupDraftStatus>("loading");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [conflictKind, setConflictKind] = useState<"draft" | "source" | null>(null);
  const source = useRef(sourceVersion);
  const latest = useRef({ data, step });
  const restoreRef = useRef(restore);
  const revision = useRef(0);
  const saved = useRef("");
  const finished = useRef(false);
  const blocked = useRef(false);
  const flight = useRef<Promise<void> | null>(null);
  const generation = useRef(0);
  const hydrated = useRef(false);
  useLayoutEffect(() => {
    source.current = sourceVersion;
    latest.current = { data, step };
    restoreRef.current = restore;
  }, [sourceVersion, data, step, restore]);

  const transport = useCallback((value: T): T => value && typeof value === "object" && !Array.isArray(value) && source.current !== undefined ? { ...value, __setupSourceVersion: source.current } : value, []);
  const sourceMismatch = useCallback((value: T) => {
    const base = value && typeof value === "object" && "__setupSourceVersion" in value ? value.__setupSourceVersion : undefined;
    return base !== undefined && source.current !== undefined && base !== source.current;
  }, []);
  const unpack = useCallback((value: T): T => {
    if (value && typeof value === "object" && "__setupSourceVersion" in value) {
      const copy = { ...value }; delete copy.__setupSourceVersion; return copy;
    }
    return value;
  }, []);

  const remember = useCallback((value: { data: T; step: number }) => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({ version: 2, ...value, data: transport(value.data), revision: revision.current, updatedAt: Date.now() }));
    } catch { /* A server save remains possible when browser storage is full. */ }
  }, [storageKey, transport]);

  useEffect(() => {
    generation.current += 1;
    hydrated.current = false;
    revision.current = 0;
    finished.current = false;
    blocked.current = false;
    saved.current = "";
    setActive(false);
    setStatus("loading");
    setError("");
    setConflictKind(null);
    setSavedAt(null);
  }, [storageKey, remoteKey]);

  useEffect(() => {
    if (!ready || hydrated.current) return;
    const currentGeneration = generation.current;
    let alive = true;
    const hydrate = async () => {
      const result = bootstrap || (remoteKey ? await loadSetupDraft<T>(storageKey, remoteKey) : { draft: localDraft<T>(storageKey) });
      if (!alive || currentGeneration !== generation.current) return;
      hydrated.current = true;
      if (result.draft && sourceMismatch(result.draft.data)) {
        revision.current = result.draft.revision;
        blocked.current = true;
        setConflictKind("source");
        setError("Your saved details changed after this draft was started. Use the latest saved details to avoid replacing someone else’s changes.");
        setStatus("conflict");
        setActive(true);
        return;
      }
      if (result.draft) {
        const value = { data: unpack(result.draft.data), step: Math.min(maxStep, Math.max(1, result.draft.step)) };
        revision.current = result.draft.revision;
        latest.current = value;
        restoreRef.current(value.data, value.step);
        // Local compatible edits may still need a server save, so do not skip it.
        if (revision.current) setSavedAt(result.draft.updatedAt);
      }
      blocked.current = !!result.error;
      setError(result.error || "");
      setStatus(result.error ? "error" : remoteKey ? "saved" : "local");
      setActive(true);
    };
    void hydrate();
    return () => { alive = false; };
  }, [ready, storageKey, remoteKey, maxStep, bootstrap, sourceMismatch, unpack]);

  const flush = useCallback(async (override?: { data: T; step: number; sourceVersion?: number }) => {
    if (override) {
      latest.current = { data: override.data, step: override.step };
      if (override.sourceVersion !== undefined) source.current = override.sourceVersion;
    }
    if (finished.current) return;
    if (!active || !ready) throw new Error("Wait for your saved draft to load.");
    if (blocked.current) throw new Error("Resolve the draft saving error before continuing.");
    while (flight.current) await flight.current;
    const value = latest.current;
    const fingerprint = JSON.stringify({ ...value, data: transport(value.data) });
    remember(value);
    if (!remoteKey || fingerprint === saved.current) return;
    const currentGeneration = generation.current;
    const request = (async () => {
      setStatus("saving");
      try {
        const response = await api.put<{ draft: SetupDraftRecord<T> }>(endpoint(remoteKey), { ...value, data: transport(value.data), expectedRevision: revision.current });
        if (currentGeneration !== generation.current) return;
        if (!response?.draft || !Number.isSafeInteger(response.draft.revision)) throw new Error("Your draft could not be saved. Try again.");
        revision.current = response.draft.revision;
        saved.current = fingerprint;
        remember(latest.current);
        setSavedAt(response.draft.updatedAt);
        setStatus("saved");
        setError("");
        setConflictKind(null);
      } catch (failure) {
        if (currentGeneration !== generation.current) return;
        const conflict = failure instanceof ApiError && failure.status === 409;
        trackSetupEvent("draft_save_failed", { stage: conflict ? "conflict" : "connection" });
        blocked.current = conflict;
        setConflictKind(conflict ? "draft" : null);
        setStatus(conflict ? "conflict" : "error");
        setError(conflict ? "This draft changed in another tab or device. Reload the saved draft before continuing; your current edits are kept in this tab until then." : "Your changes are kept in this tab but could not be saved to your account. Check your connection and retry.");
        throw failure;
      }
    })();
    flight.current = request;
    try { await request; } finally { if (flight.current === request) flight.current = null; }
  }, [active, ready, remoteKey, remember, transport]);

  useEffect(() => {
    if (!active || !ready || finished.current) return;
    if (blocked.current && conflictKind === "source") return;
    remember({ data, step });
    if (blocked.current) return;
    const timer = window.setTimeout(() => { void flush().catch(() => {}); }, 800);
    return () => window.clearTimeout(timer);
  }, [active, ready, data, step, remember, flush, conflictKind, sourceVersion]);

  const reload = useCallback(async () => {
    if (!remoteKey) return;
    setStatus("loading");
    try {
      if (flight.current) await flight.current.catch(() => {});
      const response = await api.get<{ draft: SetupDraftRecord<T> | null }>(endpoint(remoteKey));
      if (!response.draft) throw new Error("The saved draft was cleared. Reload this page to start from the saved profile.");
      if (sourceMismatch(response.draft.data)) {
        revision.current = response.draft.revision;
        blocked.current = true;
        setConflictKind("source"); setStatus("conflict");
        setError("These saved details changed after this draft was started. Use the latest saved details before continuing.");
        return;
      }
      const value = { data: unpack(response.draft.data), step: Math.min(maxStep, Math.max(1, response.draft.step)) };
      revision.current = response.draft.revision;
      saved.current = JSON.stringify({ ...value, data: transport(value.data) });
      latest.current = value;
      restoreRef.current(value.data, value.step);
      remember(value);
      blocked.current = false;
      setConflictKind(null);
      setError("");
      setSavedAt(response.draft.updatedAt);
      setStatus("saved");
    } catch (failure) {
      blocked.current = true;
      setStatus("error");
      setError(failure instanceof Error ? failure.message : "The saved draft could not be reloaded.");
    }
  }, [remoteKey, maxStep, remember, sourceMismatch, unpack, transport]);

  const retry = useCallback(async () => {
    if (blocked.current && status !== "conflict" && remoteKey) {
      try {
        const response = await api.get<{ draft: SetupDraftRecord<T> | null }>(endpoint(remoteKey));
        if ((response.draft?.revision || 0) !== revision.current) {
          setConflictKind("draft");
          setStatus("conflict");
          setError("A newer draft exists on your account. Reload it before continuing; your current edits remain in this tab.");
          return;
        }
        blocked.current = false;
      } catch { setError("Your account draft is still unavailable. Check your connection and retry."); return; }
    }
    await flush().catch(() => {});
  }, [flush, status, remoteKey]);

  const clear = useCallback(async () => {
    if (flight.current) await flight.current;
    if (remoteKey && revision.current) {
      try { await api.delete(endpoint(remoteKey), { body: JSON.stringify({ expectedRevision: revision.current }), headers: { "Content-Type": "application/json" } }); }
      catch (failure) {
        // Account completion can clear this exact draft atomically on the server.
        if (!(failure instanceof ApiError && failure.status === 409 && failure.data && typeof failure.data === "object" && "draft" in failure.data && failure.data.draft === null)) throw failure;
      }
    }
    finished.current = true;
    try { sessionStorage.removeItem(storageKey); } catch { /* Optional local copy. */ }
  }, [storageKey, remoteKey]);

  const discard = useCallback(async () => {
    try {
      if (remoteKey && revision.current) await api.delete(endpoint(remoteKey), { body: JSON.stringify({ expectedRevision: revision.current }), headers: { "Content-Type": "application/json" } });
      revision.current = 0; saved.current = ""; blocked.current = false;
      setConflictKind(null); setSavedAt(null); setError(""); setStatus("saved");
      remember(latest.current);
    } catch { setError("The draft changed again. Reload this page to check the latest saved details."); }
  }, [remoteKey, remember]);

  // This callable handle attaches callbacks without executing them or reading their refs.
  // eslint-disable-next-line react-hooks/refs
  return Object.assign(clear, { conflictKind, discard, ready: active && ready, status, savedAt, error, retry, reload, flush });
}
