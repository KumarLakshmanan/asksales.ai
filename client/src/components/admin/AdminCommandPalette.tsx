"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { confirmUnsavedNavigation } from "@/hooks/use-unsaved-changes";
import { Lock, Search } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { useAdminAuth } from "@/contexts/AdminAuthContext";
import { adminSearchEntries } from "@/lib/adminNavigation";

const filterAdminCommands = (value: string, search: string, keywords?: string[]) => {
  const query = search.trim().toLowerCase();
  if (!query) return 1;

  const searchableText = [value, ...(keywords || [])].join(" ").toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  return terms.every((term) => searchableText.includes(term)) ? 1 : 0;
};

interface AdminCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AdminCommandPalette({ open, onOpenChange }: AdminCommandPaletteProps) {
  const router = useRouter();
  const { admin } = useAdminAuth();
  const isSuperAdmin = admin?.role === "super_admin";

  const groupedEntries = useMemo(() => {
    const groups = new Map<string, typeof adminSearchEntries>();
    for (const entry of adminSearchEntries) {
      const existing = groups.get(entry.section) || [];
      existing.push(entry);
      groups.set(entry.section, existing);
    }
    return Array.from(groups.entries());
  }, []);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key?.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    };

    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, [onOpenChange, open]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} filter={filterAdminCommands}>
      <CommandInput placeholder="Search admin pages, providers, and controls…" />
      <CommandList className="max-h-[min(70vh,560px)]">
        <CommandEmpty className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
          <Search className="h-5 w-5 opacity-50" />
          <span>No admin destinations match that search.</span>
        </CommandEmpty>
        {groupedEntries.map(([section, entries]) => (
          <CommandGroup key={section} heading={section}>
            {entries.map((entry) => {
              const locked = Boolean(entry.superAdminOnly && !isSuperAdmin);
              return (
                <CommandItem
                  key={`${entry.path}:${entry.label}`}
                  value={`${entry.label} ${entry.section}`}
                  keywords={entry.keywords}
                  disabled={locked}
                  onSelect={() => {
                    if (!confirmUnsavedNavigation()) return;
                    if (locked) return;
                    close();
                    router.push(entry.path);
                  }}
                  className="gap-3"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    {entry.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  {locked ? (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Lock className="h-3.5 w-3.5" /> Requires super admin
                    </span>
                  ) : (
                    <CommandShortcut>↵</CommandShortcut>
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
      <div className="flex items-center justify-between border-t bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
        <span>Search pages, providers, and pricing controls</span>
        <span><kbd className="rounded border bg-background px-1.5 py-0.5 font-mono">Esc</kbd> to close</span>
      </div>
    </CommandDialog>
  );
}
