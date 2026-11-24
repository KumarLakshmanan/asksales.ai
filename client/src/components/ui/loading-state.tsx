import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"
import { DashboardPageSkeleton, SectionRowsSkeleton } from "@/components/skeletons"

const loadingStateVariants = cva("flex flex-col gap-3", {
  variants: {
    size: {
      /** Inside a card, panel or list. */
      section: "w-full p-4",
      /** A whole route while its first request runs. */
      page: "min-h-[60vh] w-full",
      /** A row or small box. */
      inline: "flex-row items-center justify-center py-4",
    },
  },
  defaultVariants: { size: "section" },
})

export interface LoadingStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children">,
    VariantProps<typeof loadingStateVariants> {
  /**
   * What is loading, e.g. "Loading campaigns…". Announced to screen readers
   * and, when `showLabel` is set, shown under the spinner.
   */
  label?: string
  showLabel?: boolean
}

const spinnerSize = { inline: "sm" } as const

/**
 * Loading placeholder for a page, section or row that has nothing to show yet.
 * Page and section sizes show a layout skeleton (no spinner) so the content
 * keeps its place. Inline stays a small spinner for buttons and tight rows.
 */
const LoadingState = React.forwardRef<HTMLDivElement, LoadingStateProps>(
  ({ className, size, label = "Loading…", showLabel = false, ...props }, ref) => {
    if (size === "inline") {
      return (
        <div ref={ref} role="status" aria-live="polite" className={cn(loadingStateVariants({ size }), className)} {...props}>
          <Spinner size={spinnerSize.inline} label={null} className="text-muted-foreground" />
          <span className="sr-only">{label}</span>
        </div>
      )
    }
    return (
      <div
        ref={ref}
        role="status"
        aria-live="polite"
        aria-busy="true"
        className={cn(loadingStateVariants({ size }), "items-stretch justify-start", className)}
        {...props}
      >
        {size === "page" ? <DashboardPageSkeleton /> : <SectionRowsSkeleton />}
        {showLabel ? (
          <p className="text-center text-sm text-muted-foreground">{label}</p>
        ) : (
          <span className="sr-only">{label}</span>
        )}
      </div>
    )
  },
)
LoadingState.displayName = "LoadingState"

export { LoadingState }
