import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useProviderCreditUsage } from "@/hooks/use-provider-credit-usage";
const state = vi.hoisted(() => ({ scope: "organization:1", get: vi.fn() }));
vi.mock("@/hooks/use-billing-api", () => ({
  useBillingApi: () => ({ get: state.get }),
}));
vi.mock("@/hooks/use-billing-organizations", () => ({
  useBillingOrganizations: () => ({ billingScopeKey: state.scope }),
}));
beforeEach(() => {
  state.scope = "organization:1";
  state.get.mockReset();
  state.get.mockImplementation(async () => [
    {
      apiProvider: "openai",
      totalCredits: state.scope === "organization:1" ? 10 : 90,
      totalApiCostCents: 1,
      eventCount: 1,
    },
  ]);
});
describe("shared provider credit reporting", () => {
  it("keeps organization and date-range caches isolated", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const { result, rerender } = renderHook(
      ({ startDate, endDate }) => useProviderCreditUsage(startDate, endDate),
      {
        initialProps: { startDate: "", endDate: "" },
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(result.current.data?.[0].totalCredits).toBe(10));
    rerender({ startDate: "2026-10-01", endDate: "2026-10-03" });
    await waitFor(() => expect(state.get).toHaveBeenCalledTimes(2));
    expect(decodeURIComponent(state.get.mock.calls[1][0])).toContain(
      "endDate=2026-10-03T23:59:59.999Z",
    );
    state.scope = "organization:2";
    rerender({ startDate: "2026-10-01", endDate: "2026-10-03" });
    await waitFor(() => expect(result.current.data?.[0].totalCredits).toBe(90));
    expect(state.get).toHaveBeenCalledTimes(3);
    state.scope = "organization:1";
    rerender({ startDate: "", endDate: "" });
    await waitFor(() => expect(result.current.data?.[0].totalCredits).toBe(10));
    expect(state.get).toHaveBeenCalledTimes(3);
  });
});
