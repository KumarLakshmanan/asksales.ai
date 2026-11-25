import * as React from "react"

import { cn } from "@/lib/utils"

type PaddingSide = "t" | "r" | "b" | "l"

const PADDING_SIDES: Record<string, PaddingSide[]> = {
  "": ["t", "r", "b", "l"],
  x: ["r", "l"],
  y: ["t", "b"],
  t: ["t"],
  r: ["r"],
  b: ["b"],
  l: ["l"],
}

function paddingOverrides(className: string | undefined, breakpoint?: "sm") {
  const overridden = new Set<PaddingSide>()

  for (const token of className?.split(/\s+/) ?? []) {
    const prefix = breakpoint ? `${breakpoint}:` : ""
    if (breakpoint ? !token.startsWith(prefix) : token.includes(":")) continue

    const utility = token.slice(prefix.length).replace(/^!/, "")
    const match = utility.match(/^p([xytrbl]?)-/)
    if (!match) continue

    for (const side of PADDING_SIDES[match[1]]) overridden.add(side)
  }

  return overridden
}

function responsiveCardPadding(className: string | undefined, includeTop: boolean) {
  const baseOverrides = paddingOverrides(className)
  const smallOverrides = paddingOverrides(className, "sm")
  const sides: PaddingSide[] = includeTop ? ["t", "r", "b", "l"] : ["r", "b", "l"]

  return sides.flatMap((side) => [
    !baseOverrides.has(side) && `p${side}-5`,
    !baseOverrides.has(side) && !smallOverrides.has(side) && `sm:p${side}-6`,
  ])
}

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "shadcn-card min-w-0 max-w-full rounded-xl border border-card-border bg-card text-card-foreground shadow-xs",
      className
    )}
    {...props}
  />
));
Card.displayName = "Card"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5", responsiveCardPadding(className, true), className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "text-base font-semibold leading-tight tracking-[-0.015em]",
      className
    )}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("max-w-[65ch] text-sm leading-5 text-muted-foreground", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn(responsiveCardPadding(className, false), className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center", responsiveCardPadding(className, false), className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
}
