import { test, expect, expectNoHorizontalOverflow } from "./fixtures/app";
import type { Page, Route } from "@playwright/test";
import { INBOX_CHANNELS, INBOX_ORIGIN_FILTERS, type InboxItem, type InboxChannel } from "../../shared/outreachInbox";

if (process.env.EMAIL_PROVIDER_CHROMIUM_PATH) {
  test.use({ launchOptions: { executablePath: process.env.EMAIL_PROVIDER_CHROMIUM_PATH }, video: 'off', serviceWorkers: 'block' });
}

const channels: InboxChannel[] = [
  "email",
  "whatsapp",
  "instagram",
  "facebook",
  // Repeat supported channels so pagination still covers multiple threads.
  "email",
  "whatsapp",
  "sms",
];
const labels = [
  "Email",
  "WhatsApp",
  "Instagram",
  "Messenger",
  "SMS",
];
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(
    browserErrors.get(page),
    "The Inbox must render without uncaught errors",
  ).toEqual([]);
});
const makeItem = (channel: InboxChannel, id: number): InboxItem => ({
  key: `conversation:${id}`,
  kind: "conversation",
  id,
  channel,
  leadId: 100 + id,
  leadName:
    [
      "Asha Raman",
      "Ben Carter",
      "Carla Diaz",
      "Dev Shah",
      "Eva Chen",
      "Farah Ali",
      "George Hill",
    ][id - 1] || "Historical contact",
  leadEmail: `contact${id}@example.test`,
  leadPhone: "919999999999",
  leadCompany: "Orchid Labs",
  leadAvatar: null,
  recipient: channel === "email" ? "asha@example.test" : channel === "sms" ? "919999999999" : `recipient-${id}`,
  subject: channel === "email" ? "September proposal" : null,
  preview: `Latest ${channel} reply`,
  activityAt: `2026-09-${String(26 - id).padStart(2, "0")}T10:00:00.000Z`,
  unreadCount: id < 3 ? 2 : 0,
  totalMessages: 1,
  status: "active",
  integrationProvider: channel === "email" ? "gmail" : channel === "sms" ? "msg91" : null,
  origin: id === 2 ? "outreach" : "customer",
  aiHandled: id === 2,
  reply: {
    canReply: true,
    reason: null,
    accountLabel:
      channel === "email" ? "sales@orchid.test" : `Orchid ${channel}`,
    providerAccountId: `original-${id}`,
  },
});

