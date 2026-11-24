import type { Route } from "@playwright/test";
import { test, expect, installAppShellMocks, expectNoHorizontalOverflow } from "./fixtures/app";

async function json(route: Route, data: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ success: status < 400, data, ...(status >= 400 ? { error: data } : {}) }) });
}
const standard = {
  id: 1, userId: null as number | null, name: "Website Development", description: "Discovery, design and implementation.",
  category: "Web and software", templateType: "document", createdAt: "2026-10-01", updatedAt: "2026-10-01",
  includeKnowledgeBase: true, includeBusinessProfile: true,
  templateContent: { sections: [{ title: "Executive summary", kind: "cover", body: "A website for {{client_name}} by {{project_deadline}}.", instruction: "Only use the confirmed scope." }], requiredFields: ["client_name", "project_deadline"], placeholders: ["client_name", "project_deadline"], warnings: [] },
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: {} }));
  await installAppShellMocks(page);
  await page.route("**/api/proposals/templates/favorites", route => json(route, []));
  await page.route("**/api/proposals/templates", route => json(route, [standard]));
});

test("catalog edits and retirement preserve the payload, Cancel and failed save recovery", async ({ page }, info) => {
  const items = [{ id: 21, name: "Strategy workshop", description: "Discovery and delivery plan", currency: "USD", unitPrice: 1500, unit: "project", active: true }];
  const writes: unknown[] = [];
  let fail = true;
  await page.route("**/api/proposals/catalog", route => json(route, items));
  await page.route("**/api/proposals/catalog/21", async route => {
    const body = route.request().postDataJSON();
    writes.push(body);
    if (fail) return json(route, "Synthetic save failure", 500);
    Object.assign(items[0], body);
    return json(route, items[0]);
  });
  await page.goto("/dashboard/proposals/catalog");
  await page.getByRole("button", { name: "Edit Strategy workshop" }).click();
  await expect(page.getByRole("heading", { name: "Edit item", exact: true })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Unsaved change");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Unit", { exact: true })).toHaveValue("unit");
  await page.getByRole("button", { name: "Edit Strategy workshop" }).click();
  await page.getByLabel("Available for new proposals").uncheck();
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Synthetic save failure");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Strategy workshop");
  await expect(page.getByLabel("Available for new proposals")).not.toBeChecked();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("catalog-edit-failure.png"), fullPage: true });
  fail = false;
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(page.getByText("Retired", { exact: true })).toBeVisible();
  expect(writes).toEqual(Array.from({ length: 2 }, () => ({ name: "Strategy workshop", description: "Discovery and delivery plan", currency: "USD", unitPrice: 1500, unit: "project", active: false })));
  await expect(page.getByRole("heading", { name: "Add item", exact: true })).toBeVisible();
});

