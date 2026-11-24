"use client";

import React, { useId } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import type { NavSection } from "@/lib/sidebarConfig";

export function SidebarWorkspaceSection({ section, active, expanded, onExpandedChange, children }: {
  section: NavSection;
  active: boolean;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const contentId = useId();
  return (
    <section aria-label={section.label} className="relative">
      <div aria-hidden="true" className={`pointer-events-none absolute inset-x-0 top-0 h-11 rounded-[9px] ${active ? "bg-sidebar-accent" : ""}`} />
      <Link
        href={section.collapsedPath}
        aria-current={active ? "location" : undefined}
        title={section.label}
        className={`group absolute left-0 right-11 top-0 flex h-11 min-w-0 items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-sm font-medium transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active ? "text-sidebar-accent-foreground" : "text-muted-foreground"}`}
      >
        <span aria-hidden="true" className={`flex h-7 w-7 shrink-0 items-center justify-center ${active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"}`}>
          {section.icon && React.isValidElement(section.icon)
            ? React.cloneElement(section.icon as React.ReactElement<{ className?: string }>, { className: "h-3.5 w-3.5" })
            : section.icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{section.label}</span>
      </Link>
      <details
        className="group/workspace"
        open={expanded}
        onToggle={event => {
          // Controlled route/preference updates also dispatch native toggle.
          // Save only a user change, never automatic active-route expansion.
          if (event.currentTarget.open !== expanded) onExpandedChange(event.currentTarget.open);
        }}
      >
        <summary
          role="button"
          aria-label={`${section.label} pages`}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="relative ml-auto flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-[9px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
        >
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open/workspace:rotate-180" />
        </summary>
        <div id={contentId} className="ml-[1.375rem] mt-0.5 space-y-0.5 border-l border-sidebar-border py-1 pl-3">
          {children}
        </div>
      </details>
    </section>
  );
}
