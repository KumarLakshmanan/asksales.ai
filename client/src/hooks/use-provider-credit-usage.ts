"use client";
import { useQuery } from "@tanstack/react-query";
import { useBillingApi } from "./use-billing-api";
import { useBillingOrganizations } from "./use-billing-organizations";
import { billingDateRange, type ProviderUsage } from "@/lib/billing-reporting";
export function useProviderCreditUsage(startDate = "", endDate = "") {
  const api = useBillingApi();
  const { billingScopeKey } = useBillingOrganizations();
  const range = billingDateRange(startDate, endDate);
  return useQuery<ProviderUsage[]>({
    queryKey: [
      "wallet-provider-usage",
      billingScopeKey,
      range.start,
      range.end,
    ],
    queryFn: () =>
      api.get<ProviderUsage[]>(
        `/api/wallet/provider-usage${range.query ? `?${range.query}` : ""}`,
      ),
  });
}
