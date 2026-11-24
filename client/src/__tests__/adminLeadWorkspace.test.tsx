import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AdminLeadWorkspace } from "@/components/admin/AdminLeadWorkspace";
const { get, remove, toast } = vi.hoisted(() => ({
  get: vi.fn(),
  remove: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/admin-api", () => ({ default: { get, delete: remove } }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
const lead = {
  id: 42,
  userId: 3,
  name: "Beyond first page",
  firstName: null,
  lastName: null,
  email: "lead@example.test",
  phone: null,
  company: null,
  companyName: "Canonical company",
  jobTitle: "Director",
  source: "instagram",
  status: "contacted",
  score: 75,
  createdAt: "2026-10-03T00:00:00Z",
  userName: "Owner",
  userEmail: "owner@example.test",
};
function response(page = 1) {
  return {
    items: [
      {
        ...lead,
        id: page === 1 ? 42 : 43,
        name: page === 1 ? lead.name : "Second server page",
      },
    ],
    pagination: { total: 41, page, pageSize: 20, totalPages: 3 },
    stats: {
      totalLeads: 41,
      active: 28,
      converted: 4,
      qualified: 12,
      contacted: 3,
      conversionRate: 10,
    },
    filters: {
      statuses: ["new", "contacted"],
      sources: ["instagram", "manual"],
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation(async (url: string) =>
    url.includes("/export")
      ? "id,name\r\n42,Lead\r\n"
      : response(
          Number(
            new URL(url, "https://local.test").searchParams.get("page") || 1,
          ),
        ),
  );
});
afterEach(cleanup);
describe("shared admin lead workspace", () => {
  it("consumes the server items contract and pages the full filtered directory", async () => {
    render(<AdminLeadWorkspace />);
    expect(await screen.findByText("Beyond first page")).toBeInTheDocument();
    expect(screen.getByText("Canonical company")).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Lead pages" }),
    ).toHaveTextContent("Showing 1–20 of 41 matching leads");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Second server page")).toBeInTheDocument();
    expect(get.mock.calls.at(-1)?.[0]).toContain("page=2");
  });
  it("sends source, status and search to the server instead of filtering a local subset", async () => {
    render(<AdminLeadWorkspace mode="inventory" />);
    await screen.findByText("Beyond first page");
    fireEvent.change(screen.getByLabelText("Lead source"), {
      target: { value: "instagram" },
    });
    fireEvent.change(screen.getByLabelText("Lead status"), {
      target: { value: "contacted" },
    });
    fireEvent.change(screen.getByLabelText("Search all leads"), {
      target: { value: "Canonical" },
    });
    await waitFor(() => {
      const query = new URL(get.mock.calls.at(-1)![0], "https://local.test")
        .searchParams;
      expect(query.get("source")).toBe("instagram");
      expect(query.get("status")).toBe("contacted");
      expect(query.get("search")).toBe("Canonical");
      expect(query.get("page")).toBe("1");
    });
  });
  it("downloads all matching rows without a page limit and safely releases the blob URL", async () => {
    const create = vi.fn().mockReturnValue("blob:test");
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    render(<AdminLeadWorkspace />);
    await screen.findByText("Beyond first page");
    fireEvent.change(screen.getByLabelText("Lead source"), {
      target: { value: "instagram" },
    });
    await waitFor(() =>
      expect(get.mock.calls.at(-1)![0]).toContain("source=instagram"),
    );
    await screen.findByText("Beyond first page");
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    const exportCall = get.mock.calls.find(([url]) =>
      url.includes("/export"),
    )![0];
    expect(exportCall).toContain("source=instagram");
    expect(exportCall).not.toContain("page=");
    expect(exportCall).not.toContain("pageSize=");
    expect(create).toHaveBeenCalledWith(expect.any(Blob));
    click.mockRestore();
  });
  it("shows a recoverable fetch error instead of a false empty directory", async () => {
    get.mockRejectedValueOnce(new Error("Unavailable"));
    render(<AdminLeadWorkspace />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
    expect(screen.queryByText("No matching leads")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry leads" }));
    expect(await screen.findByText("Beyond first page")).toBeInTheDocument();
  });
});
