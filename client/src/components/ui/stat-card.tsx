import * as React from "react"
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react"

import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"

export type StatTrend = "up" | "down" | "flat"

export interface StatDelta {
  /** Display text, already formatted: "+12%", "−3 leads". */
  value: React.ReactNode
  trend: StatTrend
  /**
   * Which direction is good news. Defaults to "up". Set "down" for metrics
   * like cost or bounce rate, "none" when a change is neither good nor bad.
   */
  positiveDirection?: "up" | "down" | "none"
  /** Context after the delta: "vs last week". */
  label?: React.ReactNode
}

export interface StatCardProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  label: React.ReactNode
  /** The headline number, already formatted. `null`/`undefined` renders the empty placeholder. */
  value?: React.ReactNode
  /** Shown when `value` is missing, so “no data” never reads as zero. */
  emptyValue?: React.ReactNode
  delta?: StatDelta
  /** Secondary line under the value. */
  description?: React.ReactNode
  icon?: React.ReactNode
  /** Renders a skeleton in the same footprint, so the grid does not jump when data arrives. */
  loading?: boolean
  tone?: "neutral" | "primary" | "success" | "warning" | "destructive"
  /** Optional slot below the description (sparkline, progress bar, link). */
  footer?: React.ReactNode
}

const toneClasses: Record<NonNullable<StatCardProps["tone"]>, string> = {
  neutral: "border-border/70 bg-card",
  primary: "border-primary/20 bg-primary/[0.04]",
  success: "border-success/20 bg-success/[0.04]",
  warning: "border-warning/25 bg-warning/[0.05]",
  destructive: "border-destructive/20 bg-destructive/[0.04]",
}

function deltaSentiment({ trend, positiveDirection = "up" }: StatDelta) {
  if (trend === "flat" || positiveDirection === "none") return "neutral"
  return trend === positiveDirection ? "good" : "bad"
}

const trendWords: Record<StatTrend, string> = { up: "Up", down: "Down", flat: "No change" }

/** One KPI tile: label, value, optional trend delta, description, icon and footer. */
const StatCard = React.forwardRef<HTMLElement, StatCardProps>(
  (
    { label, value, emptyValue = "—", delta, description, icon, loading = false, tone = "neutral", footer, className, ...props },
    ref,
  ) => {
    const sentiment = delta ? deltaSentiment(delta) : null
    const TrendIcon = delta?.trend === "up" ? ArrowUpRight : delta?.trend === "down" ? ArrowDownRight : Minus
    const hasValue = value !== null && value !== undefined && value !== ""

    return (
      <article
        ref={ref}
        aria-busy={loading || undefined}
        className={cn(
          "flex min-w-0 flex-col rounded-xl border p-4 shadow-xs",
          toneClasses[tone],
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 truncate text-xs font-medium text-muted-foreground">{label}</h3>
          {icon ? (
            <span className="shrink-0 text-muted-foreground [&_svg]:size-4" aria-hidden="true">
              {icon}
            </span>
          ) : null}
        </div>

        {loading ? (
          <div className="mt-2 space-y-2" aria-hidden="true">
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-3.5 w-32" />
          </div>
        ) : (
          <>
            <p className="mt-2 break-words text-2xl font-semibold tracking-tight tabular-nums text-foreground">
              {hasValue ? value : <span className="text-muted-foreground">{emptyValue}</span>}
            </p>

            {delta || description ? (
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                {delta ? (
                  <span
                    className={cn(
                      "inline-flex items-center gap-0.5 font-semibold tabular-nums",
                      sentiment === "good" && "text-success",
                      sentiment === "bad" && "text-destructive",
                      sentiment === "neutral" && "text-muted-foreground",
                    )}
                  >
                    <TrendIcon className="size-3.5" aria-hidden="true" />
                    {/* Colour and arrow are visual only; say the direction in words too. */}
                    <span className="sr-only">{trendWords[delta.trend]} </span>
                    {delta.value}
                  </span>
                ) : null}
                {delta?.label ? <span>{delta.label}</span> : null}
                {description ? <span className="min-w-0">{description}</span> : null}
              </div>
            ) : null}
          </>
        )}

        {footer ? <div className="mt-3">{footer}</div> : null}
      </article>
    )
  },
)
StatCard.displayName = "StatCard"

export interface StatGridProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Columns at the widest breakpoint. Collapses to 1 on phones and 2 on tablets. */
  columns?: 2 | 3 | 4 | 5
}

const gridColumns: Record<NonNullable<StatGridProps["columns"]>, string> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5",
}

/** Responsive grid for StatCards. */
function StatGrid({ columns = 4, className, ...props }: StatGridProps) {
  return <div className={cn("grid grid-cols-1 gap-3", gridColumns[columns], className)} {...props} />
}

export { StatCard, StatGrid }
