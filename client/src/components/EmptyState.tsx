"use client";

import { Target, LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─── Chat/Tab empty state (original) ─────────────────────────────────────────
export default function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center" data-testid="empty-state">
      <div className="w-24 h-24 rounded-full bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center mb-6">
        <Target className="w-12 h-12 text-primary" />
      </div>
      <h3 className="text-2xl font-semibold mb-3 text-primary">Waiting for Your Goal</h3>
      <p className="text-muted-foreground max-w-md leading-relaxed">
        Tell me what you want to achieve,
        <br />
        and I&apos;ll show you the best strategies
      </p>
    </div>
  );
}

// ─── Generic empty state — reusable across list pages ────────────────────────

interface EmptyStateAction {
  label: string;
  onClick: () => void;
  variant?: "default" | "outline" | "ghost";
}

interface PageEmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  className?: string;
  compact?: boolean;
}

/**
 * Generic page-level empty state for lists, tables, and data views.
 * Supports optional icon, description, primary and secondary actions.
 */
export function PageEmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  className,
  compact = false,
}: PageEmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "py-8 px-4" : "py-16 px-6",
        className
      )}
    >
      {Icon && (
        <div
          className={cn(
            "rounded-full bg-muted flex items-center justify-center mb-4",
            compact ? "w-10 h-10" : "w-14 h-14"
          )}
        >
          <Icon
            className={cn(
              "text-muted-foreground",
              compact ? "w-5 h-5" : "w-7 h-7"
            )}
          />
        </div>
      )}

      <h3
        className={cn(
          "font-semibold text-foreground",
          compact ? "text-sm" : "text-base"
        )}
      >
        {title}
      </h3>

      {description && (
        <p
          className={cn(
            "text-muted-foreground mt-1 max-w-xs",
            compact ? "text-xs" : "text-sm"
          )}
        >
          {description}
        </p>
      )}

      {(action || secondaryAction) && (
        <div className="flex items-center gap-2 mt-5">
          {secondaryAction && (
            <Button
              size={compact ? "sm" : "default"}
              variant={secondaryAction.variant ?? "outline"}
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </Button>
          )}
          {action && (
            <Button
              size={compact ? "sm" : "default"}
              variant={action.variant ?? "default"}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
