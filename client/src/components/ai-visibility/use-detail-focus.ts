'use client';
import { useEffect, useRef } from 'react';

/** Keep keyboard and narrow-screen users with the evidence they just opened. */
export function useDetailFocus(selection: number | null | undefined) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selection || !ref.current) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current.focus({ preventScroll: true });
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const behavior = reduce ? 'auto' : 'smooth';
    if (window.innerWidth < 1024) ref.current.scrollIntoView?.({ block: 'start', behavior });
    else {
      // Beside the list the panel normally stays in view, but if the layout leaves it off-screen
      // (short window, zoomed page) a click would seem to do nothing, so bring it into view.
      const rect = ref.current.getBoundingClientRect?.();
      if (rect && (rect.top < 0 || rect.top > window.innerHeight - 80))
        ref.current.scrollIntoView?.({ block: 'nearest', behavior });
    }
    return () => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [selection]);
  return ref;
}
