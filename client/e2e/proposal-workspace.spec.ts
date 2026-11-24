import type { Page, Route } from "@playwright/test";
import {
  test,
  expect,
  installAppShellMocks,
  expectNoHorizontalOverflow,
} from "./fixtures/app";

const templates = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  userId: null,
  name: `Proposal template ${i + 1}`,
  description: "Approved reusable scope",
  category: "Implementation",
  templateType: "document",
  published: true,
  version: 1,
  includeKnowledgeBase: true,
  includeBusinessProfile: true,
  sourceFileName: null,
  coverNote: "Prepared for {{client_name}}.",
  termsAndConditions: "Payment is due within 14 days.",
  lineItems: [],
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  templateContent: {
    sections: [
      {
        title: "Scope",
        body: "Confirmed deliverables for the customer.",
        kind: "content",
      },
    ],
    requiredFields: [],
    placeholders: [],
    warnings: [],
  },
}));

async function json(route: Route, data: unknown) {
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ success: true, data }),
  });
}

function draftRecord(id: number, body: Record<string, unknown>, revision: number) {
  return {
    id,
    proposalNumber: `P-${id}`,
    status: "draft",
    revision,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...body,
  };
}

async function mockDraftPersistence(page: Page, id: number) {
  let created: Record<string, unknown> | undefined;
  let updated: Record<string, unknown> | undefined;
  await page.route("**/api/proposals", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    created = route.request().postDataJSON();
    await json(route, draftRecord(id, created!, 1));
  });
  await page.route(`**/api/proposals/${id}`, async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    updated = route.request().postDataJSON();
    await json(route, draftRecord(id, { ...created, ...updated }, 2));
  });
  return {
    created: () => created,
    updated: () => updated,
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await installAppShellMocks(page);
  await page.route("**/api/proposals/templates/favorites", (route) =>
    json(route, []),
  );
  await page.route("**/api/proposals/templates", (route) =>
    json(route, templates),
  );
  await page.route("**/api/proposals/sources*", (route) =>
    json(route, {
      contacts: [
        { id: 1, name: "Customer", email: "customer@example.test" },
      ],
      conversations: [],
      tickets: [],
    }),
  );
  await page.route("**/api/proposals/catalog", (route) => json(route, []));
  await page.route("**/api/proposals/brand", (route) =>
    json(route, { companyName: "Regression Workspace" }),
  );
  await page.route("**/api/proposals/onboarding-resources", (route) =>
    json(route, { teams: [], members: [] }),
  );
});

test("shows the daily sales columns and sends exact work filters", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/api/proposals?*", async (route) => {
    requests.push(route.request().url());
    await json(route, {
      proposals: [
        {
          id: 601,
          proposalNumber: "P-601",
          title: "Implementation offer",
          recipientName: "Customer",
          recipientEmail: "customer@example.test",
          status: "draft",
          currency: "USD",
          total: "900",
          validUntil: "2026-12-31T23:59:59.999Z",
          sentAt: null,
          createdAt: "2026-09-01T00:00:00Z",
          updatedAt: "2026-09-14T00:00:00Z",
          lastActivityAt: "2026-09-15T00:00:00Z",
          owner: { id: 7, name: "Account Owner", email: "owner@example.test" },
          metadata: { teamApproval: { status: "pending" } },
        },
      ],
      total: 1,
      totalPages: 1,
    });
  });
  await page.route("**/api/proposals/analytics", (route) =>
    json(route, {
      total: 1,
      draft: 1,
      sent: 0,
      viewed: 0,
      accepted: 0,
      rejected: 0,
      expired: 0,
      delivery_unknown: 0,
      acceptanceRate: 0,
      funnel: { created: 1, delivered: 0, viewed: 0, decided: 0, accepted: 0 },
    }),
  );

  await page.goto("/dashboard/proposals");
  await expect(page.getByRole("columnheader", { name: "Owner" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Last activity" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Next action" })).toBeVisible();
  await expect(page.getByText("Account Owner", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByLabel("Attention filter").click();
  await page.getByRole("option", { name: "Needs approval", exact: true }).click();
  await expect.poll(() => requests.some((url) => new URL(url).searchParams.get("attention") === "needs_approval")).toBe(true);
});

