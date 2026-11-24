import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EmailPage from "@/app/dashboard/(main)/saved-templates/email/page";

const mocks = vi.hoisted(() => ({ get: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/api", () => ({ default: mocks }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/ui/masonry-grid", () => ({ MasonryGrid: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/content-library/TemplatePreviewCard", () => ({ TemplatePreviewCard: ({ title }: { title: string }) => <h2>{title}</h2> }));
vi.mock("@/components/content-library/DraftLibraryCard", () => ({ DraftLibraryCard: ({ asset }: { asset: { title: string } }) => <h2>{asset.title}</h2> }));
vi.mock("@/components/email-builder/DnDEmailBuilder", () => ({ default: () => null, blocksToHtml: () => "", blocksToPlainText: () => "" }));
vi.mock("@/components/RichTextEditor", () => ({ default: () => null }));

const date = "2026-10-09T12:00:00.000Z";
const reusable = { id: 1, name: "Welcome reusable", type: "email", subject: "Hello", content: "Welcome reusable body", createdAt: date, updatedAt: date };
const draft = (id: number) => ({ id, title: `Launch draft ${id}`, type: "email_template", channel: "email", content: "Launch body", status: "draft", createdAt: date });

// Return paginated, server-filtered template responses rather than mocking the hook.
function installLibrary(templates = [reusable], assets = [draft(1), draft(2)]) {
  mocks.get.mockImplementation(async (path: string) => {
    const url = new URL(path, "http://localhost");
    if (url.pathname === "/api/content/assets") return assets;
    if (url.pathname === "/api/content/templates") {
      const search = (url.searchParams.get("search") || "").toLowerCase();
      const matches = templates.filter(item => `${item.name} ${item.content}`.toLowerCase().includes(search));
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return { templates: matches.slice(offset, offset + limit), total: matches.length };
    }
    throw new Error(`Unexpected request: ${path}`);
  });
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><EmailPage /></QueryClientProvider>);
}

describe("email library counts and recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installLibrary();
  });

  it.each([39, 38])("derives totals and per-tab counts from %s mixed items", async total => {
    installLibrary([reusable], Array.from({ length: total - 1 }, (_, index) => draft(index + 1)));
    mount();
    expect(await screen.findByText(`Showing ${total} of ${total} items`)).toBeVisible();
    expect(screen.getByRole("tab", { name: `All content (${total})` })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: `Saved drafts (${total - 1})` })).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Reusable templates (1)" }));
    expect(screen.getByRole("status")).toHaveTextContent(`Showing 1 of ${total} items`);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
  });

  it("shows zero matches and clears search from the empty state using the keyboard", async () => {
    mount();
    await screen.findByText("Showing 3 of 3 items");
    const search = screen.getByPlaceholderText("Search templates...");
    fireEvent.change(search, { target: { value: "zzqa-no-match-20261009" } });
    await screen.findByText("No templates match your search");
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringContaining("search=zzqa-no-match-20261009")));
    expect(screen.getByRole("status")).toHaveTextContent("Showing 0 of 3 items");
    expect(screen.getByRole("tab", { name: "Reusable templates (1)" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create Your First Template" })).not.toBeInTheDocument();
    const emptyStateReset = screen.getAllByRole("button", { name: "Clear search" })[1];
    emptyStateReset.focus();
    await userEvent.keyboard("{Enter}");
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    await screen.findByText("Showing 3 of 3 items");
    expect(screen.getByRole("tab", { name: "All content (3)" })).toHaveAttribute("aria-selected", "true");
  });

  it("retains the exact focused empty-state reset during a pending debounced search", async () => {
    const successfulRead = mocks.get.getMockImplementation()!;
    let release!: (value: { templates: typeof reusable[]; total: number }) => void;
    const pending = new Promise<{ templates: typeof reusable[]; total: number }>(resolve => { release = resolve; });
    mocks.get.mockImplementation((path: string) => path.includes("search=zzqa-delayed-no-match") ? pending : successfulRead(path));
    mount();
    await screen.findByText("Showing 3 of 3 items");
    const search = screen.getByRole("textbox", { name: "Search email templates" });
    fireEvent.change(search, { target: { value: "zzqa-delayed-no-match" } });
    const reset = screen.getAllByRole("button", { name: "Clear search" })[1];
    reset.focus();
    expect(reset).toHaveFocus();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Updating templates…")).toBeVisible();
    expect(screen.queryByText("No templates match your search")).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringContaining("search=zzqa-delayed-no-match")));
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(reset).toBeInTheDocument();
    expect(reset).toHaveFocus();
    expect(screen.getByText("Updating templates…")).toBeVisible();
    expect(screen.queryByText("No templates match your search")).not.toBeInTheDocument();
    release({ templates: [], total: 0 });
    await waitFor(() => expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByText("No templates match your search")).toBeVisible();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Clear search" })[1]).toBe(reset));
    await userEvent.keyboard("{Enter}");
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    await screen.findByText("Showing 3 of 3 items");
  });

  it("combines tab and query filters and preserves the selected tab on both reset controls", async () => {
    mount();
    await screen.findByText("Showing 3 of 3 items");
    await userEvent.click(screen.getByRole("tab", { name: "Reusable templates (1)" }));
    const search = screen.getByPlaceholderText("Search templates...");
    fireEvent.change(search, { target: { value: "launch" } });
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith(expect.stringContaining("search=launch")));
    await screen.findByText("Showing 0 of 3 items");
    await userEvent.click(screen.getAllByRole("button", { name: "Clear search" })[1]);
    await screen.findByText("Showing 1 of 3 items");
    expect(screen.getByRole("tab", { name: "Reusable templates (1)" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Saved drafts (2)" }));
    fireEvent.change(search, { target: { value: "LAUNCH DRAFT 1" } });
    await screen.findByText("Showing 1 of 3 items");
    expect(screen.getByRole("heading", { name: "Launch draft 1" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Launch draft 2" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await screen.findByText("Showing 2 of 3 items");
    expect(search).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Saved drafts (2)" })).toHaveAttribute("aria-selected", "true");
  });

  it("distinguishes loaded items from the total across template pages", async () => {
    installLibrary(Array.from({ length: 25 }, (_, id) => ({ ...reusable, id, name: `Reusable ${id}` })));
    mount();
    await screen.findByText("Showing 26 of 27 items");
    expect(screen.getByRole("tab", { name: "Reusable templates (25)" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Load more templates" }));
    await screen.findByText("Showing 27 of 27 items");
    expect(mocks.get).toHaveBeenCalledWith(expect.stringContaining("offset=24"));
    expect(screen.queryByRole("button", { name: "Load more templates" })).not.toBeInTheDocument();
  });

  it("keeps a distinct first-use library state with creation guidance", async () => {
    installLibrary([], []);
    mount();
    await screen.findByText("Showing 0 of 0 items");
    expect(screen.getByText("No email templates yet")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create Your First Template" }));
    expect(mocks.push).toHaveBeenCalledWith("/dashboard/saved-templates/email/generate");
  });

  it("does not describe an empty tab as an empty library", async () => {
    installLibrary([], [draft(1)]);
    mount();
    await screen.findByText("Showing 1 of 1 items");
    await userEvent.click(screen.getByRole("tab", { name: "Reusable templates (0)" }));
    expect(screen.getByText("No reusable templates yet")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Showing 0 of 1 items");
    expect(screen.queryByText("No email templates yet")).not.toBeInTheDocument();
  });

  it("does not publish incomplete totals on a partial failure and offers a count retry", async () => {
    const successfulRead = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((path: string) => path.startsWith("/api/content/templates")
      ? Promise.reject(new Error("Templates unavailable"))
      : successfulRead(path));
    mount();
    expect(await screen.findByText("Library counts unavailable")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Launch draft 1" })).toBeVisible();
    expect(screen.queryByText(/Showing \d+ of \d+ items/)).not.toBeInTheDocument();
    mocks.get.mockImplementation(successfulRead);
    await userEvent.click(screen.getByRole("button", { name: "Retry counts" }));
    await screen.findByText("Showing 3 of 3 items");
  });
});
