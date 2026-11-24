import { test, expect, installAppShellMocks } from "./fixtures/app";
import type { Page } from "@playwright/test";

test.setTimeout(60_000);
test.use({ serviceWorkers: "block", video: "off" });
const authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=mock-client&state=mock-state";
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
});
test.afterEach(async ({ page, audit }, testInfo) => {
  await testInfo.attach("gmail-browser-audit", { contentType: "application/json", body: Buffer.from(JSON.stringify({ ...audit, pageErrors: pageErrors.get(page) })) });
  expect(pageErrors.get(page), "Gmail must render without uncaught errors").toEqual([]);
  expect(audit.failedRequests.filter(request => request.includes("_rsc=")), "Failed RSC requests remain fatal").toEqual([]);
});

async function mockGmail(page: Page) {
  const state = { connected: false, reconnectRequired: false, authorizationFailure: false, authorizationUrl, authorizationRequests: 0, googleNavigations: 0, hold: null as Promise<void> | null, statusProfiles: [] as Array<string | null> };
  await page.addInitScript(() => {
    localStorage.setItem("user", JSON.stringify({ id: 4101 }));
    sessionStorage.setItem("active-business-profile:4101", "4102");
  });
  // All API and Google requests are intercepted before reaching any service.
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return route.abort("blockedbyclient");
    return route.continue();
  });
  await installAppShellMocks(page);
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (state.reconnectRequired && request.method() === "POST" && path === "/api/gmail/oauth/watch") {
      return route.fulfill({ status: 409, json: {
        code: "GMAIL_RECONNECT_REQUIRED", error: "Gmail authorization expired or was revoked. Reconnect this mailbox.",
      } });
    }
    if (request.method() !== "GET") return route.fulfill({ status: 409, json: { error: "All mutations blocked by fixture" } });
    if (path === "/api/gmail/oauth/authorize") {
      state.authorizationRequests++;
      if (state.hold) await state.hold;
      return state.authorizationFailure
        ? route.fulfill({ status: 503, json: { error: "private provider token response" } })
        : route.fulfill({ json: { url: state.authorizationUrl } });
    }
    if (path === "/api/gmail/oauth/status") {
      state.statusProfiles.push(request.headers()["x-business-profile-id"] || null);
      return route.fulfill({ json: { connected: state.connected, email: state.connected ? "mailbox@example.test" : null, watchStatus: "not_configured", configSource: "default" } });
    }
    if (path === "/api/resend/domains") return route.fulfill({ json: { domains: [] } });
    if (path === "/api/email-senders") return route.fulfill({ json: { senders: [] } });
    if (path === "/api/outreach-conversations/inbox") return route.fulfill({ json: {
      items: [], nextCursor: null, unreadThreads: { all: 0, email: 0, whatsapp: 0, instagram: 0, facebook: 0, sms: 0 },
    } });
    if (path === "/api/settings/business-profiles") return route.fulfill({ json: [
      { id: 4102, companyName: "Initial Business", isDefault: true, role: "owner" },
      { id: 4103, companyName: "Return Business", role: "owner" },
    ] });
    if (path === "/api/settings/business-profiles/4103") return route.fulfill({ json: { id: 4103, companyName: "Return Business", role: "owner" } });
    return route.fallback();
  });
  await page.route("https://accounts.google.com/**", route => {
    state.googleNavigations++;
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Mock Google authorization</title><p>Google request intercepted locally</p>" });
  });
  return state;
}

test("Gmail authorization failure stays safe and retry opens only mocked Google", async ({ page }) => {
  const state = await mockGmail(page);
  await page.goto("/dashboard/integrations/email?gmail_error=access_denied");
  await expect(page.getByText("Google authorization was cancelled. Choose Connect Gmail to try again.").first()).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/integrations\/email$/);
  const connect = page.getByRole("region", { name: "Gmail account", exact: true }).getByRole("button", { name: "Connect Gmail", exact: true });
  await expect(connect).toBeEnabled();
  state.authorizationFailure = true;
  await connect.click();
  await expect(page.getByText("Gmail sign-in could not be opened. Try again, or ask the app administrator to check Gmail sign-in settings.")).toBeVisible();
  await expect(page.getByText("private provider token response")).toHaveCount(0);
  await expect(connect).toBeEnabled();
  state.authorizationFailure = false;
  await connect.click();
  await expect(page).toHaveURL(authorizationUrl);
  expect(state.authorizationRequests).toBe(2);
  expect(state.googleNavigations).toBe(1);
});