test("template preview keeps trial values unsaved and restores focus; import retains its options and contract", async ({ page }, info) => {
  let library = [standard];
  const uploads: string[] = [];
  await page.route("**/api/proposals/templates", route => json(route, library));
  await page.route("**/api/proposals/templates/import", async route => {
    uploads.push(route.request().postData() || "");
    library = [...library, { ...standard, id: 2, userId: 4101, name: "Imported scope" }];
    return json(route, library[1]);
  });
  await page.goto("/dashboard/proposals/templates");
  const trigger = page.getByRole("button", { name: "Customer preview of Website Development" });
  await trigger.click();
  const preview = page.getByRole("dialog", { name: "Website Development", exact: true });
  await preview.getByText("Try required field values (1)", { exact: true }).click();
  await preview.getByLabel("project_deadline", { exact: true }).fill("15 Nov 2026");
  await preview.getByRole("button", { name: "Mobile width", exact: true }).click();
  await expect(preview.getByRole("article")).toContainText("15 Nov 2026");
  await expect(preview.getByRole("article")).not.toContainText("Only use the confirmed scope.");
  await page.screenshot({ path: info.outputPath("template-customer-preview.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "Import DOCX", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import a DOCX template" });
  await expect(dialog.getByRole("checkbox", { name: "Use knowledge base" })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Use business profile" })).toBeChecked();
  await dialog.getByRole("button", { name: "Import template", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Choose a DOCX file to import.");
  expect(uploads).toEqual([]);
  await dialog.getByLabel("DOCX file · up to 15 MB").setInputFiles({ name: "scope.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("synthetic DOCX fixture") });
  await dialog.getByLabel("Template name", { exact: true }).fill("Imported scope");
  await page.screenshot({ path: info.outputPath("template-import.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Import template", exact: true }).click();
  await expect(page.getByRole("tab", { name: /My templates/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Imported scope", exact: true })).toBeVisible();
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toContain('name="includeKnowledgeBase"');
  expect(uploads[0]).toContain('name="includeBusinessProfile"');
  expect(uploads[0]).not.toContain("15 Nov 2026");
  await expectNoHorizontalOverflow(page);
});

test("list failure is distinct from empty data and recovery retains the existing filter requests", async ({ page }, info) => {
  let fail = true;
  const requests: URL[] = [];
  await page.route("**/api/proposals/analytics", route => json(route, { total: 0, draft: 0, sent: 0, viewed: 0, accepted: 0, rejected: 0, expired: 0, delivery_unknown: 0, acceptanceRate: 0 }));
  await page.route("**/api/proposals?*", route => {
    requests.push(new URL(route.request().url()));
    return fail ? json(route, "Synthetic list failure", 500) : json(route, { proposals: [], total: 0, totalPages: 1 });
  });
  await page.goto("/dashboard/proposals");
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(/Synthetic list failure/);
  await expect(page.getByRole("heading", { name: "No proposals match this view" })).toHaveCount(0);
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No proposals match this view" })).toBeVisible();
  await page.getByLabel("Status filter").click();
  await page.getByRole("option", { name: "Delivery review", exact: true }).click();
  await expect.poll(() => requests.some(url => url.searchParams.get("status") === "delivery_unknown")).toBe(true);
  expect(requests.every(url => url.searchParams.get("limit") === "25")).toBe(true);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("proposals-empty.png"), fullPage: true });
});

test("populated workbench preserves state-specific actions and pagination", async ({ page }, info) => {
  const statuses = ["draft", "delivery_unknown", "sent", "viewed", "accepted", "rejected"];
  const rows = statuses.map((status, index) => ({ id: 1041 + index, proposalNumber: `P-2026-${1041 + index}`, title: ["Website launch", "CRM rollout", "Campaign strategy", "Support retainer", "Brand workshop", "Content sprint"][index], recipientName: "Alex Morgan", recipientEmail: "alex@example.test", owner: index === 1 ? null : { id: 7, name: "Olivia Chen", email: "olivia@example.test" }, status, currency: "USD", total: ["3135", "5000", "2000", "900", "1500", "800"][index], validUntil: "2026-11-15", updatedAt: "2026-10-31", lastActivityAt: "2026-10-31", metadata: index === 0 ? { teamApproval: { status: "changes_requested" } } : {} }));
  await page.route("**/api/proposals?*", route => json(route, { proposals: rows, total: 6, totalPages: 1 }));
  await page.route("**/api/proposals/analytics", route => json(route, { total: 6, accepted: 1, acceptanceRate: 50, funnel: { created: 6, delivered: 4, viewed: 3, decided: 2, accepted: 1 } }));
  await page.goto("/dashboard/proposals");
  const table = page.getByRole("table", { name: "Proposals", exact: true });
  await expect(table.getByRole("row")).toHaveCount(7);
  await expect(table.getByText("Delivery review", { exact: true })).toBeVisible();
  await expect(table.getByText("Team: changes requested", { exact: true })).toBeVisible();
  await expect(table.getByRole("button", { name: /^Send / })).toHaveCount(1);
  await expect(table.getByRole("button", { name: /^Delete / })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("proposals-workbench.png"), fullPage: true });
  await table.getByRole("button", { name: "Delete Website launch", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("This cannot be undone.");
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(table.getByRole("row")).toHaveCount(7);
});

test("manual pricing and review preserve totals, optional controls and draft payload", async ({ page }, info) => {
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/proposals/catalog", route => json(route, []));
  await page.route("**/api/proposals/brand", route => json(route, { companyName: "Regression Company" }));
  await page.route("**/api/proposals/sources*", route => json(route, { contacts: [], conversations: [], tickets: [] }));
  await page.route("**/api/proposals/onboarding-resources", route => json(route, { teams: [], members: [] }));
  await page.route("**/api/proposals", async route => { const body = route.request().postDataJSON(); writes.push(body); await json(route, { ...body, id: 1041, revision: 1, status: "draft" }); });
  await page.route("**/api/proposals/1041", async route => { const body = route.request().postDataJSON(); writes.push(body); await json(route, { ...body, id: 1041, revision: Number(body.expectedRevision || 1) + 1, status: "draft" }); });
  await page.goto("/dashboard/proposals/new");
  await page.getByPlaceholder("Website launch for Acme").fill("Website launch for Acme");
  await page.getByLabel("Customer name", { exact: true }).fill("Alex Morgan");
  await page.getByLabel(/^Customer email/).fill("alex@example.test");
  await page.screenshot({ path: info.outputPath("proposal-customer.png"), fullPage: true });
  const steps = page.getByRole("navigation", { name: "Proposal creation steps" });
  await steps.getByRole("button", { name: /Scope and pricing/ }).click();
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page.getByLabel("Item 1 name", { exact: true }).fill("Website design");
  await page.getByLabel("Item 1 quantity", { exact: true }).fill("20");
  await page.getByLabel("Item 1 unit price", { exact: true }).fill("150");
  await page.getByLabel("Item 1 unit", { exact: true }).fill("hour");
  await page.getByLabel("Discount type", { exact: true }).selectOption("fixed");
  await page.getByLabel("Discount value", { exact: true }).fill("150");
  await page.getByLabel("Tax (%)", { exact: true }).fill("10");
  await page.getByLabel("Terms and conditions", { exact: true }).fill("50% deposit; balance due in 14 days.");
  await expect(page.getByText("USD 3,135.00", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Optional add-on", { exact: true })).toBeVisible();
  await expect(page.getByText("Alternative packages", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("proposal-scope-pricing.png"), fullPage: true });
  await steps.getByRole("button", { name: /4.*Review/ }).click();
  await expect(page.getByLabel("Create onboarding on acceptance")).toBeChecked();
  await expect(page.getByRole("button", { name: "Download preview PDF", exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: info.outputPath("proposal-review.png"), fullPage: true });
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect.poll(() => writes.at(-1)).toMatchObject({ discountType: "fixed", discountValue: 150, taxRate: 10, lineItems: [{ name: "Website design", quantity: 20, unitPrice: 150, unit: "hour" }] });
});
