import { expect, expectNoHorizontalOverflow, test } from "./fixtures/app";

test("focused playbook editing preserves graph data and guards live changes", async ({
  page,
  audit,
}, testInfo) => {
  await page.routeWebSocket("**/api/agents/progress**", () => {});
  const fields = Array.from({ length: 44 }, (_, i) => ({
    key: i === 0 ? "stay.checkIn" : `stay.detail${i}`,
    type: "text",
    required: true,
    pii: "none",
    prompt: i === 0 ? "What is your check-in date?" : `Question ${i}`,
    validation: { maxLength: 120 },
  }));
  const graph = {
    schemaVersion: 2,
    entryNodeId: "start",
    fields,
    metadata: {
      presentationDefaults: {
        mode: "fixed",
        optionStrategy: "all",
        allowReordering: false,
        avoidRecentPhrasings: true,
        deterministicFallback: "Please share your details.",
      },
    },
    nodes: [
      {
        id: "start",
        type: "collect",
        data: { label: "Stay details", fieldKeys: ["stay.checkIn"] },
      },
      {
        id: "finish",
        type: "complete",
        data: { label: "Finish", instruction: "Thank the guest." },
      },
    ],
    edges: [
      {
        id: "next",
        source: "start",
        target: "finish",
        condition: { operator: "all_required_fields_present" },
        priority: 10,
      },
    ],
    variants: [{ id: "main", weight: 100 }],
  };
  const items = [
    {
      id: 21,
      name: "Hospitality Sales & Enquiries",
      description: "Stays, resort information, and callbacks.",
      status: "published",
      enabled: true,
      activeVersion: 12,
      draftGraph: graph,
      templateMode: "managed",
      templateKey: "hospitality",
      templateVersion: 12,
      assignments: [
        {
          id: 50,
          channel: null,
          intent: "booking_request",
          enabled: true,
          priority: 40,
          trafficPercent: 100,
        },
      ],
    },
    {
      id: 22,
      name: "Proposal request",
      description: "",
      status: "published",
      enabled: false,
      activeVersion: 1,
      draftGraph: graph,
      templateMode: "managed",
      assignments: [],
    },
  ];
  let saves = 0;
  let publishes = 0;
  let allowValidation = true;
  await page.route("**/api/support/ai/playbooks", (route) =>
    route.fulfill({ json: items }),
  );
  await page.route("**/api/settings/ai-agents", (route) =>
    route.fulfill({
      json: [
        {
          agentType: "hotel_sales",
          displayName: "Hotel Sales Agent",
          enabled: true,
        },
      ],
    }),
  );
  await page.route("**/api/support/ai/playbook-templates", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/support/ai/playbooks/validate", (route) =>
    route.fulfill({
      json: {
        valid: allowValidation,
        errors: allowValidation ? [] : ["A required connection is missing."],
        warnings: [],
      },
    }),
  );
  await page.route("**/api/auth/csrf-token", (route) =>
    route.fulfill({ json: { csrfToken: "qa-only" } }),
  );
  await page.route("**/api/support/ai/playbooks/21", async (route) => {
    const payload = route.request().postDataJSON();
    expect(payload.graph.edges).toEqual(graph.edges);
    expect(payload.graph.variants).toEqual(graph.variants);
    expect(payload.graph.metadata).toEqual(graph.metadata);
    expect(payload.graph.fields[0].validation).toEqual(fields[0].validation);
    expect(payload.graph.fields).toHaveLength(44);
    expect(
      payload.graph.nodes.find((node: { id: string }) => node.id === "finish")
        .data.label,
    ).toBe("Finish edited in graph");
    items[0] = {
      ...items[0],
      name: payload.name,
      description: payload.description,
      draftGraph: payload.graph,
    };
    saves++;
    await route.fulfill({ json: items[0] });
  });
  await page.route("**/api/support/ai/playbooks/21/publish", async (route) => {
    publishes++;
    await route.fulfill({ json: { version: 13 } });
  });

  await page.goto("/dashboard/settings/outreach/playbooks");
  await expect(
    page.getByRole("heading", { name: "Conversation flow", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Question shown to the customer")).toHaveCount(
    0,
  );
  await page
    .getByRole("navigation", { name: "Conversation steps" })
    .getByRole("button", { name: /Stay details/ })
    .click();
  await expect(page.getByLabel("Step label")).toHaveValue("Stay details");
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Graph editor", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await page.locator('.react-flow__node[data-id="finish"]').click();
  await page.getByLabel("Step label").fill("Finish edited in graph");
  await expect(
    page.locator('.react-flow__node[data-id="finish"]'),
  ).toContainText("Finish edited in graph");
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await page.getByRole("button", { name: "Flow map", exact: true }).click();
  await expect(page.locator(".react-flow")).toBeVisible();
  await expect(page.getByRole("button", { name: "fit view" })).toBeVisible();
  await page.getByRole("button", { name: "Steps", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Conversation steps" }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("conversation.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Questions", exact: true }).click();
  await expect(page.getByLabel("Question shown to the customer")).toHaveCount(
    1,
  );
  await page
    .getByLabel("Question shown to the customer")
    .fill("What date would you like to arrive?");
  await page
    .getByRole("searchbox", { name: "Search questions" })
    .fill("detail43");
  await expect(page.getByLabel("Question shown to the customer")).toHaveValue(
    "Question 43",
  );
  await page
    .getByRole("searchbox", { name: "Search questions" })
    .fill("checkIn");
  await expect(page.getByLabel("Question shown to the customer")).toHaveValue(
    "What date would you like to arrive?",
  );
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("questions.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Playbook name").fill("Hospitality guest guide");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("navigation", { name: "Playbook selection" })
    .getByRole("button", { name: /Proposal request/ })
    .click();
  await expect(page.getByLabel("Playbook name")).toHaveValue(
    "Hospitality guest guide",
  );
  await page.getByText("Developer tools", { exact: true }).click();
  await page
    .getByRole("button", { name: "Developer JSON", exact: true })
    .click();
  const jsonText = await page
    .getByLabel("Playbook developer JSON")
    .inputValue();
  await page.getByLabel("Playbook developer JSON").fill("{");
  await page.getByRole("button", { name: "Questions", exact: true }).click();
  await expect(page.getByLabel("Playbook developer JSON")).toBeVisible();
  await page.getByLabel("Playbook developer JSON").fill(jsonText);
  await page.getByRole("button", { name: "Questions", exact: true }).click();
  await expect(page.getByLabel("Question shown to the customer")).toHaveValue(
    "What date would you like to arrive?",
  );
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect.poll(() => saves).toBe(1);
  await expect(
    page.getByRole("heading", { name: "Hospitality guest guide", exact: true }),
  ).toBeVisible();
  allowValidation = false;
  await page
    .getByLabel("Question shown to the customer")
    .fill("Updated question");
  await expect(
    page.getByText("A required connection is missing."),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Needs attention");
  await expect(page.getByRole("button", { name: "Publish changes", exact: true })).toBeDisabled();
  expect(publishes).toBe(0);
  expect(saves).toBe(1);
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await expect(
    page.getByText(
      "Channel rules take effect immediately. They are not part of the saved draft.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Enable all channels booking_request" }),
  ).toBeChecked();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("channels-dark.png"),
    fullPage: true,
  });
  expect(audit.blockedMutations).toEqual([]);
  expect(
    audit.consoleErrors.filter(
      (error) => !error.includes("Failed to fetch") && !error.includes("404"),
    ),
  ).toEqual([]);
});
