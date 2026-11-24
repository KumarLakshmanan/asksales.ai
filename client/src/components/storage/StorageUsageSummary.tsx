"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Skeleton } from "@/components/ui/skeleton";
import { formatStorageBytes, storageCapacity } from "@/lib/storage";
import type { WorkspaceUsage } from "@/lib/storage-workspace";

export function StorageUsageSummary({
  usage,
  loading,
  error,
  retry,
}: {
  usage?: WorkspaceUsage;
  loading: boolean;
  error: boolean;
  retry: () => void;
}) {
  const capacity = usage && storageCapacity(usage);
  return (
    <section
      aria-label="Storage usage"
      className="space-y-3"
    >
      {usage && capacity ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
          <div className="min-w-0 space-y-3 rounded-2xl border border-border bg-card p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">Shared storage capacity</h2>
              <span
                className={`text-xs ${capacity.percent >= 90 ? "text-destructive" : "text-muted-foreground"}`}
              >
                {capacity.unlimited
                  ? "No storage limit"
                  : `${capacity.percent.toFixed(1)}% used`}
              </span>
            </div>
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl">
              {formatStorageBytes(capacity.used)}
              <span className="text-sm font-normal text-muted-foreground">
                {capacity.unlimited
                  ? "stored"
                  : `of ${formatStorageBytes(capacity.limit)}`}
              </span>
            </p>
            {!capacity.unlimited && (
              <div
                className="h-2.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label="Storage used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.min(100, capacity.percent)}
              >
                <div
                  className={`h-full rounded-full ${capacity.percent >= 90 ? "bg-destructive" : "bg-primary"}`}
                  style={{ width: `${Math.min(100, capacity.percent)}%` }}
                />
              </div>
            )}
            <p className="text-xs leading-5 text-muted-foreground">
              {capacity.unlimited
                ? "Capacity is shared across your organization."
                : capacity.percent >= 100
                  ? "Storage is full. Permanently remove files from Trash or review your plan."
                  : `${formatStorageBytes(capacity.remaining)} available across your organization.`}{" "}
              Files in Trash count toward capacity until permanently removed.
            </p>
          </div>
          <div className="min-w-0 space-y-3 rounded-2xl border border-border bg-card p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <p className="text-lg font-semibold">
                {usage.planName || "Free"} plan
              </p>
              <Link
                href="/dashboard/billing/subscription"
                className="inline-flex min-h-11 items-center text-xs text-primary hover:underline"
              >
                Manage plan
              </Link>
            </div>
            <div><p className="text-xs text-muted-foreground">Selected business profile</p>{usage.businessName && <p className="mt-1 text-sm font-semibold">{usage.businessName}</p>}</div>
            <div className="grid grid-cols-2 gap-4 border-t border-border pt-3">
              <div>
                <p className="text-2xl font-semibold tabular-nums">
                  {usage.activeCount.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">
                  Active files · {formatStorageBytes(usage.activeBytes)}
                </p>
              </div>
              <div>
                <p className="text-2xl font-semibold tabular-nums">
                  {usage.trashCount.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">
                  In Trash · {formatStorageBytes(usage.trashBytes)}
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : loading ? (
        <div
          className="space-y-4 rounded-2xl border border-border bg-card p-6"
          role="status"
          aria-label="Loading storage usage"
        >
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-52" />
          <Skeleton className="h-2 w-full" />
        </div>
      ) : null}
      {error && (
        <Callout
          tone="danger"
          actions={
            <Button variant="outline" onClick={retry}>
              Try again
            </Button>
          }
        >
          Storage usage could not be loaded.
        </Callout>
      )}
    </section>
  );
}
