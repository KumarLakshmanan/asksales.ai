import type { HTMLAttributes } from "react";
import { PageShell } from "@/components/ui/page-shell";
import { cn } from "@/lib/utils";

interface SupportAIPageShellProps extends HTMLAttributes<HTMLDivElement> {
  variant?: "page" | "chat";
  padding?: "none" | "sm" | "md" | "lg";
}

export function SupportAIPageShell({
  variant = "page",
  padding = "md",
  className,
  ...props
}: SupportAIPageShellProps) {
  return (
    <PageShell
      maxWidth="full"
      padding={padding}
      className={cn(
        "min-w-0 max-w-[1440px]",
        variant === "chat" && "flex h-full min-h-0 flex-col space-y-0",
        className,
      )}
      {...props}
    />
  );
}
