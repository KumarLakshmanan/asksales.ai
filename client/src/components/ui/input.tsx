import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-md border border-input-strong bg-field px-3 py-2 text-base shadow-xs transition-[border-color,box-shadow] duration-150 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/[var(--input-placeholder-alpha)] hover:border-foreground/30 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20 aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/20 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 md:text-sm",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
