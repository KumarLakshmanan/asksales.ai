import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex max-w-full items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 disabled:transform-none data-[loading=true]:active:scale-100 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-transparent bg-primary-action text-primary-foreground shadow-[var(--edge-highlight),var(--shadow-xs)] hover:bg-primary-action-hover",
        destructive:
          "border border-transparent bg-destructive-action text-white shadow-[var(--edge-highlight),var(--shadow-xs)] hover:bg-destructive-action/90",
        outline:
          "border border-input-strong bg-card shadow-xs hover:border-foreground/30 hover:bg-muted",
        secondary: "border border-transparent bg-secondary text-secondary-foreground hover:bg-secondary-hover",
        // Add a transparent border so that when someone toggles a border on later, it doesn't shift layout/size.
        ghost: "border border-transparent hover:bg-muted hover:text-foreground",
        link: "border border-transparent bg-transparent text-primary-text underline-offset-4 shadow-none hover:underline motion-safe:active:scale-100",
      },
      // Heights are set as "min" heights, because sometimes Ai will place large amount of content
      // inside buttons. With a min-height they will look appropriate with small amounts of content,
      // but will expand to fit large amounts of content. Compact sizes grow to 40px on touch screens.
      size: {
        default: "min-h-10 px-4 py-2",
        sm: "min-h-8 gap-1.5 px-3 text-[13px] [@media(pointer:coarse)]:min-h-10",
        lg: "min-h-11 px-5 text-[15px]",
        icon: "h-10 w-10",
        "icon-sm": "h-8 w-8 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  /**
   * Shows a spinner, blocks clicks and marks the button busy. The button keeps
   * focus and its width, so a keyboard user is not dropped back to <body>.
   */
  loading?: boolean
  /** Replaces the label while `loading` (e.g. "Saving…"). Defaults to the normal children. */
  loadingText?: React.ReactNode
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, loading = false, loadingText, disabled, children, onClick, ...props },
    ref,
  ) => {
    const classes = cn(buttonVariants({ variant, size, className }))
    const isIconSize = size === "icon" || size === "icon-sm"

    // Slot needs exactly one child, so asChild buttons only get the busy attributes.
    if (asChild) {
      return (
        <Slot className={classes} ref={ref} aria-busy={loading || undefined} {...props}>
          {children}
        </Slot>
      )
    }

    return (
      <button
        className={cn(classes, loading && "cursor-wait")}
        ref={ref}
        // aria-disabled (not disabled) while loading keeps the button focusable.
        disabled={disabled}
        aria-disabled={loading || undefined}
        aria-busy={loading || undefined}
        data-loading={loading || undefined}
        onClick={(event) => {
          if (loading) {
            event.preventDefault()
            return
          }
          onClick?.(event)
        }}
        {...props}
      >
        {loading ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
        {loading && isIconSize ? <span className="sr-only">Loading</span> : null}
        {loading && isIconSize ? null : loading && loadingText !== undefined ? loadingText : children}
      </button>
    )
  },
)
Button.displayName = "Button"

export { Button, buttonVariants }
