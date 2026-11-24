import {
  expect,
  expectNoHorizontalOverflow,
  installAppShellMocks,
  test,
} from "./fixtures/app";
const completed = {
  importId: 73,
  totalRecords: 1,
  successCount: 1,
  duplicateCount: 0,
  errorCount: 0,
  skippedCount: 0,
  warningCount: 0,
  issues: [],
  importStatus: "completed",
};
const csv = {
  name: "synthetic.csv",
  mimeType: "text/csv",
  buffer: Buffer.from("email,company\nfixture@example.test,Synthetic"),
};
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await installAppShellMocks(page);
  await page.route("**/api/crm/reminders?*", (route) =>
    route.fulfill({ json: { success: true, data: [] } }),
  );
  await page.route("**/api/proposals/related?*", (route) =>
    route.fulfill({ json: [] }),
  );
});
test("lost import response reconciles identical bytes and mapping, without an automatic repeat", async ({
  page,
  audit,
}) => {
  let writes = 0;
  const bodies: string[] = [];
  await page.route("**/api/crm/contacts/import", (route) => {
    writes++;
    bodies.push(route.request().postData() || "");
    return writes === 1
      ? route.abort("failed")
      : route.fulfill({ json: { success: true, data: completed } });
  });
  await page.goto("/dashboard/crm/import");
  await page.locator("input[type=file]").setInputFiles(csv);
  await page
    .getByRole("button", { name: "Import Contacts", exact: true })
    .click();
  await expect(
    page.getByText(/The response was lost or interrupted/),
  ).toBeVisible();
  expect(writes).toBe(1);
  await page
    .getByRole("button", { name: "Reconcile same import", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Import Complete" }),
  ).toBeVisible();
  expect(writes).toBe(2);
  expect(
    bodies.every(
      (body) =>
        body.includes("fixture@example.test,Synthetic") &&
        body.includes('"email":"email"'),
    ),
  ).toBe(true);
  await expectNoHorizontalOverflow(page);
  expect(audit.blockedMutations).toEqual([]);
});
test("a known import receipt survives refresh and completes through a read, with no second write", async ({
  page,
  audit,
}) => {
  let writes = 0;
  let recoveryReads = 0;
  let reloadStarted = false;
  await page.route("**/api/crm/contacts/import", (route) => {
    writes++;
    return route.fulfill({
      status: 503,
      json: { error: "Synthetic interruption", importId: 73, retryable: true },
    });
  });
  await page.route("**/api/crm/imports/73", (route) => {
    if (reloadStarted) recoveryReads++;
    return route.fulfill({
      json: {
        success: true,
        data:
          !reloadStarted
            ? {
                ...completed,
                importStatus: "processing",
                totalRecords: 2,
                processedRecords: 1,
              }
            : completed,
      },
    });
  });
  await page.goto("/dashboard/crm/import");
  await page.locator("input[type=file]").setInputFiles(csv);
  await page
    .getByRole("button", { name: "Import Contacts", exact: true })
    .click();
  await expect(page.getByText("Import #73", { exact: true })).toBeVisible();
  await expect(page.getByText(/1 of 2 row receipts committed/)).toBeVisible();
  await page.route("**/dashboard/crm/import", (route) => {
    if (route.request().isNavigationRequest()) reloadStarted = true;
    return route.fallback();
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Import Complete" }),
  ).toBeVisible();
  expect(writes).toBe(1);
  expect(recoveryReads).toBeGreaterThan(0);
  expect(audit.blockedMutations).toEqual([]);
});
test("contact recovery persists after refresh and offers no replay after an uncertain evaluation", async ({
  page,
  audit,
}) => {
  let status = "pending",
    writes = 0;
  await page.route("**/api/crm/contacts/42**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/retry")) {
      writes++;
      status = "review_required";
      return route.fulfill({
        json: { success: true, data: { transitionId: 73, status } },
      });
    }
    if (path.endsWith("/automation-handoffs"))
      return route.fulfill({
        json: {
          success: true,
          data: [
            {
              transitionId: 73,
              status,
              events: [
                {
                  type: "pipeline_status_change",
                  oldValue: "new",
                  newValue: "contacted",
                  status,
                },
              ],
            },
          ],
          pagination: { page: 1, totalPages: 1 },
        },
      });
    if (path.endsWith("/workspace-summary"))
      return route.fulfill({
        json: {
          success: true,
          data: {
            counts: { conversations: 0, activities: 1, tickets: 0 },
            upcomingReminders: [],
            ticketsDue: [],
            unansweredConversations: [],
            nextReminder: null,
            owner: null,
          },
        },
      });
    if (path.endsWith("/conversations"))
      return route.fulfill({
        json: {
          conversations: [],
          pagination: { page: 1, total: 0, totalPages: 1 },
        },
      });
    return route.fulfill({
      json: {
        success: true,
        data: {
          id: 42,
          firstName: "Synthetic",
          email: "fixture@example.test",
          status: "contacted",
          pipelineStatus: "contacted",
          tags: [],
          currency: "USD",
          createdAt: "2026-10-23T00:00:00Z",
        },
      },
    });
  });
  await page.goto("/dashboard/crm/contacts/42");
  await expect(page.getByText(/Saved transition #73/)).toBeVisible();
  expect(writes).toBe(0);
  await page.reload();
  await page
    .getByRole("button", { name: "Retry pending evaluation", exact: true })
    .click();
  await expect(
    page.getByText("Saved transition #73 · Review required"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry pending evaluation", exact: true }),
  ).toHaveCount(0);
  expect(writes).toBe(1);
  expect(audit.consoleErrors).toEqual([]);
  // Reload may cancel reads whose responses the previous document no longer
  // needs. Still report network failures and any cancelled mutation.
  expect(audit.failedRequests.filter((request) => !/^GET .*: net::ERR_ABORTED$/.test(request))).toEqual([]);
  await expect(
    page.getByRole("link", { name: "Link to transition #73" }),
  ).toHaveAttribute("href", "#automation-transition-73");
  await expectNoHorizontalOverflow(page);
  expect(audit.blockedMutations).toEqual([]);
});
