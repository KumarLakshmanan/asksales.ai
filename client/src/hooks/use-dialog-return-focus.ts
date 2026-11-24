"use client";

import { useRef } from "react";

/** Pair programmatic dialogs with the exact invoking control, including duplicates. */
export function useDialogReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  const fallback = useRef<HTMLInputElement>(null);
  const capture = (element: HTMLElement) => { opener.current = element; };
  const restore = (event: Event) => {
    event.preventDefault();
    const original = opener.current;
    const target = original?.isConnected && !original.closest('[hidden], [inert], [aria-hidden="true"]')
      ? original : fallback.current;
    target?.focus({ preventScroll: true });
    opener.current = null;
  };
  return { capture, restore, fallback };
}