async function installInbox(page: Page) {
  const items = channels.map((channel, index) => makeItem(channel, index + 1));
  items.push({
    ...makeItem("email", 20),
    key: "legacy:20",
    kind: "legacy",
    unreadCount: 0,
    preview: "Older campaign outreach",
    origin: "outreach",
    reply: {
      canReply: false,
      reason:
        "Historical send · read only. The original account cannot be verified.",
      accountLabel: null,
      providerAccountId: null,
    },
  });
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const searches: string[] = [];
  const state = {
    theme: 'light' as 'light' | 'dark',
    failSend: false,
    sendGate: null as Promise<void> | null,
    failList: false,
    failMessages: false,
    detailDelay: 0,
    listCalls: 0,
    inProgress: false,
  };
  const history = new Map<number, Array<Record<string, unknown>>>(
    items.map((item) => [
      item.id,
      [
        {
          id: item.id * 100,
          conversationId: item.id,
          userId: 4101,
          direction: "inbound",
          content: `History for ${item.leadName}`,
          status: "delivered",
          isRead: false,
          createdAt: item.activityAt,
          sentAt: item.activityAt,
          deliveredAt: null,
          readAt: null,
        },
      ],
    ]),
  );
  await page.addInitScript(() => {
    // Playwright also injects this script into formatted-email srcdoc frames.
    // Those frames must not replace the parent tab's verified account cache.
    if (window.top !== window) return;
    localStorage.setItem(
      "user",
      JSON.stringify({
        id: 4101,
        name: "Regression Alpha",
        email: "regression-alpha@example.test",
      }),
    );
    sessionStorage.setItem("active-business-profile:4101", "11");
    const NativeSocket = window.WebSocket;
    const sockets: Array<{
      onmessage: ((event: MessageEvent) => void) | null;
    }> = [];
    class InboxSocket extends EventTarget {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose = null;
      onerror = null;
      send() {}
      close() {
        this.readyState = 3;
      }
      constructor() {
        super();
        sockets.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }
    }
    class RoutedSocket {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url: string | URL, protocols?: string | string[]) {
        return String(url).includes("_next/")
          ? new NativeSocket(url, protocols)
          : new InboxSocket();
      }
    }
    Object.defineProperty(window, "WebSocket", {
      value: RoutedSocket,
      configurable: true,
    });
    Object.assign(window, {
      emitInboxEvent: (type: string) =>
        sockets.forEach((socket) =>
          socket.onmessage?.(
            new MessageEvent("message", {
              data: JSON.stringify({
                type,
                data: { businessProfileId: 11 },
                businessProfileId: 11,
              }),
            }),
          ),
        ),
    });
  });
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/settings/outreach/email-designs') return json(route, { canManage: false, preferences: { outreach: 'classic', assistant: 'classic', revision: 'initial' }, brand: { companyName: 'Orchid Labs', logoUrl: null, primaryColor: '#2563eb' } });
    if (path === '/api/settings/preferences') {
      if (request.method() === 'PUT') state.theme = request.postDataJSON().theme;
      return json(route, { theme: state.theme, language: 'en', timezone: 'UTC' });
    }
    if (path === "/api/settings/business-profiles")
      return json(route, [{ id: 11, name: "Orchid Labs", isDefault: true }]);
    const activity = path.match(/^\/api\/settings\/outreach\/assistants\/conversations\/(\d+)\/activity$/);
    if (activity) {
      const item = items.find((entry) => entry.id === Number(activity[1]));
      return json(route, { items: [], nextCursor: null, context: {
        assistantId: null, name: null, revision: null,
        channel: item?.channel || "email", accountId: null,
        mode: "manual", sessionStatus: "active", playbook: null, followUp: null,
      } });
    }
    if (/csrf/.test(path)) return json(route, { csrfToken: "inbox-test-csrf" });
    if (path === '/api/content/templates') return json(route, { templates: [{ id: 51, name: 'Inbox saved email', type: 'email', content: 'Saved Asha reply', htmlContent: '<p><b>Saved Asha reply</b></p>', usageCount: 0, isApproved: true }], total: 1 });
    if (path === '/api/content/templates/predefined' || path === '/api/content/assets') return json(route, []);
    if (path === '/api/content/templates/51/use') return json(route, { success: true, templateId: 51, templateVersion: 1, content: 'Saved Asha reply', htmlContent: '<p><b>Saved Asha reply</b></p>' });
    if (path === "/api/outreach/attachments")
      return json(route, {
        attachments: [
          {
            id: "test-attachment",
            fileName: "proposal.pdf",
            originalName: "proposal.pdf",
            mimeType: "application/pdf",
            size: 64,
          },
        ],
      });
    if (path === "/api/outreach-conversations/compose/templates")
      return json(route, {
        templates: [
          {
            id: 1,
            name: "proposal_update",
            language: "en",
            status: "APPROVED",
            headerType: "TEXT",
            header: "For {{1}}",
            body: "Hello {{1}}, your proposal is ready.",
          },
        ],
      });
    if (path === "/api/outreach-conversations/inbox") {
      state.listCalls++;
      if (state.failList)
        return json(route, { error: "Inbox temporarily unavailable" }, 503);
      const channel = url.searchParams.get("channel");
      const origin = url.searchParams.get("origin");
      const query = url.searchParams.get("search") || "";
      searches.push(query);
      let filtered = items.filter(
        (item) =>
          (!channel || channel === "all" || item.channel === channel) &&
          (url.searchParams.get("unread") !== "true" || item.unreadCount > 0) &&
          (!origin || (origin === "ai" ? item.aiHandled : item.origin === origin)) &&
          (!query ||
            [item.leadName, item.preview, item.leadCompany]
              .join(" ")
              .toLowerCase()
              .includes(query.toLowerCase())),
      );
      const totalThreads = Object.fromEntries([...INBOX_CHANNELS, "all"].map(channel => [
        channel, items.filter(item => channel === "all" || item.channel === channel).length,
      ]));
      const channelItems = items.filter(item => !channel || channel === "all" || item.channel === channel);
      const originCounts = Object.fromEntries(INBOX_ORIGIN_FILTERS.map(origin => [
        origin, channelItems.filter(item => origin === "ai" ? item.aiHandled : item.origin === origin).length,
      ]));
      const unreadThreads = Object.fromEntries(
        ["all", ...new Set(channels)].map((channel) => [
          channel,
          items.filter(
            (item) =>
              item.unreadCount > 0 &&
              (channel === "all" || item.channel === channel),
          ).length,
        ]),
      );
      const offset = Number(url.searchParams.get("cursor") || 0);
      const nextCursor =
        filtered.length > offset + 7 ? String(offset + 7) : null;
      filtered = filtered.slice(offset, offset + 7);
      return json(route, { items: filtered, unreadThreads, totalThreads, originCounts, nextCursor });
    }
    const detail = path.match(
      /^\/api\/outreach-conversations\/inbox\/(conversation|legacy)\/(\d+)$/,
    );
    if (detail) {
      const item = items.find(
        (item) => item.key === `${detail[1]}:${detail[2]}`,
      );
      if (state.detailDelay && Number(detail[2]) === 1)
        await new Promise((resolve) => setTimeout(resolve, state.detailDelay));
      return item
        ? json(route, {
            item,
            ...(item.kind === "legacy"
              ? {
                  message: {
                    ...history.get(item.id)![0],
                    direction: "outbound",
                    content: item.preview,
                    status: "sent",
                  },
                }
              : {}),
          })
        : json(route, { error: "This inbox item is unavailable." }, 404);
    }
    const thread = path.match(
      /^\/api\/outreach-conversations\/([^/]+)\/(\d+)\/(messages|draft-reply|discard-draft|read)$/,
    );
    if (thread) {
      const id = Number(thread[2]);
      const item = items.find((item) => item.id === id)!;
      if (request.method() === "GET") {
        if (state.failMessages) return json(route, { error: "Messages temporarily unavailable" }, 503);
        if (url.searchParams.get("markRead") !== "false") item.unreadCount = 0;
        const anchor = Number(url.searchParams.get("beforeMessageId") || 0);
        const all = history.get(id)!;
        const end = anchor
          ? all.findIndex((message) => message.id === anchor)
          : all.length;
        return json(route, {
          conversation: { ...item, userId: 4101, leadName: item.leadName },
          messages: all.slice(Math.max(0, end - 50), end),
        });
      }
      if (thread[3] === "read") {
        item.unreadCount = 0;
        return json(route, { success: true });
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      requests.push({ path, body });
      if (thread[3] === "draft-reply")
        return json(route, {
          content: "Thanks for your interest. Let us discuss the proposal.",
        });
      if (thread[3] === "discard-draft") return json(route, { success: true });
      if (state.sendGate) await state.sendGate;
      if (state.failSend)
        return json(
          route,
          { error: "Provider unavailable. Your draft is saved." },
          503,
        );
      if (state.inProgress)
        return json(route, { success: true, inProgress: true }, 202);
      history.get(id)!.push({
        id: 10000 + requests.length,
        conversationId: id,
        direction: "outbound",
        content: body.content,
        htmlContent: body.htmlContent,
        status: "sent",
        createdAt: new Date().toISOString(),
        isRead: true,
      });
      return json(route, { success: true });
    }
    if (
      /\/api\/(auth\/me|platform\/access|settings\/preferences|wallet|chat\/threads|notifications\/unread\/count)$/.test(
        path,
      )
    )
      return route.fallback();
    return json(route, {});
  });
  return { items, requests, searches, state, history };
}

