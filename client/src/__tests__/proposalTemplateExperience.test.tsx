import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TemplateEditor,
  type EditableTemplate,
} from "@/components/proposals/TemplateEditor";
import { TemplateCustomerPreview } from "@/components/proposals/TemplateCustomerPreview";
import ProposalTemplatesPage from "@/app/dashboard/(main)/proposals/templates/page";
import AdminProposalTemplates from "@/app/admin/dashboard/proposal-templates/page";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  upload: vi.fn(),
  push: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: mocks }));
vi.mock("@/lib/admin-api", () => ({ api: mocks }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock("@/contexts/AdminAuthContext", () => ({
  useAdminAuth: () => ({ admin: { role: "super_admin" } }),
}));

const editable = (
  overrides: Partial<EditableTemplate> = {},
): EditableTemplate => ({
  name: "Discovery engagement",
  category: "Consulting",
  templateContent: {
    sections: [
      {
        title: "Our scope",
        kind: "content",
        body: "A discovery workshop for {{client_name}}.",
        instruction: "Use only the confirmed scope.",
      },
    ],
    placeholders: ["client_name"],
    requiredFields: ["client_name"],
    warnings: ["Review the imported image."],
  },
  ...overrides,
});
const standard = {
  ...editable(),
  id: 1,
  version: 2,
  published: true,
  userId: null,
  templateType: "document",
  createdAt: "2026-09-01",
  updatedAt: "2026-09-01",
};
const mine = {
  ...editable({ name: "My launch plan", category: "Marketing" }),
  id: 2,
  version: 1,
  published: false,
  userId: 42,
  templateType: "document",
  createdAt: "2026-09-01",
  updatedAt: "2026-09-01",
};

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue([]);
  mocks.put.mockResolvedValue({});
  mocks.post.mockResolvedValue({});
});

describe("proposal template editor and preview", () => {
  it("lets a business explicitly select and save its default terms", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<TemplateEditor initial={editable({ termsAndConditions: "Payment on completion." })} onSave={save} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Use as default template" }));
    fireEvent.change(screen.getByLabelText("Terms and conditions"), { target: { value: "Approved payment terms." } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ isDefault: true, termsAndConditions: "Approved payment terms." })));
  });

  it("requires terms when the business chooses a default and keeps admin publication distinct", () => {
    const save = vi.fn();
    const view = render(<TemplateEditor initial={editable()} onSave={save} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Use as default template" }));
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Add approved terms before choosing this default template.");
    view.unmount();
    render(<TemplateEditor admin initial={editable()} onSave={save} onCancel={() => {}} />);
    expect(screen.queryByRole("checkbox", { name: "Use as default template" })).not.toBeInTheDocument();
  });

  it("validates required fields, preserves guidance and never saves sample copy", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <TemplateEditor
        admin
        initial={editable({ published: true })}
        onSave={save}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Customer copy"), {
      target: { value: "Deliver by {{project_deadline}}." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Add these placeholders to required fields: project_deadline.",
    );
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Required fields"), {
      target: { value: "client_name, project_deadline" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "Consulting",
          templateContent: expect.objectContaining({
            requiredFields: ["client_name", "project_deadline"],
            warnings: ["Review the imported image."],
            sections: [
              expect.objectContaining({
                body: "Deliver by {{project_deadline}}.",
                instruction: "Use only the confirmed scope.",
              }),
            ],
          }),
        }),
      ),
    );
    expect(JSON.stringify(save.mock.calls[0][0])).not.toContain(
      "Northstar Studio will",
    );
  });
  it("shows customer copy with known values and the full investment breakdown", () => {
    render(<TemplateCustomerPreview template={editable()} />);
    const document = screen.getByRole("article", {
      name: "Customer proposal document",
    });
    expect(
      within(document).getByText(
        "A discovery workshop for Alex Morgan · Acme Co.",
      ),
    ).toBeInTheDocument();
    expect(
      within(document).queryByText("Use only the confirmed scope."),
    ).not.toBeInTheDocument();
    expect(within(document).getByText("USD 3,135.00")).toBeInTheDocument();
    expect(within(document).getByText("Subtotal")).toBeInTheDocument();
    expect(within(document).getByText("Discount")).toBeInTheDocument();
    expect(within(document).getByText("Tax (10%)")).toBeInTheDocument();
    expect(
      screen.getByText(/Preview values are never saved/),
    ).toBeInTheDocument();
  });
  it("requires a concrete replacement when ten published slots are occupied", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <TemplateEditor
        admin
        initial={editable({ published: false })}
        publishedTemplates={Array.from({ length: 10 }, (_, index) => ({
          id: index + 1,
          name: `Standard ${index + 1}`,
        }))}
        onSave={save}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Publish to standard templates" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose one of the 10 published templates to replace.",
    );
    fireEvent.change(screen.getByLabelText("Replace a published template"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and publish" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ replaceTemplateId: 3, published: true }),
      ),
    );
  });
});

