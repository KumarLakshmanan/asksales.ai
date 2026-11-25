"use client";

import { useEffect, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isPageChunkError, reloadCurrentPage } from '@/lib/page-error-recovery';

/** After this long a loader says it is still working and offers a retry. */
export const PAGE_LOADING_SLOW_AFTER_MS = 8_000;

interface PageLoadingStateProps {
  /** What is happening, e.g. "Loading brand toolkits…". */
  label?: string;
  /** Optional sentence under the label. */
  description?: string;
  /** Names the page being opened, so a full-screen loader still says where the user is. */
  context?: string;
  className?: string;
  /** Show the elapsed time and a retry after this many ms. 0 turns it off. */
  slowAfterMs?: number;
  /** Retry for a slow load. Defaults to reloading the page. */
  onRetry?: () => void;
  retryLabel?: string;
}

export function PageLoadingState({
  label = "Loading this page…",
  description,
  context,
  className,
  slowAfterMs = PAGE_LOADING_SLOW_AFTER_MS,
  onRetry,
  retryLabel = "Try again",
}: PageLoadingStateProps) {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!slowAfterMs) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1_000);
    return () => window.clearInterval(timer);
  }, [slowAfterMs]);

  const slow = slowAfterMs > 0 && elapsedMs >= slowAfterMs;
  const seconds = Math.floor(elapsedMs / 1_000);

  return (
    <div
      className={cn(
        "flex min-h-[45vh] flex-col items-center justify-center gap-6 px-4 py-16",
        className
      )}
      style={{ animation: "page-loader-fade 300ms ease-out 150ms both" }}
    >
      {/* Slim sweeping bar across the top of the loading area */}
      <div className="relative h-0.5 w-48 overflow-hidden rounded-full bg-primary/10" aria-hidden="true">
        <div
          className="page-loader-sweep absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary"
          style={{ animation: "page-loader-sweep 1.4s ease-in-out infinite" }}
        />
      </div>

      {/* Three bouncing dots */}
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="page-loader-dot h-2 w-2 rounded-full bg-primary"
            style={{ animation: "page-loader-dot 1.2s ease-in-out infinite", animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>

      <div className="max-w-md text-center" role="status" aria-live="polite">
        {context ? (
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{context}</p>
        ) : null}
        <p className={cn("text-base font-medium text-foreground", context && "mt-1.5")}>{label}</p>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        {slow ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Still working after {seconds} seconds. The server may be busy.
          </p>
        ) : null}
      </div>

      {slow ? (
        <Button variant="outline" size="sm" onClick={onRetry ?? reloadCurrentPage}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}

interface PageErrorStateProps {
  error?: Error | null;
  reset: () => void;
  title?: string;
  description?: string;
  digest?: string;
  className?: string;
}

export function PageErrorState({
  error,
  reset,
  title = "We couldn’t load this page",
  description = "The request did not complete. Please try again.",
  digest,
  className,
}: PageErrorStateProps) {
  const chunkError = isPageChunkError(error);
  return (
    <div className={cn("flex min-h-[45vh] items-center justify-center px-4 py-16", className)}>
      <div className="w-full max-w-md rounded-xl border border-destructive/20 bg-card p-6 text-center shadow-sm sm:p-8">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <AlertCircle className="h-6 w-6" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{chunkError ? 'A page update could not be downloaded. Reload the page to get the latest version.' : description}</p>
        {digest && (
          <p className="mt-3 text-xs text-muted-foreground">Reference: {digest}</p>
        )}
        <Button className="mt-6" onClick={chunkError ? reloadCurrentPage : reset}>
          <RefreshCw className="h-4 w-4" />
          {chunkError ? 'Reload page' : 'Try again'}
        </Button>
        {!chunkError && <Button variant="outline" className="ml-2 mt-6" onClick={reloadCurrentPage}>Reload page</Button>}
      </div>
    </div>
  );
}
