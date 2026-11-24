import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WhatsAppTemplateEditor from "@/components/whatsapp-templates/WhatsAppTemplateEditor";
import { WhatsAppPreview } from "@/components/whatsapp-templates/WhatsAppPreview";
import { ApiError } from "@/lib/api-client";
import { editWhatsAppText, formatWhatsAppSelection, nextWhatsAppVariable } from "@/lib/whatsapp-template-text";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), postForm: vi.fn(), put: vi.fn(), push: vi.fn(), toast: vi.fn(),
  params: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }), useSearchParams: () => mocks.params }));
vi.mock("@/lib/api", async () => { const { ApiError } = await import("@/lib/api-client"); return { ApiError, default: { ...mocks, get: (path: string) => path === "/api/whatsapp/config" ? Promise.resolve({ configured: true, config: { businessAccountId: "test-waba", wabaName: "Test Business", connectionStatus: "ready", tokenStatus: "valid" } }) : mocks.get(path) } }; });
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: 7, businessProfileId: 11 }, isAuthenticated: true, isLoading: false }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

function expandOptionalSections() {
  document.querySelectorAll<HTMLDetailsElement>("details").forEach((details) => {
    if (!details.open) fireEvent.click(details.querySelector("summary")!);
  });
}
function addComponent(name: string) {
  const toggle = screen.getByRole("button", { name: "Template components" });
  if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("button", { name }));
  expandOptionalSections();
}

const template = {
  id: 17, name: "appointment_reminder", language: "en_US", category: "UTILITY", status: "DRAFT",
  headerType: "TEXT", header: "Appointment update", body: "Hi {{1}}, your appointment is tomorrow.",
  footer: "Reply for help", buttons: [{ type: "URL", text: "View details", url: "https://example.com/appointment" }],
  examples: { "body:1": "Alex" }, wabaTemplateId: null, metaStatus: null, hasLocalChanges: true,
};

function renderEditor(props: { templateId?: string } = {}) {
  const view = render(<WhatsAppTemplateEditor {...props} />);
  expandOptionalSections();
  return view;
}

