import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CreditActivity from "@/components/billing/CreditActivity";

const mocks = vi.hoisted(() => ({ get: vi.fn(), scope: "owner:business-101" }));
vi.mock("@/hooks/use-billing-api", () => ({ useBillingApi: () => ({ get: mocks.get }) }));
vi.mock("@/hooks/use-billing-organizations", () => ({ useBillingOrganizations: () => ({ billingScopeKey: mocks.scope, ready: true }) }));

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><CreditActivity /></QueryClientProvider>);
}
const lastParams = () => new URL(mocks.get.mock.calls.at(-1)![0], "https://example.test").searchParams;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope = "owner:business-101";
  mocks.get.mockResolvedValue({ transactions: [{ id: 1, type: "deduction", amount: "-12.25", balanceAfter: "987.75", description: "Lead discovery", createdAt: "2026-09-29T08:00:00Z" }], total: 21 });
});
afterEach(cleanup);

describe("credit activity", () => {
  it("distinguishes separate same-minute and same-second ledger entries without hiding them", async () => {
    const entries = [
      { id: 103, createdAt: "2026-10-25T04:48:30.253Z" },
      { id: 102, createdAt: "2026-10-25T04:48:30.253Z" },
      { id: 101, createdAt: "2026-10-25T04:48:24.082Z" },
    ].map(entry => ({ ...entry, type: "refund", amount: "2.00", balanceAfter: "500.00", description: "Refund for rejected queued email" }));
    mocks.get.mockResolvedValue({ transactions: entries, total: 71 });
    show();
    const table = await screen.findByRole("table");
    const mobile = screen.getByRole("list", { name: "Credit transactions" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(mobile).getAllByRole("listitem")).toHaveLength(3);
    for (const container of [table, mobile]) {
      for (const entry of entries) {
        expect(within(container).getByText(`Transaction #${entry.id}`)).toBeInTheDocument();
      }
      expect(within(container).getAllByText("+2")).toHaveLength(3);
      for (const entry of [entries[0], entries[2]]) {
        const time = new Date(entry.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        expect(within(container).getAllByText((_, element) => element?.tagName === "P" && !!element.textContent?.includes(time)).length).toBeGreaterThan(0);
      }
    }
    expect(screen.getByRole("status")).toHaveTextContent("1–3 of 71 transactions");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastParams().get("offset")).toBe("10"));
  });

  it("uses ledger signs and paginates the server query rather than filtering only one page", async () => {
    show();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("-12.25")).toBeInTheDocument();
    expect(within(table).getByText("987.75")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastParams().get("offset")).toBe("10"));
    fireEvent.change(screen.getByLabelText("Transaction type"), { target: { value: "refund" } });
    await waitFor(() => expect(lastParams().get("type")).toBe("refund"));
    expect(lastParams().get("offset")).toBe("0");
    expect(lastParams().get("limit")).toBe("10");
  });

  it("includes the complete local date range and does not request an inverted range", async () => {
    show();
    await screen.findByRole("table");
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-09-14" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-09-29" } });
    await waitFor(() => expect(lastParams().get("endDate")).toBe(new Date("2026-09-29T23:59:59.999").toISOString()));
    expect(lastParams().get("startDate")).toBe(new Date("2026-09-14T00:00:00.000").toISOString());
    const count = mocks.get.mock.calls.length;
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-10-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("The end date must be on or after the start date.");
    expect(mocks.get).toHaveBeenCalledTimes(count);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await screen.findByRole("table");
    expect(screen.getByLabelText("From date")).toHaveValue("");
    expect(screen.getByLabelText("To date")).toHaveValue("");
  });

  it("does not show the previous business ledger while the new scope loads", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><CreditActivity /></QueryClientProvider>);
    await screen.findByRole("table");
    mocks.scope = "staff:business-202";
    mocks.get.mockImplementation(() => new Promise(() => {}));
    view.rerender(<QueryClientProvider client={client}><CreditActivity /></QueryClientProvider>);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Lead discovery")).toBeNull();
    expect(screen.getByRole("status", { name: "Loading credit activity" })).toBeInTheDocument();
  });
});
