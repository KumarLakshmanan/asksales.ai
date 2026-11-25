import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/lib/utils"

const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & {
    /**
     * "pill" (default): a grey track with a raised selected item, for switching a view in place.
     * "underline": a line under the selected tab, for sections of a page.
     */
    variant?: "pill" | "underline"
  }
>(({ className, variant = "pill", ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    data-variant={variant}
    className={cn(
      "group/tabs text-muted-foreground",
      variant === "underline"
        ? "flex items-end gap-6 overflow-x-auto border-b border-border"
        : "inline-flex min-h-10 items-center justify-center rounded-md bg-muted p-[3px]",
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex min-h-[34px] items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] px-3 py-1.5 text-sm font-semibold transition-[color,background-color,box-shadow] duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-xs data-[state=active]:ring-1 data-[state=active]:ring-border",
      "group-data-[variant=underline]/tabs:min-h-10 group-data-[variant=underline]/tabs:rounded-none group-data-[variant=underline]/tabs:px-0 group-data-[variant=underline]/tabs:shadow-[inset_0_-2px_0_transparent] group-data-[variant=underline]/tabs:data-[state=active]:bg-transparent group-data-[variant=underline]/tabs:data-[state=active]:shadow-[inset_0_-2px_0_hsl(var(--primary))] group-data-[variant=underline]/tabs:data-[state=active]:ring-0",
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