test("unknown callback text and malicious authorization URLs never reach the browser destination", async ({ page }) => {
  const state = await mockGmail(page);
  await page.goto(`/dashboard/integrations/email?gmail_error=${encodeURIComponent("private-provider-detail https://attacker.test")}`);
  await expect(page.getByText("Gmail could not be connected. Choose Connect Gmail to try again.").first()).toBeVisible();
  await expect(page.getByText(/private-provider-detail/)).toHaveCount(0);
  state.authorizationUrl = "https://accounts.google.com.attacker.test/o/oauth2/v2/auth";
  const connect = page.getByRole("region", { name: "Gmail account", exact: true }).getByRole("button", { name: "Connect Gmail", exact: true });
  await connect.click();
  await expect(page.getByText("Gmail sign-in could not be opened. Try again, or ask the app administrator to check Gmail sign-in settings.")).toBeVisible();
  await expect(connect).toBeEnabled();
  await expect(page).toHaveURL(/\/dashboard\/integrations\/email$/);
  expect(state.googleNavigations).toBe(0);
});

test("consumed callback fields stay removed after reload while unrelated URL state is kept", async ({ page }) => {
  const state = await mockGmail(page);
  await page.goto("/dashboard/integrations/email?gmail_error=access_denied&section=senders#active-senders");
  await expect(page.getByText("Google authorization was cancelled. Choose Connect Gmail to try again.").first()).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/integrations\/email\?section=senders#active-senders$/);
  await page.reload();
  await expect(page.getByRole("region", { name: "Gmail account", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/integrations\/email\?section=senders#active-senders$/);
  await expect(page.getByText("Google authorization was cancelled. Choose Connect Gmail to try again.")).toHaveCount(0);
  expect(state.authorizationRequests).toBe(0);
  expect(state.googleNavigations).toBe(0);
  expect(state.statusProfiles.every(profile => profile === "4102")).toBe(true);
});

test("Gmail callback cleanup retains unresolved follow-up history through reload", async ({ page }, info) => {
  await mockGmail(page);
  await page.addInitScript(() => {
    const native = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("asksales:follow-up-save:")) throw new DOMException("Synthetic quota full", "QuotaExceededError");
      native.call(this, key, value);
    };
    // Seed once on the callback document. Reload must use the retained entry.
    if (!new URL(location.href).searchParams.has("gmail_error")) return;
    const attempted = { revision: "a".repeat(64), enableAutoFollowUp: true, followUpSteps: [
      { id: 1, delayValue: 2, delayUnit: "days", templateId: -1, templateName: "Auto-generate" },
    ] };
    history.replaceState({ ...history.state, __asksalesFollowUpRecovery: { version: 2, scopes: {
      "4101:4102": { email: { token: 2, serial: 2, pending: false, needsRefresh: true,
        attempted, unresolved: [{ token: 2, settings: attempted }] } },
    } } }, "");
  });
  const checkpoints: unknown[] = [];
  const checkRecovery = async () => {
    const recovery = await page.evaluate(() => history.state?.__asksalesFollowUpRecovery);
    expect(recovery.version).toBe(2);
    expect(recovery.scopes["4101:4102"].email.unresolved).toHaveLength(1);
    expect(recovery.scopes["4101:4102"].email.unresolved[0].settings.followUpSteps[0].delayValue).toBe(2);
    expect(await page.evaluate(() => sessionStorage.getItem("asksales:follow-up-save:4101:4102"))).toBeNull();
    checkpoints.push(recovery);
  };
  await page.goto("/dashboard/integrations/email?gmail_error=access_denied&section=senders");
  await expect(page.getByText("Google authorization was cancelled. Choose Connect Gmail to try again.").first()).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/integrations\/email\?section=senders$/);
  await checkRecovery();
  await page.reload();
  await expect(page.getByRole("region", { name: "Gmail account", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard\/integrations\/email\?section=senders$/);
  await checkRecovery();
  await info.attach("callback-follow-up-history", { contentType: "application/json", body: Buffer.from(JSON.stringify(checkpoints)) });
});

test("a delayed authorization response cannot navigate after changing business", async ({ page }) => {
  const state = await mockGmail(page);
  let release!: () => void;
  state.hold = new Promise<void>(resolve => { release = resolve; });
  await page.goto("/dashboard/integrations/email");
  const connect = page.getByRole("region", { name: "Gmail account", exact: true }).getByRole("button", { name: "Connect Gmail", exact: true });
  await connect.click();
  await expect.poll(() => state.authorizationRequests).toBe(1);
  await page.evaluate(() => {
    sessionStorage.setItem("active-business-profile:4101", "4103");
    window.dispatchEvent(new Event("business-profile-changed"));
  });
  release();
  await expect(connect).toBeEnabled();
  await expect(page).toHaveURL(/\/dashboard\/integrations\/email$/);
  expect(state.googleNavigations).toBe(0);
});

test("Gmail failure cause and support reference remain visible and copyable", async ({ page, context }, info) => {
  await mockGmail(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const reference = 'aabbccdd-1122-4333-8444-556677889900';
  await page.goto(`/dashboard/integrations/email?gmail_error=gmail_api_disabled&gmail_error_stage=mailbox_profile&gmail_error_ref=${reference}`);
  const diagnostic = page.getByRole('alert').filter({ hasText: 'Gmail connection could not finish' });
  await expect(diagnostic).toContainText('Gmail API is disabled');
  await expect(diagnostic).toContainText('Failed step: Reading the Gmail mailbox identity.');
  await expect(diagnostic).toContainText(`Reference: ${reference}`);
  await expect(page).toHaveURL(/\/dashboard\/integrations\/email$/);
  await diagnostic.getByRole('button', { name: 'Copy error details' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(`Reference: ${reference}`);
  expect(copied).toContain('Error code: gmail_api_disabled');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('gmail-failure-details.png'), fullPage: true });
  await diagnostic.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(diagnostic).toHaveCount(0);
});

test("successful callback restores the verified business before reading Gmail and makes no sync claim", async ({ page }, testInfo) => {
  const state = await mockGmail(page);
  state.connected = true;
  await page.goto("/dashboard/integrations/email?gmail_success=true&gmail_business_profile_id=4103");
  await expect(page.getByText("Your Gmail account is connected. Check reply sync below.")).toBeVisible();
  await expect(page.getByText("Your Gmail account is connected. Check reply sync below.")).toHaveCount(1);
  await expect(page.getByText("Your Gmail account is ready for sending and reply sync.")).toHaveCount(0);
  await expect(page).toHaveURL(/\/dashboard\/integrations\/email$/);
  await expect.poll(() => state.statusProfiles.length).toBeGreaterThan(0);
  expect(state.statusProfiles.every(profile => profile === "4103")).toBe(true);
  expect(state.googleNavigations).toBe(0);
  await expect(page.getByRole("region", { name: "Gmail account", exact: true })).toContainText("Reply sync needs attention");
  await page.screenshot({ path: testInfo.outputPath("gmail-callback-success.png"), fullPage: true });
  await testInfo.attach("mock-connection-audit", { contentType: "application/json", body: Buffer.from(JSON.stringify({
    allApiRequestsMocked: true, googleNavigations: state.googleNavigations, statusProfiles: state.statusProfiles,
  })) });
});

test("a Gmail reconnect response preserves the app session in the browser", async ({ page }, testInfo) => {
  const state = await mockGmail(page);
  state.connected = true;
  state.reconnectRequired = true;
  await page.goto("/dashboard/integrations/email");
  const gmailAccount = page.getByRole("region", { name: "Gmail account", exact: true });
  const restart = gmailAccount.getByRole("button", { name: "Restart sync", exact: true });
  await expect(restart).toBeEnabled();
  const accountBefore = await page.evaluate(() => {
    localStorage.setItem("token", "fixture-app-session");
    window.addEventListener("auth:unauthorized", () => document.documentElement.setAttribute("data-qa-auth-unauthorized", "true"));
    return localStorage.getItem("user");
  });
  await restart.click();
  await expect(page.getByText("Gmail authorization expired or was revoked. Reconnect this mailbox.")).toBeVisible();
  await expect(restart).toBeEnabled();
  await expect(page).toHaveURL(/\/dashboard\/integrations\/email$/);
  const sessionAfter = await page.evaluate(() => ({
    token: localStorage.getItem("token"), account: localStorage.getItem("user"),
    profile: sessionStorage.getItem("active-business-profile:4101"),
    unauthorizedEvent: document.documentElement.hasAttribute("data-qa-auth-unauthorized"),
  }));
  expect(sessionAfter).toEqual({ token: "fixture-app-session", account: accountBefore, profile: "4102", unauthorizedEvent: false });
  expect(state.googleNavigations).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("gmail-reconnect-session-preserved.png"), fullPage: true });
  await testInfo.attach("mock-reconnect-session-audit", { contentType: "application/json", body: Buffer.from(JSON.stringify({
    allApiRequestsMocked: true, exercisedEndpoint: "/api/gmail/oauth/watch", responseStatus: 409,
    responseCode: "GMAIL_RECONNECT_REQUIRED", accountPreserved: sessionAfter.account === accountBefore,
    appTokenPreserved: sessionAfter.token === "fixture-app-session", unauthorizedEvent: sessionAfter.unauthorizedEvent,
  })) });
});

test("connected Gmail opens the Email Inbox directly with the email filter selected", async ({ page }, testInfo) => {
  const state = await mockGmail(page);
  state.connected = true;
  const legacyRequests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/dashboard/outreach/email") legacyRequests.push(request.url());
  });
  await page.goto("/dashboard/integrations/email?gmail_success=true&gmail_business_profile_id=4103");
  await expect(page).toHaveURL(/\/dashboard\/integrations\/email$/);
  const outreach = page.getByRole("link", { name: /Email outreach/ });
  await expect(outreach).toHaveAttribute("href", "/dashboard/outreach/inbox?channel=email");
  await outreach.click();
  await expect(page).toHaveURL(/\/dashboard\/outreach\/inbox\?channel=email$/);
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Filter by channel" }).getByRole("button", { name: "Email", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(legacyRequests).toEqual([]);
  expect(state.googleNavigations).toBe(0);
  await testInfo.attach("canonical-email-navigation", { contentType: "application/json", body: Buffer.from(JSON.stringify({ legacyRequests, finalUrl: page.url() })) });
});
