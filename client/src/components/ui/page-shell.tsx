import * as React from "react";
import { cn } from "@/lib/utils";

type MaxWidth = "sm" | "md" | "lg" | "xl" | "2xl" | "full";

interface PageShellProps extends React.HTMLAttributes<HTMLDivElement> {
  maxWidth?: MaxWidth;
  padding?: "none" | "sm" | "md" | "lg";
}

const maxWidthClasses: Record<MaxWidth, string> = {
  sm: "max-w-screen-sm",
  md: "max-w-screen-md",
  lg: "max-w-screen-lg",
  xl: "max-w-screen-xl",
  "2xl": "max-w-screen-2xl",
  full: "max-w-full",
};

const paddingClasses: Record<NonNullable<PageShellProps["padding"]>, string> = {
  none: "",
  sm: "px-4 py-4 sm:px-5",
  md: "px-4 py-5 sm:px-6 sm:py-6 lg:px-8",
  lg: "px-4 py-6 sm:px-8 sm:py-8 lg:px-10",
};

function PageShell({
  maxWidth = "2xl",
  padding = "md",
  className,
  children,
  ...props
}: PageShellProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full space-y-6",
        maxWidthClasses[maxWidth],
        paddingClasses[padding],
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export { PageShell };
export type { PageShellProps };