test("selects a published template and preserves it in the saved draft", async ({
  page,
}) => {
  const persisted = await mockDraftPersistence(page, 501);

  await page.goto("/dashboard/proposals/templates");
  await expect(
    page.getByRole("heading", { name: "Proposal templates", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use template", exact: true }),
  ).toHaveCount(10);
  await expectNoHorizontalOverflow(page);

  await page
    .getByRole("button", { name: "Use template", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/templateId=1/);
  await page
    .getByPlaceholder("Website launch for Acme")
    .fill("Customer implementation");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();

  await expect.poll(() => persisted.created()?.templateId).toBe(1);
  expect(persisted.created()?.approvalRequired).toBe(true);
  expect(persisted.created()?.generatedSections).toMatchObject([
    { title: "Scope", body: "Confirmed deliverables for the customer." },
  ]);
});

test("admin edits a published template and persists customer copy", async ({
  page,
}) => {
  let saved: Record<string, unknown> | undefined;
  await page.route("**/api/admin/me", (route) =>
    route.fulfill({
      json: {
        admin: {
          id: 1,
          name: "Admin",
          email: "admin@example.test",
          role: "super_admin",
        },
      },
    }),
  );
  await page.route("**/api/admin/notifications*", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/admin/proposal-templates", (route) =>
    route.fulfill({ json: templates }),
  );
  await page.route("**/api/admin/proposal-templates/1", async (route) => {
    saved = route.request().postDataJSON();
    await route.fulfill({ json: { ...templates[0], ...saved, version: 2 } });
  });

  await page.goto("/admin/dashboard/proposal-templates");
  await expect(
    page.getByRole("heading", { name: "Standard proposal library" }),
  ).toBeVisible();
  await expect(page.getByText("published slots", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Edit template", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Customer copy", { exact: true })
    .fill("Updated deliverables and acceptance criteria.");
  await page
    .getByRole("button", { name: "Save and publish", exact: true })
    .click();

  await expect.poll(() => saved?.templateContent).toMatchObject({
    sections: [{ body: "Updated deliverables and acceptance criteria." }],
  });
  expect(saved?.published).toBe(true);
  await expectNoHorizontalOverflow(page);
});

test("reviews an exact delivery, approves it, sends it once, and creates a revision", async ({
  page,
}) => {
  const proposal = {
    id: 501,
    revision: 4,
    proposalNumber: "P-501",
    title: "Customer implementation",
    status: "draft",
    recipientName: "Customer",
    recipientEmail: "customer@example.test",
    leadId: 77,
    outreachConversationId: 88,
    coverNote: "Implementation scope",
    currency: "USD",
    subtotal: "900",
    discount: "0",
    total: "900",
    discountType: null,
    discountValue: "0",
    taxRate: "0",
    tax: "0",
    signatureRequired: false,
    showTermsAndConditions: true,
    termsAndConditions: "Net 14.",
    validUntil: "2026-12-31T23:59:59.999Z",
    lineItems: [
      {
        name: "Implementation",
        quantity: 1,
        unitPrice: 900,
        unit: "project",
        priceConfirmed: true,
      },
    ],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    sentAt: null,
    viewedAt: null,
    acceptedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    metadata: {
      approvalRequired: true,
      generatedSections: [
        { title: "Scope", body: "Original scope", kind: "content" },
      ],
    },
  };
  let approval: Record<string, unknown> | undefined;
  let delivery: Record<string, unknown> | undefined;
  let revisionRequest: Record<string, unknown> | undefined;
  let followupPreview: Record<string, unknown> | undefined;
  await page.route("**/api/proposals/501", (route) => json(route, proposal));
  await page.route("**/api/proposals/501/comments", (route) => json(route, []));
  for (const suffix of [
    "timeline",
    "versions",
    "feedback",
    "reminders",
    "approvals",
  ]) {
    await page.route(`**/api/proposals/501/${suffix}`, (route) =>
      json(route, []),
    );
  }
  await page.route("**/api/proposals/501/prepare-delivery", (route) =>
    json(route, {
      target: {
        channel: "email",
        outreachConversationId: 88,
        leadId: 77,
        recipient: "customer@example.test",
        recipientName: "Customer",
        recipientEmail: "customer@example.test",
        providerAccountId: "gmail-account-1",
        providerVariant: "gmail",
        senderEmail: "sales@example.test",
        subject: "Proposal: Customer implementation",
        message: "Please review Customer implementation (P-501).",
      },
      targetFingerprint: "target-fingerprint",
      reviewFingerprint: "review-fingerprint",
      ready: true,
      issues: [],
      proposal,
    }),
  );
  await page.route("**/api/proposals/501/approve", async (route) => {
    approval = route.request().postDataJSON();
    await json(route, {
      revision: 4,
      approved: true,
      requirement: { reasons: [] },
    });
  });
  await page.route("**/api/proposals/501/followups/preview", async (route) => {
    followupPreview = route.request().postDataJSON();
    const request = followupPreview as { timezone: string; steps: Array<{ subject: string }> };
    await json(route, {
      timezone: request.timezone,
      scheduled: request.steps.map((step, index) => ({
        reminderDueAt: index ? "2026-09-22T10:00:00.000Z" : "2026-09-18T04:30:00.000Z",
        metadata: {
          timezone: request.timezone,
          localDate: index ? "2026-09-22" : "2026-09-18",
          localTime: index ? "15:30" : "10:00",
          subject: step.subject,
          message: "Preview only",
        },
      })),
    });
  });
  await page.route("**/api/proposals/501/send", async (route) => {
    delivery = route.request().postDataJSON();
    proposal.status = "sent";
    await json(route, {
      publicUrl: "https://proposal.example.test/public-token",
      delivery: {
        state: "sent",
        channel: "email",
        messageId: "provider-message-1",
      },
    });
  });
  await page.route("**/api/proposals/501/revise", (route) => {
    revisionRequest = route.request().postDataJSON();
    return json(route, { id: 502 });
  });

  await page.goto("/dashboard/proposals/501?send=1&channel=email");
  await expect(
    page.getByRole("heading", { name: "Delivery review", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Prepare delivery review", exact: true })
    .click();
  await expect(page.getByText("Resolved delivery", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Approve this exact version", exact: true })
    .click();
  await expect.poll(() => approval).toMatchObject({
    expectedRevision: 4,
    expectedTargetFingerprint: "target-fingerprint",
    expectedReviewFingerprint: "review-fingerprint",
  });
  await page
    .getByRole("button", { name: "Send approved proposal", exact: true })
    .click();
  await expect(page.getByText("Delivery sent", { exact: true })).toBeVisible();
  expect(delivery?.expectedRevision).toBe(4);
  expect(typeof delivery?.idempotencyKey).toBe("string");
  await expect(page.getByRole("heading", { name: "Customer follow-ups", exact: true })).toBeVisible();
  await page.getByLabel("Customer timezone", { exact: true }).fill("Asia/Kolkata");
  await page.getByRole("button", { name: "Preview schedule", exact: true }).click();
  await expect.poll(() => followupPreview).toMatchObject({ timezone: "Asia/Kolkata" });
  await expect(page.getByRole("heading", { name: "Schedule preview", exact: true })).toBeVisible();
  await expect(page.getByText("2026-09-18 at 10:00 · Asia/Kolkata", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page
    .getByRole("button", { name: "Create revision", exact: true })
    .click();
  await expect.poll(() => revisionRequest).toMatchObject({ expectedRevision: 4 });
});

test("AI suggestions preserve linked recipient, template, and entered pricing", async ({
  page,
}) => {
  const persisted = await mockDraftPersistence(page, 503);
  let generated: Record<string, unknown> | undefined;
  await page.route("**/api/proposals/resolve-source?*", (route) =>
    json(route, {
      refs: { contactId: 1, leadId: 77 },
      recipientName: "Customer",
      recipientEmail: "customer@example.test",
    }),
  );
  await page.route("**/api/proposals/suggest", async (route) => {
    generated = route.request().postDataJSON();
    await json(route, {
      coverNote: "AI-tailored introduction",
      generatedSections: [
        { title: "Scope", body: "AI-confirmed customer scope", kind: "content" },
      ],
      lineItems: [
        { name: "Unsafe replacement", quantity: 1, unitPrice: 1 },
      ],
      metadata: {
        sources: [{ kind: "contact", id: 1, label: "Customer" }],
      },
    });
  });

  await page.goto("/dashboard/proposals/new?templateId=3");
  await page
    .getByPlaceholder("Website launch for Acme")
    .fill("AI customer implementation");
  await page
    .getByLabel("Proposal source", { exact: true })
    .selectOption("contactId:1");
  await expect(page.getByRole("textbox", { name: /Customer email/ })).toHaveValue(
    "customer@example.test",
  );

  await page
    .getByRole("navigation", { name: "Proposal creation steps" })
    .getByRole("button", { name: /Scope and pricing/ })
    .click();
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page.getByLabel("Item 1 name", { exact: true }).fill("Implementation");
  await page.getByLabel("Item 1 unit price", { exact: true }).fill("900");
  await page
    .getByRole("navigation", { name: "Proposal creation steps" })
    .getByRole("button", { name: /Customer/ })
    .click();
  await page
    .getByRole("button", { name: "Generate for review", exact: true })
    .click();

  await expect(
    page.getByRole("heading", { name: "Review AI suggestions" }),
  ).toBeVisible();
  await expect.poll(() => generated).toMatchObject({
    templateId: 3,
    contactId: 1,
    leadId: 77,
    recipientEmail: "customer@example.test",
    approvalRequired: true,
    lineItems: [{ name: "Implementation", unitPrice: 900 }],
  });
  await page
    .getByRole("button", { name: "Apply suggestions", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Proposal creation steps" })
    .getByRole("button", { name: /Scope and pricing/ })
    .click();
  await expect(page.getByLabel("Item 1 name", { exact: true })).toHaveValue(
    "Implementation",
  );
  await expect(page.getByLabel("Item 1 unit price", { exact: true })).toHaveValue(
    "900",
  );
  await expect(
    page.getByRole("textbox", {
      name: "Cover note and introduction",
      exact: true,
    }),
  ).toHaveValue("AI-tailored introduction");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect.poll(() => persisted.updated()?.lineItems).toMatchObject([
    { name: "Implementation", unitPrice: 900 },
  ]);
});

test("customizing a shared template creates a private copy", async ({ page }) => {
  let saved: Record<string, unknown> | undefined;
  await page.route("**/api/proposals/templates", async (route) => {
    if (route.request().method() === "POST") {
      saved = route.request().postDataJSON();
      return json(route, { ...saved, id: 50, userId: 4101 });
    }
    return json(route, templates);
  });

  await page.goto("/dashboard/proposals/templates");
  await page
    .getByRole("button", { name: "Customize copy", exact: true })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Customer-specific scope");
  await page
    .getByLabel("Customer copy", { exact: true })
    .fill("Private customer deliverables");
  await page
    .getByRole("button", { name: "Save template", exact: true })
    .click();

  await expect.poll(() => saved?.name).toBe("Customer-specific scope");
  expect(saved?.templateContent).toMatchObject({
    sections: [{ body: "Private customer deliverables" }],
  });
  expect(saved?.id).toBeUndefined();
});

test("approved catalog pricing is included in a manually saved proposal", async ({
  page,
}) => {
  const persisted = await mockDraftPersistence(page, 504);
  await page.route("**/api/proposals/catalog", (route) =>
    json(route, [
      {
        id: 21,
        name: "Implementation package",
        description: "Approved scope",
        unitPrice: "450",
        currency: "USD",
        active: true,
        unit: "package",
      },
    ]),
  );

  await page.goto("/dashboard/proposals/new");
  await page
    .getByPlaceholder("Website launch for Acme")
    .fill("Catalog proposal");
  await page.getByLabel("Customer name", { exact: true }).fill("Customer");
  await page.getByLabel(/^Customer email/).fill("customer@example.test");
  await page
    .getByRole("navigation", { name: "Proposal creation steps" })
    .getByRole("button", { name: /Scope and pricing/ })
    .click();
  await page
    .getByLabel("Add approved catalog item", { exact: true })
    .selectOption("21");
  await page.getByLabel("Cover note and introduction", { exact: true }).fill("Confirmed implementation scope.");
  await page.getByLabel("Terms and conditions", { exact: true }).fill("Payment is due in 14 days.");
  await expect(page.getByLabel("Item 1 name", { exact: true })).toHaveValue(
    "Implementation package",
  );
  await page
    .getByRole("navigation", { name: "Proposal creation steps" })
    .getByRole("button", { name: /Review/ })
    .click();
  await expect(page.getByRole("heading", { name: "Confirm before sending" })).toBeVisible();
  await expect(page.getByText(/Confirm these proposal requirements: objectives, deliverables, timeline, responsibilities, budget/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();

  await expect.poll(() => persisted.created()?.lineItems).toMatchObject([
    {
      catalogId: 21,
      name: "Implementation package",
      unitPrice: 450,
      quantity: 1,
      priceConfirmed: true,
    },
  ]);
});

test("keeps every public customer response control at least 44 pixels", async ({
  page,
}) => {
  await page.route("**/api/proposals/public/customer-token/feedback", (route) =>
    json(route, { proposalId: 701, feedback: [] }),
  );
  await page.route("**/api/proposals/public/customer-token", (route) =>
    json(route, {
      id: 701,
      proposalNumber: "P-701",
      title: "Customer growth program",
      status: "viewed",
      revision: 2,
      recipientName: "Customer",
      recipientEmail: "customer@example.test",
      coverNote: "A focused implementation plan.",
      currency: "USD",
      discountType: null,
      discountValue: 0,
      taxRate: 0,
      signatureRequired: false,
      showTermsAndConditions: true,
      termsAndConditions: "Net 14.",
      validUntil: "2026-12-31T23:59:59.999Z",
      lineItems: [
        {
          id: 1,
          name: "Implementation",
          description: "Approved scope",
          quantity: 1,
          unitPrice: 900,
          unit: "project",
          billingType: "one_time",
          priceConfirmed: true,
        },
      ],
      metadata: {
        generatedSections: [
          { title: "Scope", body: "Confirmed deliverables.", kind: "content" },
        ],
      },
      brand: {
        companyName: "Regression Workspace",
        logoUrl: null,
        primaryColor: "#2563eb",
      },
    }),
  );

  await page.goto("/proposal/customer-token", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Your decision", { exact: true })).toBeVisible();

  for (const name of [
    "Download PDF",
    "Accept proposal",
    "Decline proposal",
    "Ask a question",
    "Request changes",
    "Send to proposal owner",
  ]) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    const bounds = await button.boundingBox();
    expect(bounds, `${name} should have measurable bounds`).not.toBeNull();
    expect(bounds!.height, `${name} height`).toBeGreaterThanOrEqual(44);
    expect(bounds!.width, `${name} width`).toBeGreaterThanOrEqual(44);
  }

  await page.getByRole("button", { name: "Request changes", exact: true }).click();
  await expect(page.getByLabel("Changes you need", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
