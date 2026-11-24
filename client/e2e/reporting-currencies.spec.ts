import { expect, test, installAppShellMocks } from "./fixtures/app";

test("home reporting preserves currency and budget cadence in desktop and mobile views", async ({
  page,
  audit,
}, testInfo) => {
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname)
      ? route.fallback()
      : route.abort();
  });
  // Restore read-only shell fixtures after the external-network guard, so
  // configured API origins are fulfilled locally rather than contacted.
  await installAppShellMocks(page);
  await page.route("**/api/dashboard/stats", (route) =>
    route.fulfill({
      json: {
        totalLeads: 2,
        newLeads: 0,
        activeCampaigns: 1,
        completedCampaigns: 0,
        totalSpent: null,
        totalBudget: null,
        currency: null,
        spendByCurrency: { USD: 10, INR: 800 },
        budgetByCurrencyAndType: [
          { currency: "USD", type: "daily", amount: 20 },
          { currency: "INR", type: "lifetime", amount: 1000 },
        ],
        conversionRate: "0",
        leadSources: [],
        weeklyTrends: {},
        channelPerformance: {},
      },
    }),
  );
  await page.route("**/api/suggestions", (route) =>
    route.fulfill({ json: { success: true, suggestions: [] } }),
  );
  await page.route("**/api/onboarding/status", (route) =>
    route.fulfill({
      json: { profile: {}, completedTasks: [], connectedChannels: [] },
    }),
  );
  await page.goto("/dashboard/home");
  await page.getByRole("button", { name: "Performance", exact: true }).click();
  await expect(page.getByText(/INR\s*800\.00 · USD\s*10\.00/)).toBeVisible();
  await expect(
    page.getByText(/USD\s*20\.00 daily · INR\s*1,000\.00 lifetime/),
  ).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByText(/INR\s*800\.00 · USD\s*10\.00/)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`reporting-money-${width}.png`),
      fullPage: true,
    });
  }
  expect(audit.blockedMutations).toEqual([]);
});
