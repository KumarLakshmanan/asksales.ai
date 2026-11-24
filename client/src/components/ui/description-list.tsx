import * as React from "react"

import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"

export interface DescriptionItem {
  /** Stable key; defaults to the label when it is a string. */
  id?: string
  label: React.ReactNode
  /** `null`, `undefined` and `""` render `emptyValue`, so blanks never look like a layout bug. */
  value?: React.ReactNode
  /** Small helper text under the value. */
  hint?: React.ReactNode
  /** Span every column in the grid layout (long text, addresses). */
  fullWidth?: boolean
}

export interface DescriptionListProps extends React.HTMLAttributes<HTMLDListElement> {
  items: readonly DescriptionItem[]
  /**
   * "grid": label above value, in columns (cards, summaries).
   * "inline": label left, value right, one per row (details panels, receipts).
   */
  layout?: "grid" | "inline"
  /** Columns for the grid layout from `sm` up. Phones always use one. */
  columns?: 1 | 2 | 3
  emptyValue?: React.ReactNode
  /** Skeleton values in the same footprint while data loads. */
  loading?: boolean
}

const gridColumns = { 1: "", 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3" } as const

function isEmpty(value: React.ReactNode) {
  return value === null || value === undefined || value === "" || value === false
}

/**
 * Semantic label/value pairs (`<dl>`) for record details: lead profile,
 * billing summary, integration settings.
 */
const DescriptionList = React.forwardRef<HTMLDListElement, DescriptionListProps>(
  ({ items, layout = "grid", columns = 2, emptyValue = "—", loading = false, className, ...props }, ref) => (
    <dl
      ref={ref}
      aria-busy={loading || undefined}
      className={cn(
        layout === "grid" ? cn("grid grid-cols-1 gap-x-6 gap-y-4", gridColumns[columns]) : "divide-y divide-border",
        className,
      )}
      {...props}
    >
      {items.map((item, index) => {
        const key = item.id ?? (typeof item.label === "string" ? item.label : String(index))
        const value = loading ? (
          <Skeleton className="h-4 w-2/3" aria-hidden="true" />
        ) : isEmpty(item.value) ? (
          <span className="text-muted-foreground">{emptyValue}</span>
        ) : (
          item.value
        )
        return layout === "grid" ? (
          <div key={key} className={cn("min-w-0", item.fullWidth && "sm:col-span-full")}>
            <dt className="text-xs font-medium text-muted-foreground">{item.label}</dt>
            <dd className="mt-1 break-words text-sm text-foreground">
              {value}
              {item.hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{item.hint}</span> : null}
            </dd>
          </div>
        ) : (
          <div key={key} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
            <dt className="shrink-0 text-sm text-muted-foreground">{item.label}</dt>
            <dd className="min-w-0 break-words text-sm font-medium text-foreground sm:text-right">
              {value}
              {item.hint ? <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{item.hint}</span> : null}
            </dd>
          </div>
        )
      })}
    </dl>
  ),
)
DescriptionList.displayName = "DescriptionList"

export { DescriptionList }
