import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TemplateSelector } from "@/components/outreach/TemplateSelector";
import CreatePostModal from "@/components/modals/CreatePostModal";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), toast: vi.fn(), onSelect: vi.fn(), onOpenChange: vi.fn(), onPostCreated: vi.fn(),
  accounts: [{ credentialId: 5, platform: "facebook", accountName: "Test Page", label: "Test Page" }],
  connectedPlatforms: ["facebook"], preferredForPlatform: vi.fn(), forPlatform: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ default: mocks }));
vi.mock("@/components/social-publishing/SocialPublisher", () => ({ SocialPublisher: ({ assetId, onPublished }: { assetId: number; onPublished: () => void }) => <button onClick={onPublished}>Complete publishing review for {assetId}</button> }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/contexts/PreferencesContext", () => ({ usePreferences: () => ({ preferences: { locale: "en-US", timezone: "UTC" }, formatDate: () => "September 8, 2026" }) }));
vi.mock("@/hooks/useOrganicPublishingAccounts", () => ({ useOrganicPublishingAccounts: () => ({ accounts: mocks.accounts, connectedPlatforms: mocks.connectedPlatforms, preferredForPlatform: mocks.preferredForPlatform, forPlatform: mocks.forPlatform, loading: false, error: null }) }));

const template = { id: 17, name: "Welcome template", type: "email", content: "Original {{firstname}}", subject: "Hi {{first_name}}", htmlContent: "<p>{{first_name}} {{link}}</p>", usageCount: 0, isApproved: true };
const rendered = { success: true, templateId: 17, templateVersion: 4, subject: "Server subject", content: "Exact server-rendered content", htmlContent: "<p>Server HTML</p>", brandContext: { provenance: { businessProfile: { id: 1 }, brandToolkit: { id: 2 } } } };
function setupGet(record: Record<string, unknown>, predefined = false) {
  mocks.get.mockImplementation(async (url: string) => {
    if (url.includes("/templates/predefined")) return predefined ? [record] : [];
    if (url.startsWith("/api/content/templates?")) return predefined ? [] : [record];
    if (url === "/api/leads/1") return { firstName: "Asha" };
    return [];
  });
}
function selector(leadId?: number) { render(<TemplateSelector open onOpenChange={mocks.onOpenChange} channel="email" onSelect={mocks.onSelect} leadId={leadId} />); }
function postModal() { render(<CreatePostModal open onOpenChange={mocks.onOpenChange} onPostCreated={mocks.onPostCreated} />); }
async function openPostTemplates() {
  const tab = screen.getByRole("tab", { name: /Template/ });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
  fireEvent.click(await screen.findByRole("button", { name: /Welcome template/ }));
}

describe("approved reusable template application", () => {
  it('fills HTML draft variables with escaped values and keeps the formatted draft', async () => {
    mocks.get.mockImplementation(async (url: string) => url.startsWith('/api/content/assets?')
      ? [{ id: 19, type: 'email_template', title: 'Formatted draft', content: JSON.stringify({ body: 'Hi {{first_name}}', htmlContent: '<p><b>{{first_name}}</b></p>' }) }]
      : []);
    selector();
    fireEvent.click(await screen.findByRole('button', { name: /Formatted draft/ }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'First Name' }), { target: { value: 'Asha & team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply Template' }));
    await waitFor(() => expect(mocks.onSelect).toHaveBeenCalledWith(expect.objectContaining({ content: 'Hi Asha & team', htmlContent: '<p><b>Asha &amp; team</b></p>' })));
  });
  beforeEach(() => {
    vi.clearAllMocks();
    setupGet(template);
    mocks.post.mockResolvedValue(rendered);
    mocks.preferredForPlatform.mockReturnValue(mocks.accounts[0]);
    mocks.forPlatform.mockReturnValue(mocks.accounts);
  });

  it("loads later template pages so older email templates remain available", async () => {
    mocks.get.mockImplementation(async (url: string) => {
      if (url === '/api/content/templates?type=email&limit=200&offset=0') return { templates: [template], total: 2 };
      if (url.includes('offset=1')) return { templates: [{ ...template, id: 18, name: 'Older saved email' }], total: 2 };
      return [];
    });
    selector();
    expect(await screen.findByRole('button', { name: /Older saved email/ })).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith('/api/content/templates?type=email&limit=200&offset=1');
  });

  it("keeps follow-up placeholders unresolved until delivery", async () => {
    render(<TemplateSelector open channel="email" selectionMode="follow-up" onSelect={mocks.onSelect} onOpenChange={mocks.onOpenChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /Welcome template/ }));
    await waitFor(() => expect(mocks.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 17, content: template.content, htmlContent: template.htmlContent })));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'First Name' })).not.toBeInTheDocument();
  });

  it("copies a generated email draft to a durable template before scheduling it", async () => {
    mocks.get.mockImplementation(async (url: string) => url.includes('/assets?') ? [{ id: 80, title: 'Generated email draft', content: JSON.stringify({ subject: 'Checking in', greeting: 'Hi {{first_name}},', body: 'Need help?', closing: 'Thanks', signature: 'Team', htmlContent: '<p>Hi {{first_name}}</p>' }) }] : []);
    mocks.post.mockResolvedValueOnce({ ...template, id: 99 });
    render(<TemplateSelector open channel="email" selectionMode="follow-up" onSelect={mocks.onSelect} onOpenChange={mocks.onOpenChange} />);
    fireEvent.click(await screen.findByRole('button', { name: /Generated email draft/ }));
    await waitFor(() => expect(mocks.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 99, source: 'template' })));
    expect(mocks.post).toHaveBeenCalledWith('/api/content/templates', expect.objectContaining({ type: 'email', content: 'Hi {{first_name}},\n\nNeed help?\n\nThanks\n\nTeam', subject: 'Checking in', htmlContent: '<p>Hi {{first_name}}</p>' }));
  });

  it("asks for variables without a lead and applies only the server-rendered snapshot", async () => {
    selector();
    fireEvent.click(await screen.findByRole("button", { name: /Welcome template/ }));
    const firstName = await screen.findByRole("textbox", { name: "First Name" });
    fireEvent.change(firstName, { target: { value: "Asha" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Link" }), { target: { value: "https://example.com" } });
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply Template" }));
    await waitFor(() => expect(mocks.onSelect).toHaveBeenCalledWith(expect.objectContaining({ content: rendered.content, subject: rendered.subject, htmlContent: rendered.htmlContent, sourceTemplateId: undefined, sourceTemplateVersion: undefined, brandContext: rendered.brandContext })));
    expect(mocks.post).toHaveBeenCalledWith("/api/content/templates/17/use", { variables: { "{{first_name}}": "Asha", "{{link}}": "https://example.com" } });
  });

  it("prefills canonical aliases from lead data but still waits for server validation", async () => {
    setupGet({ ...template, htmlContent: null });
    selector(1);
    fireEvent.click(await screen.findByRole("button", { name: /Welcome template/ }));
    expect(await screen.findByRole("textbox", { name: "First Name" })).toHaveValue("Asha");
    expect(mocks.onSelect).not.toHaveBeenCalled();
  });

  it("loads direct-message templates and assets for outreach channels", async () => {
    render(<TemplateSelector open onOpenChange={mocks.onOpenChange} channel="instagram" onSelect={mocks.onSelect} />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith("/api/content/templates?type=social_message&limit=200&offset=0"));
    expect(mocks.get).toHaveBeenCalledWith("/api/content/assets?type=social_dm");
  });

  it("can restrict follow-up selection to templates the scheduler can resolve", async () => {
    render(<TemplateSelector open onOpenChange={mocks.onOpenChange} channel="email" onSelect={mocks.onSelect} selectableSources={["template"]} />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith("/api/content/templates?type=email&limit=200&offset=0"));
    expect(mocks.get).not.toHaveBeenCalledWith("/api/content/templates/predefined?type=email");
    expect(mocks.get).not.toHaveBeenCalledWith("/api/content/assets?type=email_template");
  });

  it.each(["Approve this template before using it.", "The approved brand changed. Review and approve again.", "Resolve template variables before sending."])("keeps the picker open when the server says: %s", async (message) => {
    setupGet({ ...template, subject: null, htmlContent: null, content: "No placeholders" });
    mocks.post.mockRejectedValueOnce(new Error(message));
    selector();
    fireEvent.click(await screen.findByRole("button", { name: /Welcome template/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(mocks.onSelect).not.toHaveBeenCalled();
    expect(mocks.onOpenChange).not.toHaveBeenCalled();
  });

  it("also validates predefined templates rather than bypassing their approval", async () => {
    setupGet({ ...template, subject: null, htmlContent: null, content: "No placeholders" }, true);
    selector();
    fireEvent.click(await screen.findByRole("button", { name: /Welcome template/ }));
    await waitFor(() => expect(mocks.onSelect).toHaveBeenCalled());
    expect(mocks.post).toHaveBeenCalledWith("/api/content/templates/17/use", { variables: {} });
  });

  it("does not apply a malformed successful response", async () => {
    setupGet({ ...template, subject: null, htmlContent: null, content: "No placeholders" });
    mocks.post.mockResolvedValueOnce({ success: true });
    selector();
    fireEvent.click(await screen.findByRole("button", { name: /Welcome template/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
    expect(mocks.onSelect).not.toHaveBeenCalled();
  });

  it("guards repeated clicks while template validation is in flight", async () => {
    setupGet({ ...template, subject: null, htmlContent: null, content: "No placeholders" });
    let finish!: (value: typeof rendered) => void;
    mocks.post.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    selector();
    const card = await screen.findByRole("button", { name: /Welcome template/ });
    fireEvent.click(card);
    fireEvent.click(card);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await act(async () => { finish(rendered); });
    expect(mocks.onSelect).toHaveBeenCalledTimes(1);
  });

  it("uses rendered social template content in the post composer", async () => {
    setupGet({ ...template, type: "social", content: "Hello {{first_name}}", htmlContent: null, subject: null });
    postModal();
    await openPostTemplates();
    fireEvent.change(screen.getByLabelText("{{first_name}}"), { target: { value: "Asha" } });
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply template" }));
    expect(await screen.findByLabelText("Selected Template Caption · Version 4")).toHaveValue(rendered.content);
    expect(mocks.post).toHaveBeenCalledWith("/api/content/templates/17/use", { variables: { "{{first_name}}": "Asha" } });
    expect(mocks.onPostCreated).not.toHaveBeenCalled();
  });

  it("does not substitute unvalidated content when the post composer receives a stale-brand failure", async () => {
    setupGet({ ...template, type: "social", content: "No placeholders", htmlContent: null, subject: null });
    mocks.post.mockRejectedValueOnce(new Error("Review the updated brand context first."));
    postModal();
    await openPostTemplates();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "Review the updated brand context first.", variant: "destructive" })));
    expect(screen.queryByLabelText(/Selected Template Caption/)).not.toBeInTheDocument();
    expect(mocks.onPostCreated).not.toHaveBeenCalled();
  });

  it.each([false, true])("uses selected owned brand context for synchronous generation without exposing predefined creator context (predefined=%s)", async (isPredefined) => {
    setupGet({ ...template, type: "social", content: "No placeholders", htmlContent: null, subject: null, isPredefined });
    postModal();
    await openPostTemplates();
    await screen.findByLabelText("Selected Template Caption · Version 4");
    const tab = screen.getByRole("tab", { name: "AI Generate" });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    fireEvent.change(screen.getByPlaceholderText("Describe what you want to generate..."), { target: { value: "A product announcement" } });
    mocks.post.mockResolvedValueOnce({ success: true, caption: "Generated caption" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Generate Content" })); });
    const generation = mocks.post.mock.calls.find(([url]) => url === "/api/content/studio/social")!;
    expect(generation[1]).toMatchObject({ prompt: "A product announcement", persist: false });
    if (isPredefined) {
      expect(generation[1]).not.toHaveProperty("businessProfileId");
      expect(generation[1]).not.toHaveProperty("brandToolkitId");
    } else {
      expect(generation[1]).toMatchObject({ businessProfileId: 1, brandToolkitId: 2 });
    }
  });

  it("preserves the server-rendered template version and owned brand lineage in the created post", async () => {
    setupGet({ ...template, type: "social", content: "No placeholders", htmlContent: null, subject: null });
    mocks.post.mockImplementation(async (url: string) => {
      if (url.endsWith("/use")) return rendered;
      if (url === "/api/content/assets") return { id: 41 };
      return { success: true, results: { facebook: { success: true, status: "succeeded" } } };
    });
    postModal();
    await openPostTemplates();
    await screen.findByLabelText("Selected Template Caption · Version 4");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue to publishing review" })); });
    expect(mocks.post).toHaveBeenCalledWith("/api/content/assets", expect.objectContaining({
      content: rendered.content, sourceTemplateId: 17, sourceTemplateVersion: 4,
      businessProfileId: 1, brandToolkitId: 2,
    }));
    expect(mocks.onPostCreated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Complete publishing review for 41' }));
    expect(mocks.onPostCreated).toHaveBeenCalled();
  });
});
