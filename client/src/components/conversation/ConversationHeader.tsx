import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ConversationHeaderTab {
  id: string;
  label: string;
}

interface ConversationHeaderProps {
  title: string;
  eyebrow?: string;
  subtitle?: ReactNode;
  leading?: ReactNode;
  status?: ReactNode;
  participants?: ReactNode;
  actions?: ReactNode;
  tabs?: ConversationHeaderTab[];
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  className?: string;
  /** Hide the eyebrow and subtitle on narrow screens so messages keep the room. */
  compactOnMobile?: boolean;
}

export function ConversationHeader({
  title,
  eyebrow,
  subtitle,
  leading,
  status,
  participants,
  actions,
  tabs,
  activeTab,
  onTabChange,
  className,
  compactOnMobile = false,
}: ConversationHeaderProps) {
  return (
    <header className={cn("relative z-20 shrink-0 border-b border-border/70 bg-background/95 px-3 py-2.5 backdrop-blur-xl sm:px-5", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {leading ? <div className="shrink-0">{leading}</div> : null}
        <div className="min-w-0 flex-[1_1_24rem]">
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0">
              {eyebrow ? <p className={cn("mb-0.5 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground", compactOnMobile && "hidden sm:block")}>{eyebrow}</p> : null}
              <h1 title={title} className="break-words text-sm font-semibold leading-tight text-foreground sm:text-base">{title}</h1>
            </div>
            {status ? <div className="shrink-0">{status}</div> : null}
          </div>
          {subtitle ? <div className={cn("mt-0.5 min-w-0 truncate text-xs text-muted-foreground", compactOnMobile && "hidden sm:block")}>{subtitle}</div> : null}
        </div>

        {participants || actions ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3">
            {participants ? <div className="flex shrink-0 items-center">{participants}</div> : null}
            {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
          </div>
        ) : null}
      </div>

      {tabs?.length ? (
        <nav aria-label={`${title} views`} className="mt-2 flex w-fit max-w-full flex-wrap items-center rounded-lg border border-border/70 bg-muted/35 p-0.5 sm:mx-auto">
          {tabs.map((tab) => {
            const selected = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                aria-current={selected ? "page" : undefined}
                onClick={() => onTabChange?.(tab.id)}
                className={cn(
                  "min-h-7 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      ) : null}
    </header>
  );
}
