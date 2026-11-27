"use client";

import * as React from "react";
import { Eye, History, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCreatorScope } from "./CreatorScope";
import { GeneratorReadiness } from "./GeneratorReadiness";

type CreatorView = "compose" | "preview" | "recent";

interface CreatorWorkspaceContextValue {
  view: CreatorView;
  setView: (view: CreatorView) => void;
  /** Side-by-side compose + preview. Measured on the workspace itself, not the
   * viewport: inside a campaign side pane the page is wide but the pane is not. */
  wide: boolean;
}

/** Below this workspace width the creator uses Compose / Preview / Recent tabs. */
const WIDE_WORKSPACE_MIN_WIDTH = 760;

const CreatorWorkspaceContext = React.createContext<CreatorWorkspaceContextValue | null>(null);

function useCreatorWorkspace() {
  const context = React.useContext(CreatorWorkspaceContext);
  if (!context) throw new Error("Creator workspace components must be used inside ContentCreatorShell");
  return context;
}

export function ContentCreatorShell({ children, className }: React.PropsWithChildren<{ className?: string }>) {
  const { threadId } = useCreatorScope();
  const [view, setView] = React.useState<CreatorView>(threadId ? "recent" : "compose");
  const workspaceRef = React.useRef<HTMLDivElement>(null);
  // Start in the tab layout on server and client alike, then measure before paint.
  const [wide, setWide] = React.useState(false);

  React.useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const measure = () => setWide(workspace.getBoundingClientRect().width >= WIDE_WORKSPACE_MIN_WIDTH);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  return (
    <CreatorWorkspaceContext.Provider value={{ view, setView, wide }}>
      <div
        ref={workspaceRef}
        data-creator-workspace
        data-creator-layout={wide ? "wide" : "tabs"}
        className={cn("flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background", className)}
      >
        {children}
      </div>
    </CreatorWorkspaceContext.Provider>
  );
}

export function ContentCreatorHeader({ children, className }: React.PropsWithChildren<{ className?: string }>) {
  return (
    <header className={cn("shrink-0 border-b border-border bg-card px-4 py-4 sm:px-6", className)}>
      {children}
    </header>
  );
}

