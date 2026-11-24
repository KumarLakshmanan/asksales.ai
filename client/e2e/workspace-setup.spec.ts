import { expect, expectNoHorizontalOverflow, test } from "./fixtures/app";
import { onboardingFixture } from "./fixtures/workspace-setup";
import { setupScreenshot } from "./fixtures/setup-screenshots";


test("analyzes every new workspace before the four steps and saves its toolkit images", async ({
  page,
  audit,
}, testInfo) => {
  // The synthetic website selects Inter. Keep its preview independent of
  // external Google Fonts availability while retaining the console audit.
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({
    contentType: "text/css",
    body: "@font-face { font-family: 'Inter'; src: local('DejaVu Sans'); font-style: normal; font-weight: 400 700; }",
  }));
  const { requests } = await onboardingFixture(page);
  await page.goto("/setup/business-profile/new");
  await expect(
    page.getByRole("heading", { name: "Start with your website" }),
  ).toBeVisible();
  await setupScreenshot(page, testInfo, "01-website-analyzer");
  await page.getByLabel("Website URL").fill("https://creator.example");
  await page
    .getByRole("button", { name: "Analyze website", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your website results" }),
  ).toBeVisible();
  await setupScreenshot(page, testInfo, "02-website-overview");
  await page.getByRole("tab", { name: "Overview", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Brand & images" })).toBeFocused();
  await setupScreenshot(page, testInfo, "03-website-brand-images");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("heading", { name: "Saved knowledge base content" })).toBeVisible();
  await expect(page.getByText("Creator Studio website knowledge")).toBeVisible();
  await setupScreenshot(page, testInfo, "04-website-knowledge");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your website results" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review extracted details" }).click();
  await expect(page.getByLabel("Workspace name *")).toHaveValue(
    "Creator Studio",
  );
  await page.getByRole("button", { name: "Creator", exact: true }).click();
  await expectNoHorizontalOverflow(page);
  await setupScreenshot(page, testInfo, "05-workspace-profile");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Short description *")).toHaveValue(
    "I create tutorials and support my community.",
  );
  await expect(page.getByRole("button", { name: /Analyze/ })).toHaveCount(0);
  await setupScreenshot(page, testInfo, "06-workspace-about");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: "Customer support", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Content & social media", exact: true })
    .click();
  await page
    .getByLabel("First goal (optional)")
    .fill("Reply faster to my audience");
  await setupScreenshot(page, testInfo, "07-workspace-uses");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Instagram", exact: true }).click();
  await expectNoHorizontalOverflow(page);
  await setupScreenshot(page, testInfo, "08-workspace-channels");
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(page).toHaveURL(/\/setup\/brand-toolkit\/41$/);
  await page.reload();
  await expect(page.getByLabel("Brand name *")).toHaveValue("Creator Studio");
  for (let step = 1; step < 4; step++) {
    await expectNoHorizontalOverflow(page);
    await setupScreenshot(page, testInfo, `${String(step + 8).padStart(2, '0')}-brand-${['identity', 'voice', 'visuals'][step - 1]}`);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }
  await expect(
    page.getByRole("button", { name: "Keep brand image 1" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Keep brand image 2" }).click();
  await expect(
    page.getByRole("checkbox", { name: "Keep website screenshot" }),
  ).toBeChecked();
  await expectNoHorizontalOverflow(page);
  await setupScreenshot(page, testInfo, "12-brand-images");
  for (let step = 4; step < 7; step++) {
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expectNoHorizontalOverflow(page);
    await setupScreenshot(page, testInfo, `${String(step + 9).padStart(2, '0')}-brand-${['content', 'business-dna', 'review'][step - 4]}`);
  }
  await page.getByRole("button", { name: "Finish setup", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/home$/);
  await setupScreenshot(page, testInfo, "16-new-workspace-home");
  expect(
    requests.filter(
      (item) =>
        item.path === "/api/settings/business-profiles" &&
        item.method === "POST",
    ),
  ).toHaveLength(1);
  expect(
    requests.find((item) => item.path === "/api/setup/website-analysis/jobs")
      ?.business,
  ).toBe("41");
  expect(
    requests.find((item) => item.path === "/api/settings/business-profiles/41")
      ?.body,
  ).toMatchObject({
    workspaceType: "creator",
    applicationUses: ["customer_support", "content_social"],
    preferredChannels: ["Instagram"],
  });
  const toolkit = requests.find(
    (item) => item.path === "/api/content/brand-toolkits",
  );
  expect(toolkit?.business).toBe("41");
  expect(toolkit?.body).toMatchObject({
    imageAssets: [
      {
        url: "/uploads/41/one.png",
        originalUrl: "https://creator.example/one.png",
      },
    ],
    websiteScreenshotUrl: "/uploads/41/screenshot.png",
  });
  expect(
    requests.some((item) => item.path === "/api/auth/mark-setup-complete"),
  ).toBe(false);
  expect(audit.consoleErrors).toEqual([]);
});

test("edits profile 26 using the shared form without creation screens", async ({
  page,
  audit,
}, testInfo) => {
  const { requests } = await onboardingFixture(page);
  await page.goto("/dashboard/business-profiles/26");
  await expect(page.getByLabel("Workspace name *")).toHaveValue(
    "Northstar Studio",
  );
  await expect(
    page.getByRole("heading", { name: "Your workspace profile" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Analyze/ })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: /Brand toolkit/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Individual", exact: true }).click();
  await page.getByLabel("Country", { exact: true }).selectOption("India");
  await page.getByLabel("Time zone", { exact: true }).selectOption("Asia/Kolkata");
  await setupScreenshot(page, testInfo, "17-edit-profile");
  await page.getByRole("button", { name: "About", exact: true }).click();
  await page.getByLabel("Short description", { exact: true }).fill("We help independent creators build a consistent brand.");
  await page.getByLabel("Contact email (optional)").fill("hello@northstar.example");
  await expectNoHorizontalOverflow(page);
  await setupScreenshot(page, testInfo, "18-edit-about");
  await page.getByRole("button", { name: "Uses", exact: true }).click();
  await page
    .getByRole("button", { name: "Personal productivity", exact: true })
    .click();
  await expectNoHorizontalOverflow(page);
  await setupScreenshot(page, testInfo, "19-edit-uses");
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Email", exact: true }).click();
  await expectNoHorizontalOverflow(page);
  await setupScreenshot(page, testInfo, "20-edit-channels");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/home$/);
  const saved = requests.find(
    (item) =>
      item.path === "/api/settings/business-profiles/26" &&
      item.method === "PUT",
  );
  expect(saved?.body).toMatchObject({
    workspaceType: "individual",
    applicationUses: ["personal_productivity"],
    preferredChannels: ["Email"],
    timezone: "Asia/Kolkata",
    description: "We help independent creators build a consistent brand.",
    email: "hello@northstar.example",
    companySize: "51-200",
  });
  expect(saved?.body).not.toHaveProperty("profileType");
  expect(saved?.body).not.toHaveProperty("businessGoals");
  expect(
    requests.some(
      (item) =>
        item.path.includes("/setup/") || item.path.includes("brand-toolkits"),
    ),
  ).toBe(false);
  expect(audit.consoleErrors).toEqual([]);
});
