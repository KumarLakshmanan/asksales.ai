"use client";
import Link from "next/link";
import { Building2, Users } from "lucide-react";
import { useBillingOrganizations } from "@/hooks/use-billing-organizations";

export default function BillingOrganizationSelector({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const billing = useBillingOrganizations();
  return (
    <div
      className="mb-5 rounded-xl border border-border bg-card px-4 py-3"
      aria-busy={disabled || !billing.ready}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Building2 className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Business profile</p>
            <p className="mt-0.5 truncate text-sm font-semibold">
              {billing.organization?.name ||
                (billing.unavailable
                  ? "Business unavailable"
                  : "Loading business…")}
            </p>
          </div>
        </div>
        <p className="min-w-0 flex-[1_1_20rem] text-xs leading-5 text-muted-foreground">
          Billing follows the business selected in the sidebar. Credits and plan
          allowances are shared across the owner’s business profiles.
        </p>
        {billing.businessProfileId && (
          <Link
            href="/dashboard/settings/team"
            className="inline-flex min-h-11 items-center gap-2 text-sm text-primary hover:underline"
          >
            <Users className="h-4 w-4" aria-hidden />
            {billing.organization?.role === "owner"
              ? "Manage staff"
              : "View staff"}
          </Link>
        )}
      </div>
      {billing.unavailable && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {billing.isError
            ? "Billing could not be loaded for this business."
            : "No billing account was found for this business."}{" "}
          <button className="underline" onClick={() => void billing.refetch()}>
            Try again
          </button>
        </p>
      )}
    </div>
  );
}