test('Clear filters updates the URL and survives reload without dropping unrelated navigation context', async ({ page }) => {
  const mock = await installInbox(page);
  mock.items.splice(0, mock.items.length, ...mock.items.filter(item => item.channel !== 'sms'));
  await page.goto('/dashboard/outreach/inbox?channel=sms&source=crm&source=work#conversation-list');
  await expect(page.getByText('No conversations yet', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page).toHaveURL(url => !url.searchParams.has('channel') && url.searchParams.getAll('source').join(',') === 'crm,work' && url.hash === '#conversation-list');
  await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Open Asha Raman on Email' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'SMS', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Open Asha Raman on Email' })).toBeVisible();
  expect(mock.requests).toHaveLength(0);
});

test.describe('email provider evidence', () => {
  test('keeps queued, accepted, delivered, failed and unknown states distinct after refresh', async ({ page }, testInfo) => {
    const mock = await installInbox(page);
    const statuses = ['pending', 'sent', 'delivered', 'failed', 'manual_review'];
    for (const [index, status] of statuses.entries()) {
      mock.history.get(1)!.push({ id: 800 + index, conversationId: 1, direction: 'outbound',
        content: `Synthetic email ${status}`, status, providerCallState: status === 'manual_review' ? 'unknown' : 'confirmed',
        manualReviewRequired: status === 'manual_review',
        errorMessage: status === 'manual_review' ? 'Provider delivery could not be authoritatively confirmed.' : undefined,
        createdAt: '2026-10-12T10:00:00.000Z' });
    }
    await page.goto('/dashboard/outreach/inbox?thread=conversation%3A1');
    for (const status of statuses) {
      const card = page.locator('article').filter({ hasText: `Synthetic email ${status}` });
      await expect(card).toBeVisible();
      await expect(card.locator('footer summary')).toContainText(status === 'manual_review' ? 'Pending confirmation'
        : status.charAt(0).toUpperCase() + status.slice(1));
      if (status !== 'delivered') await expect(card.locator('footer summary')).not.toContainText('Delivered');
    }
    await expect(page.locator('article').filter({ hasText: 'Synthetic email manual_review' }).getByRole('alert'))
      .toContainText("didn't confirm whether this message was delivered");
    await expect(page.getByText('authoritatively confirmed')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('email-evidence-states.png'), fullPage: true });
    expect(mock.requests).toHaveLength(0);
  });

  test('keeps an ambiguous retry on one intent and refreshes later acceptance without claiming delivery', async ({ page }, testInfo) => {
    const mock = await installInbox(page);
    const keys: string[] = [];
    const outcome = { id: 899, conversationId: 1, direction: 'outbound', content: 'Synthetic uncertain email',
      status: 'manual_review', providerCallState: 'unknown', manualReviewRequired: true,
      errorMessage: 'Provider delivery could not be authoritatively confirmed.', createdAt: '2026-10-12T10:00:00.000Z' };
    await page.route('**/api/outreach-conversations/email/1/messages', route => {
      if (route.request().method() === 'GET') return route.fallback();
      keys.push(route.request().postDataJSON().idempotencyKey);
      if (!mock.history.get(1)!.some(message => message.id === outcome.id)) mock.history.get(1)!.push(outcome);
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({
        success: false, manualReviewRequired: true, retryable: false, error: outcome.errorMessage,
      }) });
    });
    await page.goto('/dashboard/outreach/inbox?thread=conversation%3A1');
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill(outcome.content);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const card = page.locator('article').filter({ hasText: outcome.content });
    await expect(card.locator('footer summary')).toContainText('Pending confirmation');
    await expect(composer).toHaveText(outcome.content);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => keys.length).toBe(2);
    expect(keys[1]).toBe(keys[0]);
    expect(mock.history.get(1)!.filter(message => message.id === outcome.id)).toHaveLength(1);
    Object.assign(outcome, { status: 'sent', providerCallState: 'confirmed', manualReviewRequired: false,
      providerMessageId: 'synthetic-later-receipt', errorMessage: undefined });
    await page.evaluate(() => (window as unknown as { emitInboxEvent: (type: string) => void }).emitInboxEvent('new_inbound_message'));
    await expect(card.locator('footer summary')).toContainText('Sent');
    await expect(card.getByRole('alert')).toHaveCount(0);
    await expect(card.locator('footer summary')).not.toContainText('Delivered');
    expect(keys).toHaveLength(2);
    await page.screenshot({ path: testInfo.outputPath('email-later-acceptance.png'), fullPage: true });
  });
});

