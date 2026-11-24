"use client";
import { useEffect, useState } from "react";

/** Let mobile form actions flow below fields while the onscreen keyboard is open. */
export function useKeyboardViewport() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let fullHeight = window.innerHeight;
    const viewport = window.visualViewport;
    const update = () => {
      fullHeight = Math.max(fullHeight, window.innerHeight);
      const focused = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      setOpen(focused && fullHeight - (viewport?.height || window.innerHeight) > 120);
    };
    const orientation = () => { fullHeight = window.innerHeight; update(); };
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", orientation);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", orientation);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, []);
  return open;
}
