"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/** One keyboard/focus contract for support and admin navigation overlays. */
export function ResponsiveNavigation({ open, onOpenChange, title, children, desktopClassName }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  desktopClassName?: string;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const update = () => { if (desktop.matches) onOpenChange(false); };
    update(); desktop.addEventListener("change", update);
    return () => desktop.removeEventListener("change", update);
  }, [onOpenChange]);
  return <>
    <aside aria-label={title} className={cn("hidden lg:flex", desktopClassName)}>{children}</aside>
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="flex w-64 max-w-[calc(100vw-2rem)] flex-col gap-0 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground"
        onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={event => {
          const target = returnFocus.current?.isConnected && returnFocus.current.getClientRects().length
            ? returnFocus.current : document.getElementById("main-content");
          if (target) { event.preventDefault(); target.focus(); }
        }}>
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <SheetDescription className="sr-only">Choose a page. Press Escape to close navigation.</SheetDescription>
        <aside aria-label={title} className="flex h-full min-h-0 flex-col pt-10">{children}</aside>
      </SheetContent>
    </Sheet>
  </>;
}