describe("WhatsApp builder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.setItem("user", JSON.stringify({ id: 7 }));
    mocks.params = new URLSearchParams();
    mocks.get.mockResolvedValue({ success: true, template });
    mocks.post.mockResolvedValue({ success: true, template });
    mocks.put.mockResolvedValue({ success: true, template });
    mocks.postForm.mockResolvedValue({ success: true, url: "/uploads/header.png", template });
  });

  it("starts blank with no promotional message or action and keeps optional sections collapsed", () => {
    render(<WhatsAppTemplateEditor />);
    expect(screen.getByLabelText("Body")).toHaveValue("");
    expect(screen.getByLabelText("Footer")).toHaveValue("");
    expect(screen.queryByLabelText("Button 1 text")).not.toBeInTheDocument();
    expect(screen.queryByText("Shop now")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Marketing" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Template components" })).toHaveAttribute("aria-expanded", "false");
    expect([...document.querySelectorAll("details")].every(details => !details.open)).toBe(true);
  });

  it("saves unfinished text and buttons as a draft while preventing approval submission", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText(/Template name/), { target: { value: "unfinished_message" } });
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Hello {{2}}" } });
    addComponent("Add URL button");
    fireEvent.click(screen.getByRole("button", { name: "Review template" }));
    expect(screen.getByRole("button", { name: "Submit to Meta" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /View checklist/ }));
    const checklist = within(screen.getByRole("region", { name: "Submission checklist" }));
    expect(checklist.getByRole("button", { name: "Fix the message body" })).toBeInTheDocument();
    expect(checklist.getByRole("button", { name: "Complete button 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save new WhatsApp template" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/whatsapp/templates", expect.objectContaining({ draftOnly: true, body: "Hello {{2}}", examples: { "body:2": "" }, buttons: [{ type: "URL", text: "Visit website", url: "" }] })));
    expect(mocks.post.mock.calls.some(([path]) => path.includes("/submit"))).toBe(false);
  });

  it("uses dedicated authentication configuration and an OTP preview instead of URL buttons", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText(/Template name/), { target: { value: "verification_code" } });
    fireEvent.click(screen.getByRole("button", { name: "Authentication" }));
    expect(screen.queryByLabelText("Body")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Template components" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("OTP button type")).toHaveValue("COPY_CODE");
    fireEvent.change(screen.getByLabelText("OTP button label"), { target: { value: "Copy verification code" } });
    const phone = within(screen.getByRole("region", { name: "Template preview" }));
    expect(phone.getByText(/Your verification code is 123456/)).toBeInTheDocument();
    expect(phone.getByText("Copy verification code")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save new WhatsApp template" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/whatsapp/templates", expect.objectContaining({ category: "AUTHENTICATION", draftOnly: true, headerType: "NONE", buttons: [], authConfig: expect.objectContaining({ otpType: "COPY_CODE", buttonText: "Copy verification code" }) })));
  });

  it("requires Android settings for one-tap approval but still allows an incomplete draft", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText(/Template name/), { target: { value: "android_verification" } });
    fireEvent.click(screen.getByRole("button", { name: "Authentication" }));
    fireEvent.change(screen.getByLabelText("OTP button type"), { target: { value: "ONE_TAP" } });
    expect(screen.getByLabelText("Android package name")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review template" }));
    expect(screen.getByRole("button", { name: "Submit to Meta" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save new WhatsApp template" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Back to builder" }));
    fireEvent.change(screen.getByLabelText("Autofill button label"), { target: { value: "Use code" } });
    fireEvent.change(screen.getByLabelText("Android package name"), { target: { value: "com.example.app" } });
    fireEvent.change(screen.getByLabelText("App signature hash"), { target: { value: "123456789Ab" } });
    fireEvent.click(screen.getByRole("button", { name: "Review template" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit to Meta" })).toBeEnabled());
  });

  it("preserves current copy until an AI suggestion is applied and supports undo", async () => {
    mocks.post.mockResolvedValue({ success: true, subject: "Suggested header", message: "Suggested appointment reminder." });
    renderEditor();
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "My original message." } });
    fireEvent.change(screen.getByLabelText("WhatsApp AI brief"), { target: { value: "An appointment reminder" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate copy" }));
    await screen.findByRole("button", { name: "Apply generated copy" });
    expect(screen.getByLabelText("Body")).toHaveValue("My original message.");
    fireEvent.click(screen.getByRole("button", { name: "Apply generated copy" }));
    expect(screen.getByLabelText("Body")).toHaveValue("Suggested appointment reminder.");
    expect(screen.getByLabelText("Header text")).toHaveValue("Suggested header");
    fireEvent.click(screen.getByRole("button", { name: "Undo applied AI copy" }));
    expect(screen.getByLabelText("Body")).toHaveValue("My original message.");
    expect(screen.queryByLabelText("Header text")).not.toBeInTheDocument();
  });

  it("rejects an oversized AI suggestion without truncating it or replacing current copy", async () => {
    mocks.post.mockResolvedValue({ success: true, message: "x".repeat(1025) });
    renderEditor();
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "My original message." } });
    fireEvent.change(screen.getByLabelText("WhatsApp AI brief"), { target: { value: "Write a reminder" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate copy" }));
    expect(await screen.findByRole("button", { name: "Apply generated copy" })).toBeDisabled();
    expect(screen.getByText("x".repeat(1025))).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("exceeds the message limits");
    expect(screen.getByLabelText("Body")).toHaveValue("My original message.");
  });

  it.each([undefined, "17"])("opens in Builder on create/edit (%s)", async (templateId) => {
    renderEditor({ templateId });
    expect(await screen.findByRole("button", { name: "Builder" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText(/Template name/)).toBeInTheDocument();
    expect(screen.getByLabelText("Body")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Template preview" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  it("preserves draft fields and an uploaded file when switching views, then saves that file", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText(/Template name/), { target: { value: "image_offer" } });
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "A new offer for you." } });
    fireEvent.change(screen.getByLabelText("Footer"), { target: { value: "Offer ends Friday" } });
    addComponent("Add URL button");
    fireEvent.change(screen.getByLabelText("Button 1 text"), { target: { value: "Browse offers" } });
    fireEvent.change(screen.getByLabelText("Button 1 URL"), { target: { value: "https://example.com" } });
    addComponent("Add image header");
    const file = new File(["image"], "offer.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Upload file"), { target: { files: [file] } });
    const previewUrl = screen.getByAltText("WhatsApp template header").getAttribute("src");
    fireEvent.click(screen.getByRole("button", { name: "Guided" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByLabelText("Body")).toHaveValue("A new offer for you.");
    expect(screen.getByLabelText("Footer")).toHaveValue("Offer ends Friday");
    expect(screen.getByLabelText("Button 1 text")).toHaveValue("Browse offers");
    expect(screen.getByLabelText("Replace file")).toBeInTheDocument();
    expect(screen.getByAltText("WhatsApp template header")).toHaveAttribute("src", previewUrl);
    fireEvent.click(screen.getByRole("button", { name: "Builder" }));
    expect(screen.getByAltText("WhatsApp template header")).toHaveAttribute("src", previewUrl);
    fireEvent.click(screen.getByRole("button", { name: "Save new WhatsApp template" }));
    await waitFor(() => expect(mocks.postForm).toHaveBeenCalled());
    expect(mocks.postForm.mock.calls[0][1].get("file")).toBe(file);
    expect(mocks.post.mock.calls[0][1]).toMatchObject({ body: "A new offer for you.", footer: "Offer ends Friday" });
  });

  it("inserts independently numbered header/body variables at the cursor and previews their examples", async () => {
    const user = userEvent.setup();
    renderEditor();
    addComponent("Add text header");
    const header = screen.getByLabelText("Header text") as HTMLInputElement;
    const body = screen.getByLabelText("Body") as HTMLTextAreaElement;
    fireEvent.change(header, { target: { value: "Hello " } });
    header.setSelectionRange(6, 6);
    await user.click(screen.getByRole("button", { name: "Add header variable" }));
    fireEvent.change(body, { target: { value: "Order  is ready." } });
    body.setSelectionRange(6, 6);
    await user.click(screen.getByRole("button", { name: "Add body variable" }));
    expect(header).toHaveValue("Hello {{1}}");
    expect(body).toHaveValue("Order {{1}} is ready.");
    expect(screen.getByLabelText("Example for header {{1}}")).toHaveValue("");
    expect(screen.getByLabelText("Example for body {{1}}")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Review template" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Example for header {{1}}"), { target: { value: "Customer" } });
    fireEvent.change(screen.getByLabelText("Example for body {{1}}"), { target: { value: "ORDER-42" } });
    const phone = within(screen.getByRole("region", { name: "Template preview" }));
    expect(phone.getByText("Hello Customer")).toBeInTheDocument();
    expect(phone.getByText("Order ORDER-42 is ready.")).toBeInTheDocument();
  });

  it.each([
    ["Bold text", "*", "strong"], ["Italic text", "_", "em"],
    ["Strikethrough text", "~", "s"], ["Monospace text", "```", "code"],
  ])("stores WhatsApp delimiters and previews %s", async (action, delimiter, tag) => {
    renderEditor();
    const body = screen.getByLabelText("Body") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "Hello there" } });
    body.setSelectionRange(0, 5);
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(body).toHaveValue(`${delimiter}Hello${delimiter} there`);
    const phone = screen.getByRole("region", { name: "Template preview" });
    expect(phone.querySelector(tag)).toHaveTextContent("Hello");
  });

  it("keeps descriptive variable labels connected to numbered examples and the saved payload", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText(/Template name/), { target: { value: "named_variables" } });
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Hello {{1}}" } });
    fireEvent.change(screen.getByLabelText("Label for body {{1}}"), { target: { value: "Customer name" } });
    fireEvent.change(screen.getByLabelText("Example for body {{1}}"), { target: { value: "Alex" } });
    expect(screen.getByText("Variables: Customer name")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Template preview" })).getByText("Hello Alex")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save new WhatsApp template" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/whatsapp/templates", expect.objectContaining({ body: "Hello {{1}}", variableLabels: { "body:1": "Customer name" }, examples: { "body:1": "Alex" } })));
  });

  it("toggles placeholders and sample values without modifying saved template content", () => {
    const { container } = render(<WhatsAppPreview variant="phone" showControls body="Hello {{1}}" examples={{ "body:1": "Alex" }} variableLabels={{ "body:1": "Customer name" }} />);
    expect(container.textContent).toContain("Hello Alex");
    fireEvent.click(screen.getByRole("button", { name: "Show sample values in preview" }));
    expect(container.textContent).toContain("Hello {{1}}");
    expect(screen.getByRole("button", { name: "Show sample values in preview" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Show sample values in preview" }));
    expect(container.textContent).toContain("Hello Alex");
  });

  it("keeps formatting and variable insertion within the character limits", () => {
    renderEditor();
    const body = screen.getByLabelText("Body") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "a".repeat(1024) } });
    body.setSelectionRange(1024, 1024);
    fireEvent.click(screen.getByRole("button", { name: "Add body variable" }));
    expect(body).toHaveValue("a".repeat(1024));
    expect(screen.getByRole("alert")).toHaveTextContent("1024-character limit");
    addComponent("Add text header");
    fireEvent.change(screen.getByLabelText("Header text"), { target: { value: "h".repeat(60) } });
    fireEvent.click(screen.getByRole("button", { name: "Add header variable" }));
    expect(screen.getByLabelText("Header text")).toHaveValue("h".repeat(60));
    expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("60-character limit"))).toBe(true);
  });

  it("limits buttons to three, reorders their complete data, and never saves drag identifiers", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText(/Template name/), { target: { value: "button_order" } });
    addComponent("Add URL button");
    fireEvent.change(screen.getByLabelText("Button 1 URL"), { target: { value: "https://example.com" } });
    addComponent("Add quick reply");
    addComponent("Add phone call");
    fireEvent.click(screen.getByRole("button", { name: "Template components" }));
    expect(screen.getByRole("button", { name: "Add URL button" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add button" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Button 3 phone number"), { target: { value: "+14155550123" } });
    fireEvent.click(screen.getByRole("button", { name: "Move button 3 up" }));
    expect(screen.getByLabelText("Button 2 text")).toHaveValue("Call us");
    expect(screen.getByLabelText("Button 2 phone number")).toHaveValue("+14155550123");
    fireEvent.click(screen.getByRole("button", { name: "Save new WhatsApp template" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/whatsapp/templates", expect.anything()));
    const savedButtons = mocks.post.mock.calls[0][1].buttons;
    expect(savedButtons).toEqual([
      { type: "URL", text: "Visit website", url: "https://example.com" },
      { type: "PHONE_NUMBER", text: "Call us", phone_number: "+14155550123" },
      { type: "QUICK_REPLY", text: "Reply" },
    ]);
  });

  it("returns from review to the builder and saves before submitting to Meta", async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText(/Template name/), { target: { value: "reviewed_offer" } });
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "An offer is available." } });
    expect(screen.queryByRole("button", { name: "Submit to Meta" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review template" }));
    expect(screen.getByRole("heading", { name: "Review your template" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to builder" }));
    expect(screen.getByLabelText(/Template name/)).toHaveValue("reviewed_offer");
    fireEvent.click(screen.getByRole("button", { name: "Review template" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit to Meta" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Submit to Meta" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/whatsapp/templates/17/submit", {}));
    expect(mocks.post.mock.calls.map(([path]) => path)).toEqual(["/api/whatsapp/templates", "/api/whatsapp/templates/17/submit"]);
  });

  it("blocks retries after a stale revision conflict and preserves both messages for comparison", async () => {
    mocks.get.mockResolvedValue({ template: { ...template, revision: "revision-1" } });
    renderEditor({ templateId: "17" });
    await screen.findByDisplayValue(template.name);
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "My unsaved revision." } });
    mocks.get.mockResolvedValue({ template: { ...template, body: "Saved by another editor.", revision: "revision-2" } });
    mocks.put.mockRejectedValueOnce(new ApiError("This template has changed. Reload it before saving.", 409));
    fireEvent.click(screen.getByRole("button", { name: "Save WhatsApp template changes" }));
    await screen.findByText("This template was changed in another editor");
    expect(screen.getByLabelText("Body")).toHaveValue("My unsaved revision.");
    expect(mocks.put).toHaveBeenCalledWith("/api/whatsapp/templates/17", expect.objectContaining({ clientRevision: "revision-1", body: "My unsaved revision." }));
    expect(screen.getByRole("button", { name: "Save WhatsApp template changes" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save WhatsApp template changes" }));
    expect(mocks.put).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Compare messages"));
    expect(screen.getByText("Saved by another editor.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review template" }));
    expect(screen.getByRole("button", { name: "Submit to Meta" })).toBeDisabled();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload latest saved version" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back to builder" }));
    await screen.findByDisplayValue("Saved by another editor.");
    expect(screen.getByRole("button", { name: "Save WhatsApp template changes" })).toBeEnabled();
    expect(mocks.put).toHaveBeenCalledOnce();
    confirm.mockRestore();
  }, 15_000);

  it("loads and edits an existing draft through PUT", async () => {
    renderEditor({ templateId: "17" });
    await screen.findByDisplayValue(template.name);
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Hi {{1}}, your appointment is Monday." } });
    fireEvent.click(screen.getByRole("button", { name: "Save WhatsApp template changes" }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith("/api/whatsapp/templates/17", expect.objectContaining({ body: "Hi {{1}}, your appointment is Monday.", examples: { "body:1": "Alex" } })));
  });

  it("locks identity and category for approved linked templates while allowing content edits", async () => {
    mocks.get.mockResolvedValue({ template: { ...template, wabaTemplateId: "meta-17", metaStatus: "APPROVED" } });
    renderEditor({ templateId: "17" });
    await screen.findByDisplayValue(template.name);
    expect(screen.getByLabelText(/Template name/)).toBeDisabled();
    expect(screen.getByLabelText("Language")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Marketing" })).toBeDisabled();
    expect(screen.getByLabelText("Body")).not.toBeDisabled();
  });

  it.each([
    { metaStatus: "PENDING" }, { metaStatus: "APPROVED", submissionStatus: "submission_uncertain" },
  ])("blocks editing for a template awaiting synchronization (%j)", async (state) => {
    mocks.get.mockResolvedValue({ template: { ...template, wabaTemplateId: "meta-17", ...state } });
    renderEditor({ templateId: "17" });
    await screen.findByDisplayValue(template.name);
    expect(screen.getByLabelText("Body")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Template components" }));
    expect(screen.getByRole("button", { name: "Add image header" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add body variable" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save WhatsApp template changes" })).toBeDisabled();
  });

  it("keeps identity conflicts from being submitted through review", async () => {
    mocks.get.mockResolvedValue({ template: { ...template, submissionStatus: "identity_conflict" } });
    renderEditor({ templateId: "17" });
    await screen.findByDisplayValue(template.name);
    fireEvent.click(screen.getByRole("button", { name: "Review template" }));
    expect(screen.getByRole("button", { name: "Submit to Meta" })).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("formats preview text safely and preserves literal unmatched delimiters and identifiers", () => {
    const { container } = render(<WhatsAppPreview variant="phone" body={'*Hello _Alex_* ~old~ ```*literal*``` <img src=x onerror=alert(1)> account_id_42 *unfinished'} />);
    expect(container.querySelector("strong em")).toHaveTextContent("Alex");
    expect(container.querySelector("s")).toHaveTextContent("old");
    expect(container.querySelector("code")).toHaveTextContent("*literal*");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.textContent).toContain("account_id_42 *unfinished");
  });

  it("lets unfinished work be saved and takes the user to a missing submission field and takes the user to the missing field", async () => {
    renderEditor();
    expect(screen.getByRole("button", { name: "Save new WhatsApp template" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Add a template name" }));
    await waitFor(() => expect(screen.getByLabelText(/Template name/)).toHaveFocus());
  });

  it("replaces a selected variable without introducing a numbering gap or clearing its example", async () => {
    renderEditor({ templateId: "17" });
    await screen.findByDisplayValue(template.name);
    const body = screen.getByLabelText("Body") as HTMLTextAreaElement;
    body.setSelectionRange(3, 8);
    fireEvent.click(screen.getByRole("button", { name: "Add body variable" }));
    expect(body).toHaveValue(template.body);
    expect(screen.getByLabelText("Example for body {{1}}")).toHaveValue("Alex");
    expect(screen.getByRole("button", { name: "Review template" })).toBeEnabled();
  });

  it("keeps missing examples visible and treats example text as literal content", () => {
    const { container, rerender } = render(<WhatsAppPreview variant="phone" body="Hello {{1}}" examples={{ "body:1": "" }} />);
    expect(container.textContent).toContain("Hello {{1}}");
    rerender(<WhatsAppPreview variant="phone" body="Hello {{1}}" examples={{ "body:1": "Customer {{2}}" }} />);
    expect(container.textContent).toContain("Hello Customer {{2}}");
  });

  it("keeps a failed media upload in the editor and retries the saved draft with the same file", async () => {
    mocks.postForm.mockRejectedValueOnce(new Error("Upload interrupted"));
    renderEditor();
    fireEvent.change(screen.getByLabelText(/Template name/), { target: { value: "retry_image" } });
    addComponent("Add image header");
    const file = new File(["image"], "retry.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Upload file"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Save new WhatsApp template" }));
    await waitFor(() => expect(mocks.postForm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save new WhatsApp template" })).toBeEnabled());
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert").some(alert => alert.textContent?.includes("Upload interrupted"))).toBe(true);
    expect(screen.getByLabelText("Replace file")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save new WhatsApp template" }));
    await waitFor(() => expect(mocks.postForm).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls.filter(([path]) => path === "/api/whatsapp/templates")).toHaveLength(1);
    expect(mocks.put).toHaveBeenCalledWith("/api/whatsapp/templates/17", expect.anything());
    expect(mocks.postForm.mock.calls[1][1].get("file")).toBe(file);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(1));
  });

  it("allows choosing the same file after removing it", async () => {
    const user = userEvent.setup();
    renderEditor();
    addComponent("Add image header");
    const file = new File(["image"], "same.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload file"), file);
    expect(screen.getByLabelText("Replace file")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Remove file" }));
    await user.upload(screen.getByLabelText("Upload file"), file);
    expect(screen.getByLabelText("Replace file")).toBeInTheDocument();
  });

  it("blocks edits and saving while AI generation is in flight", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.post.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderEditor();
    fireEvent.change(screen.getByLabelText(/Template name/), { target: { value: "ai_race" } });
    fireEvent.change(screen.getByLabelText("WhatsApp AI brief"), { target: { value: "An appointment reminder" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate copy" }));
    expect(screen.getByLabelText("Body")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save new WhatsApp template" })).toBeDisabled();
    finish({ success: true, message: "Your appointment is tomorrow." });
    await screen.findByRole("button", { name: "Apply generated copy" });
    expect(screen.getByLabelText("Body")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Apply generated copy" }));
    expect(screen.getByLabelText("Body")).toHaveValue("Your appointment is tomorrow.");
    expect(screen.getByLabelText("Body")).toBeEnabled();
  });

  it("matches the server's limit of twenty variable examples", async () => {
    mocks.get.mockResolvedValue({ template: { ...template, headerType: "NONE", header: null, body: Array.from({ length: 21 }, (_, index) => `{{${index + 1}}}`).join(" "), examples: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`body:${index + 1}`, `Sample ${index + 1}`])) } });
    renderEditor({ templateId: "17" });
    await screen.findByDisplayValue(template.name);
    expect(screen.getByRole("button", { name: "Review template" })).toBeEnabled();
    expect(screen.getByText(/Up to 20 variable examples/)).toBeInTheDocument();
  });
});

describe("WhatsApp cursor edits", () => {
  it("preserves surrounding text and places the caret after an inserted variable", () => {
    expect(editWhatsAppText("Hello there", 6, 11, "{{1}}", 60)).toEqual({ value: "Hello {{1}}", selectionStart: 11, selectionEnd: 11 });
    expect(formatWhatsAppSelection("Hello there", 0, 5, "*")).toEqual({ value: "*Hello* there", selectionStart: 1, selectionEnd: 6 });
    expect(nextWhatsAppVariable("{{1}} {{1}} {{2}}")).toBe(3);
    expect(editWhatsAppText("h".repeat(60), 60, 60, "{{1}}", 60)).toBeNull();
  });

  it("toggles formatting around the current selection and fills a missing variable number", () => {
    expect(formatWhatsAppSelection("*Hello* there", 1, 6, "*")).toEqual({ value: "Hello there", selectionStart: 0, selectionEnd: 5 });
    expect(nextWhatsAppVariable("{{2}}")).toBe(1);
  });
});
