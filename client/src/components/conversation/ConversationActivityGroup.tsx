"use client";

import { useEffect, useState, type ReactNode } from "react";
import Image from "next/image";
import { AlertCircle, Check, ChevronDown, Clock3, Loader2, PauseCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationActivityStatus, ConversationActivityStep } from "./types";

const STATUS_META: Record<ConversationActivityStatus, { label: string; icon: typeof Check; className: string }> = {
  queued: { label: "Queued", icon: Clock3, className: "text-muted-foreground" },
  running: { label: "Running", icon: Loader2, className: "text-info" },
  completed: { label: "Completed", icon: Check, className: "text-success" },
  failed: { label: "Failed", icon: AlertCircle, className: "text-destructive" },
  cancelled: { label: "Cancelled", icon: PauseCircle, className: "text-muted-foreground" },
  gated: { label: "Gated", icon: PauseCircle, className: "text-warning" },
  awaiting_approval: { label: "Needs approval", icon: PauseCircle, className: "text-warning" },
};

function formatDuration(durationMs?: number) {
  if (!durationMs) return null;
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}
export function ActivityStatusIcon({ status, className }: { status: ConversationActivityStatus; className?: string }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return <Icon className={cn("h-3.5 w-3.5 shrink-0", meta.className, status === "running" && "animate-spin", className)} aria-hidden="true" />;
}

interface ConversationActivityGroupProps {
  agentName: string;
  agentRole?: string;
  avatar?: string;
  initials?: string;
  accentColor?: string;
  label: string;
  status: ConversationActivityStatus;
  elapsed?: string;
  steps?: ConversationActivityStep[];
  children?: ReactNode;
  defaultExpanded?: boolean;
  className?: string;
  testId?: string;
}

export function ConversationActivityGroup({
  agentName,
  agentRole,
  avatar,
  initials,
  accentColor = "hsl(var(--primary))",
  label,
  status,
  elapsed,
  steps = [],
  children,
  defaultExpanded = status === "running" || status === "failed" || status === "awaiting_approval",
  className,
  testId,
}: ConversationActivityGroupProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const statusMeta = STATUS_META[status];

  useEffect(() => {
    if (status === "running" || status === "failed" || status === "awaiting_approval") setExpanded(true);
  }, [status]);

  return (
    <section
      data-testid={testId}
      className={cn("ml-0 max-w-[48rem] overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04)] sm:ml-12", className)}
      aria-label={`${agentName}: ${label}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background">
          {avatar ? (
            <Image src={avatar} alt={agentName} width={32} height={32} className="h-full w-full object-contain p-0.5" />
          ) : (
            <span className="text-[10px] font-semibold" style={{ color: accentColor }}>{initials || agentName.slice(0, 2).toUpperCase()}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-xs font-semibold text-foreground">{agentName}</span>
            {agentRole ? <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">{agentRole}</span> : null}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <ActivityStatusIcon status={status} />
            <span className="truncate text-sm text-foreground/85">{label}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
          {elapsed ? <span>{elapsed}</span> : <span>{statusMeta.label}</span>}
          <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
        </div>
      </button>

      {expanded ? (
        <div className="border-t border-border/60 px-3.5 py-2.5">
          {steps.length > 0 ? (
            <ol className="space-y-1" aria-label="Agent activity">
              {steps.map((step) => (
                <li key={step.id} className="rounded-lg px-2 py-2 hover:bg-muted/30">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className="mt-0.5">{step.icon || <ActivityStatusIcon status={step.status} />}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-xs font-medium text-foreground/90">{step.label}</span>
                        {formatDuration(step.durationMs) ? (
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{formatDuration(step.durationMs)}</span>
                        ) : null}
                      </div>
                      {step.detail ? <p className="mt-0.5 break-words text-[11px] leading-relaxed text-muted-foreground">{step.detail}</p> : null}
                      {step.children ? <div className="mt-2">{step.children}</div> : null}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
          {children}
        </div>
      ) : null}
    </section>
  );
}