describe("proposal template library", () => {
  it("separates standard and personal templates, filters categories, and keeps DOCX import secondary", async () => {
    mocks.get.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith("/favorites") ? [] : [standard, mine]),
    );
    render(<ProposalTemplatesPage />);
    expect(
      await screen.findByRole("heading", { name: "Discovery engagement" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "My launch plan" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("DOCX file · up to 15 MB"),
    ).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /My templates/ }));
    fireEvent.click(screen.getByRole("tab", { name: /My templates/ }));
    expect(
      await screen.findByRole("heading", { name: "My launch plan" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Template category"), {
      target: { value: "Marketing" },
    });
    expect(
      screen.getByRole("heading", { name: "My launch plan" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import DOCX" }));
    expect(
      await screen.findByLabelText("DOCX file · up to 15 MB"),
    ).toBeInTheDocument();
  });
  it("persists favorites and can show a personal favorite across library tabs", async () => {
    mocks.get.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith("/favorites") ? [mine.id] : [standard, mine],
      ),
    );
    render(<ProposalTemplatesPage />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add Discovery engagement to favorites",
      }),
    );
    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith(
        "/api/proposals/templates/1/favorite",
        { favorite: true },
      ),
    );
    expect(
      await screen.findByRole("button", {
        name: "Remove Discovery engagement from favorites",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Favorites/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Favorites/ }));
    expect(
      await screen.findByRole("heading", { name: "My launch plan" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Discovery engagement" }),
    ).toBeInTheDocument();
  });
});

describe("admin template history", () => {
  it("requires a selected slot before restoring a published version into a full library", async () => {
    const current = {
      ...standard,
      id: 11,
      name: "Archived discovery",
      published: false,
      version: 5,
    };
    const published = Array.from({ length: 10 }, (_, index) => ({
      ...standard,
      id: index + 1,
      name: `Standard ${index + 1}`,
    }));
    mocks.get.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith("/history")
          ? [
              {
                id: 83,
                adminId: 3,
                action: "updated",
                createdAt: "2026-09-01T10:00:00Z",
                snapshot: { ...current, published: true, version: 2 },
              },
            ]
          : [...published, current],
      ),
    );
    render(<AdminProposalTemplates />);
    const name = await screen.findByRole("heading", {
      name: "Archived discovery",
    });
    fireEvent.click(
      within(name.closest("article")!).getByRole("button", { name: "History" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Version 2 Updated/ }),
    );
    const restore = screen.getByRole("button", {
      name: "Restore as version 6",
    });
    expect(restore).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Replace a published template"), {
      target: { value: "4" },
    });
    expect(restore).toBeEnabled();
    fireEvent.click(restore);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        "/api/admin/proposal-templates/11/rollback",
        { historyId: 83, expectedVersion: 5, replaceTemplateId: 4 },
      ),
    );
  });
});