test("Outreach opens the unified Inbox with one-row channel filters, pagination and search", async ({
  page,
}, testInfo) => {
  const mock = await installInbox(page);
  await page.goto("/dashboard/outreach");
  await expect(page).toHaveURL(/\/dashboard\/outreach\/inbox$/);
  const inbox = page.getByTestId("outreach-inbox");
  await expect(
    inbox.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  for (const label of labels)
    await expect(
      inbox
        .getByRole("group", { name: "Filter by channel" })
        .getByRole("button", { name: new RegExp(`^${label}(?:\\s*[0-9]+)?$`) }),
    ).toBeVisible();
  const filters = inbox.getByRole("group", { name: "Filter by channel" });
  await expect(filters.getByRole("button")).toHaveCount(6);
  const filterTops = await filters.getByRole("button").evaluateAll((buttons) =>
    buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
  );
  expect(new Set(filterTops).size).toBe(1);
  await expect(inbox.getByRole("button", { name: /^Open / })).toHaveCount(7);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("inbox-list.png"),
    fullPage: true,
    style: 'nextjs-portal, [data-sonner-toaster] { visibility: hidden !important; }',
  });
  // Reaching the list end triggers the existing automatic pagination. Waiting
  // for its new row avoids racing a click against the disappearing load button.
  await inbox.getByRole("button", { name: "Load more conversations" }).scrollIntoViewIfNeeded();
  await inbox.getByRole("button", { name: /Open Historical contact/ }).click();
  const selected = page.getByRole("region", { name: "Selected conversation" });
  await expect(selected.getByText("Older campaign outreach")).toBeVisible();
  await expect(
    selected.getByText(/original account cannot be verified/),
  ).toBeVisible();
  await expect(
    selected.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveCount(0);
  if (testInfo.project.name.includes("mobile"))
    await selected.getByRole("button", { name: "Back to inbox" }).click();
  await inbox
    .getByRole("textbox", { name: "Search inbox" })
    .fill("Older campaign");
  await expect(inbox.getByRole("button", { name: /^Open / })).toHaveCount(1);
  expect(mock.searches).toContain("Older campaign");
});

test('email formatting survives failed Inbox sends and is included in the retry payload', async ({ page }, testInfo) => {
  const mock = await installInbox(page);
  await page.goto('/dashboard/outreach/inbox?thread=conversation%3A1', { waitUntil: 'domcontentloaded' });
  const selected = page.getByRole('region', { name: 'Selected conversation' });
  const field = selected.getByRole('textbox', { name: 'Message', exact: true });
  await field.fill('Hello Asha');
  await field.press('ControlOrMeta+a');
  await selected.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(field.locator('b,strong')).toHaveText('Hello Asha');
  await selected.getByRole('button', { name: 'Italic', exact: true }).click();
  await expect(field.locator('i,em')).toHaveText('Hello Asha');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('inbox-email-formatting.png'), fullPage: true });
  mock.state.failSend = true;
  await selected.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(selected.getByRole('alert').filter({ hasText: 'draft is saved' })).toContainText('draft is saved');
  await expect(field).toHaveText('Hello Asha');
  const failed = mock.requests.at(-1)!.body;
  expect(failed.content).toBe('Hello Asha');
  expect(String(failed.htmlContent)).toMatch(/<(b|strong)>/);
  expect(String(failed.htmlContent)).toMatch(/<(i|em)>/);
  mock.state.failSend = false;
  await selected.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(field).toBeEmpty();
  expect(mock.requests.at(-1)!.body).toEqual(failed);
});

test('WhatsApp reply formatting sends native bold and italic markers', async ({ page }, testInfo) => {
  const mock = await installInbox(page);
  await page.goto('/dashboard/outreach/inbox?thread=conversation%3A2', { waitUntil: 'domcontentloaded' });
  const selected = page.getByRole('region', { name: 'Selected conversation' });
  const field = selected.getByRole('textbox', { name: 'Message', exact: true });
  await expect(field).toBeVisible();
  const replyControls = [field, ...['Attach files', 'Template', 'AI', 'Send'].map(name => selected.getByRole('button', { name, exact: true }))];
  const bounds = await Promise.all(replyControls.map(control => control.boundingBox()));
  const centers = bounds.map(box => box!.y + box!.height / 2);
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(8);
  await field.fill('Hello Ben');
  await field.press('ControlOrMeta+a');
  await selected.getByRole('button', { name: 'Format message' }).click();
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(field).toHaveValue('*Hello Ben*');
  await selected.getByRole('button', { name: 'Format message' }).click();
  await page.getByRole('button', { name: 'Italic', exact: true }).click();
  await expect(field).toHaveValue('*_Hello Ben_*');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('inbox-whatsapp-formatting.png'), fullPage: true });
  await selected.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(field).toHaveValue('');
  expect(mock.requests.at(-1)!.body.content).toBe('*_Hello Ben_*');
  expect(mock.requests.at(-1)!.body.htmlContent).toBeUndefined();
});

test('conversation origins filter the list and identify sent messages', async ({ page }, testInfo) => {
  const mock = await installInbox(page);
  mock.history.get(2)!.push({
    id: 201, conversationId: 2, direction: 'outbound', content: 'Your proposal is ready.', status: 'sent',
    createdAt: new Date().toISOString(), origin: { kind: 'outreach', label: 'AskSales outreach', outreachName: 'Proposal review', templateName: 'proposal_update', followUpStep: 2 },
  });
  await page.goto('/dashboard/outreach/inbox?channel=whatsapp');
  const inbox = page.getByTestId('outreach-inbox');
  const counts = inbox.getByRole('group', { name: 'Show conversations' });
  await expect(counts.getByRole('button', { name: /^All\s*2$/ })).toBeVisible();
  await expect(counts.getByRole('button', { name: /^Unread\s*1$/ })).toBeVisible();
  await expect(inbox.getByText('Outreach · AI', { exact: true })).toBeVisible();
  await inbox.getByRole('button', { name: /^AI handled\s*1$/ }).click();
  const conversations = inbox.getByRole('button', { name: /^Open / });
  await expect(conversations).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
  await inbox.getByRole('region', { name: 'Conversation filters' }).screenshot({ path: testInfo.outputPath('inbox-origin-filters.png'), animations: 'disabled' });
  await conversations.first().click();
  await expect(page.getByText('AskSales outreach · Proposal review · Template proposal_update · Follow-up 2')).toBeVisible();
});

