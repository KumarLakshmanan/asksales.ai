import { test, expect, expectNoHorizontalOverflow } from "./fixtures/app";
import type { Page } from "@playwright/test";
import type { WorkspaceFile } from "../src/lib/storage-workspace";
const creative: WorkspaceFile = {
  id: 1,
  fileName: "launch.png",
  originalName: "Launch creative.png",
  mimeType: "image/png",
  fileSizeBytes: 82400,
  category: "image",
  storageKey: "",
  url: null,
  createdAt: "2026-09-29T00:00:00Z",
  updatedAt: "2026-09-29T00:00:00Z",
  businessProfileId: 4102,
  referenceType: "content_asset",
  referenceId: "12",
  workspace: { tags: ["launch"], collection: "Autumn campaign" },
  source: { label: "Content library", href: "/dashboard/saved-templates" },
  dependency: {
    linked: true,
    needsReview: true,
    message:
      "This file is linked to other work. Removing it may break that resource.",
  },
};
const brief: WorkspaceFile = {
  ...creative,
  id: 2,
  fileName: "brief.csv",
  originalName: "Campaign brief.csv",
  mimeType: "text/csv",
  fileSizeBytes: 480,
  category: "document",
  referenceType: "user_upload",
  referenceId: null,
  workspace: {},
  source: null,
  dependency: {
    linked: false,
    needsReview: false,
    message:
      "No source link is recorded. This does not guarantee the file is unused.",
  },
};
async function workspace(page: Page, theme: "light" | "dark") {
  const state = {
    files: [structuredClone(creative), structuredClone(brief)],
    uploads: 0,
    actions: [] as unknown[],
  };
  await page.addInitScript(() => {
    localStorage.setItem(
      "user",
      JSON.stringify({ id: 4101, name: "Regression Alpha" }),
    );
    sessionStorage.setItem("active-business-profile:4101", "4102");
  });
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    const json = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    const ok = (data: unknown) => json({ success: true, data });
    if (path === "/api/settings/preferences")
      return json({ theme, language: "en", timezone: "Asia/Kolkata" });
    if (/csrf/.test(path)) return json({ csrfToken: "storage-fixture-csrf" });
    if (path === "/api/settings/storage/workspace") {
      const active = state.files.filter((f) => !f.workspace.trashedAt),
        trash = state.files.filter((f) => f.workspace.trashedAt);
      return ok({
        storageUsedBytes: 100 * 1024 * 1024,
        maxStorageBytes: 500 * 1024 * 1024,
        fileCount: 7,
        usagePercent: 20,
        planName: "Starter",
        businessName: "Regression Company",
        businessProfileId: 4102,
        activeCount: active.length,
        activeBytes: active.reduce((n, f) => n + f.fileSizeBytes, 0),
        trashCount: trash.length,
        trashBytes: trash.reduce((n, f) => n + f.fileSizeBytes, 0),
        retentionDays: 30,
        collections: ["Autumn campaign"],
        breakdown: [
          { category: "image", count: 1, bytes: 82400 },
          { category: "document", count: 1, bytes: 480 },
        ],
      });
    }
    if (path === "/api/settings/storage/workspace/files") {
      const p = url.searchParams;
      let files = state.files.filter((f) =>
        p.get("view") === "trash"
          ? !!f.workspace.trashedAt
          : !f.workspace.trashedAt,
      );
      if (p.get("search"))
        files = files.filter((f) =>
          (f.originalName || f.fileName)
            .toLowerCase()
            .includes(p.get("search")!.toLowerCase()),
        );
      if (p.get("category"))
        files = files.filter((f) => f.category === p.get("category"));
      return ok({ files, total: files.length, nextCursor: null });
    }
    if (/\/workspace\/files\/\d+$/.test(path))
      return ok(
        state.files.find((f) => f.id === Number(path.split("/").at(-1))),
      );
    if (path.endsWith("/thumbnail"))
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    if (path.endsWith("/content"))
      return route.fulfill({
        contentType: "text/csv",
        body: 'Name,Status\n"Doe, Jane",Ready',
      });
    if (path === "/api/settings/storage/workspace/actions") {
      const body = req.postDataJSON();
      state.actions.push(body);
      state.files = state.files
        .filter(
          (f) => !(body.action === "purge" && body.fileIds.includes(f.id)),
        )
        .map((f) =>
          body.fileIds.includes(f.id)
            ? {
                ...f,
                originalName: body.name || f.originalName,
                workspace: {
                  ...f.workspace,
                  ...(body.action === "trash"
                    ? { trashedAt: new Date().toISOString() }
                    : {}),
                  ...(body.action === "restore"
                    ? { trashedAt: undefined }
                    : {}),
                  ...(body.action === "organize"
                    ? { tags: body.tags, collection: body.collection }
                    : {}),
                },
              }
            : f,
        );
      return ok({ affected: body.fileIds.length });
    }
    if (path === "/api/settings/storage/check-upload")
      return ok({ allowed: true });
    if (path === "/api/settings/storage/files" && req.method() === "POST") {
      state.uploads++;
      return ok(brief);
    }
    if (path === "/api/settings/storage/workspace/activity")
      return ok({
        events: [
          {
            id: 1,
            name: creative.originalName,
            action: "uploaded",
            at: creative.createdAt,
            actor_user_id: 4101,
          },
        ],
        total: 1,
      });
    if (
      /^\/api\/(auth\/me|platform\/access|settings\/business-profiles|crm\/configuration|wallet|chat\/threads|notifications\/unread\/count|organizations)$/.test(
        path,
      )
    )
      return route.fallback();
    return json({});
  });
  return state;
}
for (const theme of ["light", "dark"] as const) {
  test(
    theme + " details, filters, preview, Trash and restore",
    async ({ page, audit }, info) => {
      const state = await workspace(page, theme);
      await page.goto("/dashboard/storage");
      await expect(
        page.getByRole("button", { name: "Launch creative.png", exact: true }),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({
        path: info.outputPath("storage-" + theme + ".png"),
        fullPage: true,
        animations: "disabled",
      });
      await page
        .getByRole("button", { name: "Launch creative.png", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByText("Regression Company", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByRole("link", { name: "Open Content library" }),
      ).toHaveAttribute("href", "/dashboard/saved-templates");
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await page
        .getByRole("button", { name: "Actions for Campaign brief.csv" })
        .click();
      await page
        .getByRole("menuitem", { name: "Preview", exact: true })
        .click();
      await expect(page.getByRole("cell", { name: "Doe, Jane" })).toBeVisible();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Actions for Launch creative.png" })
        .click();
      await page
        .getByRole("menuitem", { name: "Move to Trash", exact: true })
        .click();
      await expect(
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Move to Trash", exact: true }),
      ).toBeDisabled();
      await page.getByRole("dialog").getByRole("checkbox").check();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Move to Trash", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toBeHidden();
      if (info.project.name.startsWith("mobile"))
        await page
          .getByRole("combobox", { name: "Browse storage" })
          .selectOption("trash");
      else await page.getByRole("button", { name: /^Trash, / }).click();
      await expect(
        page.getByRole("button", { name: "Launch creative.png", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Actions for Launch creative.png" })
        .click();
      await page
        .getByRole("menuitem", { name: "Restore", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Restore files", exact: true })
        .click();
      await expect(
        page.getByText("Trash is empty", { exact: true }),
      ).toBeVisible();
      expect(state.actions).toHaveLength(2);
      await expectNoHorizontalOverflow(page);
      expect(audit.consoleErrors).toEqual([]);
    },
  );
  test(
    theme + " grid thumbnails, URL filters and multiple uploads",
    async ({ page, audit }, info) => {
      const state = await workspace(page, theme);
      await page.goto("/dashboard/storage");
      await expect(
        page.getByRole("button", { name: "Campaign brief.csv", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Grid view", exact: true })
        .click();
      await expect(page.locator("article img")).toHaveCount(1);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({
        path: info.outputPath("storage-grid-" + theme + ".png"),
        fullPage: true,
        animations: "disabled",
      });
      await page.getByRole("searchbox", { name: "Search files" }).fill("brief");
      await expect(page).toHaveURL(/search=brief/);
      await expect(
        page.getByRole("button", { name: "Launch creative.png", exact: true }),
      ).toBeHidden();
      await page
        .getByRole("button", { name: "Upload files", exact: true })
        .click();
      await page.getByLabel("Choose files to upload").setInputFiles([
        {
          name: "one.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("first"),
        },
        {
          name: "two.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("Name\nJane"),
        },
      ]);
      await expect.poll(() => state.uploads).toBe(2);
      await expect(
        page.getByText("done", { exact: false }).first(),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath("storage-uploads-" + theme + ".png"),
        fullPage: true,
        animations: "disabled",
      });
      await page
        .getByRole("button", { name: "Close panel", exact: true })
        .click();
      await expectNoHorizontalOverflow(page);
      expect(audit.consoleErrors).toEqual([]);
    },
  );
}
