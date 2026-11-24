import React from "react";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectBusinessProfile } from "@/lib/business-profile";
import { useBillingOrganizations } from "@/hooks/use-billing-organizations";
import { useBillingApi } from "@/hooks/use-billing-api";
import BillingOrganizationSelector from "@/components/billing/BillingOrganizationSelector";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ default: mocks }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: 5 }, isLoading: false }),
}));
const context = (businessProfileId: number) => ({
  organizations: [
    {
      id: 77,
      businessProfileId,
      name: businessProfileId === 11 ? "North Studio" : "South Studio",
      ownerUserId: 5,
      defaultForUserId: 5,
      role: businessProfileId === 11 ? "owner" : "member",
      canManageBilling: businessProfileId === 11,
    },
  ],
  invitations: [],
  selectedOrganizationId: 77,
});
function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function BillingQueryWrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  localStorage.setItem("user", JSON.stringify({ id: 5 }));
  sessionStorage.setItem("active-billing-organization:5", "999");
  selectBusinessProfile(11);
  mocks.get.mockImplementation(
    (path: string, options?: { headers?: HeadersInit }) =>
      path === "/api/organizations"
        ? Promise.resolve(
            context(
              Number(
                new Headers(options?.headers).get("X-Business-Profile-Id"),
              ),
            ),
          )
        : Promise.resolve({ balance: 10 }),
  );
  mocks.post.mockResolvedValue({});
});
afterEach(cleanup);

describe("Business-derived billing identity", () => {
  it("uses one business selection and separates cached role state for profiles sharing a payer", async () => {
    const { result } = renderHook(() => useBillingOrganizations(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const firstScope = result.current.billingScopeKey;
    expect(result.current.organization?.canManageBilling).toBe(true);
    expect(result.current.organizationId).toBe(77);
    act(() => selectBusinessProfile(22));
    await waitFor(() =>
      expect(result.current.organization?.businessProfileId).toBe(22),
    );
    expect(result.current.organization?.canManageBilling).toBe(false);
    expect(result.current.organizationId).toBe(77);
    expect(result.current.billingScopeKey).not.toBe(firstScope);
    expect(sessionStorage.getItem("active-billing-organization:5")).toBe("999");
    expect(result.current).not.toHaveProperty("switchOrganization");
  });
  it("captures business access and original payer together while payment verification is pending", async () => {
    const { result } = renderHook(
      () => ({ billing: useBillingOrganizations(), api: useBillingApi() }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.billing.ready).toBe(true));
    const originalRequest = result.current.api;
    act(() => selectBusinessProfile(22));
    await waitFor(() =>
      expect(result.current.billing.organization?.businessProfileId).toBe(22),
    );
    await originalRequest.post("/api/subscriptions/verify", {
      paymentId: "captured",
    });
    const headers = new Headers(mocks.post.mock.calls[0][2].headers);
    expect(headers.get("X-Business-Profile-Id")).toBe("11");
    expect(headers.get("X-Billing-Organization-Id")).toBe("77");
    await result.current.api.get("/api/wallet");
    expect(
      new Headers(mocks.get.mock.calls.at(-1)?.[1].headers).get(
        "X-Business-Profile-Id",
      ),
    ).toBe("22");
  });
  it("shows the current business and staff link without an independent billing chooser", async () => {
    render(<BillingOrganizationSelector />, { wrapper: wrapper() });
    await screen.findByText("North Studio");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("link", { name: "Manage staff" })).toHaveAttribute(
      "href",
      "/dashboard/settings/team",
    );
  });
});
