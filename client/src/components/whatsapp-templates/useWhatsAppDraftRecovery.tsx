"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Callout } from "@/components/ui/callout";
import { selectedBusinessProfileId, subscribeBusinessProfile } from "@/lib/business-profile";

const PREFIX = "whatsapp-draft-recovery:v1:";
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const STORAGE_ERROR = "Recovery is unavailable in this browser. Keep this page open and save your draft before leaving.";

interface RecoveryCopy<T> {
  version: 1;
  revision: string | null;
  savedAt: number;
  value: T;
}

export interface WhatsAppDraftRecoveryOptions<T> {
  scope: string;
  value: T;
  dirty: boolean;
  revision: string | null;
  ready: boolean;
  onRestore: (value: T) => void;
  isDraft: (value: unknown) => value is T;
}

function serialize(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof Blob !== "undefined" && item instanceof Blob) {
      throw new Error("Attachments must be uploaded separately");
    }
    return item;
  });
  if (typeof serialized !== "string") throw new Error("Invalid recovery value");
  return serialized;
}

/** A tab-local recovery copy, isolated by verified account, business and editor.
 * The caller must provide serializable fields and reattach uploaded File objects.
 */
export function useWhatsAppDraftRecovery<T>(options: WhatsAppDraftRecoveryOptions<T>) {
  const { user } = useAuth();
  const [profileVersion, setProfileVersion] = useState(0);
  useEffect(() => subscribeBusinessProfile(() => setProfileVersion((version) => version + 1)), []);
  let businessId: number | null = null;
  try {
    // The existing selector reads the cached account. During an account switch,
    // only trust its selection when that cached identity matches verified auth.
    const cachedUser = JSON.parse(localStorage.getItem("user") || "null");
    const cachedId = cachedUser?.id ?? cachedUser?.user?.id;
    businessId = (cachedId === user?.id ? selectedBusinessProfileId() : null) ?? user?.businessProfileId ?? null;
  } catch { businessId = user?.businessProfileId ?? null; }
  // profileVersion ensures a profile-selection event refreshes the scope.
  void profileVersion;
  const key = user?.id && businessId ? `${PREFIX}${user.id}:${businessId}:${encodeURIComponent(options.scope)}` : null;
  let currentValue: string | null = null;
  try { currentValue = serialize(options.value); } catch { /* The save attempt surfaces unsupported values. */ }
  const latest = useRef({ ...options, key });
  useLayoutEffect(() => { latest.current = { ...options, key }; });
  const [pending, setPending] = useState<(RecoveryCopy<T> & { key: string }) | null>(null);
  const pendingRef = useRef(pending);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [savedValue, setSavedValue] = useState<string | null>(null);
  const [lastRecoveredAt, setLastRecoveredAt] = useState<number | undefined>(undefined);
  const suppressed = useRef<{ key: string | null; value: string } | null>(null);
  const initialized = useRef<string | null>(null);
  const approvedNavigation = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const flush = useCallback(() => {
    cancel();
    const current = latest.current;
    if (!current.ready || !current.key || !current.dirty || pendingRef.current?.key === current.key) return;
    try {
      if (!current.isDraft(current.value)) throw new Error("Invalid recovery draft");
      const serialized = serialize(current.value);
      if (suppressed.current?.key === current.key && suppressed.current.value === serialized) return;
      const time = Date.now();
      const copy: RecoveryCopy<T> = { version: 1, revision: current.revision, savedAt: time, value: current.value };
      sessionStorage.setItem(current.key, serialize(copy));
      setSavedAt(time);
      setSavedValue(serialized);
      setError(null);
    } catch { setError(STORAGE_ERROR); }
  }, [cancel]);

  const clear = useCallback(() => {
    cancel();
    const current = latest.current;
    try {
      suppressed.current = { key: current.key, value: serialize(current.value) };
      if (current.key) sessionStorage.removeItem(current.key);
      setError(null);
    } catch { setError(STORAGE_ERROR); }
    pendingRef.current = null;
    setPending(null);
    setSavedAt(null);
    setSavedValue(null);
  }, [cancel]);

  useEffect(() => {
    cancel();
    if (!options.ready || !key) {
      pendingRef.current = null;
      setPending(null);
      setSavedAt(null);
      setSavedValue(null);
      return;
    }
    const priorKey = initialized.current;
    initialized.current = key;
    pendingRef.current = null;
    setPending(null);
    setSavedAt(null);
    setSavedValue(null);
    setLastRecoveredAt(undefined);
    setError(null);
    // A mounted editor changing tenants must never copy the previous tenant's
    // still-rendered fields into the next tenant's recovery key.
    if (priorKey && priorKey !== key) {
      try { suppressed.current = { key, value: serialize(latest.current.value) }; } catch { setError(STORAGE_ERROR); }
    }
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      const copy: unknown = JSON.parse(raw);
      if (typeof copy !== "object" || !copy || !("version" in copy) || copy.version !== 1 ||
          !("savedAt" in copy) || typeof copy.savedAt !== "number" || !Number.isFinite(copy.savedAt) ||
          copy.savedAt > Date.now() + 60_000 || Date.now() - copy.savedAt > MAX_AGE ||
          !("revision" in copy) || copy.revision !== options.revision ||
          !("value" in copy) || !latest.current.isDraft(copy.value)) {
        sessionStorage.removeItem(key);
        return;
      }
      const validated = copy as RecoveryCopy<T>;
      if (serialize(validated.value) === serialize(latest.current.value)) {
        setSavedAt(validated.savedAt);
        setSavedValue(serialize(validated.value));
        return;
      }
      const recovered = { ...validated, key };
      pendingRef.current = recovered;
      setPending(recovered);
    } catch {
      try { sessionStorage.removeItem(key); } catch { /* Preserve the visible storage failure. */ }
      setError(STORAGE_ERROR);
    }
  }, [key, options.ready, options.revision, cancel]);

  useEffect(() => {
    cancel();
    if (options.ready && options.dirty && key && !pendingRef.current) timer.current = setTimeout(flush, 300);
    return cancel;
  }, [key, currentValue, options.dirty, options.ready, pending, cancel, flush]);

  useEffect(() => {
    let approvalTimer: ReturnType<typeof setTimeout> | null = null;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!latest.current.dirty || approvedNavigation.current) return;
      flush();
      event.preventDefault();
      event.returnValue = "";
    };
    const onPageHide = () => flush();
    const onAnchor = (event: MouseEvent) => {
      if (!latest.current.dirty || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(target instanceof HTMLAnchorElement) || target.hasAttribute("download") || (target.target && target.target !== "_self")) return;
      const destination = new URL(target.href, window.location.href);
      const current = new URL(window.location.href);
      if (destination.origin === current.origin && destination.pathname === current.pathname && destination.search === current.search) return;
      if (!window.confirm("You have unsaved changes. Leave this page? A recovery copy will remain in this tab when available.")) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      flush();
      approvedNavigation.current = true;
      if (approvalTimer) clearTimeout(approvalTimer);
      // Suppress a duplicate native prompt for this navigation only. A failed
      // SPA transition must not silence future refresh warnings indefinitely.
      approvalTimer = setTimeout(() => { approvedNavigation.current = false; }, 1_000);
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("click", onAnchor, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("click", onAnchor, true);
      if (approvalTimer) clearTimeout(approvalTimer);
    };
  }, [flush]);

  // Returning to the mounted editor after a cancelled/handled navigation should
  // restore the browser unload warning on the next change.
  useEffect(() => { approvedNavigation.current = false; }, [options.value]);

  const restore = () => {
    const copy = pendingRef.current;
    if (!copy || copy.key !== latest.current.key) return;
    latest.current.onRestore(copy.value);
    pendingRef.current = null;
    setPending(null);
    setLastRecoveredAt(copy.savedAt);
    setSavedAt(copy.savedAt);
    setSavedValue(serialize(copy.value));
    setError(null);
  };
  const visiblePending = pending?.key === key ? pending : null;
  const missingFileName = visiblePending && typeof visiblePending.value === "object" && visiblePending.value &&
    "missingFileName" in visiblePending.value && typeof visiblePending.value.missingFileName === "string" ? visiblePending.value.missingFileName : null;
  const status = error ? "Recovery unavailable" : visiblePending ? "Recovery available" : options.dirty ?
    savedAt && savedValue === currentValue ? `Recovery copy saved at ${new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Unsaved changes" : "Saved";
  const banner = error || visiblePending ? (
    <Callout tone="warning">
      {error && <p role="alert">{error}</p>}
      {visiblePending && <div role="status">
        <p>Unfinished work from {new Date(visiblePending.savedAt).toLocaleString()} is available in this tab.</p>
        {missingFileName && <p className="mt-1">Reattach {missingFileName} after restoring. File uploads are not stored in recovery copies.</p>}
        <div className="mt-2 flex gap-3">
          <button type="button" className="rounded border border-current px-3 py-1 font-medium" onClick={restore}>Restore unfinished work</button>
          <button type="button" className="rounded px-3 py-1 underline" onClick={clear}>Discard recovery copy</button>
        </div>
      </div>}
    </Callout>
  ) : null;

  return { banner, clear, flush, status, lastRecoveredAt };
}
