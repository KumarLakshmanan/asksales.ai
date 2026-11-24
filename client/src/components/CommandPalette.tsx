"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, CornerDownLeft, LayoutDashboard, Search, X } from "lucide-react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useQuery } from "@tanstack/react-query";
import type { PlatformModuleKey } from "@/lib/platform-access";
import { buildDashboardDestinationIndex, scoreDashboardDestination, type DashboardDestination } from "@/lib/dashboard-destinations";
import { useBusinessProfiles } from "@/hooks/use-business-profiles";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { BUSINESS_PROFILE_HEADER } from "@/lib/business-profile";
import type { AssistantCatalog } from "@/lib/outreach-assistants";
import { BRAND_NAME } from "@/lib/brand";
import { confirmUnsavedNavigation } from "@/hooks/use-unsaved-changes";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabledModules?: PlatformModuleKey[];
  workspaceName?: string;
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
}

function SearchResult({
  title,
  category,
  icon,
  value,
  onSelect,
}: {
  title: string;
  category: string;
  icon: React.ReactNode;
  value: string;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={value}
      aria-label={`${title} — ${category}`}
      onSelect={onSelect}
      className="group flex min-h-12 items-center gap-3 rounded-xl border border-transparent px-3 py-2 text-foreground transition-colors hover:bg-muted data-[selected=true]:border-primary/30 data-[selected=true]:bg-primary/10 data-[selected=true]:text-foreground"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground group-data-[selected=true]:border-primary/30 group-data-[selected=true]:bg-primary/10 group-data-[selected=true]:text-primary">
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block break-words text-sm font-medium">{title}</span>
        <span className="mt-0.5 block break-words text-[11px] leading-4 text-muted-foreground group-data-[selected=true]:text-foreground">{category}</span>
      </span>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-primary opacity-0 group-data-[selected=true]:opacity-100" />
    </CommandItem>
  );
}

export function CommandPalette({ open, onOpenChange, enabledModules, workspaceName, returnFocusRef }: CommandPaletteProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const previousFocus = React.useRef<HTMLElement | null>(null);
  const { user } = useAuth();
  const profiles = useBusinessProfiles();
  const profileId = profiles.activeProfile?.id;
  const workspaceRole = !profiles.isLoading && !profiles.isError ? profiles.activeProfile?.role : undefined;
  const canAccessAssistants = !enabledModules || enabledModules.includes("support_ai");
  const assistantCatalog = useQuery({
    queryKey: ["outreach-assistants", user?.id, profileId, "catalog"],
    queryFn: () => api.get<AssistantCatalog>("/api/settings/outreach/assistants/catalog", {
      headers: { [BUSINESS_PROFILE_HEADER]: String(profileId) },
    }),
    enabled: open && canAccessAssistants && !!profileId && !profiles.isLoading,
    staleTime: 30_000,
    retry: 1,
  });
  const destinations = React.useMemo(() => buildDashboardDestinationIndex({
    enabledModules,
    workspaceRole,
    query: searchParams,
    canManageAssistants: canAccessAssistants && !!profileId && !profiles.isLoading && !profiles.isError && !assistantCatalog.isError && assistantCatalog.data?.permissions.canManage === true,
  }), [enabledModules, workspaceRole, searchParams, canAccessAssistants, profileId, profiles.isLoading, profiles.isError, assistantCatalog.isError, assistantCatalog.data]);
  const destinationByHref = React.useMemo(() => new Map(destinations.map(destination => [destination.href, destination])), [destinations]);
  const filter = React.useCallback((value: string, search: string) => {
    const destination = destinationByHref.get(value as DashboardDestination["href"]);
    return destination ? scoreDashboardDestination(destination, search) : 0;
  }, [destinationByHref]);

  React.useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key?.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [onOpenChange, open]);

  const goTo = React.useCallback((path: string) => {
    if (!confirmUnsavedNavigation()) return;
    onOpenChange(false);
    router.push(path);
  }, [onOpenChange, router]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      filter={filter}
      label="Search pages, actions, and settings"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        inputRef.current?.focus();
      }}
      onCloseAutoFocus={(event) => {
        const target = returnFocusRef?.current || previousFocus.current;
        if (target?.isConnected && target !== document.body) {
          event.preventDefault();
          target.focus();
        }
      }}
      dialogClassName="top-[clamp(32px,10vh,112px)] max-h-[calc(100dvh-clamp(32px,10vh,112px)-1rem)] max-w-[680px] translate-y-0 gap-0 rounded-[20px] border-border bg-popover p-0 shadow-2xl sm:p-0 [&>button]:hidden"
      commandClassName="min-h-0 max-h-[calc(100dvh-clamp(32px,10vh,112px)-1rem)] rounded-[20px] bg-popover text-foreground [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-2 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.16em] [&_[cmdk-group-heading]]:text-muted-foreground"
    >
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-1.5 sm:px-6">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
          <span className="shrink-0 whitespace-nowrap font-semibold tracking-[-0.01em] text-foreground">{BRAND_NAME}</span>
          <span className="hidden text-muted-foreground sm:inline">/</span>
          <span className="line-clamp-2 min-w-0 basis-full break-words text-muted-foreground sm:flex-1 sm:basis-auto" aria-label={`Pages in ${workspaceName || "your workspace"}`} title={`Pages in ${workspaceName || "your workspace"}`}>Pages in {workspaceName || "your workspace"}</span>
        </div>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          onKeyDown={(event) => {
            // cmdk handles Enter on its root; closing must not also select a page.
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
          aria-label="Close search"
          className="flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-1 py-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] leading-none">Esc</kbd>
          <X className="h-4 w-4 shrink-0" />
        </button>
      </div>

      <CommandInput
        ref={inputRef}
        placeholder="Search pages, actions, and settings..."
        aria-label="Search pages, actions, and settings"
        wrapperClassName="h-[72px] shrink-0 border-border px-5 sm:px-6"
        iconClassName="mr-4 h-5 w-5 text-primary opacity-100"
        className="h-full text-[17px] font-medium text-foreground placeholder:font-normal placeholder:text-muted-foreground"
      />

      <CommandList className="min-h-0 max-h-[min(62vh,500px)] scroll-py-3 overflow-y-auto px-3 pb-3 pt-1 sm:px-4">
        <CommandEmpty className="flex flex-col items-center gap-2 px-4 py-14 text-center">
          <span className="mb-1 flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-muted text-primary">
            <Search className="h-5 w-5" />
          </span>
          <span className="text-sm font-semibold text-foreground">No results found</span>
          <span className="text-xs text-muted-foreground">Try another page or action name.</span>
        </CommandEmpty>

        <CommandGroup heading="Pages" className="p-0">
          {destinations.map(destination => (
            <SearchResult
              key={destination.href}
              title={destination.title}
              category={destination.parent}
              icon={destination.icon || <LayoutDashboard className="h-4 w-4" />}
              value={destination.href}
              onSelect={() => goTo(destination.href)}
            />
          ))}
        </CommandGroup>
      </CommandList>

      <div className="flex min-h-[49px] shrink-0 items-center justify-between gap-3 border-t border-border bg-muted/50 px-5 text-[11px] text-muted-foreground sm:px-6">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5"><kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">↑ ↓</kbd> Navigate</span>
          <span className="flex items-center gap-1.5"><kbd className="flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted"><CornerDownLeft className="h-3 w-3" /></kbd> Open</span>
        </div>
        <span className="hidden font-semibold tracking-[0.08em] text-muted-foreground sm:inline">{BRAND_NAME.toUpperCase()} SEARCH</span>
      </div>
    </CommandDialog>
  );
}
