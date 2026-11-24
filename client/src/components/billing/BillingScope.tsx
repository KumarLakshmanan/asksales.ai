"use client";
import { useBillingOrganizations } from "@/hooks/use-billing-organizations";
import BillingOrganizationSelector from "./BillingOrganizationSelector";
export default function BillingScope({
  children,
}: {
  children: React.ReactNode;
}) {
  const billing = useBillingOrganizations();
  return (
    <>
      <BillingOrganizationSelector />
      {billing.ready ? (
        <div key={billing.billingScopeKey}>{children}</div>
      ) : !billing.unavailable ? (
        <p className="py-8 text-sm text-muted-foreground" role="status">
          Loading business billing…
        </p>
      ) : null}
    </>
  );
}
