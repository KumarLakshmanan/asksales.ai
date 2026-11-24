import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface StreamingTextProps {
  active?: boolean;
  children: ReactNode;
  className?: string;
}

export function StreamingText({ active = false, children, className }: StreamingTextProps) {
  return (
    <div className={cn("relative", className)} aria-busy={active} aria-live={active ? "polite" : undefined}>
      {children}
      {active ? (
        <span className="ml-0.5 inline-flex h-4 items-end" aria-label="Response is streaming">
          <span className="h-3.5 w-0.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
        </span>
      ) : null}
    </div>
  );
}
