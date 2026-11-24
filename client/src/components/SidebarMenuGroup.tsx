"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import type { NavSection } from "@/lib/sidebarConfig";

export function SidebarMenuGroup({ section, isItemActive, expanded: controlledExpanded, onExpandedChange, itemOpen, onItemOpenChange }: {
  section: NavSection;
  isItemActive: (path: string) => boolean;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  itemOpen?: (path: string) => boolean;
  onItemOpenChange?: (path: string, open: boolean) => void;
}) {
  const [localExpanded, setExpanded] = useState(true);
  const expanded = controlledExpanded ?? localExpanded;
  const contentId = useId();
  const storageKey = `sidebar-section:${section.section}:expanded`;

  useEffect(() => {
    if (controlledExpanded !== undefined) return;
    try {
      setExpanded(localStorage.getItem(storageKey) !== "false");
    } catch {
      // Navigation remains usable when browser storage is unavailable.
    }
  }, [storageKey, controlledExpanded]);

  const toggleSection = () => {
    const nextExpanded = !expanded;
    if (onExpandedChange) { onExpandedChange(nextExpanded); return; }
    setExpanded(nextExpanded);
    try {
      localStorage.setItem(storageKey, String(nextExpanded));
    } catch {
      // Keep the toggle working even when the preference cannot be saved.
    }
  };

  return <section aria-label={section.label} className="my-3 py-3">
    <h2 className="pb-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={toggleSection}
        className="flex min-h-8 w-full items-center justify-between gap-3 rounded-lg px-4 text-xs font-medium tracking-wide text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>{section.label}</span>
        <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`} />
      </button>
    </h2>
    <div id={contentId} hidden={!expanded} className="space-y-1">
      {section.children.map(item => {
        const itemActive = isItemActive(item.path);
        const children = item.children ?? [];
        if (children.length > 0) {
          const dropdownActive = itemActive || children.some(child => isItemActive(child.path));
          return <details key={item.path} className="group/menu" open={itemOpen ? itemOpen(item.path) : dropdownActive ? true : undefined} onToggle={onItemOpenChange ? event => onItemOpenChange(item.path, event.currentTarget.open) : undefined}>
            <summary className={`flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-2 text-sm transition-colors [&::-webkit-details-marker]:hidden ${dropdownActive ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"}`}>
              {item.icon}<span className="min-w-0 flex-1">{item.label}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open/menu:rotate-180" />
            </summary>
            <div className="ml-5 space-y-0.5 border-l border-sidebar-border pl-3">
              {children.map(child => <Link
                key={child.path}
                href={child.path}
                aria-current={isItemActive(child.path) ? "page" : undefined}
                className={`flex min-h-9 items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors ${isItemActive(child.path) ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"}`}
              >
                {child.icon}<span className="min-w-0 flex-1">{child.label}</span>
              </Link>)}
            </div>
          </details>;
        }
        return <Link
          key={item.path}
          href={item.path}
          aria-current={itemActive ? "page" : undefined}
          className={`flex min-h-11 items-center gap-3 rounded-xl px-4 py-2 text-sm transition-colors ${itemActive ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"}`}
        >
          {item.icon}<span className="min-w-0 flex-1">{item.label}</span>
        </Link>;
      })}
    </div>
  </section>;
}
