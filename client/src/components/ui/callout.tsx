import * as React from "react"
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X, type LucideIcon } from "lucide-react"
import { cva } from "class-variance-authority"

import { cn } from "@/lib/utils"

export type CalloutTone = "info" | "success" | "warning" | "danger" | "neutral"

const calloutVariants = cva("relative flex w-full gap-3 rounded-xl border text-sm", {
  variants: {
    tone: {
      info: "border-info/25 bg-info/[0.06] [--callout-accent:hsl(var(--info))]",
      success: "border-success/25 bg-success/[0.06] [--callout-accent:hsl(var(--success))]",
      warning: "border-warning/30 bg-warning/[0.08] [--callout-accent:hsl(var(--warning))]",
      danger: "border-destructive/25 bg-destructive/[0.06] [--callout-accent:hsl(var(--destructive))]",
      neutral: "border-border bg-muted/40 [--callout-accent:hsl(var(--muted-foreground))]",
    },
    size: {
      default: "p-4",
      sm: "px-3 py-2.5 text-xs",
    },
  },
  defaultVariants: { tone: "info", size: "default" },
})

const toneIcons: Record<CalloutTone, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
  neutral: Info,
}

export interface CalloutProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: CalloutTone
  size?: "default" | "sm"
  title?: React.ReactNode
  /** Override the tone's icon, or pass `false` for none. */
  icon?: LucideIcon | false
  /** Buttons or links under the message, e.g. "Retry" or "Reconnect". */
  actions?: React.ReactNode
  /** Shows a close button. Omit for messages the user cannot dismiss. */
  onDismiss?: () => void
  dismissLabel?: string
  /**
   * Announce the message as soon as it appears. Defaults to true for `danger`
   * (role="alert"); set it for warnings that appear after a user action.
   * Leave it off for messages that are part of the page from the start.
   */
  announce?: boolean
}

/**
 * Inline message for errors, warnings, confirmations and tips that belong to a
 * section of the page (not a toast). Colour comes from the theme's semantic
 * tokens, so it works in light and dark mode.
 */
const Callout = React.forwardRef<HTMLDivElement, CalloutProps>(
  (
    {
      tone = "info",
      size = "default",
      title,
      icon,
      actions,
      onDismiss,
      dismissLabel = "Dismiss",
      announce,
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const Icon = icon === false ? null : (icon ?? toneIcons[tone])
    const shouldAnnounce = announce ?? tone === "danger"
    return (
      <div
        ref={ref}
        role={shouldAnnounce ? (tone === "danger" ? "alert" : "status") : undefined}
        data-tone={tone}
        className={cn(calloutVariants({ tone, size }), onDismiss && "pr-10", className)}
        {...props}
      >
        {Icon ? (
          <Icon
            className={cn("shrink-0 text-[color:var(--callout-accent)]", size === "sm" ? "mt-px size-3.5" : "mt-0.5 size-4")}
            aria-hidden="true"
          />
        ) : null}
        <div className="min-w-0 flex-1 space-y-1">
          {title ? <p className="font-semibold leading-snug text-foreground">{title}</p> : null}
          {children ? (
            <div className="break-words leading-relaxed text-foreground/80 [&_a]:font-medium [&_a]:underline [&_a]:underline-offset-2">
              {children}
            </div>
          ) : null}
          {actions ? <div className="flex flex-wrap items-center gap-2 pt-2">{actions}</div> : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={dismissLabel}
            className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    )
  },
)
Callout.displayName = "Callout"

export { Callout, calloutVariants }
