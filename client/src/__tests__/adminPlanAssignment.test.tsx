import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminPlanAssignment from "@/components/admin/AdminPlanAssignment";
import { SUBSCRIPTION_PLANS } from "../../../shared/subscriptions";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/admin-api", () => ({ default: { get: mocks.get, post: mocks.post } }));

const overview = {
  organization: { id: 19, name: "Aimplify AI", ownerUserId: 7, ownerEmail: "owner@example.test" },
  current: null,
  pending: null,
  access: { reason: "rollout_pending", allowed: true, canTopUp: false, accessUntil: null },
  nextDepositAt: null,
  entitlements: { limits: {}, usage: {}, enforced: false, catalogVersion: null, planSlug: null },
  adminTerms: [],
  catalog: { version: 2, plans: SUBSCRIPTION_PLANS, currency: "INR", taxInclusive: true },
};

function show() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><AdminPlanAssignment organizationId={19} /></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(overview);
  mocks.post.mockResolvedValue(overview);
});
afterEach(cleanup);

describe("administrator plan assignment", () => {
  it("reviews an explicit complimentary assignment with an audit reason", async () => {
    show();
    await screen.findByText("Aimplify AI");
    fireEvent.change(screen.getByLabelText("Published plan"), { target: { value: "growth" } });
    fireEvent.change(screen.getByLabelText("Reason for the plan change"), { target: { value: "Approved support grant" } });
    fireEvent.click(screen.getByRole("button", { name: "Review assignment" }));
    expect(screen.getByText(/this admin assignment charges ₹0/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/api/admin/subscriptions/organizations/19/plan",
      { catalogVersion: 2, plan: "growth", term: "monthly", timing: "now", reason: "Approved support grant" },
    ));
  });

  it("requires an existing paid term to finish first", async () => {
    mocks.get.mockResolvedValue({
      ...overview,
      current: {
        id: "paid", version: 2, name: "Starter", plan: "starter", term: "monthly",
        mode: "live", status: "active", paidThrough: "2027-09-28T00:00:00Z",
        cancelAtPeriodEnd: false, paymentMethod: "upi", source: "razorpay",
      },
      access: { reason: "paid", allowed: true, canTopUp: true, accessUntil: "2027-09-28T00:00:00Z" },
    });
    show();
    await screen.findByText(/Starter · Paid/);
    expect(screen.getByRole("option", { name: /Now · paid term still active/ })).toBeDisabled();
    expect(screen.getByLabelText("When should this plan start?")).toHaveValue("at_term_end");
  });
});
