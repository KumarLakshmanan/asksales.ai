"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

export type UnsavedNavigationIntent = "navigation" | "workspace";
type Guard = { dirty: () => boolean; confirm: () => boolean; clear: () => void; restore: () => void; leave: (intent: UnsavedNavigationIntent) => void };
const guards = new Set<Guard>();
export function restoreUnsavedNavigation() { guards.forEach(guard => guard.restore()); }
export function confirmUnsavedNavigation(intent: UnsavedNavigationIntent = "navigation") {
  const pending = [...guards].filter(guard => guard.dirty());
  if (!pending.every(guard => guard.confirm())) return false;
  pending.forEach(guard => { guard.leave(intent); guard.clear(); });
  return true;
}

const historyKey = "__asksalesNavigation";
type Position = { session: string; index: number };
function position(state: unknown): Position | undefined {
  if (!state || typeof state !== "object") return;
  const value = (state as Record<string, unknown>)[historyKey] as Position | undefined;
  return value && typeof value.session === "string" && Number.isSafeInteger(value.index) ? value : undefined;
}
let users = 0;
let dispose: (() => void) | undefined;

/** Install before dashboard forms load; preserve Next's own history state. */
export function installUnsavedNavigation() {
  if (users++ === 0) {
    const history = window.history;
    const push = history.pushState;
    const replace = history.replaceState;
    const initial = position(history.state) ?? { session: crypto.randomUUID(), index: 0 };
    let current = { position: initial, state: history.state, url: location.href };
    let restoring = false;
    const stamp = (state: unknown, next: Position) => ({ ...(state && typeof state === "object" ? state : {}), [historyKey]: next });
    replace.call(history, stamp(history.state, initial), "", location.href);
    current.state = history.state;
    history.pushState = function (state, unused, url) {
      const next = { ...current.position, index: current.position.index + 1 };
      push.call(this, stamp(state, next), unused, url);
      current = { position: next, state: history.state, url: location.href };
    };
    history.replaceState = function (state, unused, url) {
      replace.call(this, stamp(state, current.position), unused, url);
      current = { ...current, state: history.state, url: location.href };
    };
    const pop = (event: PopStateEvent) => {
      const next = position(event.state);
      if (restoring) {
        event.stopImmediatePropagation();
        if (next?.session === current.position.session) {
          if (next.index === current.position.index) restoring = false;
          else history.go(current.position.index - next.index);
        } else {
          restoring = false;
          push.call(history, current.state, "", current.url);
        }
        return;
      }
      const target = new URL(location.href), previous = new URL(current.url);
      const changesPage = target.pathname !== previous.pathname || target.search !== previous.search;
      if (changesPage && !confirmUnsavedNavigation()) {
        // popstate cannot be canceled. Keep App Router on the dirty form and
        // return to its entry without adding duplicates to the Forward stack.
        event.stopImmediatePropagation();
        if (next?.session === current.position.session && next.index !== current.position.index) {
          restoring = true;
          history.go(current.position.index - next.index);
        } else {
          // Same-document entries created before instrumentation lack an index.
          // Restore the route/state rather than losing the user's dirty form.
          push.call(history, current.state, "", current.url);
        }
        return;
      }
      const nextPosition = next ?? { ...current.position, index: current.position.index + 1 };
      current = { position: nextPosition, state: event.state, url: location.href };
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const next = new URL(link.href, location.href);
      if (next.pathname === location.pathname && next.search === location.search && next.origin === location.origin) return;
      if (!confirmUnsavedNavigation()) { event.preventDefault(); event.stopPropagation(); }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (![...guards].some(guard => guard.dirty())) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("popstate", pop, true);
    document.addEventListener("click", click, true);
    window.addEventListener("beforeunload", unload);
    dispose = () => {
      history.pushState = push; history.replaceState = replace;
      window.removeEventListener("popstate", pop, true);
      document.removeEventListener("click", click, true);
      window.removeEventListener("beforeunload", unload);
    };
  }
  return () => { if (--users === 0) { dispose?.(); dispose = undefined; } };
}

/** Warn only for an actual edit; successful saves release the guard synchronously. */
export function useUnsavedChanges(dirty: boolean | (() => boolean), message = "You have unsaved changes. Leave without saving?", onLeave?: (intent: UnsavedNavigationIntent) => void) {
  const dirtyRef = useRef(dirty);
  const leaveRef = useRef(onLeave);
  useLayoutEffect(() => { dirtyRef.current = dirty; leaveRef.current = onLeave; }, [dirty, onLeave]);
  const isDirty = useCallback(() => typeof dirtyRef.current === "function" ? dirtyRef.current() : dirtyRef.current, []);
  const clearGuard = useCallback(() => { dirtyRef.current = false; }, []);
  const confirmLeave = useCallback(() => !isDirty() || window.confirm(message), [isDirty, message]);
  useEffect(() => {
    const guard: Guard = { dirty: isDirty, confirm: confirmLeave, clear: clearGuard, restore: () => { dirtyRef.current = dirty; }, leave: intent => leaveRef.current?.(intent) };
    guards.add(guard);
    const release = installUnsavedNavigation();
    return () => { guards.delete(guard); release(); };
  }, [clearGuard, confirmLeave, dirty, isDirty]);
  // Preserve the original callable API; assigning callbacks does not invoke them or read refs.
  // eslint-disable-next-line react-hooks/refs
  return Object.assign(confirmLeave, { confirmLeave, clearGuard });
}
