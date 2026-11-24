import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BillingPage from "@/app/dashboard/(main)/billing/page";
import { bottomNavItems } from "@/lib/sidebarConfig";
import { SUBSCRIPTION_PLANS } from "../../../shared/subscriptions";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  state: null as Record<string, unknown> | null,
}));

vi.mock("@/hooks/use-billing-api", () => ({ useBillingApi: () => ({ get: mocks.get }) }));
vi.mock("@/hooks/use-billing-organizations", () => ({ useBillingOrganizations: () => ({ billingScopeKey: "11:77", ready: true }) }));
vi.mock("@/hooks/use-subscription", () => ({
  useSubscription: () => ({
    data: mocks.state, isPending: false, isError: false, refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-pricing-catalog", () => ({
  usePricingCatalog: () => ({ data: { plans: SUBSCRIPTION_PLANS } }),
}));

function showPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><BillingPage /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = {
    organization: { canManageBilling: true },
    access: { reason: "rollout_pending", canTopUp: false },
    subscription: null,
    nextDepositAt: null,
    pendingChange: null,
    charges: [],
    mode: "test",
  };
  mocks.get.mockImplementation((path: string) => Promise.resolve(
    path === "/api/wallet"
      ? { balance: 65603.77, rechargeRate: 10 }
      : { transactions: [], total: 0 },
  ));
});
afterEach(cleanup);

describe("billing overview", () => {
  it("uses Billing in navigation and shows honest dates and invoice state without a paid plan", async () => {
    expect(bottomNavItems.find(item => item.path === "/dashboard/billing")?.label).toBe("Billing");
    showPage();
    expect(screen.getByRole("heading", { name: "No active plan" })).toBeInTheDocument();
    expect(screen.getAllByText("Not scheduled")).toHaveLength(2);
    expect(screen.getByText("No plan invoices yet")).toBeInTheDocument();
    expect(await screen.findByText("65,603.77")).toBeInTheDocument();
    expect(screen.getByText("Top-ups are available with an active paid plan.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /₹500/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Recharge history" })).toHaveAttribute("href", "/dashboard/billing/recharge-history");
  });

  it("shows verified renewal, invoice and selected top-up when a plan is paid", async () => {
    mocks.state = {
      organization: { canManageBilling: true },
      access: { reason: "paid", canTopUp: true },
      subscription: {
        id: "sub_test", version: 2, name: "Growth", plan: "growth",
        term: "yearly", status: "active", cancelAtPeriodEnd: false,
        paidThrough: "2027-09-28T00:00:00.000Z",
      },
      nextDepositAt: "2026-10-28T00:00:00.000Z",
      pendingChange: null,
      charges: [{
        id: "charge_1", plan: "growth", amountPaise: 1440000,
        paidAt: "2026-09-28T00:00:00.000Z",
        invoiceUrl: "https://example.com/invoice/charge_1",
        refundAmountPaise: 0,
      }],
      mode: "live",
    };
    mocks.get.mockImplementation((path: string) => Promise.resolve(
      path === "/api/wallet"
        ? { balance: 15000, rechargeRate: 10 }
        : { transactions: [{ id: 7, amount: "2500", amountPaid: "250", currency: "INR", createdAt: "2026-09-27T00:00:00.000Z" }], total: 1 },
    ));
    showPage();
    expect(screen.getByRole("heading", { name: "Growth plan" })).toBeInTheDocument();
    expect(screen.getByText("28 Oct 2026")).toBeInTheDocument();
    expect(screen.getByText("28 Sept 2027")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Invoice" })).toHaveAttribute("href", "https://example.com/invoice/charge_1");
    const recharge = within(screen.getByRole("region", { name: "Recharge credits" }));
    expect(recharge.getByRole("link", { name: /₹500/ })).toHaveAttribute("href", "/dashboard/billing/recharge?amount=500");
    expect(await recharge.findByText("₹250 top-up")).toBeInTheDocument();
  });

  it("keeps purchase options read-only for staff members", async () => {
    mocks.state = {
      ...mocks.state,
      organization: { canManageBilling: false },
      access: { reason: "paid", canTopUp: true },
    };
    showPage();
    const recharge = within(screen.getByRole("region", { name: "Recharge credits" }));
    expect(await recharge.findByText("₹500")).toBeInTheDocument();
    expect(recharge.queryByRole("link", { name: /₹500/ })).toBeNull();
    expect(recharge.getByText("Ask the business owner or billing admin to purchase credits.")).toBeInTheDocument();
  });

  it("labels an administrator grant as a plan without implying a payment or renewal", () => {
    mocks.state = {
      organization: { canManageBilling: true },
      access: { reason: "admin_grant", canTopUp: true },
      subscription: {
        id: "admin-grant", version: 2, name: "Growth", plan: "growth",
        term: "monthly", status: "active", cancelAtPeriodEnd: true,
        paidThrough: "2027-09-28T00:00:00.000Z", source: "admin",
      },
      nextDepositAt: "2027-10-01T00:00:00.000Z",
      pendingChange: null, charges: [], mode: "test",
    };
    showPage();
    expect(screen.getByRole("heading", { name: "Growth plan" })).toBeInTheDocument();
    expect(screen.getByText("Monthly administrator plan · no charge")).toBeInTheDocument();
    expect(screen.getByText("Plan ends")).toBeInTheDocument();
    expect(screen.getByText("No plan invoices yet")).toBeInTheDocument();
    expect(screen.getByText("Administrator plans do not renew automatically.")).toBeInTheDocument();
    expect(screen.getByText("Off", { exact: true })).toBeInTheDocument();
  });

  it("shows a halted renewal as needing attention even while the paid term remains valid", () => {
    mocks.state = {
      ...mocks.state,
      access: { reason: "paid", canTopUp: true },
      subscription: { id: "sub_halted", version: 2, name: "Growth", plan: "growth", term: "monthly", status: "halted", cancelAtPeriodEnd: false, paidThrough: "2099-10-01T00:00:00Z" },
    };
    showPage();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.queryByText("On", { exact: true })).toBeNull();
    expect(screen.getByText("Paid access ends")).toBeInTheDocument();
  });

  it("shows actual grace access dates without representing grace as a free trial or an active plan", () => {
    mocks.state = { ...mocks.state, access: { reason: "payment_grace", canTopUp: false, accessUntil: "2099-10-01T00:00:00Z" } };
    showPage();
    expect(screen.getByText("Grace access ends")).toBeInTheDocument();
    expect(screen.getByText("1 Oct 2099")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No active plan" })).toBeInTheDocument();
    expect(screen.queryByText(/free trial/i)).toBeNull();
  });
});
