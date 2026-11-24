import { test, expect, expectNoHorizontalOverflow } from "./fixtures/app";
import type { Page, Route } from "@playwright/test";
import { captureMSG91Page } from './fixtures/msg91-screenshots';

async function mockComposer(page: Page, dark = false) {
  const batches: Record<string, unknown>[] = [];
  const json = (route: Route, body: unknown) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/settings/outreach/email-designs') return json(route, { canManage: false, preferences: { outreach: 'classic', assistant: 'classic', revision: 'initial' }, brand: { companyName: 'Orchid Labs', logoUrl: null, primaryColor: '#2563eb' } });
    const channel = url.searchParams.get("channel") || "email";
    if (/csrf/.test(path))
      return json(route, { csrfToken: "composer-test-csrf" });
    if (/^\/api\/settings\/integrations\/\w+\/follow-ups$/.test(path))
      return json(route, { enableAutoFollowUp: true, followUpSteps: [{ id: 1, delayValue: 1, delayUnit: 'days', templateId: 77, templateName: 'Friendly check-in' }] });
    if (path === "/api/settings/business-profiles")
      return json(route, [{ id: 11, name: "Orchid Labs", isDefault: true }]);
    if (path === "/api/settings/preferences")
      return json(route, {
        theme: dark ? "dark" : "light",
        language: "en",
        timezone: "UTC",
      });
    if (path.endsWith("/compose/options"))
      return json(route, {
        channel,
        accounts: [
          {
            id: "account-1",
            label: channel === "email" ? "sales@orchid.example" : channel === "sms" ? "MSG91 - ORCHID" : "Orchid Labs",
            senderId: channel === "email" ? 7 : undefined,
            providerAccountId: channel === "sms" ? "ORCHID" : "account-1",
            isDefault: true,
            ready: true,
            reason: null,
          },
        ],
      });
    if (path.endsWith("/compose/recipients")) {
      const recipients = [
        {
          id: 1,
          name: "Ada Lovelace",
          firstName: "Ada",
          lastName: "Lovelace",
          company: "Analytical Engines",
          email: "ada@example.test",
          phone: "919876543210",
          recipient:
            channel === "email"
              ? "ada@example.test"
              : channel === "whatsapp" || channel === "sms"
                ? "919876543210"
                : "12345678",
          eligible: true,
          reason: null,
          requiresTemplate: channel === "whatsapp",
        },
        {
          id: 2,
          name: "Grace Hopper",
          firstName: "Grace",
          lastName: "Hopper",
          company: "",
          email: "",
          phone: "",
          recipient: "",
          eligible: false,
          reason:
            channel === "email"
              ? "Add a valid email address to this contact."
              : "This contact has not messaged this account.",
        },
      ];
      const ids = url.searchParams.get("ids")?.split(",").map(Number);
      return json(route, {
        recipients: ids
          ? recipients.filter((item) => ids.includes(item.id))
          : recipients,
        nextCursor: null,
      });
    }
    if (path.endsWith("/compose/templates"))
      return json(route, {
        templates: [
          {
            id: "welcome-en",
            name: "welcome",
            language: "en_US",
            body: "Hello {{1}}, your proposal is ready.",
            headerType: "TEXT",
            header: "For {{1}}",
          },
          {
            id: "welcome-es",
            name: "welcome",
            language: "es",
            body: "Hola {{1}}, tu propuesta está lista.",
          },
        ],
      });
    if (path === "/api/outreach/attachments")
      return json(route, {
        attachments: [
          {
            id: "a0000000-0000-4000-8000-000000000001",
            fileName: "proposal.txt",
            size: 15,
          },
        ],
      });
    if (path === "/api/outreach-conversations/compose/contact")
      return json(route, { leadId: 1 });
    if (path === "/api/outreach-conversations/bulk") {
      batches.push(request.postDataJSON());
      return json(route, {
        success: true,
        total: 1,
        queued: 1,
        errors: 0,
        results: [
          { leadId: 1, messageId: 11, conversationId: 9, status: "queued" },
        ],
      });
    }
    if (path === "/api/outreach-conversations/inbox")
      return json(route, {
        items: [],
        nextCursor: null,
        unreadThreads: {
          all: 0,
          email: 0,
          whatsapp: 0,
          instagram: 0,
          facebook: 0,
          sms: 0,
        },
      });
    if (path === "/api/outreach-conversations/unread/counts")
      return json(route, { email: 0, whatsapp: 0, instagram: 0, facebook: 0, sms: 0 });
    if (path === "/api/content/assets" || path.includes("/content/templates"))
      return json(route, []);
    if (
      /\/api\/(auth\/me|platform\/access|wallet|chat\/threads|notifications\/unread\/count)$/.test(
        path,
      )
    )
      return route.fallback();
    return json(route, {});
  });
  return batches;
}

