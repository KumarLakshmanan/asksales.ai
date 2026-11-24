import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WhatsAppTemplateLibrary from "@/components/whatsapp-templates/WhatsAppTemplateLibrary";
import WhatsAppTemplateDetails from "@/components/whatsapp-templates/WhatsAppTemplateDetails";
import { WhatsAppTemplateHistory } from "@/components/whatsapp-templates/WhatsAppTemplateHistory";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  push: vi.fn(),
  toast: vi.fn(),
  params: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useParams: () => ({ id: "17" }),
  useSearchParams: () => mocks.params,
}));
vi.mock("@/lib/api", () => ({ default: mocks }));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
const template = {
  id: 17,
  name: "appointment_reminder",
  language: "en_US",
  category: "UTILITY",
  status: "APPROVED",
  metaStatus: "APPROVED",
  wabaTemplateId: "meta17",
  body: "Hello {{1}}",
  examples: { "body:1": "Alex" },
  hasLocalChanges: true,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
};
describe("WhatsApp library and details improvements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.params = new URLSearchParams();
    window.history.replaceState(null, "", "/");
    mocks.get.mockResolvedValue({
      templates: [template],
      total: 14,
      page: 1,
      pageSize: 6,
      statusCounts: { APPROVED: 12, LOCAL_ONLY: 2 },
      languages: ["en_US", "ta"],
    });
  });
  it("restores server filters, table layout and pagination from the URL and preserves them in detail navigation", async () => {
    mocks.params = new URLSearchParams(
      "page=2&layout=table&language=ta&status=APPROVED&sort=name_asc",
    );
    render(<WhatsAppTemplateLibrary />);
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith("/api/whatsapp/templates", {
      params: expect.objectContaining({
        page: 2,
        language: "ta",
        status: "APPROVED",
        sort: "name_asc",
      }),
    });
    expect(screen.getByLabelText("Filter by language")).toHaveValue("ta");
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "View" }));
    const destination = mocks.push.mock.calls[0][0];
    const query = new URL(destination, "https://example.com").searchParams;
    expect(query.get("returnTo")).toContain("page=2");
    expect(query.get("returnTo")).toContain("layout=table");
  });
  it("keeps existing results visible after a failed refresh and retries", async () => {
    render(<WhatsAppTemplateLibrary />);
    await screen.findByText(template.name);
    mocks.get.mockRejectedValueOnce(new Error("Network unavailable"));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Refresh templates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Showing the previous results",
    );
    expect(screen.getByText(template.name)).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
  });
  it("debounces server searches and resets the result page", async () => {
    mocks.params = new URLSearchParams("page=2");
    render(<WhatsAppTemplateLibrary />);
    await screen.findByText(template.name);
    fireEvent.change(screen.getByLabelText("Search templates"), {
      target: { value: "appointment" },
    });
    await waitFor(() =>
      expect(mocks.get).toHaveBeenLastCalledWith("/api/whatsapp/templates", {
        params: expect.objectContaining({ page: 1, search: "appointment" }),
      }),
    );
    expect(window.location.search).toContain("search=appointment");
  });
  it("distinguishes a filtered empty result from an empty workspace", async () => {
    mocks.params = new URLSearchParams("language=ta");
    mocks.get.mockResolvedValue({
      templates: [],
      total: 0,
      languages: ["en_US", "ta"],
      statusCounts: { APPROVED: 1 },
    });
    render(<WhatsAppTemplateLibrary />);
    expect(
      await screen.findByRole("heading", {
        name: "No templates match these filters",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Clear filters" }),
    ).toBeInTheDocument();
  });
  it("opens task-based patterns with specific customization guidance", async () => {
    mocks.params = new URLSearchParams("view=library");
    render(<WhatsAppTemplateLibrary />);
    expect(
      screen.getByRole("button", { name: "Manage appointments" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Replace each numbered variable/),
    ).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Manage appointments" }));
    expect(
      screen.queryByRole("heading", { name: "Your order is on the way" }),
    ).not.toBeInTheDocument();
  });
  it("routes submission through review, refreshes status and preserves the return route", async () => {
    mocks.params = new URLSearchParams({
      returnTo:
        "/dashboard/integrations/whatsapp/templates?layout=table&page=2",
    });
    mocks.get.mockResolvedValue({ template });
    mocks.post.mockResolvedValue({
      template: {
        ...template,
        metaStatus: "REJECTED",
        metaRejectionReason: "Review the message category",
        lastSyncedAt: "2026-10-03T00:00:00Z",
      },
    });
    render(<WhatsAppTemplateDetails />);
    await screen.findByRole("heading", { name: template.name });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Review before submission" }));
    const reviewUrl = new URL(
      mocks.push.mock.calls[0][0],
      "https://example.com",
    );
    expect(reviewUrl.pathname).toBe(
      "/dashboard/integrations/whatsapp/templates/17/edit",
    );
    expect(reviewUrl.searchParams.get("step")).toBe("review");
    expect(reviewUrl.searchParams.get("returnTo")).toBe(
      "/dashboard/integrations/whatsapp/templates?layout=table&page=2",
    );
    expect(mocks.post).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Refresh status" }));
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/whatsapp/templates/17/refresh",
      {},
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Review the message category",
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Back to templates" }));
    expect(mocks.push).toHaveBeenCalledWith(
      "/dashboard/integrations/whatsapp/templates?layout=table&page=2",
    );
  });
  it.each(["NONE", " none ", "Old rejection feedback"])("does not show rejection feedback for an approved template (%s)", async (reason) => {
    mocks.get.mockResolvedValue({ template: { ...template, hasLocalChanges: false, metaRejectionReason: reason } });
    render(<WhatsAppTemplateDetails />);
    await screen.findByRole("heading", { name: "Meta approved" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/address the feedback before submitting/)).not.toBeInTheDocument();
  });
  it("does not turn Meta's NONE rejection reason into an alert after refreshing", async () => {
    mocks.get.mockResolvedValue({ template: { ...template, hasLocalChanges: false } });
    mocks.post.mockResolvedValue({ template: { ...template, hasLocalChanges: false, metaStatus: "REJECTED", metaRejectionReason: "NONE" } });
    render(<WhatsAppTemplateDetails />);
    await screen.findByRole("heading", { name: "Meta approved" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh status" }));
    await screen.findByRole("heading", { name: "Meta rejected" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("requires an accessible confirmation before deletion and keeps failed deletion retryable", async () => {
    mocks.get.mockResolvedValue({ template });
    mocks.delete.mockRejectedValueOnce(new Error("Please retry"));
    render(<WhatsAppTemplateDetails />);
    await screen.findByRole("heading", { name: template.name });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(mocks.delete).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Delete template" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Please retry",
    );
    expect(
      within(dialog).getByRole("button", { name: "Delete template" }),
    ).not.toBeDisabled();
  });
  it("compares changed content and can select an earlier recorded revision", () => {
    render(
      <WhatsAppTemplateHistory
        current={{ body: "New message", footer: "Help" }}
        approvedSnapshot={{ body: "Approved message", footer: "Help" }}
        history={[
          {
            at: "2026-10-01T00:00:00Z",
            action: "created",
            snapshot: { body: "First draft" },
          },
        ]}
      />,
    );
    expect(screen.getByText("Approved message")).toBeInTheDocument();
    expect(screen.getByText("New message")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Compare current draft with"), {
      target: { value: "0" },
    });
    expect(screen.getByText("First draft")).toBeInTheDocument();
  });
});
