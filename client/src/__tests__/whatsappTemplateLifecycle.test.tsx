import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WhatsAppTemplateLibrary from "@/components/whatsapp-templates/WhatsAppTemplateLibrary";
import WhatsAppTemplateDetails from "@/components/whatsapp-templates/WhatsAppTemplateDetails";
import WhatsAppTemplateEditor from "@/components/whatsapp-templates/WhatsAppTemplateEditor";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  postForm: vi.fn(),
  put: vi.fn(),
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

vi.mock("@/lib/api", async () => { const { ApiError } = await import("@/lib/api-client"); const api = { ...mocks, get: (path: string) => path === "/api/whatsapp/config" ? Promise.resolve({ configured: true, config: { businessAccountId: "test-waba", wabaName: "Test Business", connectionStatus: "ready", tokenStatus: "valid" } }) : mocks.get(path) }; return { default: api, api, ApiError }; });
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: 7, businessProfileId: 11 }, isAuthenticated: true, isLoading: false }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

function expandOptionalSections() {
  document.querySelectorAll<HTMLDetailsElement>("details").forEach((details) => {
    if (!details.open) fireEvent.click(details.querySelector("summary")!);
  });
}

const template = {
  id: 17,
  name: "appointment_reminder",
  language: "en_US",
  category: "UTILITY",
  status: "DRAFT",
  header: "Appointment update",
  headerType: "TEXT",
  body: "Hi {{1}}, your appointment is tomorrow.",
  footer: "Reply for help",
  buttons: [{ type: "URL", text: "View details", url: "https://example.com/appointment" }],
  examples: { 1: "Alex" },
  wabaTemplateId: null,
  metaStatus: null,
  hasLocalChanges: true,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

async function renderGuidedEditor(templateId?: string) {
  const view = render(<WhatsAppTemplateEditor templateId={templateId} />);
  fireEvent.click(await screen.findByRole("button", { name: "Guided" }));
  expandOptionalSections();
  return view;
}

describe("WhatsApp template lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.setItem("user", JSON.stringify({ id: 7 }));
    mocks.params = new URLSearchParams();
    mocks.get.mockResolvedValue({ success: true, templates: [template] });
    mocks.post.mockResolvedValue({ success: true, template });
    mocks.postForm.mockResolvedValue({ success: true, url: "/uploads/whatsapp-header.png", template });
    mocks.put.mockResolvedValue({ success: true, template });
  });

  it("exposes working view and edit actions for saved templates", async () => {
    const user = userEvent.setup();
    render(<WhatsAppTemplateLibrary />);
    await user.click(await screen.findByRole("button", { name: /My templates/ }));
    expect(await screen.findByText("appointment_reminder")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(mocks.push).toHaveBeenCalledWith(expect.stringMatching(/^\/dashboard\/integrations\/whatsapp\/templates\/17(?:\?returnTo=.*)?$/));
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(mocks.push).toHaveBeenCalledWith(expect.stringMatching(/^\/dashboard\/integrations\/whatsapp\/templates\/17\/edit\?returnTo=/));
  });

  it('clones the copy into a new unlinked draft without changing the original', async () => {
    mocks.params = new URLSearchParams('cloneFrom=17');
    mocks.get.mockResolvedValue({ success: true, template: { ...template, wabaTemplateId: 'meta-17', metaStatus: 'APPROVED' } });
    await renderGuidedEditor();
    await screen.findByRole('note');
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expandOptionalSections();
    expect(screen.getByLabelText(/Template name/)).toHaveValue('appointment_reminder_copy');
    expect(screen.getByLabelText('Language')).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expandOptionalSections();
    fireEvent.click(screen.getByRole('button', { name: 'Save new WhatsApp template' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/whatsapp/templates', expect.objectContaining({ name: 'appointment_reminder_copy', body: template.body })));
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.post.mock.calls[0][1]).not.toHaveProperty('wabaTemplateId');
  });

  it('requires a different language for a language variant and explains manual translation', async () => {
    mocks.params = new URLSearchParams('cloneFrom=17&variant=language');
    mocks.get.mockResolvedValue({ success: true, template });
    await renderGuidedEditor();
    expect(await screen.findByRole('note')).toHaveTextContent('Text is not automatically translated');
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expandOptionalSections();
    expect(screen.getByRole('button', { name: /Next/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(screen.getByRole('button', { name: 'Submit to Meta' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /View checklist/ }));
    fireEvent.click(within(screen.getByRole('region', { name: 'Submission checklist' })).getByRole('button', { name: 'Choose a different language' }));
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ta' } });
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit to Meta' })).toBeEnabled());
  });

  it('does not share owned uploads between a clone and its source', async () => {
    mocks.params = new URLSearchParams('cloneFrom=17');
    mocks.get.mockResolvedValue({ success: true, template: { ...template, headerType: 'IMAGE', headerMediaUrl: '/api/settings/storage/files/7/download' } });
    await renderGuidedEditor();
    expect(await screen.findByRole('note')).toHaveTextContent('private uploads and provider handles are not shared');
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expandOptionalSections();
    expect(screen.getByLabelText('WhatsApp header media URL')).toHaveValue('');
    expect(screen.getByRole('button', { name: /Next/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(screen.getByRole('button', { name: 'Submit to Meta' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save new WhatsApp template' })).toBeEnabled();
  });

  it.each(['IMAGE', 'VIDEO', 'DOCUMENT'])('reopens and saves an uploaded %s header without a URL error', async (headerType) => {
    const headerMediaUrl = '/uploads/1/content_asset/header-1790070506529.jpeg';
    mocks.get.mockResolvedValue({ success: true, template: { ...template, headerType, headerMediaUrl } });
    await renderGuidedEditor("17");
    await screen.findByRole('heading', { name: 'Edit template' });
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expandOptionalSections();
    expect(screen.getByLabelText('WhatsApp header media URL')).toHaveValue(headerMediaUrl);
    expect(screen.queryByText(/Add a valid .* file, HTTPS URL/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next/ })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expandOptionalSections();
    fireEvent.click(screen.getByRole('button', { name: 'Save WhatsApp template changes' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/whatsapp/templates/17', expect.objectContaining({ headerType, headerMediaUrl })));
    expect(mocks.postForm).not.toHaveBeenCalled();
  });

  it('preflights a public media URL without saving or submitting a template', async () => {
    mocks.get.mockResolvedValue({ success: true, template: { ...template, headerType: 'IMAGE', headerMediaUrl: 'https://example.com/header.png' } });
    mocks.post.mockResolvedValue({ success: true, mimeType: 'image/png', sizeBytes: 1024, note: 'Reachable now.' });
    await renderGuidedEditor("17");
    await screen.findByRole('heading', { name: 'Edit template' });
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expandOptionalSections();
    fireEvent.click(screen.getByRole('button', { name: 'Check public media URL' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/whatsapp/templates/media-preflight', { headerType: 'IMAGE', url: 'https://example.com/header.png' }));
    await screen.findByText(/Reachable now\./);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.postForm).not.toHaveBeenCalled();
  });

  it("loads the owner-scoped detail and opens its editor", async () => {
    mocks.get.mockResolvedValue({ success: true, template });
    const user = userEvent.setup();
    render(<WhatsAppTemplateDetails />);
    expect(await screen.findByRole("heading", { name: "appointment_reminder" })).toBeInTheDocument();
    expect(screen.getByText("Hi {{1}}, your appointment is tomorrow.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(mocks.push).toHaveBeenCalledWith(expect.stringMatching(/^\/dashboard\/integrations\/whatsapp\/templates\/17\/edit\?returnTo=/));
  });

  it("shows the saved media reference on media-header template details", async () => {
    mocks.get.mockResolvedValue({
      success: true,
      template: { ...template, headerType: "IMAGE", header: null, headerMediaUrl: "4::existing-meta-media" },
    });
    render(<WhatsAppTemplateDetails />);
    expect(await screen.findByText("4::existing-meta-media")).toBeInTheDocument();
  });

  it("loads an existing template, edits it, and submits through PUT", async () => {
    mocks.get.mockResolvedValue({ success: true, template });
    const user = userEvent.setup();
    await renderGuidedEditor("17");
    expect(await screen.findByRole("heading", { name: "Edit template" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expandOptionalSections();
    const body = screen.getByDisplayValue("Hi {{1}}, your appointment is tomorrow.");
    fireEvent.change(body, { target: { value: "Hi {{1}}, your appointment is next Monday." } });
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expandOptionalSections();
    await user.click(screen.getByRole("button", { name: "Save WhatsApp template changes" }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      "/api/whatsapp/templates/17",
      expect.objectContaining({ body: "Hi {{1}}, your appointment is next Monday.", examples: { "body:1": "Alex" } }),
    ));
    expect(mocks.push).toHaveBeenCalledWith(expect.stringMatching(/^\/dashboard\/integrations\/whatsapp\/templates\/17(?:\?returnTo=.*)?$/));
  });

  it("creates a new template through the add wizard", async () => {
    const user = userEvent.setup();
    await renderGuidedEditor();
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expandOptionalSections();
    await user.type(screen.getByLabelText(/Template name/), "new_offer");
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expandOptionalSections();
    await user.click(screen.getByRole("button", { name: "Save new WhatsApp template" }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/api/whatsapp/templates",
      expect.objectContaining({ name: "new_offer", category: "MARKETING" }),
    ));
    expect(mocks.push).toHaveBeenCalledWith("/dashboard/integrations/whatsapp/templates");
  });

  it("locks name and language for linked templates but allows reviewed content edits", async () => {
    mocks.get.mockResolvedValue({ success: true, template: { ...template, wabaTemplateId: 'meta-17', metaStatus: 'APPROVED' } });
    const user = userEvent.setup();
    await renderGuidedEditor("17");
    await screen.findByRole('heading', { name: 'Edit template' });
    expect(screen.getAllByRole('status').some(status => status.textContent?.includes('Name and language are fixed'))).toBe(true);
    await user.click(screen.getByRole('button', { name: /Next/ }));
    expandOptionalSections();
    expect(screen.getByLabelText(/Template name/)).toBeDisabled();
    expect(screen.getByLabelText('Language')).toBeDisabled();
    expect(screen.getByDisplayValue(template.body)).not.toBeDisabled();
  });

  it("blocks repeated submission and editing while a provider result is uncertain", async () => {
    mocks.get.mockResolvedValue({ success: true, template: { ...template, wabaTemplateId: 'meta-17', metaStatus: 'APPROVED', submissionStatus: 'submission_uncertain' } });
    render(<WhatsAppTemplateDetails />);
    await screen.findByRole('heading', { name: template.name });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Sync with Meta');
    expect(screen.queryByRole('button', { name: 'Submit to Meta' })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute('aria-disabled', 'true');
  });

  it("shows sync conflicts instead of reporting a silently complete synchronization", async () => {
    mocks.post.mockResolvedValue({ count: 1, skipped: [{ name: 'support_alert', reason: 'A concurrent edit was preserved.' }] });
    render(<WhatsAppTemplateLibrary />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sync from Meta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A concurrent edit was preserved.');
  });

  it("generates WhatsApp template copy with the existing text AI provider flow", async () => {
    mocks.post.mockImplementation((path: string) => {
      if (path === "/api/content/studio/social-message") {
        return Promise.resolve({ success: true, subject: "Appointment reminder", message: "Hi {{first_name}}, your appointment is at {{1}}. Reply to {{first_name}} here." });
      }
      return Promise.resolve({ success: true, template });
    });
    const user = userEvent.setup();
    await renderGuidedEditor();

    await user.click(screen.getByRole("button", { name: /Next/ }));
    expandOptionalSections();
    await user.type(screen.getByLabelText("WhatsApp AI brief"), "Remind customers about tomorrow's appointment");
    await user.click(screen.getByRole("button", { name: "Generate copy" }));

    await screen.findByRole("button", { name: "Apply generated copy" });
    expect(screen.getByLabelText("Body")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Apply generated copy" }));
    expect(screen.getByLabelText("Body")).toHaveValue("Hi {{1}}, your appointment is at {{2}}. Reply to {{1}} here.");
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/content/studio/social-message",
      expect.objectContaining({ platform: "whatsapp", persist: false }),
    );
  });

  it("uploads a custom media file after saving a WhatsApp draft", async () => {
    await renderGuidedEditor();

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expandOptionalSections();
    fireEvent.change(screen.getByLabelText(/Template name/), { target: { value: "media_offer" } });
    fireEvent.change(screen.getByDisplayValue("None"), { target: { value: "IMAGE" } });
    fireEvent.change(screen.getByLabelText("Upload file"), {
      target: { files: [new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "header.png", { type: "image/png" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expandOptionalSections();
    fireEvent.click(screen.getByRole("button", { name: "Save new WhatsApp template" }));

    await waitFor(() => expect(mocks.postForm).toHaveBeenCalledWith(
      "/api/whatsapp/templates/17/media",
      expect.any(FormData),
      expect.objectContaining({ onUploadProgress: expect.any(Function) }),
    ));
  }, 15_000);

  it("renders image, video, and document selections in the phone preview", async () => {
    const user = userEvent.setup();
    await renderGuidedEditor();
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expandOptionalSections();
    const headerType = screen.getByDisplayValue("None");

    await user.selectOptions(headerType, "IMAGE");
    fireEvent.change(screen.getByLabelText("Upload file"), {
      target: { files: [new File(["image"], "header.png", { type: "image/png" })] },
    });
    expect(screen.getByAltText("WhatsApp template header")).toHaveAttribute("src", expect.stringMatching(/^blob:/));

    await user.selectOptions(headerType, "VIDEO");
    fireEvent.change(screen.getByLabelText("Upload file"), {
      target: { files: [new File(["video"], "header.mp4", { type: "video/mp4" })] },
    });
    expect(screen.getByLabelText("WhatsApp template header video")).toHaveAttribute("src", expect.stringMatching(/^blob:/));

    await user.selectOptions(headerType, "DOCUMENT");
    fireEvent.change(screen.getByLabelText("Upload file"), {
      target: { files: [new File(["%PDF-test"], "offer.pdf", { type: "application/pdf" })] },
    });
    expect(screen.getByText("Document attached")).toBeInTheDocument();
  });

  it("keeps header and body examples independent in the preview and payload", async () => {
    mocks.get.mockResolvedValue({
      success: true,
      template: {
        ...template,
        header: "Hello {{1}}",
        body: "Order {{1}} is ready.",
        examples: { "header:1": "Customer", "body:1": "ORDER-42" },
      },
    });
    const user = userEvent.setup();
    await renderGuidedEditor("17");
    await screen.findByRole("heading", { name: "Edit template" });
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expandOptionalSections();

    expect(screen.getByLabelText("Example for header {{1}}")).toHaveValue("Customer");
    expect(screen.getByLabelText("Example for body {{1}}")).toHaveValue("ORDER-42");
    expect(screen.getByText("Hello Customer")).toBeInTheDocument();
    expect(screen.getByText("Order ORDER-42 is ready.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Next/ }));
    expandOptionalSections();
    await user.click(screen.getByRole("button", { name: "Save WhatsApp template changes" }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      "/api/whatsapp/templates/17",
      expect.objectContaining({ examples: { "header:1": "Customer", "body:1": "ORDER-42" } }),
    ));
  });

  it("blocks non-contiguous Meta variables with a useful error", async () => {
    const user = userEvent.setup();
    await renderGuidedEditor();
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expandOptionalSections();
    await user.type(screen.getByLabelText(/Template name/), "gap_test");
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Hello {{2}}" } });
    expect(screen.getByRole("alert")).toHaveTextContent("start at {{1}} and continue without gaps");
    expect(screen.getByRole("button", { name: /Next/ })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByRole("button", { name: "Submit to Meta" })).toBeDisabled();
  });

  it("clears stale header media when the header type changes", async () => {
    mocks.get.mockResolvedValue({
      success: true,
      template: { ...template, headerType: "IMAGE", header: null, headerMediaUrl: "https://cdn.example.com/old-header.png" },
    });
    const user = userEvent.setup();
    await renderGuidedEditor("17");

    await screen.findByRole("heading", { name: "Edit template" });
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expandOptionalSections();
    await user.selectOptions(screen.getByDisplayValue("Image"), "NONE");
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expandOptionalSections();
    await user.click(screen.getByRole("button", { name: "Save WhatsApp template changes" }));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      "/api/whatsapp/templates/17",
      expect.objectContaining({ headerType: "NONE", headerMediaUrl: null }),
    ));
  });

  it("preserves an existing media reference when a user switches away and back", async () => {
    mocks.get.mockResolvedValue({
      success: true,
      template: { ...template, headerType: "IMAGE", header: null, headerMediaUrl: "https://cdn.example.com/old-header.png" },
    });
    const user = userEvent.setup();
    await renderGuidedEditor("17");

    await screen.findByRole("heading", { name: "Edit template" });
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expandOptionalSections();
    await user.selectOptions(screen.getByDisplayValue("Image"), "VIDEO");
    await user.selectOptions(screen.getByDisplayValue("Video"), "IMAGE");
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expandOptionalSections();
    await user.click(screen.getByRole("button", { name: "Save WhatsApp template changes" }));

    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(
      "/api/whatsapp/templates/17",
      expect.objectContaining({ headerType: "IMAGE", headerMediaUrl: "https://cdn.example.com/old-header.png" }),
    ));
  });

  it("filters saved templates by Meta status and paginates the result set", async () => {
    const records = Array.from({ length: 7 }, (_, index) => ({
      ...template,
      id: index + 1,
      name: `template_${index + 1}`,
      wabaTemplateId: index === 6 ? "meta-7" : null,
      metaStatus: index === 6 ? "APPROVED" : null,
    }));
    mocks.get.mockResolvedValue({ success: true, templates: records });
    const user = userEvent.setup();
    render(<WhatsAppTemplateLibrary />);

    expect(await screen.findByText("template_1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("template_7")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Filter by status"), "APPROVED");
    expect(screen.getByText("template_7")).toBeInTheDocument();
    expect(screen.queryByText("template_1")).not.toBeInTheDocument();
  });
});