test("SMS outreach reviews personalized text before queuing through the MSG91 sender", async ({ page, audit }, testInfo) => {
  const batches = await mockComposer(page);
  await page.goto("/dashboard/outreach/create?channel=sms&leadId=1");
  await expect(page.getByLabel("Select Ada Lovelace")).toBeChecked();
  await expect(page.getByLabel("Send from", { exact: true })).toContainText("MSG91 - ORCHID");
  await page.getByRole('heading', { name: 'New outreach', exact: true }).scrollIntoViewIfNeeded();
  await captureMSG91Page(page, testInfo, 'msg91-outreach-compose-top');
  await page.getByLabel("Message body").fill("Hello {{first_name}}, welcome to {{company}}.");
  await expect(page.getByLabel("Subject", { exact: true })).toHaveCount(0);
  await expect(page.locator("input[type=file]")).toHaveCount(0);
  await captureMSG91Page(page, testInfo, 'msg91-outreach-compose');
  await page.getByRole("button", { name: "Review outreach", exact: true }).click();
  await expect(page.getByText("Hello Ada, welcome to Analytical Engines.", { exact: true })).toBeVisible();
  expect(batches).toEqual([]);
  await expectNoHorizontalOverflow(page);
  await page.getByRole('heading', { name: 'Review outreach', exact: true }).scrollIntoViewIfNeeded();
  await captureMSG91Page(page, testInfo, 'msg91-outreach-review');
  await page.getByLabel('Personalized SMS length').scrollIntoViewIfNeeded();
  await captureMSG91Page(page, testInfo, 'msg91-outreach-personalized-preview');
  await page.getByRole("button", { name: "Send to 1 recipient", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Outreach queued", exact: true }).first()).toBeVisible();
  await captureMSG91Page(page, testInfo, 'msg91-outreach-queued');
  expect(batches).toHaveLength(1);
  expect(batches[0]).toMatchObject({
    channel: "sms", providerAccountId: "ORCHID",
    confirmation: { confirmed: true, channel: "sms", recipientCount: 1 },
    messages: [{ leadId: 1, message: "Hello Ada, welcome to Analytical Engines.", followUps: [] }],
  });
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

test("legacy creation links preserve the channel and selected contact in one dashboard composer", async ({
  page,
  audit,
}) => {
  await mockComposer(page);
  for (const channel of ["email", "whatsapp", "instagram", "facebook", "sms"]) {
    await page.goto(
      `/dashboard/outreach/${channel}/create?leadId=1&message=Hello`,
      { waitUntil: 'domcontentloaded' },
    );
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/outreach/create\\?.*channel=${channel}`),
    );
    await expect(
      page.getByRole("heading", { name: "New outreach", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Select Ada Lovelace")).toBeChecked();
    const labels = ["Email", "WhatsApp", "Instagram", "Messenger", "SMS"];
    const bounds = await Promise.all(
      labels.map((label) =>
        page
          .getByLabel("Outreach channel")
          .getByRole("button", { name: label, exact: true })
          .boundingBox(),
      ),
    );
    expect(new Set(bounds.map((box) => Math.round(box!.y))).size).toBe(1);
    await expectNoHorizontalOverflow(page);
  }
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

test("Inbox starts new outreach using the selected channel", async ({
  page,
  audit,
}) => {
  await mockComposer(page);
  await page.goto("/dashboard/outreach");
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "WhatsApp", exact: true }).click();
  const create = page
    .getByTestId("outreach-inbox")
    .getByRole("link", { name: "New outreach" });
  await expect(create).toHaveAttribute(
    "href",
    "/dashboard/outreach/create?channel=whatsapp",
  );
  await create.click();
  await expect(
    page.getByRole("heading", { name: "New outreach", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByLabel("Outreach channel")
      .getByRole("button", { name: "WhatsApp", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: test.info().outputPath('inbox-to-whatsapp-compose.png'),
    fullPage: true,
  });
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

test("email review includes attachments and schedule without follow-up configuration", async ({
  page,
  audit,
}) => {
  const batches = await mockComposer(page);
  await page.goto("/dashboard/outreach/create?channel=email&leadId=1");
  await expect(page.getByLabel("Select Ada Lovelace")).toBeChecked();
  await page
    .getByLabel("Subject", { exact: true })
    .fill("Hello {{first_name}}");
  await page
    .getByLabel("Message body")
    .fill("Welcome to {{company}}, {{first_name}}.");
  await page.locator("input[type=file]").setInputFiles({
    name: "proposal.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Proposal details"),
  });
  await expect(page.getByText("proposal.txt", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  const planned = new Date(Date.now() + 48 * 60 * 60_000);
  const local = new Date(
    planned.getTime() - planned.getTimezoneOffset() * 60_000,
  )
    .toISOString()
    .slice(0, 16);
  await page.getByLabel("Send date and time").fill(local);
  await expect(page.getByText('Timing & follow-ups', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Saved platform follow-ups' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add follow-up', exact: true })).toHaveCount(0);
  await page.getByLabel("Select Grace Hopper").check();
  await page
    .getByRole("button", { name: "Review outreach", exact: true })
    .click();
  await expect(page.getByText("These contacts will be excluded")).toBeVisible();
  await expect(
    page.getByText("Welcome to Analytical Engines, Ada."),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Saved platform follow-ups' })).toHaveCount(0);
  await expect(page.locator('.outreach-composer').getByText('Follow-ups', { exact: true })).toHaveCount(0);
  expect(batches).toHaveLength(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: test.info().outputPath('email-scheduled-review.png'),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Schedule to 1 recipient" }).click();
  await expect(
    page.getByRole("link", { name: "Open conversation" }),
  ).toHaveAttribute("href", "/dashboard/outreach/inbox?thread=conversation:9");
  expect(batches).toHaveLength(1);
  expect(batches[0]).toMatchObject({
    creationVersion: 1,
    followUpSource: 'outreach',
    channel: "email",
    providerAccountId: "account-1",
    scheduledAt: expect.any(String),
    attachments: ["a0000000-0000-4000-8000-000000000001"],
    messages: [
      {
        leadId: 1,
        senderId: 7,
        subject: "Hello Ada",
        message: "Welcome to Analytical Engines, Ada.",
        followUps: [],
      },
    ],
  });
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});

test("WhatsApp templates and social messages keep their selected account and recipient mapping in dark theme", async ({
  page,
  audit,
}) => {
  const batches = await mockComposer(page, true);
  await page.goto("/dashboard/outreach/create?channel=whatsapp&contactId=8");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole('button', { name: /Choose a template/ }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('button', { name: /welcome.*en_US/ }).click();
  await drawer.getByLabel("Header variable 1").fill("{{first_name}}");
  await drawer.getByLabel("Body variable 1").fill("{{first_name}}");
  await drawer.getByRole('button', { name: 'Use template', exact: true }).click();
  await page
    .getByText(
      "These recipients have agreed to receive WhatsApp messages from this business.",
    )
    .click();
  await page
    .getByRole("button", { name: "Review outreach", exact: true })
    .click();
  await expect(
    page.getByText("For Ada\n\nHello Ada, your proposal is ready.", {
      exact: true,
    }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: test.info().outputPath('whatsapp-template-review-dark.png'),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Send to 1 recipient" }).click();
  await expect(
    page.getByRole("link", { name: "Open conversation" }),
  ).toBeVisible();
  expect(batches[0]).toMatchObject({
    channel: "whatsapp",
    whatsappOptInConfirmed: true,
    providerAccountId: "account-1",
    messages: [
      {
        leadId: 1,
        expectedRecipient: "919876543210",
        templateName: "welcome",
        templateLanguage: "en_US",
        templateComponents: [
          { type: "header", parameters: [{ type: "text", text: "Ada" }] },
          { type: "body", parameters: [{ type: "text", text: "Ada" }] },
        ],
      },
    ],
  });
  for (const channel of ["instagram", "facebook"]) {
    await page.goto(
      `/dashboard/outreach/create?channel=${channel}&contactId=8`,
    );
    await expect(page.getByLabel("Select Ada Lovelace")).toBeChecked();
    await page.getByLabel("Message body").fill("Hello {{first_name}}");
    await page
      .getByRole("button", { name: "Review outreach", exact: true })
      .click();
    await page.getByRole("button", { name: "Send to 1 recipient" }).click();
    await expect(
      page.getByRole("link", { name: "Open conversation" }),
    ).toBeVisible();
    expect(batches.at(-1)).toMatchObject({
      channel,
      providerAccountId: "account-1",
      messages: [
        { leadId: 1, message: "Hello Ada", expectedRecipient: "12345678" },
      ],
    });
  }
  expect(audit.blockedMutations).toEqual([]);
  expect(audit.consoleErrors).toEqual([]);
});


test('uncertain bulk receipt keeps its conversation link and excludes automatic resend', async ({page,audit}) => {
  await mockComposer(page);
  await page.route('**/api/outreach-conversations/bulk',route=>route.fulfill({json:{success:true,total:1,queued:0,errors:0,uncertain:1,
    results:[{leadId:1,messageId:11,conversationId:9,status:'uncertain',error:'Queue confirmation needs review. This saved message may still send.'}]}}));
  await page.goto('/dashboard/outreach/create?channel=email&leadId=1');
  await page.getByLabel('Subject',{exact:true}).fill('Synthetic reviewed message');
  await page.getByLabel('Message body').fill('Synthetic reviewed body.');
  await page.getByRole('button',{name:'Review outreach',exact:true}).click();
  await page.getByRole('button',{name:'Send to 1 recipient',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Queue confirmation needs review',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Open conversation'})).toHaveAttribute('href','/dashboard/outreach/inbox?thread=conversation:9');
  await expect(page.getByRole('button',{name:'Review failed recipients'})).toHaveCount(0);
  await expect(page.getByText('No messages were queued',{exact:true})).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  expect(audit.blockedMutations).toEqual([]);expect(audit.consoleErrors).toEqual([]);
});
