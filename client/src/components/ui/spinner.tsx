import * as React from "react"
import { Loader2 } from "lucide-react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const spinnerVariants = cva("shrink-0 animate-spin motion-reduce:animate-[spin_1.5s_linear_infinite]", {
  variants: {
    size: {
      xs: "size-3.5",
      sm: "size-4",
      md: "size-5",
      lg: "size-6",
      xl: "size-8",
    },
  },
  defaultVariants: { size: "sm" },
})

export interface SpinnerProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children">,
    VariantProps<typeof spinnerVariants> {
  /**
   * Text announced to screen readers. Pass `null` when the spinner sits inside
   * something that already announces its busy state (e.g. a loading Button).
   */
  label?: string | null
}

/**
 * The single loading indicator for the app. Replaces hand-written
 * `<Loader2 className="h-4 w-4 animate-spin" />` so sizes and announcements stay consistent.
 */
const Spinner = React.forwardRef<HTMLSpanElement, SpinnerProps>(
  ({ className, size, label = "Loading", ...props }, ref) => {
    const decorative = label === null
    return (
      <span
        ref={ref}
        role={decorative ? undefined : "status"}
        aria-hidden={decorative ? true : undefined}
        className={cn("inline-flex items-center justify-center", className)}
        {...props}
      >
        <Loader2 className={spinnerVariants({ size })} aria-hidden="true" />
        {decorative ? null : <span className="sr-only">{label}</span>}
      </span>
    )
  },
)
Spinner.displayName = "Spinner"

export { Spinner, spinnerVariants }
