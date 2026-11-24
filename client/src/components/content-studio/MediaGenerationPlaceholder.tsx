"use client";

import { Image as ImageIcon, Sparkles, Video } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

const ACTIVE_GENERATION_STATUSES = new Set(["generating", "pending", "processing", "queued"]);

export function isMediaGenerating(status?: string | null) {
  return ACTIVE_GENERATION_STATUSES.has(status?.toLowerCase() || "");
}

interface MediaGenerationPlaceholderProps {
  kind: "image" | "video" | "content";
  className?: string;
  compact?: boolean;
  label?: string;
  /** Replaces the default helper line, e.g. with an estimated time. */
  detail?: string;
}

export function MediaGenerationPlaceholder({
  kind,
  className,
  compact = false,
  label,
  detail,
}: MediaGenerationPlaceholderProps) {
  const Icon = kind === "video" ? Video : kind === "image" ? ImageIcon : Sparkles;
  const defaultLabel = kind === "content"
    ? "Drafting your content"
    : `Rendering your ${kind}`;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label || defaultLabel}
      className={cn(
        "relative isolate flex min-h-44 w-full overflow-hidden bg-muted/35 px-6 py-8",
        compact ? "min-h-32 items-center justify-center" : "items-center justify-center",
        className,
      )}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,hsl(var(--primary)/0.14),transparent_52%)] motion-safe:animate-pulse" />
      <div className="absolute inset-x-0 top-1/2 h-px bg-gradient-to-r from-transparent via-primary/35 to-transparent motion-safe:animate-pulse" />
      <div className="relative flex max-w-sm flex-col items-center text-center">
        <div className="relative flex h-14 w-14 items-center justify-center rounded-full border border-primary/25 bg-background shadow-sm">
          <span className="absolute inset-1 rounded-full border border-dashed border-primary/30 motion-safe:animate-spin" />
          <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
        </div>
        <div className="mt-4 flex items-center gap-2 text-sm font-semibold text-foreground">
          <Spinner size="sm" label={null} className="text-primary" />
          {label || defaultLabel}
        </div>
        {compact && detail && <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>}
        {!compact && (
          <>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail || "Applying your prompt, brand context, and format settings."}</p>
            <div className="mt-5 w-52 space-y-2" aria-hidden="true">
              <div className="h-1.5 w-full rounded-full bg-primary/20 motion-safe:animate-pulse" />
              <div className="mx-auto h-1.5 w-4/5 rounded-full bg-primary/15 motion-safe:animate-pulse" />
              <div className="mx-auto h-1.5 w-3/5 rounded-full bg-primary/10 motion-safe:animate-pulse" />
            </div>
          </>
        )}
        <span className="sr-only">Generation is in progress. This preview will update when the result is ready.</span>
      </div>
    </div>
  );
}
