"use client";

import type { ElementType, ReactNode } from "react";
import { CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import styles from "@/components/marketing/marketing.module.css";

export const PERFORMANCE_MARKETING_VIEW_KEY = "performance-marketing-advanced-view";

export type PerformanceAiState =
  | "learning"
  | "healthy"
  | "watch"
  | "recommendation"
  | "ai_paused"
  | "manual_hold"
  | "insufficient_data";

const AI_STATE_LABELS: Record<PerformanceAiState, string> = {
  learning: "Learning",
  healthy: "Healthy",
  watch: "Watch",
  recommendation: "Recommendation",
  ai_paused: "AI paused",
  manual_hold: "Manual hold",
  insufficient_data: "Insufficient data",
};

const AI_STATE_CLASSES: Record<PerformanceAiState, string> = {
  learning: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  healthy: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  watch: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  recommendation: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  ai_paused: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  manual_hold: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  insufficient_data: "border-border bg-muted text-muted-foreground",
};

export function PerformanceAiStateBadge({ state }: { state?: PerformanceAiState }) {
  const safeState = state && AI_STATE_LABELS[state] ? state : "insufficient_data";
  return <Badge variant="outline" className={AI_STATE_CLASSES[safeState]}>{AI_STATE_LABELS[safeState]}</Badge>;
}

export function PerformanceMarketingViewToggle({ advanced, onChange }: { advanced: boolean; onChange: (enabled: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
      <span className={advanced ? "text-muted-foreground" : "font-medium"}>Standard</span>
      <Switch aria-label="Advanced view" checked={advanced} onCheckedChange={onChange}/>
      <span className={advanced ? "font-medium" : "text-muted-foreground"}>Advanced</span>
    </label>
  );
}

export function WorkspaceFilterBar({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Card>
      <CardContent aria-label={label} className={`${styles.filterBar} p-3`}>
        {children}
      </CardContent>
    </Card>
  );
}

export function FreshnessIndicator({
  state,
  title,
  detail,
  action,
}: {
  state: "fresh" | "stale" | "disconnected" | "error" | "partial";
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  const dotClass = state === "fresh"
    ? "bg-emerald-500"
    : state === "error"
      ? "bg-destructive"
      : "bg-amber-500";
  return (
    <div role={state === "error" ? "alert" : "status"} className={`${styles.notice} flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card text-xs`}>
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClass}`}/>
        <span className="font-medium">{title}</span>
        {detail && <span className="truncate text-muted-foreground">· {detail}</span>}
      </div>
      {action}
    </div>
  );
}

export function PerformanceEmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  icon: ElementType;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
        <div className="rounded-full bg-primary/10 p-3"><Icon className="h-7 w-7 text-primary"/></div>
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
        </div>
        {actionLabel && onAction && <Button onClick={onAction}>{actionLabel}</Button>}
      </CardContent>
    </Card>
  );
}

export type MetricChainItem = {
  label: string;
  value: string;
  supporting: string;
  icon: ElementType;
};

export function PerformanceMetricChain({ items }: { items: MetricChainItem[] }) {
  return (
    <div className={styles.metricGrid}>
        {items.map((item) => (
          <div key={item.label} className={styles.metric}>
            <div className="mb-4 flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{item.label}</span>
              <item.icon aria-hidden="true" className="h-4 w-4 shrink-0 text-primary"/>
            </div>
            <p className="break-words text-2xl font-semibold tracking-tight tabular-nums">{item.value}</p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{item.supporting}</p>
          </div>
        ))}
    </div>
  );
}

export function EvidenceDisclosure({ title = "View evidence", children }: { title?: string; children: ReactNode }) {
  return (
    <details className="rounded-lg border bg-muted/20 p-3">
      <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{title}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

export function HealthyState({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 p-5 text-sm text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4"/>{children}</div>;
}
