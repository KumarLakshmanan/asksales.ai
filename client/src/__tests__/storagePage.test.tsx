import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StoragePage from "@/app/dashboard/(main)/storage/page";
import {
  selectBusinessProfile,
  selectedBusinessProfileId,
} from "@/lib/business-profile";
import { StorageFiles } from "@/components/storage/StorageFiles";
import { previewCsv } from "@/components/storage/StoragePreview";
import type { WorkspaceFile, WorkspaceUsage } from "@/lib/storage-workspace";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  postForm: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: mocks,
  buildApiUrl: (path: string) => path,
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
const image: WorkspaceFile = {
  id: 1,
  fileName: "launch.png",
  originalName: "Launch creative.png",
  mimeType: "image/png",
  fileSizeBytes: 600,
  category: "image",
  url: null,
  storageKey: "",
  createdAt: "2026-09-29T00:00:00Z",
  updatedAt: "2026-09-29T00:00:00Z",
  businessProfileId: 101,
  referenceType: "content_asset",
  referenceId: "42",
  workspace: {},
  source: { label: "Content library", href: "/dashboard/saved-templates" },
  dependency: {
    linked: true,
    needsReview: true,
    message: "This file is linked to other work.",
  },
};
const document: WorkspaceFile = {
  ...image,
  id: 2,
  fileName: "brief.txt",
  originalName: "Campaign brief.txt",
  mimeType: "text/plain",
  fileSizeBytes: 300,
  category: "document",
  referenceType: "user_upload",
  referenceId: null,
  source: null,
  dependency: {
    linked: false,
    needsReview: false,
    message: "No source link recorded.",
  },
};
const actor: WorkspaceFile = {
  ...document,
  id: 3,
  fileName: "leads.json",
  originalName: "Lead results.json",
  mimeType: "application/json",
  fileSizeBytes: 100,
  category: "actor_output",
  storageKey: "7/actor_output/lead-export/run-1/leads.json",
};
const usage: WorkspaceUsage = {
  storageUsedBytes: 1000,
  maxStorageBytes: 2000,
  fileCount: 3,
  usagePercent: 50,
  planName: "Free",
  breakdown: [
    { category: "image", count: 1, bytes: 600 },
    { category: "document", count: 1, bytes: 300 },
    { category: "actor_output", count: 1, bytes: 100 },
  ],
  activeCount: 3,
  activeBytes: 1000,
  trashCount: 0,
  trashBytes: 0,
  collections: [],
  businessProfileId: 101,
  businessName: "Acme",
  retentionDays: 30,
};
let library: WorkspaceFile[], client: QueryClient;
function files(endpoint: string) {
  const p = new URL(endpoint, "https://test.local").searchParams;
  let matching =
    selectedBusinessProfileId() === 102
      ? [
          {
            ...document,
            id: 99,
            originalName: "Other business.txt",
            businessProfileId: 102,
          },
        ]
      : library;
  matching = matching.filter((f) =>
    p.get("view") === "trash"
      ? !!f.workspace.trashedAt
      : !f.workspace.trashedAt,
  );
  if (p.get("category"))
    matching = matching.filter((f) => f.category === p.get("category"));
  if (p.get("search"))
    matching = matching.filter((f) =>
      (f.originalName || f.fileName)
        .toLowerCase()
        .includes(p.get("search")!.toLowerCase()),
    );
  if (p.get("tag"))
    matching = matching.filter((f) =>
      f.workspace.tags?.includes(p.get("tag")!),
    );
  if (p.get("sort") === "size")
    matching = [...matching].sort((a, b) => b.fileSizeBytes - a.fileSizeBytes);
  const offset = Number(p.get("cursor") || 0);
  return {
    files: matching.slice(offset, offset + 2),
    total: matching.length,
    nextCursor: offset + 2 < matching.length ? String(offset + 2) : null,
  };
}
function load(endpoint: string) {
  if (endpoint === "/api/settings/storage/workspace") return usage;
  if (endpoint.includes("/workspace/files?")) return files(endpoint);
  if (/\/workspace\/files\/\d+$/.test(endpoint))
    return library.find((f) => f.id === Number(endpoint.split("/").at(-1)));
  if (endpoint.includes("/folders?"))
    return {
      folders: [
        {
          folder: "lead-export/run-1",
          count: 150,
          bytes: 10000,
          newest: actor.createdAt,
        },
      ],
      total: 1,
    };
  if (endpoint.includes("/activity?"))
    return {
      events: [
        {
          id: 1,
          name: "Launch creative.png",
          action: "uploaded",
          at: image.createdAt,
          actor_user_id: 7,
        },
      ],
      total: 1,
    };
  if (endpoint.includes("/check-upload?")) return { allowed: true };
  throw new Error(`Unexpected request ${endpoint}`);
}
function page(gcTime = 0) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime } },
  });
  return render(
    <QueryClientProvider client={client}>
      <StoragePage />
    </QueryClientProvider>,
  );
}
async function menu(name: string, item: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  await user.click(screen.getByRole("menuitem", { name: item }));
}
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/dashboard/storage");
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("user", JSON.stringify({ id: 7 }));
  selectBusinessProfile(101);
  library = [
    structuredClone(image),
    structuredClone(document),
    structuredClone(actor),
  ];
  mocks.get.mockImplementation(async (endpoint: string) => load(endpoint));
  mocks.post.mockImplementation(
    async (
      endpoint: string,
      data: {
        action: string;
        fileIds: number[];
        name?: string;
        tags?: string[];
        collection?: string;
      },
    ) => {
      if (endpoint.endsWith("/download"))
        return { url: "/api/settings/storage/download-ticket?ticket=test" };
      library = library.map((f) =>
        !data.fileIds.includes(f.id)
          ? f
          : {
              ...f,
              ...(data.name ? { originalName: data.name } : {}),
              workspace: {
                ...f.workspace,
                ...(data.action === "trash"
                  ? { trashedAt: new Date().toISOString() }
                  : {}),
                ...(data.action === "restore" ? { trashedAt: undefined } : {}),
                ...(data.action === "organize"
                  ? { tags: data.tags, collection: data.collection }
                  : {}),
              },
            },
      );
      return { affected: data.fileIds.length };
    },
  );
  mocks.postForm.mockResolvedValue(image);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  URL.createObjectURL = vi.fn().mockReturnValue("blob:preview");
  URL.revokeObjectURL = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
});
describe("storage workspace", () => {
  it("shows activity without inventing an uploader for historical files", async () => {
    mocks.get.mockImplementation(async (endpoint: string) =>
      endpoint.includes("/activity?")
        ? {
            events: [
              {
                id: 2,
                name: "Legacy brief.txt",
                action: "uploaded",
                at: document.createdAt,
                actor_user_id: null,
              },
            ],
            total: 1,
          }
        : load(endpoint),
    );
    page();
    await screen.findByText("Launch creative.png");
    fireEvent.change(screen.getByRole("combobox", { name: "Browse storage" }), {
      target: { value: "activity" },
    });
    expect(await screen.findByText("Legacy brief.txt")).toBeVisible();
    expect(screen.getByText("uploaded · Uploader not recorded")).toBeVisible();
    expect(screen.queryByText(/Member #null/)).not.toBeInTheDocument();
  });
  it("keeps loaded tables and thumbnail grids bounded while retaining full selection scope", async () => {
    const files = Array.from({ length: 220 }, (_, index) => ({
      ...document,
      id: index + 1,
      originalName: `File ${index + 1}.txt`,
    }));
    const selectAll = vi.fn();
    const props = {
      files,
      selected: new Set<number>(),
      select: vi.fn(),
      selectAll,
      action: vi.fn(),
      busy: false,
    };
    const view = render(<StorageFiles {...props} view="list" />);
    expect(screen.getAllByRole("row").length).toBeLessThan(50);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select first 200 loaded files" }),
    );
    expect(selectAll).toHaveBeenCalledWith(true);
    view.rerender(<StorageFiles {...props} view="grid" />);
    expect(screen.getAllByRole("article").length).toBeLessThan(50);
  });

  it("shows shared organization capacity and refreshes overview and current files", async () => {
    page();
    await screen.findByText("Launch creative.png");
    expect(
      screen.getByRole("progressbar", { name: "Storage used" }),
    ).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("Showing 2 of 3 files")).toBeVisible();
    const calls = mocks.get.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(mocks.get.mock.calls.length).toBeGreaterThan(calls),
    );
    expect(screen.getByRole("heading", { name: "Storage" })).toBeVisible();
  });
  it("searches beyond the loaded page and saves filters in the URL", async () => {
    page();
    await screen.findByText("Launch creative.png");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search files" }), {
      target: { value: "Lead results" },
    });
    await screen.findByText("Lead results.json");
    expect(new URLSearchParams(window.location.search).get("search")).toBe(
      "Lead results",
    );
    expect(screen.getByText("Showing 1 of 1 files")).toBeVisible();
  });
  it.each(["Enter", "Space", "pointer"])(
    "recovers no matching files repeatedly with %s Clear search and stable input focus",
    async (activation) => {
      const user = userEvent.setup();
      page();
      await screen.findByText("Launch creative.png");
      const search = screen.getByRole("searchbox", { name: "Search files" });
      for (let attempt = 0; attempt < 2; attempt++) {
        await user.type(search, "no-match");
        await screen.findByRole("heading", { name: "No matching files" });
        const clear = screen.getByRole("button", { name: "Clear search" });
        if (activation === "pointer") await user.click(clear);
        else {
          search.focus();
          await user.tab();
          expect(clear).toHaveFocus();
          await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
        }
        expect(search).toHaveFocus();
        expect(search).toHaveValue("");
        await screen.findByText("Launch creative.png");
        expect(search).toHaveFocus();
        expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
        expect(new URLSearchParams(window.location.search).has("search")).toBe(false);
      }
      expect(mocks.post).not.toHaveBeenCalled();
      expect(mocks.postForm).not.toHaveBeenCalled();
    },
  );
  it("clears only search while retaining file filters, ordering, loaded pagination, view and business scope", async () => {
    const user = userEvent.setup();
    library = Array.from({ length: 5 }, (_, index) => ({
      ...document,
      id: index + 10,
      originalName: `Filtered brief ${index + 1}.txt`,
      fileSizeBytes: 500 - index,
      workspace: { tags: ["launch"], collection: "Autumn" },
    }));
    const retained = new URLSearchParams({
      category: "document", sort: "size", type: "document",
      after: "2026-09-01", before: "2026-10-01", minSize: "100", maxSize: "1000",
      tag: "launch", collection: "Autumn",
    });
    window.history.replaceState(null, "", `/dashboard/storage?${retained}`);
    localStorage.setItem("storage:view", "grid");
    // Match the production cache lifetime so clearing search recovers loaded pages.
    page(5 * 60 * 1000);
    await screen.findByText("Showing 2 of 5 files");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("Showing 4 of 5 files");
    const search = screen.getByRole("searchbox", { name: "Search files" });
    await user.type(search, "no-match");
    await screen.findByRole("heading", { name: "No matching files" });
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await screen.findByText("Showing 4 of 5 files");
    expect(search).toHaveFocus();
    expect(new URLSearchParams(window.location.search)).toEqual(retained);
    expect(screen.getByRole("combobox", { name: "Sort files" })).toHaveValue("size");
    expect(screen.getByRole("button", { name: "Grid view" })).toHaveAttribute("aria-pressed", "true");
    expect(selectedBusinessProfileId()).toBe(101);
    expect(mocks.get.mock.calls.filter(([url]) => String(url).includes("/workspace/files?")).every(([url]) => {
      const params = new URL(String(url), "https://test.local").searchParams;
      return Array.from(retained).every(([key, value]) => params.get(key) === value);
    })).toBe(true);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.postForm).not.toHaveBeenCalled();
  });
  it("keeps newer focus and search after a cleared query's delayed response", async () => {
    const user = userEvent.setup();
    page();
    await screen.findByText("Launch creative.png");
    const search = screen.getByRole("searchbox", { name: "Search files" });
    await user.type(search, "no-match");
    await screen.findByRole("heading", { name: "No matching files" });
    client.removeQueries({ predicate: (query) => query.queryKey[3] === "files" && (query.queryKey[4] as { search: string }).search === "" });
    let finish: ((data: ReturnType<typeof files>) => void) | undefined;
    mocks.get.mockImplementation(async (endpoint: string) =>
      endpoint.endsWith("/workspace/files?")
        ? new Promise((resolve) => { finish = resolve; })
        : load(endpoint),
    );
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search).toHaveFocus();
    await waitFor(() => expect(finish).toBeDefined());
    const sort = screen.getByRole("combobox", { name: "Sort files" });
    sort.focus();
    await act(async () => finish!({ files: [image], total: 1, nextCursor: null }));
    await screen.findByText("Launch creative.png");
    expect(sort).toHaveFocus();
    await user.type(search, "Lead");
    await screen.findByText("Lead results.json");
    expect(search).toHaveFocus();
    expect(search).toHaveValue("Lead");
    expect(screen.queryByText("Launch creative.png")).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("does not restore stale search focus after newer storage navigation or a business change", async () => {
    const user = userEvent.setup();
    page();
    await screen.findByText("Launch creative.png");
    await user.type(screen.getByRole("searchbox", { name: "Search files" }), "no-match");
    await screen.findByRole("heading", { name: "No matching files" });
    client.removeQueries({ predicate: (query) => query.queryKey[3] === "files" && (query.queryKey[4] as { search: string }).search === "" });
    let finish: ((data: ReturnType<typeof files>) => void) | undefined;
    mocks.get.mockImplementation(async (endpoint: string) =>
      endpoint.endsWith("/workspace/files?")
        ? new Promise((resolve) => { finish = resolve; })
        : load(endpoint),
    );
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(finish).toBeDefined());
    const browse = screen.getByRole("combobox", { name: "Browse storage" });
    browse.focus();
    fireEvent.change(browse, { target: { value: "activity" } });
    await screen.findByText(/uploaded · Member #7/);
    await act(async () => finish!({ files: [image], total: 1, nextCursor: null }));
    expect(browse).toHaveFocus();
    expect(screen.queryByRole("searchbox", { name: "Search files" })).not.toBeInTheDocument();
    window.history.replaceState(null, "", "/dashboard/storage?sort=name");
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await screen.findByRole("searchbox", { name: "Search files" });
    act(() => selectBusinessProfile(102));
    await screen.findByText("Other business.txt");
    expect(screen.getByRole("combobox", { name: "Sort files" })).toHaveValue("name");
    expect(screen.getByRole("searchbox", { name: "Search files" })).not.toHaveFocus();
    expect(screen.queryByText("Launch creative.png")).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.postForm).not.toHaveBeenCalled();
  });
  it("uses cursor pagination and resets to a new ordering", async () => {
    page();
    await screen.findByText("Launch creative.png");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("Lead results.json");
    expect(
      mocks.get.mock.calls.some(([url]) => String(url).includes("cursor=2")),
    ).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort files" }), {
      target: { value: "size" },
    });
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get("sort")).toBe(
        "size",
      ),
    );
    expect(await screen.findByText("Showing 2 of 3 files")).toBeVisible();
  });
  it("loads details lazily with a business name and source link", async () => {
    page();
    await screen.findByText("Launch creative.png");
    expect(
      mocks.get.mock.calls.some(([url]) =>
        String(url).endsWith("/workspace/files/1"),
      ),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Launch creative.png" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Acme")).toBeVisible();
    expect(
      within(dialog).getByRole("link", { name: "Open Content library" }),
    ).toHaveAttribute("href", "/dashboard/saved-templates");
  });
  it("requires dependency review before Trash and supports restoration", async () => {
    page();
    await screen.findByText("Launch creative.png");
    await menu("Launch creative.png", "Move to Trash");
    let dialog = screen.getByRole("dialog");
    const move = within(dialog).getByRole("button", { name: "Move to Trash" });
    expect(move).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(move);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/settings/storage/workspace/actions",
      { action: "trash", fileIds: [1], acknowledgeReferences: true },
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Browse storage" }), {
      target: { value: "trash" },
    });
    await screen.findByText("Launch creative.png");
    await menu("Launch creative.png", "Restore");
    dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Restore files" }),
    );
    await screen.findByText("Trash is empty");
  });
  it("renames and organizes files through confirmed batch actions", async () => {
    page();
    await screen.findByText("Campaign brief.txt");
    await menu("Campaign brief.txt", "Rename");
    let dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("File name"), {
      target: { value: "New brief.txt" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
    await screen.findByText("New brief.txt");
    await menu("New brief.txt", "Tags and collection");
    dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Tags/ }), {
      target: { value: "launch, notes" },
    });
    fireEvent.change(within(dialog).getByLabelText("Collection"), {
      target: { value: "Campaign" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save organization" }),
    );
    await waitFor(() =>
      expect(mocks.post).toHaveBeenLastCalledWith(
        "/api/settings/storage/workspace/actions",
        {
          action: "organize",
          fileIds: [2],
          tags: ["launch", "notes"],
          collection: "Campaign",
        },
      ),
    );
  });
  it("shows complete actor run counts from the server", async () => {
    page();
    await screen.findByText("Launch creative.png");
    fireEvent.change(screen.getByRole("combobox", { name: "Browse storage" }), {
      target: { value: "category:actor_output" },
    });
    const run = await screen.findByRole("button", {
      name: /lead-export.*run-1/,
    });
    expect(run).toHaveTextContent("150 files");
    fireEvent.click(run);
    await screen.findByText("Lead results.json");
    expect(new URLSearchParams(window.location.search).get("folder")).toBe(
      "lead-export/run-1",
    );
  });
  it("rejects oversized files before upload and retries with the same receipt", async () => {
    page();
    await screen.findByText("Launch creative.png");
    fireEvent.click(screen.getByRole("button", { name: "Upload files" }));
    const large = new File(["a"], "large.pdf", { type: "application/pdf" });
    Object.defineProperty(large, "size", { value: 26 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText("Choose files to upload"), {
      target: { files: [large] },
    });
    expect(
      await screen.findByText(
        "Choose a supported, non-empty file up to 25 MB.",
      ),
    ).toBeVisible();
    expect(mocks.postForm).not.toHaveBeenCalled();
    mocks.postForm.mockRejectedValueOnce(new Error("Connection interrupted"));
    fireEvent.change(screen.getByLabelText("Choose files to upload"), {
      target: {
        files: [new File(["contents"], "brief.txt", { type: "text/plain" })],
      },
    });
    await screen.findByText("Connection interrupted");
    fireEvent.click(screen.getByRole("button", { name: "Retry brief.txt" }));
    await waitFor(() => expect(mocks.postForm).toHaveBeenCalledTimes(2));
    expect(
      mocks.get.mock.calls.filter(([url]) =>
        String(url).includes("/check-upload?"),
      ),
    ).toHaveLength(1);
    expect(mocks.postForm.mock.calls[0][2].headers["X-Storage-Upload-Id"]).toBe(
      mocks.postForm.mock.calls[1][2].headers["X-Storage-Upload-Id"],
    );
  });
  it("clears selections and dialogs when the selected business changes", async () => {
    page();
    await screen.findByText("Launch creative.png");
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Launch creative.png" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Launch creative.png" }),
    );
    await screen.findByRole("dialog");
    act(() => selectBusinessProfile(102));
    await screen.findByText("Other business.txt");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Selected files" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Launch creative.png")).not.toBeInTheDocument();
  });
  it("supports a text preview and next/previous navigation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => ({ size: 7, text: async () => '{"a":1}' }),
      }),
    );
    page();
    await screen.findByText("Campaign brief.txt");
    await menu("Campaign brief.txt", "Preview");
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText('{"a":1}')).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Previous file" }),
    ).toBeEnabled();
  });
  it("ignores a slow response after a newer search", async () => {
    let finish: ((data: ReturnType<typeof files>) => void) | undefined;
    mocks.get.mockImplementation(async (endpoint: string) =>
      endpoint.includes("search=old")
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : load(endpoint),
    );
    page();
    await screen.findByText("Launch creative.png");
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "old" },
    });
    await waitFor(() => expect(finish).toBeDefined());
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "Lead" },
    });
    await screen.findByText("Lead results.json");
    await act(async () =>
      finish!({ files: [image], total: 1, nextCursor: null }),
    );
    expect(screen.queryByText("Launch creative.png")).not.toBeInTheDocument();
  });
  it("parses quoted CSV cells and embedded newlines without shifting columns", () => {
    expect(
      previewCsv('Name,Notes\r\n"Doe, Jane","said ""hello""\nand left"'),
    ).toEqual([
      ["Name", "Notes"],
      ["Doe, Jane", 'said "hello"\nand left'],
    ]);
  });
});
