import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { formatReportingMoney } from "@/lib/reportingMoney";
import { DashboardStats } from "@/app/dashboard/(main)/home/_components/DashboardStats";
afterEach(cleanup);
it("formats recorded currencies separately and never invents a currency", () => {
  expect(formatReportingMoney({ USD: 10, INR: 800 })).toMatch(
    /INR.*800\.00.*USD.*10\.00/,
  );
  expect(formatReportingMoney(undefined, 100, null)).toBe("—");
  expect(formatReportingMoney({ UNKNOWN: 12 })).toBe(
    "12 (currency unavailable)",
  );
  expect(formatReportingMoney({ USD: 0 })).toMatch(/USD.*0\.00/);
});
it("shows independent spend currencies and budget cadence in the home dashboard", () => {
  render(
    <DashboardStats
      isLoading={false}
      stats={{
        totalLeads: 1,
        newLeads: 0,
        activeCampaigns: 1,
        completedCampaigns: 0,
        conversionRate: "0",
        totalSpent: null,
        totalBudget: null,
        spendByCurrency: { USD: 10, INR: 800 },
        budgetByCurrencyAndType: [
          { currency: "USD", type: "daily", amount: 20 },
          { currency: "INR", type: "lifetime", amount: 1000 },
        ],
      }}
    />,
  );
  expect(screen.getByText(/INR.*800\.00.*USD.*10\.00/)).toBeVisible();
  expect(
    screen.getByText(/USD.*20\.00 daily.*INR.*1,000\.00 lifetime/),
  ).toBeVisible();
  expect(screen.queryByText("₹810")).toBeNull();
});
