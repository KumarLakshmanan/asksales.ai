import { expect, expectNoHorizontalOverflow, test } from "./fixtures/app";

test("large hospitality flow is readable without editing its business rules", async ({ page, audit }, testInfo) => {
  const nodes = Array.from({ length: 56 }, (_, i) => ({
    id: String(i), type: i === 0 ? "trigger" : i % 3 === 0 ? "complete" : "capability",
    data: { label: i === 0 ? "Welcome" : i === 2 ? "Spa information" : `Guest enquiry ${i}`,
      ...(i !== 0 && i % 3 !== 0 ? { capabilityName: "knowledge.answer" } : {}) },
    position: { x: 0, y: 0 },
  }));
  const edges = nodes.slice(1).map((node, i) => ({ id: `edge-${i}`, source: String(Math.floor(i / 3)), target: node.id,
    priority: i, condition: { operator: "matches_intent", value: `request_${i}` } }));
  const graph = { schemaVersion: 2, entryNodeId: "0", nodes, edges, fields: [] };
  await page.route("**/api/support/ai/playbooks", route => route.fulfill({ json: [{ id: 901, name: "Hospitality map QA", status: "draft", enabled: false, draftGraph: graph, assignments: [] }] }));
  await page.route("**/api/settings/ai-agents", route => route.fulfill({ json: [] }));
  await page.route("**/api/support/ai/playbook-templates", route => route.fulfill({ json: [] }));
  await page.route("**/api/support/ai/playbooks/validate", route => route.fulfill({ json: { valid: true, errors: [], warnings: [] } }));
  const writes: string[] = [];
  await page.route("**/api/support/ai/playbooks/901**", route => {
    writes.push(route.request().method());
    return route.fulfill({ status: 409, json: { error: "This map check never saves or publishes." } });
  });
  await page.goto("/dashboard/settings/outreach/playbooks");
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(56);
  await expect(page.getByLabel("Jump to step")).toBeVisible();
  const boxes = await page.locator(".react-flow__node").evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  }));
  for (const [i, box] of boxes.entries()) {
    for (const other of boxes.slice(i + 1)) {
      expect(box.x + box.w <= other.x || other.x + other.w <= box.x || box.y + box.h <= other.y || other.y + other.h <= box.y).toBe(true);
    }
  }
  await page.getByLabel("Jump to step").selectOption("2");
  await expect(page.getByLabel("Step label")).toHaveValue("Spa information");
  await expect(page.locator('.react-flow__node[data-id="2"]')).toContainText("Answer using approved information");
  const width = await page.locator('.react-flow__node[data-id="2"]').evaluate(element => element.getBoundingClientRect().width);
  expect(width).toBeGreaterThanOrEqual(230);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("spa-focused.png"), fullPage: true });
  await page.getByRole("button", { name: "Show whole flow", exact: true }).click();
  await expect(page.getByLabel("Step editor")).toHaveCount(0);
  await page.getByRole("button", { name: "Start here", exact: true }).click();
  await expect(page.getByLabel("Step label")).toHaveValue("Welcome");
  await page.getByRole("button", { name: "Auto arrange", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(56);
  await expectNoHorizontalOverflow(page);
  expect(writes).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors.filter(error => !error.includes("Failed to fetch") && !error.includes("404"))).toEqual([]);
});
