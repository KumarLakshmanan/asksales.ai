import * as React from "react"
import { cva } from "class-variance-authority"

import { cn } from "@/lib/utils"

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger" | "progress"

const statusBadgeVariants = cva(
  "inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      tone: {
        // Text stays in the foreground colour for contrast; the dot, border and tint carry the tone.
        neutral: "border-border bg-muted/60 text-muted-foreground [--status-dot:hsl(var(--muted-foreground))]",
        info: "border-info/30 bg-info/10 text-foreground [--status-dot:hsl(var(--info))]",
        success: "border-success/30 bg-success/10 text-foreground [--status-dot:hsl(var(--success))]",
        warning: "border-warning/40 bg-warning/10 text-foreground [--status-dot:hsl(var(--warning))]",
        danger: "border-destructive/30 bg-destructive/10 text-foreground [--status-dot:hsl(var(--destructive))]",
        progress: "border-primary/30 bg-primary/10 text-foreground [--status-dot:hsl(var(--primary))]",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
)

/**
 * The app-wide meaning of common status words. Unknown statuses fall back to
 * "neutral", so a new backend value never renders as an error.
 */
const STATUS_TONES: Record<string, StatusTone> = {
  // done / healthy
  active: "success", approved: "success", complete: "success", completed: "success", connected: "success",
  delivered: "success", generated: "success", live: "success", paid: "success", published: "success",
  resolved: "success", sent: "success", success: "success", succeeded: "success", verified: "success", won: "success",
  // in flight
  generating: "progress", importing: "progress", in_progress: "progress", processing: "progress",
  publishing: "progress", queued: "progress", running: "progress", sending: "progress", syncing: "progress", uploading: "progress",
  // needs attention
  awaiting_approval: "warning", expiring: "warning", needs_review: "warning", partial: "warning", paused: "warning",
  pending: "warning", pending_review: "warning", review: "warning", unverified: "warning",
  // broken
  blocked: "danger", bounced: "danger", cancelled: "danger", canceled: "danger", disconnected: "danger", error: "danger",
  expired: "danger", failed: "danger", lost: "danger", overdue: "danger", rejected: "danger", suspended: "danger",
  // informational
  new: "info", open: "info", scheduled: "info",
  // quiet
  archived: "neutral", draft: "neutral", inactive: "neutral", unknown: "neutral",
}

function normaliseStatus(status: string) {
  return status.trim().toLowerCase().replace(/[\s-]+/g, "_")
}

/** Tone for a status word, e.g. "In progress" → "progress". */
export function getStatusTone(status: string | null | undefined, overrides?: Record<string, StatusTone>): StatusTone {
  if (!status) return "neutral"
  const key = normaliseStatus(status)
  return overrides?.[key] ?? STATUS_TONES[key] ?? "neutral"
}

/** "in_progress" → "In progress". */
export function formatStatusLabel(status: string) {
  const words = status.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ").toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export interface StatusBadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Raw status from the API. Picks the tone and, unless `label` is set, the text. */
  status?: string | null
  /** Force a tone instead of looking up `status`. */
  tone?: StatusTone
  /** Visible text. Defaults to the status, humanised. */
  label?: React.ReactNode
  /** Per-call additions to the status→tone map (keys are snake_case). */
  toneOverrides?: Record<string, StatusTone>
  /** Leading dot; pulses for "progress" unless the user prefers reduced motion. */
  dot?: boolean
}

/**
 * Status pill whose colour comes from one shared meaning map, so "failed" is
 * red and "scheduled" is blue on every screen. Colour is never the only
 * signal: the text always states the status.
 */
const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(
  ({ status, tone, label, toneOverrides, dot = true, className, ...props }, ref) => {
    const resolvedTone = tone ?? getStatusTone(status, toneOverrides)
    const text = label ?? (status ? formatStatusLabel(status) : "Unknown")
    return (
      <span ref={ref} data-tone={resolvedTone} className={cn(statusBadgeVariants({ tone: resolvedTone }), className)} {...props}>
        {dot ? (
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full bg-[color:var(--status-dot)]",
              resolvedTone === "progress" && "motion-safe:animate-pulse",
            )}
            aria-hidden="true"
          />
        ) : null}
        <span className="truncate">{text}</span>
      </span>
    )
  },
)
StatusBadge.displayName = "StatusBadge"

export { StatusBadge, statusBadgeVariants }
