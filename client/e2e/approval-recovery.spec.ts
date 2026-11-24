import { test, expect, expectNoHorizontalOverflow } from "./fixtures/app";
import { installOutreachReview } from "./fixtures/outreach-review";
test("populated tool recovery navigation and keyboard focus, with persistent labels and read-only approval recovery", async ({
  page,
  audit,
}, testInfo) => {
  await installOutreachReview(page, "light");
  let failRefresh = false;
  await page.route("**/*", (route) =>
    ["127.0.0.1", "localhost"].includes(new URL(route.request().url()).hostname)
      ? route.fallback()
      : route.abort(),
  );
  await page.route("**/api/support/ai/approval-recovery", (route) => {
    return !failRefresh
      ? route.fulfill({
          json: [
            {
              id: 7,
              toolName: "create_booking",
              threadId: 42,
              status: "approved",
              resumeStatus: "ready",
              message:
                "Protected approval data could not be verified. Check support encryption configuration and review any existing execution before retrying.",
            },
          ],
        })
      : route.fulfill({ status: 503, json: { error: "Synthetic outage" } });
  });
  await page.route(
    "**/api/settings/outreach/assistants/diagnostics?*",
    (route) =>
      route.fulfill({
        json: {
          days: 30,
          assignments: [],
          metrics: [],
          knowledgeGaps: [],
          usage: [],
        },
      }),
  );
  await page.route("**/api/support/ai/tool-executions?*", (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).searchParams.get("status") === "failed"
          ? [
              {
                id: 11,
                conversationId: 42,
                toolName: "create_booking",
                riskLevel: "high",
                status: "failed",
                attemptCount: 1,
                error: "Synthetic uncertain result",
                lastAttemptAt: "2026-10-23T15:00:00Z",
                reconciliationStatus: "pending",
              },
            ]
          : [],
    }),
  );

  await page.goto("/dashboard/settings/outreach");
  const link = page.getByRole("link", {
    name: "Reply operations",
    exact: true,
  });
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/settings\/outreach\/operations$/);
  const queue = page.getByRole("link", { name: "Reply queue", exact: false });
  await queue.focus();
  await expect(queue).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/settings\/outreach\/orchestration$/);
  await expect(
    page.getByRole("heading", { name: "AI reply operations", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: /Review issues/ }).click();
  const note = page.getByPlaceholder(
    "Required provider or database verification note",
    { exact: true },
  );
  await note.fill("Synthetic provider-side verification");
  const fields = await note.evaluate((el) => ({
    labelCount: (el as HTMLInputElement).labels?.length,
    ariaLabel: el.getAttribute("aria-label"),
    labelledBy: el.getAttribute("aria-labelledby"),
  }));
  expect(fields.labelCount).toBe(1);
  await expect(
    page.getByLabel("Tool verification note", { exact: true }),
  ).toHaveValue("Synthetic provider-side verification");
  await expect(
    page.getByText("create booking · Review #7", { exact: true }),
  ).toBeVisible();
  failRefresh = true;
  const refresh = page.getByRole("button", {
    name: "Refresh approvals",
    exact: true,
  });
  await refresh.focus();
  await expect(refresh).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Approval recovery could not be loaded" }),
  ).toContainText("last loaded approvals are still shown");
  await expect(
    page.getByText("create booking · Review #7", { exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("populated-tool-recovery.png"),
    fullPage: true,
  });
  expect(audit.blockedMutations).toEqual([]);
});