test('saved email templates keep their HTML when inserted into an Inbox reply', async ({ page }, testInfo) => {
  const mock = await installInbox(page);
  await page.goto('/dashboard/outreach/inbox?thread=conversation%3A1', { waitUntil: 'domcontentloaded' });
  const selected = page.getByRole('region', { name: 'Selected conversation' });
  await selected.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Inbox saved email/ }).click();
  const field = selected.getByRole('textbox', { name: 'Message', exact: true });
  await expect(field.locator('b,strong')).toHaveText('Saved Asha reply');
  await page.screenshot({ path: testInfo.outputPath('inbox-saved-email-template.png'), fullPage: true });
  await selected.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(field).toBeEmpty();
  expect(mock.requests.at(-1)!.body).toMatchObject({ content: 'Saved Asha reply', htmlContent: '<p><b>Saved Asha reply</b></p>' });
});

test('Inbox templates use the conversation account and selected WhatsApp language', async ({ page }, testInfo) => {
  const mock = await installInbox(page);
  mock.items[1].reply.requiresTemplate = true;
  const catalogs: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/compose/templates')) catalogs.push(new URL(request.url()).searchParams.get('providerAccountId') || ''); });
  await page.goto('/dashboard/outreach/inbox?thread=conversation%3A2', { waitUntil: 'domcontentloaded' });
  const selected = page.getByRole('region', { name: 'Selected conversation' });
  await expect(selected.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  await selected.getByRole('button', { name: 'Template', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Send a WhatsApp template' });
  await drawer.getByRole('searchbox', { name: 'Search templates' }).fill('proposal');
  await drawer.getByRole('button', { name: /proposal_update/ }).click();
  await expect(drawer.getByRole('button', { name: 'Send template', exact: true })).toBeDisabled();
  await drawer.getByLabel('Header variable 1').fill('Ben');
  await drawer.getByLabel('Body variable 1').fill('Ben');
  await expect(drawer.getByText('Hello Ben, your proposal is ready.', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('inbox-whatsapp-account-template.png'), fullPage: true });
  await drawer.getByRole('button', { name: 'Send template', exact: true }).click();
  await expect.poll(() => mock.requests.length).toBe(1);
  expect(catalogs.length).toBeGreaterThan(0);
  expect(new Set(catalogs)).toEqual(new Set(['original-2']));
  expect(mock.requests[0].body).toMatchObject({ templateName: 'proposal_update', templateLanguage: 'en', expectedProviderAccountId: 'original-2' });
});

test('conversation refresh failures preserve history and rich drafts with a working retry', async ({ page }, testInfo) => {
  const mock = await installInbox(page);
  await page.goto('/dashboard/outreach/inbox?thread=conversation%3A1', { waitUntil: 'domcontentloaded' });
  const selected = page.getByRole('region', { name: 'Selected conversation' });
  const field = selected.getByRole('textbox', { name: 'Message', exact: true });
  await field.fill('Keep this draft');
  mock.state.failMessages = true;
  await page.evaluate(() => (window as unknown as Window & { emitInboxEvent: (event: string) => void }).emitInboxEvent('outreach_message_updated'));
  await expect(selected.getByRole('alert').filter({ hasText: 'Messages temporarily unavailable' })).toContainText('Messages temporarily unavailable');
  await expect(selected.getByText('History for Asha Raman')).toBeVisible();
  await expect(field).toHaveText('Keep this draft');
  await expect(selected.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('inbox-refresh-error-draft.png'), fullPage: true });
  mock.state.failMessages = false;
  await selected.getByRole('button', { name: 'Retry conversation' }).click();
  await expect(selected.getByRole('button', { name: 'Retry conversation' })).toHaveCount(0);
  await expect(field).toHaveText('Keep this draft');
  await expect(selected.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

test('SMS Inbox replies support multiple segments without rich markup', async ({ page }, testInfo) => {
  const mock = await installInbox(page);
  await page.goto('/dashboard/outreach/inbox?thread=conversation%3A7', { waitUntil: 'domcontentloaded' });
  const selected = page.getByRole('region', { name: 'Selected conversation' });
  const field = selected.getByRole('textbox', { name: 'Message', exact: true });
  await field.fill('A'.repeat(161));
  await expect(field).toHaveValue('A'.repeat(161));
  await expect(selected.getByLabel('SMS reply length')).toContainText('2 segments');
  await expect(selected.getByRole('toolbar')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('inbox-sms-multiple-segments.png'), fullPage: true });
  await selected.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(field).toHaveValue('');
  expect(String(mock.requests.at(-1)!.body.content)).toHaveLength(161);
});

test("reply failures preserve drafts and retries preserve idempotency and original account", async ({
  page,
}, testInfo) => {
  const mock = await installInbox(page);
  mock.state.failSend = true;
  let releaseSend!: () => void;
  mock.state.sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  await page.goto("/dashboard/outreach/inbox?thread=conversation%3A1");
  const selected = page.getByRole("region", { name: "Selected conversation" });
  await expect(selected.getByText("sales@orchid.test")).toBeVisible();
  await expect(
    selected.getByText("asha@example.test", { exact: true }),
  ).toBeVisible();
  await selected
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Our revised proposal is ready.");
  await selected.getByRole("button", { name: "Send", exact: true }).click();
  await selected
    .getByRole("textbox", { name: "Message", exact: true })
    .press("Control+Enter");
  await expect.poll(() => mock.requests.length).toBe(1);
  releaseSend();
  mock.state.sendGate = null;
  await expect(selected.getByRole("alert").filter({ hasText: "Provider unavailable" })).toContainText(
    "Provider unavailable",
  );
  expect(
    mock.requests.filter((request) => request.path.endsWith("/messages")),
  ).toHaveLength(1);
  const first = mock.requests[0].body;
  expect(first).toMatchObject({
    expectedProviderAccountId: "original-1",
    expectedRecipient: "asha@example.test",
    inboxContext: true,
  });
  await expect(
    selected.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveText("Our revised proposal is ready.");
  mock.state.failSend = false;
  await selected.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    selected.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEmpty();
  expect(mock.requests[1].body.idempotencyKey).toBe(first.idempotencyKey);
  await expect(
    selected.getByText("Our revised proposal is ready.", { exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("inbox-thread.png"),
    fullPage: true,
  });
});

test("HTML email stays readable in dark Inbox and its original layout is contained", async ({ page }, testInfo) => {
  const mock = await installInbox(page);
  mock.history.get(1)![0] = {
    ...mock.history.get(1)![0],
    direction: "outbound",
    content: "Hello Asha,\n\nHere is your proposal.",
    htmlContent: '<html><head><style>body{background:#fff;color:#222}</style></head><body><div style="width:1200px;background:#fff;color:#222">Hello Asha, here is your proposal.</div></body></html>',
  };
  await page.goto("/dashboard/outreach/inbox?thread=conversation%3A1", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  const selected = page.getByRole("region", { name: "Selected conversation" });
  const email = selected.getByRole("listitem", { name: "Sent email" });
  await expect(selected.getByText(/No published assistant assigned/)).toBeVisible();
  await expect(email.getByText("Hello Asha,", { exact: false })).toBeVisible();
  await expect(email.getByTitle("Formatted email content")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("inbox-email-dark.png"), fullPage: true });
  await email.getByRole("button", { name: "View formatted email" }).click();
  await expect(email.getByRole("button", { name: "Show text" })).toBeVisible();
  const preview = email.locator('iframe[title="Formatted email content"]');
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((frame) => frame.getBoundingClientRect().height)).toBeLessThanOrEqual(520);
  await expectNoHorizontalOverflow(page);
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({ path: testInfo.outputPath("inbox-formatted-email-dark.png"), fullPage: true });
  await email.getByRole("button", { name: "Show text" }).click();
  await expect(preview).toHaveCount(0);
  await expect(email.getByText("Here is your proposal.", { exact: false })).toBeVisible();
});

test("unread counts threads, opening marks read and selection remains until leaving", async ({
  page,
}, testInfo) => {
  await installInbox(page);
  await page.goto("/dashboard/outreach/inbox");
  const inbox = page.getByTestId("outreach-inbox");
  await inbox.getByRole("button", { name: /^Unread\s*2$/ }).click();
  await expect(inbox.getByRole("button", { name: /^Open / })).toHaveCount(2);
  await inbox.getByRole("button", { name: "Open Asha Raman on Email" }).click();
  await expect(page.getByText("History for Asha Raman")).toBeVisible();
  if (testInfo.project.name.includes("mobile")) {
    await page.getByRole("button", { name: "Back to inbox" }).click();
    await expect(inbox.getByRole("button", { name: /^Open / })).toHaveCount(1);
  } else {
    await expect(
      inbox.getByRole("button", { name: /^Unread\s*1$/ }),
    ).toBeVisible();
    await expect(
      inbox.getByRole("button", { name: "Open Asha Raman on Email" }),
    ).toBeVisible();
    await inbox
      .getByRole("button", { name: "Open Ben Carter on WhatsApp" })
      .click();
    await expect(page.getByText("History for Ben Carter")).toBeVisible();
    await expect(
      inbox.getByRole("button", { name: "Open Asha Raman on Email" }),
    ).toHaveCount(0);
  }
});

test("channel reply controls, approved WhatsApp template values and disconnected history", async ({
  page,
}, testInfo) => {
  const mock = await installInbox(page);
  mock.items[1].reply.requiresTemplate = true;
  await page.goto("/dashboard/outreach/inbox?thread=conversation%3A2");
  const selected = page.getByRole("region", { name: "Selected conversation" });
  await selected.getByRole('button', { name: 'Template', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('button', { name: /proposal_update/ }).click();
  await drawer.getByLabel('Header variable 1').fill('Orchid Labs');
  await drawer.getByLabel('Body variable 1').fill('Ben');
  await expect(drawer.getByText('For Orchid Labs', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Hello Ben, your proposal is ready.', { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Send template" }).click();
  await expect.poll(() => mock.requests.length).toBe(1);
  expect(mock.requests[0].body).toMatchObject({
    templateName: "proposal_update",
    templateComponents: [
      { type: "header", parameters: [{ type: "text", text: "Orchid Labs" }] },
      { type: "body", parameters: [{ type: "text", text: "Ben" }] },
    ],
  });
  mock.items[2].reply = {
    ...mock.items[2].reply,
    canReply: false,
    reason: "Reconnect the original Instagram account to reply.",
  };
  await page.goto("/dashboard/outreach/inbox?thread=conversation%3A3");
  await expect(selected.getByText("History for Carla Diaz")).toBeVisible();
  await expect(
    selected.getByText(/Reconnect the original Instagram/),
  ).toBeVisible();
  await expect(
    selected.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveCount(0);
  for (const id of [5, 6, 7]) {
    await page.goto(`/dashboard/outreach/inbox?thread=conversation%3A${id}`);
    await expect(
      selected.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeVisible();
    if (mock.items.find(item => item.id === id)!.channel === 'sms') {
      await expect(selected.getByRole("button", { name: "Attach files" })).toHaveCount(0);
      await selected.getByRole("textbox", { name: "Message", exact: true }).fill('Hello');
      await expect(selected.getByLabel('SMS reply length')).toHaveText('5 characters · GSM-7 · 1 segment (estimated)');
      await selected.getByRole("textbox", { name: "Message", exact: true }).fill('न'.repeat(71));
      await expect(selected.getByLabel('SMS reply length')).toHaveText('71 characters · UCS-2 · 2 segments (estimated)');
      await page.screenshot({ path: testInfo.outputPath('inbox-sms-reply-length.png'), fullPage: true, animations: 'disabled', style: 'nextjs-portal, [data-sonner-toaster] { visibility: hidden !important; }' });
    } else {
      await expect(selected.getByRole("button", { name: "Attach files" })).toBeVisible();
    }
  }
});

test("pending delivery cannot clear a draft or create a second send attempt", async ({
  page,
}) => {
  const mock = await installInbox(page);
  mock.state.inProgress = true;
  await page.goto("/dashboard/outreach/inbox?thread=conversation%3A7");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Please confirm receipt.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Selected conversation" })
      .getByRole("alert").filter({ hasText: "still being sent" }),
  ).toContainText("still being sent");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => mock.requests.length).toBe(2);
  expect(mock.requests[1].body.idempotencyKey).toBe(
    mock.requests[0].body.idempotencyKey,
  );
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Please confirm receipt.");
});

test("refresh events update incoming replies and visible-page polling refreshes other channels", async ({
  page,
}) => {
  const mock = await installInbox(page);
  await page.clock.install();
  await page.goto("/dashboard/outreach/inbox?thread=conversation%3A1");
  await expect(page.getByText("History for Asha Raman")).toBeVisible();
  const calls = mock.state.listCalls;
  mock.history.get(1)!.push({
    id: 199,
    conversationId: 1,
    direction: "inbound",
    content: "New inbound response",
    status: "delivered",
    createdAt: new Date().toISOString(),
  });
  mock.items[0].unreadCount = 1;
  await page.evaluate(() =>
    (
      window as unknown as { emitInboxEvent: (type: string) => void }
    ).emitInboxEvent("new_inbound_message"),
  );
  await expect(
    page.getByText("New inbound response", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => mock.state.listCalls).toBeGreaterThan(calls);
  const afterEvent = mock.state.listCalls;
  await page.clock.fastForward(31_000);
  await expect.poll(() => mock.state.listCalls).toBeGreaterThan(afterEvent);
  const visibleCalls = mock.state.listCalls;
  await page.evaluate(() =>
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    }),
  );
  await page.clock.fastForward(31_000);
  expect(mock.state.listCalls).toBe(visibleCalls);
});

test("drafts stay with their conversation and email supports AI and attachments", async ({
  page,
}, testInfo) => {
  const mock = await installInbox(page);
  await page.goto("/dashboard/outreach/inbox");
  await page.getByRole("button", { name: "Open Asha Raman on Email" }).click();
  const thread = page.getByRole("region", { name: "Selected conversation" });
  await thread
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Draft for Asha");
  if (testInfo.project.name.includes("mobile"))
    await thread.getByRole("button", { name: "Back to inbox" }).click();
  await page
    .getByRole("button", { name: "Open Ben Carter on WhatsApp" })
    .click();
  await expect(
    thread.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("");
  await thread
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Draft for Ben");
  if (testInfo.project.name.includes("mobile"))
    await thread.getByRole("button", { name: "Back to inbox" }).click();
  await page.getByRole("button", { name: "Open Asha Raman on Email" }).click();
  await expect(
    thread.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveText("Draft for Asha");
  await thread.getByRole("button", { name: "AI", exact: true }).click();
  await expect(
    thread.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveText("Thanks for your interest. Let us discuss the proposal.");
  await thread.locator("input[type=file]").setInputFiles({
    name: "proposal.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\nInbox fixture"),
  });
  await expect(thread.getByText("proposal.pdf", { exact: true })).toBeVisible();
  await thread.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(
      () =>
        mock.requests.filter((request) => request.path.endsWith("/messages"))
          .length,
    )
    .toBe(1);
  expect(mock.requests.at(-1)?.body).toMatchObject({
    expectedProviderAccountId: "original-1",
    attachments: [{ id: "test-attachment" }],
  });
});

test("older history remains complete when a new message arrives between pages", async ({
  page,
}) => {
  const mock = await installInbox(page);
  mock.history.set(
    7,
    Array.from({ length: 60 }, (_, index) => ({
      id: 700 + index,
      conversationId: 7,
      direction: "inbound",
      content: `Historic message ${index + 1}`,
      status: "delivered",
      createdAt: new Date(Date.UTC(2026, 8, 25, 10, index)).toISOString(),
      isRead: true,
    })),
  );
  await page.goto("/dashboard/outreach/inbox?thread=conversation%3A7");
  const thread = page.getByRole("region", { name: "Selected conversation" });
  await expect(
    thread.getByText("Historic message 60", { exact: true }),
  ).toBeVisible();
  mock.history.get(7)!.push({
    id: 999,
    conversationId: 7,
    direction: "inbound",
    content: "Arrival during pagination",
    status: "delivered",
    createdAt: new Date().toISOString(),
  });
  await thread.getByRole("button", { name: "Load older messages" }).click();
  await expect(
    thread.getByText("Historic message 1", { exact: true }),
  ).toBeVisible();
  for (let index = 1; index <= 60; index++)
    await expect(
      thread.getByText(`Historic message ${index}`, { exact: true }),
    ).toHaveCount(1);
});

test("pointer pagination works through the Next control and scroll-triggered loading", async ({ page }) => {
  const mock = await installInbox(page);
  mock.items.push(...Array.from({ length: 14 - mock.items.length }, (_, index) => ({
    ...makeItem("email", 40 + index), leadName: `Pointer history ${index}`,
    activityAt: "2026-08-01T10:00:00.000Z",
  })));
  const viewport = page.viewportSize()!;
  // Keep Next visible so this phase exercises an actual mouse click without
  // scrolling first triggering the same pagination operation.
  await page.setViewportSize({ width: viewport.width, height: 2000 });
  await page.goto("/dashboard/outreach/inbox");
  const inbox = page.getByTestId("outreach-inbox");
  const rows = inbox.locator("button[data-inbox-key]");
  await expect(rows).toHaveCount(7);
  await inbox.getByRole("button", { name: "Load more conversations" }).click();
  await expect(rows).toHaveCount(14);
  await expect(inbox.getByRole("button", { name: "Load more conversations" })).toHaveCount(0);

  // At the normal viewport, a mouse wheel reaching the bottom must load the
  // next page and leave its last conversation reachable.
  await page.setViewportSize(viewport);
  await page.reload();
  await expect(rows).toHaveCount(7);
  const point = await rows.first().evaluate((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
        const box = parent.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height - 20 };
      }
    }
    throw new Error("Expected a scrollable conversation list");
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 2000);
  await expect(rows).toHaveCount(14);
  await page.mouse.wheel(0, 3000);
  await expect(inbox.getByRole("button", { name: "Open Pointer history 0 on Email" })).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Load more conversations" })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  expect(mock.requests).toEqual([]);
});

test("a large refresh keeps newly arrived conversations reachable through pagination", async ({
  page,
}) => {
  const mock = await installInbox(page);
  const totalBeforeRefresh = 14; // Two complete seven-row fixture pages, including SMS.
  mock.items.push(
    ...Array.from({ length: totalBeforeRefresh - mock.items.length }, (_, index) => ({
      ...makeItem("email", 40 + index),
      leadName: `Older contact ${index}`,
      activityAt: "2026-08-01T10:00:00.000Z",
    })),
  );
  await page.goto("/dashboard/outreach/inbox");
  const inbox = page.getByTestId("outreach-inbox");
  // Scrolling to click can itself load the next page and remove this control.
  await inbox.getByRole("button", { name: "Load more conversations" }).press("Enter");
  await expect(inbox.getByRole("button", { name: /^Open / })).toHaveCount(totalBeforeRefresh);
  mock.items.unshift(
    ...Array.from({ length: 8 }, (_, index) => ({
      ...makeItem("email", 100 + index),
      leadName: `New arrival ${index}`,
      activityAt: new Date(Date.UTC(2026, 8, 27, 12, 8 - index)).toISOString(),
    })),
  );
  await inbox.getByRole("button", { name: "Refresh inbox" }).click();
  await expect(
    inbox.getByRole("button", { name: "Open New arrival 0 on Email" }),
  ).toBeVisible();
  await inbox.getByRole("button", { name: "Load more conversations" }).press("Enter");
  await expect(
    inbox.getByRole("button", { name: "Open New arrival 7 on Email" }),
  ).toHaveCount(1);
});

test("invalid deep links and list errors provide recovery on both viewport sizes", async ({
  page,
}) => {
  const mock = await installInbox(page);
  mock.state.failList = true;
  await page.goto("/dashboard/outreach/inbox?thread=invalid");
  await expect(
    page
      .getByText("This conversation link is invalid.")
      .filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Inbox temporarily unavailable", { exact: false }),
  ).toBeVisible();
  mock.state.failList = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Open Asha Raman on Email" }),
  ).toBeVisible();
});

test('social conversations retain multiple timestamped drafts and identify native sends', async ({ page }) => {
  const mock = await installInbox(page);
  for (const [channel,id,label] of [['whatsapp',2,'WhatsApp'],['instagram',3,'Instagram'],['facebook',4,'Facebook']] as const) {
    const entries=Array.from({length:54},(_,index)=>({id:id*1000+index,conversationId:id,direction:'inbound',
      content:`${channel} history ${index}`,status:'delivered',isRead:true,createdAt:new Date(Date.UTC(2026,8,25,10,index)).toISOString()}));
    const first={...entries[0],direction:'outbound',status:'draft',content:`${channel} earlier draft`,isAiGenerated:true};
    const second={...entries[52],direction:'outbound',status:'draft',content:`${channel} newer draft`,isAiGenerated:true};
    const sent={...entries[53],direction:'outbound',status:'sent',content:`${channel} native reply`,metadata:{origin:'native_app'}};
    mock.history.set(id,[first,...entries.slice(1,52),second,sent]);
    await page.goto(`/dashboard/outreach/inbox?thread=conversation%3A${id}`);
    const thread=page.getByRole('region',{name:'Selected conversation'});
    await expect(thread.getByText(`Sent from ${label}`,{exact:true})).toBeVisible();
    await thread.getByRole('button',{name:'Load older messages'}).click();
    await expect(thread.getByText('Drafted',{exact:true})).toHaveCount(2);
    await expect(thread.getByText(`${channel} earlier draft`,{exact:true})).toBeVisible();
    await expect(thread.getByText(`${channel} newer draft`,{exact:true})).toHaveCount(1);
    const cards=thread.getByRole('region',{name:`AI draft for ${channel}`});
    await expect(cards).toHaveCount(2);
    await expect(cards.first()).toContainText('25 Sept 2026');
    await expectNoHorizontalOverflow(page);
    await page.reload();
    await thread.getByRole('button',{name:'Load older messages'}).click();
    await expect(thread.getByText('Drafted',{exact:true})).toHaveCount(2);
  }
  expect(mock.requests.filter(request=>request.path.endsWith('/messages'))).toHaveLength(0);
});