export function ContentCreatorBody({ children, recentCount = 0 }: React.PropsWithChildren<{ recentCount?: number }>) {
  const { view, setView, wide } = useCreatorWorkspace();
  const { threadId } = useCreatorScope();
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const actionRef = React.useRef<HTMLButtonElement | null>(null);
  // `missing` is set by an action that is disabled because Compose is incomplete (not because it is busy).
  const [mobileAction, setMobileAction] = React.useState<{ label: string; disabled: boolean; missing: string | null } | null>(null);
  const tabs: Array<{ id: CreatorView; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: "compose", label: "Compose", icon: PenLine },
    { id: "preview", label: "Preview", icon: Eye },
    { id: "recent", label: `Recent${recentCount ? ` (${recentCount})` : ""}`, icon: History },
  ];

  React.useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;

    const syncAction = () => {
      const action = body.querySelector<HTMLButtonElement>("[data-creator-action]");
      actionRef.current = action;
      const nextAction = action
        ? { label: action.textContent?.trim() || "Continue", disabled: action.disabled, missing: action.disabled ? action.dataset.creatorMissing || null : null }
        : null;
      setMobileAction((current) => (
        current?.label === nextAction?.label && current?.disabled === nextAction?.disabled && current?.missing === nextAction?.missing
          ? current
          : nextAction
      ));
    };

    syncAction();
    const observer = new MutationObserver(syncAction);
    observer.observe(body, {
      attributes: true,
      attributeFilter: ["disabled", "data-creator-missing"],
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={bodyRef} className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", wide && "flex-row")}>
      <div className={cn("grid shrink-0 grid-cols-3 border-b border-border bg-card p-1.5", wide && "hidden")} role="tablist" aria-label="Creation workspace">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
            className={cn(
              "flex min-h-10 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-semibold transition-colors",
              view === id ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </div>
      {!wide && view !== "compose" && mobileAction?.missing && (
        <p className={cn("shrink-0 px-4 text-xs text-muted-foreground", threadId ? "order-last -mb-2 mt-3" : "")}>
          {mobileAction.missing}
        </p>
      )}
      {!wide && view !== "compose" && mobileAction && (
        <button
          type="button"
          data-creator-action-proxy
          // An action missing its details sends the user to Compose to fill them in.
          disabled={mobileAction.disabled && !mobileAction.missing}
          onClick={() => {
            if (mobileAction.missing) {
              setView("compose");
              requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLElement>("textarea, input:not([type=hidden])")?.focus());
              return;
            }
            actionRef.current?.click();
          }}
          className={cn(
            "flex h-11 shrink-0 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-lg transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50",
            // Campaign creators share the viewport with chat. Reserve space in
            // their own pane instead of overlaying the chat composer.
            threadId ? "order-last mx-4 mb-4 mt-3" : "fixed inset-x-4 bottom-4 z-[var(--layer-header)]",
          )}
        >
          {mobileAction.missing ? "Go to Compose" : mobileAction.label}
        </button>
      )}
      {children}
    </div>
  );
}

export function ContentCreatorComposer({ children, className }: React.PropsWithChildren<{ className?: string }>) {
  const { view, wide } = useCreatorWorkspace();
  return (
    <aside
      data-creator-composer
      role="tabpanel"
      aria-label="Compose"
      className={cn(
        "min-h-0 w-full shrink-0 flex-col overflow-y-auto border-border bg-card",
        wide ? "flex w-[390px] min-w-[360px] border-r xl:w-[420px]" : view === "compose" ? "flex" : "hidden",
        className,
      )}
    >
      <GeneratorReadiness />
      {children}
    </aside>
  );
}

interface ContentCreatorStageProps {
  preview: React.ReactNode;
  recentCount?: number;
  children: React.ReactNode;
  className?: string;
  searchQuery?: string;
}

export function ContentCreatorStage({ preview, recentCount = 0, children, className, searchQuery }: ContentCreatorStageProps) {
  const { view, setView, wide } = useCreatorWorkspace();
  const desktopView = view === "compose" ? "preview" : view;
  const isVisible = wide || view !== "compose";

  return (
    <section
      data-creator-stage
      role="tabpanel"
      aria-label={desktopView === "preview" ? "Preview" : "Recent"}
      className={cn(
        "min-h-0 min-w-0 flex-1 flex-col bg-muted/25",
        isVisible ? "flex" : "hidden",
        className,
      )}
    >
      {searchQuery && <button type="button" className="border-b border-border bg-primary/5 px-4 py-2 text-left text-xs text-primary" onClick={() => setView("recent")}>{recentCount} recent result{recentCount === 1 ? "" : "s"} matching “{searchQuery}” — view results</button>}
      <div className={cn("h-12 shrink-0 items-end justify-between border-b border-border bg-card px-5", wide ? "flex" : "hidden")}>
        <div className="flex h-full items-end" role="tablist" aria-label="Proofing area">
          <button
            type="button"
            role="tab"
            aria-selected={desktopView === "preview"}
            onClick={() => setView("preview")}
            className={cn(
              "relative flex h-full items-center gap-2 px-3 text-sm font-semibold transition-colors",
              desktopView === "preview" ? "text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Eye className="h-4 w-4" /> Preview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={desktopView === "recent"}
            onClick={() => setView("recent")}
            className={cn(
              "relative flex h-full items-center gap-2 px-3 text-sm font-semibold transition-colors",
              desktopView === "recent" ? "text-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <History className="h-4 w-4" /> Recent
            <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{recentCount}</span>
          </button>
        </div>
        <p className="hidden pb-3 text-xs text-muted-foreground xl:block">Review your draft before using it</p>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 pb-20 sm:p-5 sm:pb-20 lg:p-6">
        {desktopView === "preview" ? preview : children}
      </div>
    </section>
  );
}

export function CreatorResultsPane({ children, className }: React.PropsWithChildren<{ className?: string }>) {
  return <div className={cn("mx-auto min-h-full w-full max-w-[1120px]", className)}>{children}</div>;
}
