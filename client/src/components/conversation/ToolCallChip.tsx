"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { ActivityStatusIcon } from "./ConversationActivityGroup";
import type { ConversationActivityStatus } from "./types";

interface ToolCallChipProps {
  label: string;
  status: ConversationActivityStatus;
  agentName?: string;
  duration?: string;
  detail?: string;
  children?: ReactNode;
  defaultExpanded?: boolean;
  className?: string;
}

export function ToolCallChip({
  label,
  status,
  agentName,
  duration,
  detail,
  children,
  defaultExpanded = false,
  className,
}: ToolCallChipProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasDetails = Boolean(children);

  return (
    <div className={cn("my-1 sm:ml-12", className)}>
      <button
        type="button"
        data-tool-status={status}
        data-tool-label={label}
        onClick={() => hasDetails && setExpanded((value) => !value)}
        aria-expanded={hasDetails ? expanded : undefined}
        className={cn(
          "flex min-h-8 w-full max-w-[44rem] items-center gap-2 rounded-lg border border-transparent px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:border-border/60 hover:bg-muted/30 hover:text-foreground",
          expanded && "border-border/60 bg-muted/25 text-foreground",
          !hasDetails && "cursor-default",
        )}
      >
        {hasDetails ? <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", expanded && "rotate-90")} aria-hidden="true" /> : <span className="w-3.5" />}
        {status === "queued" ? <Wrench className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" /> : <ActivityStatusIcon status={status} />}
        {agentName ? <span className="shrink-0 font-medium text-foreground/85">{agentName}</span> : null}
        {agentName ? <span className="text-border">·</span> : null}
        <span className="truncate">{label}</span>
        {detail ? <span className="hidden text-border sm:inline" aria-hidden="true">—</span> : null}
        {detail ? <span className="sr-only text-muted-foreground/70 sm:not-sr-only sm:truncate">{detail}</span> : null}
        {duration ? <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/70">({duration})</span> : null}
      </button>
      {expanded && children ? (
        <div className="ml-8 mt-1 max-w-[42rem] overflow-hidden rounded-xl border border-border/60 bg-card text-xs shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
          {children}
        </div>
      ) : null}
    </div>
  );
}
