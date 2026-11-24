import type { Locator, Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, test } from "./fixtures/app";

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });

const fields = [
  { id: "currentPassword", label: "Current Password", context: "current" },
  { id: "newPassword", label: "New Password", context: "new" },
  { id: "confirmPassword", label: "Confirm New Password", context: "confirm" },
] as const;

async function openSecurity(page: Page) {
  // All API traffic, including attempted writes, stays inside synthetic fixtures.
  // Never record request bodies or input values.
  const writes: string[] = [];
  const reads: string[] = [];
  const shellReads = new Set([
    "/api/auth/me", "/api/platform/access", "/api/settings/preferences",
    "/api/organizations", "/api/settings/business-profiles", "/api/crm/configuration",
    "/api/wallet", "/api/notifications/unread/count",
  ]);
  await page.route("**/api/**", route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!["GET", "HEAD"].includes(request.method())) {
      writes.push(`${request.method()} ${pathname}`);
      return route.fulfill({ status: 409, json: { error: "Local AS016 fixture blocks all mutations." } });
    }
    if (shellReads.has(pathname)) return route.fallback();
    reads.push(pathname);
    if (pathname === "/api/settings/profile") return route.fulfill({ json: {
      name: "Synthetic Settings User", email: "settings-fixture@example.test", avatar: "", bio: "", phone: "",
    } });
    if (pathname === "/api/settings/profile/notification-preferences") {
      return route.fulfill({ json: { leadAlerts: true, campaignUpdates: true } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto("/dashboard/settings");
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Security Settings", exact: true })).toBeVisible();
  await expect.poll(() => reads.includes("/api/settings/profile/notification-preferences")).toBe(true);
  const form = page.getByLabel("Current Password", { exact: true }).locator("xpath=ancestor::form");
  await form.evaluate(element => {
    element.setAttribute("data-submit-count", "0");
    element.setAttribute("data-invalid-count", "0");
    element.setAttribute("data-action-count", "0");
    for (const [event, attribute] of [["submit", "data-submit-count"], ["invalid", "data-invalid-count"]]) {
      element.addEventListener(event, () => {
        element.setAttribute(attribute, String(Number(element.getAttribute(attribute)) + 1));
      }, true);
    }
    for (const button of element.querySelectorAll("button")) {
      if (["Update Password", "Reset"].includes(button.textContent?.trim() ?? "")) {
        button.addEventListener("click", () => {
          element.setAttribute("data-action-count", String(Number(element.getAttribute("data-action-count")) + 1));
        });
      }
    }
  });
  return { writes, form };
}

async function expectBlankInputs(page: Page, visibleId?: string) {
  for (const field of fields) {
    const input = page.getByLabel(field.label, { exact: true });
    await expect(input).toHaveValue("");
    await expect(input).toHaveAttribute("type", field.id === visibleId ? "text" : "password");
    await expect(input).toHaveAttribute("required", "");
  }
}

async function expectNoActions(page: Page, form: Locator, writes: string[]) {
  expect(writes).toEqual([]);
  await expect(form).toHaveAttribute("data-submit-count", "0");
  await expect(form).toHaveAttribute("data-invalid-count", "0");
  await expect(form).toHaveAttribute("data-action-count", "0");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.locator('[role="status"][data-state="open"]')).toHaveCount(0);
}

test("Security visibility controls have unique action names and isolate repeated blank pointer toggles", async ({ page, audit }) => {
  const { writes, form } = await openSecurity(page);
  await expectBlankInputs(page);
  for (const field of fields) {
    const button = page.getByRole("button", { name: `Show ${field.context} password`, exact: true });
    await expect(button).toHaveCount(1);
    await expect(button).toHaveAttribute("type", "button");
    await expect(button).toHaveAttribute("aria-controls", field.id);
    expect(await button.getAttribute("aria-pressed")).toBeNull();
    await expect(button.locator("svg")).toHaveAttribute("aria-hidden", "true");
    await expect(button).toHaveText("");
    // aria-controls keeps this locator stable when the accessible action name changes.
    const control = page.locator(`button[aria-controls="${field.id}"]`);
    for (let cycle = 0; cycle < 2; cycle++) {
      await control.click();
      await expect(control).toHaveAccessibleName(`Hide ${field.context} password`);
      await expect(control).toBeFocused();
      await expectBlankInputs(page, field.id);
      await control.click();
      await expect(control).toHaveAccessibleName(`Show ${field.context} password`);
      await expectBlankInputs(page);
    }
  }
  await expectNoActions(page, form, writes);
  await expectNoHorizontalOverflow(page);
  expect(audit.consoleErrors).toEqual([]);
  expect(audit.failedRequests).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
  await test.info().attach("blank-security-form", { body: await form.ariaSnapshot(), contentType: "text/plain" });
  await page.screenshot({ path: test.info().outputPath("security-blank.png"), fullPage: true });
});

test("Tab, Enter, and Space retain visible focus and field alignment on the blank Security form", async ({ page, audit }) => {
  const { writes, form } = await openSecurity(page);
  await page.getByRole("button", { name: "Security", exact: true }).focus();
  // Continue from the selected tab through the remaining tab buttons to the form.
  for (let index = 0; index < 3; index++) await page.keyboard.press("Tab");
  await expect(page.getByLabel("Current Password", { exact: true })).toBeFocused();
  const geometry: unknown[] = [];
  for (const [index, field] of fields.entries()) {
    await page.keyboard.press("Tab");
    const button = page.locator(`button[aria-controls="${field.id}"]`);
    await expect(button).toBeFocused();
    const focus = await button.evaluate(element => ({
      visible: element.matches(":focus-visible"),
      shadow: getComputedStyle(element).boxShadow,
    }));
    expect(focus.visible).toBe(true);
    expect(focus.shadow).not.toBe("none");
    const input = page.getByLabel(field.label, { exact: true });
    const inputBox = (await input.boundingBox())!;
    const buttonBox = (await button.boundingBox())!;
    expect(buttonBox.width).toBeGreaterThanOrEqual(28);
    expect(buttonBox.height).toBeGreaterThanOrEqual(28);
    expect(Math.abs((inputBox.y + inputBox.height / 2) - (buttonBox.y + buttonBox.height / 2))).toBeLessThanOrEqual(1);
    expect(buttonBox.x).toBeGreaterThanOrEqual(inputBox.x);
    expect(buttonBox.x + buttonBox.width + 3).toBeLessThanOrEqual(inputBox.x + inputBox.width);
    expect(buttonBox.y - 3).toBeGreaterThanOrEqual(inputBox.y);
    expect(buttonBox.y + buttonBox.height + 3).toBeLessThanOrEqual(inputBox.y + inputBox.height);
    geometry.push({ field: field.id, inputBox, buttonBox, focus });
    if (index === 0) {
      await page.screenshot({ path: test.info().outputPath("security-keyboard-focus.png"), fullPage: true });
    }
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.keyboard.press("Enter");
      await expect(button).toBeFocused();
      await expect(button).toHaveAccessibleName(`Hide ${field.context} password`);
      await expectBlankInputs(page, field.id);
      await page.keyboard.press("Space");
      await expect(button).toBeFocused();
      await expect(button).toHaveAccessibleName(`Show ${field.context} password`);
      await expectBlankInputs(page);
    }
    if (index < fields.length - 1) {
      await page.keyboard.press("Tab");
      await expect(page.getByLabel(fields[index + 1].label, { exact: true })).toBeFocused();
    }
  }
  await expectNoActions(page, form, writes);
  await expectNoHorizontalOverflow(page);
  expect(audit.consoleErrors).toEqual([]);
  expect(audit.failedRequests).toEqual([]);
  expect(audit.blockedMutations).toEqual([]);
  await test.info().attach("blank-focus-and-layout", { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
});
