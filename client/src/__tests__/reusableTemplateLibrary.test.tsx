import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EmailPage from "@/app/dashboard/(main)/saved-templates/email/page";
import SmsPage from "@/app/dashboard/(main)/saved-templates/sms/page";
import SocialPage from "@/app/dashboard/(main)/saved-templates/social/page";
import DmPage from "@/app/dashboard/(main)/saved-templates/dm/page";
import BlogPage from "@/app/dashboard/(main)/saved-templates/blog/page";
import AdsPage from "@/app/dashboard/(main)/saved-templates/ads/page";
import { TemplatePreviewCard } from "@/components/content-library/TemplatePreviewCard";
import { TemplateVersionHistory } from "@/components/content-library/TemplateVersionHistory";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), push: vi.fn(), toast: vi.fn(), writeText: vi.fn(), refetchTemplates: vi.fn(), templates: [] as Record<string, unknown>[] }));
vi.mock("@/lib/api", () => ({ default: mocks }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/hooks/use-paginated-content-templates", () => ({ usePaginatedContentTemplates: ({ search }: { search: string }) => ({ templates: mocks.templates, total: mocks.templates.length, search: search.trim(), isLoading: false, isError: false, refetch: mocks.refetchTemplates, hasNextPage: false }) }));
vi.mock("@/components/ui/masonry-grid", () => ({ MasonryGrid: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/email-builder/DnDEmailBuilder", () => ({ default: () => <div>Drag and drop editor</div>, blocksToHtml: () => "", blocksToPlainText: () => "" }));
vi.mock("@/components/RichTextEditor", () => ({ default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label="Email rich text" value={value} onChange={(event) => onChange(event.target.value)} /> }));
vi.mock("@/components/social-publishing/SocialPublisher", () => ({ SocialPublisher: () => null }));

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
function mount(element: React.ReactNode) { return render(<QueryClientProvider client={client()}>{element}</QueryClientProvider>); }
const template = { id: 17, name: "Reusable sample", type: "sms", content: "Hello {{first_name}}", description: "Old description", category: "facebook", tags: ["old"], createdAt: "2026-09-08T04:00:00.000Z", updatedAt: "2026-09-08T04:00:00.000Z" };
const history = [
  { id: 1, version: 1, createdAt: "2026-09-07T04:00:00.000Z", snapshot: { name: "First name", type: "email", content: "Original text", isApproved: false, htmlContent: '<p onmouseover="bad()">Original text</p><script>bad()</script>' } },
  { id: 2, version: 2, createdAt: "2026-09-08T04:00:00.000Z", snapshot: { name: "Updated name", type: "email", content: "Updated text", isApproved: true, variables: ["{{first_name}}"] } },
];

describe("reusable template library", () => {
  it.each([
    ['Search email templates', EmailPage, 'textbox'], ['Search SMS templates', SmsPage, 'searchbox'],
    ['Search social templates', SocialPage, 'searchbox'], ['Search DM templates', DmPage, 'textbox'],
    ['Search blog posts', BlogPage, 'textbox'], ['Search ad templates', AdsPage, 'searchbox'],
  ] as const)('keeps "%s" named while filtering and clearing', async (name, Page, role) => {
    mocks.templates = [template];
    mount(<Page />);
    expect(await screen.findByText('Reusable sample')).toBeVisible();
    const search = screen.getByRole(role, { name });
    expect(search).toHaveValue('');
    fireEvent.change(search, { target: { value: 'zzqa-no-match-20261009' } });
    expect(search).toHaveAccessibleName(name);
    expect(screen.queryByText('Reusable sample')).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: '' } });
    expect(search).toHaveAccessibleName(name);
    expect(await screen.findByText('Reusable sample')).toBeVisible();
  });

  it('preserves ad alternatives and destination when editing reusable ad copy', async () => {
    mocks.templates = [{ ...template, type: 'ad_copy', content: JSON.stringify({ headline: 'Original', primaryText: 'Readable ad', headlines: ['Alternative'], displayUrl: 'example.com', callToAction: 'Learn more', platform: 'facebook' }) }];
    mount(<AdsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Reusable sample' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByDisplayValue('Readable ad'), { target: { value: 'Edited ad' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/content/templates/17', expect.any(Object)));
    expect(JSON.parse(mocks.put.mock.calls[0][1].content)).toMatchObject({ body: 'Edited ad', primaryText: 'Edited ad', headlines: ['Alternative'], displayUrl: 'example.com' });
  });

  it('preserves blog SEO metadata while replacing stale article sections', async () => {
    mocks.templates = [{ ...template, type: 'blog', content: JSON.stringify({ title: 'Article', introduction: 'Old intro', sections: [{ heading: 'Old', content: 'Old section' }], seoTitle: 'Search title', metaDescription: 'Search summary', tags: ['qa'] }) }];
    mount(<BlogPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Reusable sample' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByDisplayValue(/Old intro/), { target: { value: 'Revised article' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/content/templates/17', expect.any(Object)));
    const saved = JSON.parse(mocks.put.mock.calls[0][1].content);
    expect(saved).toMatchObject({ title: 'Article', content: 'Revised article', seoTitle: 'Search title', metaDescription: 'Search summary', tags: ['qa'] });
    expect(saved.sections).toBeUndefined();
    expect(saved.introduction).toBeUndefined();
  });

  it.each([EmailPage, SmsPage, SocialPage, DmPage, BlogPage, AdsPage])('keeps reusable templates visible when saved drafts fail, then retries the missing source', async (Page) => {
    mocks.templates = [{ ...template, content: 'A saved message' }];
    mocks.get.mockRejectedValue(new Error('Saved drafts unavailable'));
    mount(<Page />);
    expect(await screen.findByText('Reusable sample')).toBeVisible();
    const retry = await screen.findByRole('button', { name: 'Retry missing content' });
    mocks.get.mockResolvedValue([]);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry missing content' })).not.toBeInTheDocument());
    expect(screen.getByText('Reusable sample')).toBeVisible();
  });
  it('saves a YouTube description and reusable video title', async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    mount(<SocialPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Build reusable template' }));
    fireEvent.change(screen.getByLabelText('Template Name'), { target: { value: 'Video tutorial' } });
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'YouTube description' }));
    fireEvent.change(screen.getByLabelText('YouTube description template'), { target: { value: 'Learn about {{product_name}}' } });
    fireEvent.change(screen.getByLabelText('Video title template (optional)'), { target: { value: '{{product_name}} tutorial' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/content/templates', expect.objectContaining({ category: 'youtube', subject: '{{product_name}} tutorial', content: 'Learn about {{product_name}}' })));
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.templates = [];
    mocks.get.mockResolvedValue([]);
    mocks.post.mockResolvedValue({ id: 18, version: 1 });
    mocks.put.mockResolvedValue({ id: 17, version: 2 });
    mocks.delete.mockResolvedValue({ success: true });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mocks.writeText } });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  });

  it.each([
    ["sms", SmsPage, "e.g. Follow-up reminder", "Hi {{first_name}}, just following up on..."],
    ["social", SocialPage, "e.g. LinkedIn intro message", "Hi {{first_name}}, I noticed you..."],
    ["social_message", DmPage, "e.g. LinkedIn intro message", "Hi {{first_name}}, I noticed you..."],
    ["blog", BlogPage, "e.g. Product Launch Announcement", "Write your blog post content here..."],
    ["ad_copy", AdsPage, "e.g. Summer Sale Facebook Ad", "Ad body copy..."],
  ] as const)("creates a reusable %s template without navigating or generating an asset", async (type, Page, namePlaceholder, contentPlaceholder) => {
    mount(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Build reusable template" }));
    fireEvent.change(screen.getByPlaceholderText(namePlaceholder), { target: { value: "Manual reusable template" } });
    fireEvent.change(screen.getByPlaceholderText(contentPlaceholder), { target: { value: "Hello {{first_name}}" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/content/templates", expect.objectContaining({ type, name: "Manual reusable template", content: expect.stringContaining("Hello {{first_name}}") })));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["email", EmailPage, "email", "Update Template", "Hello {{first_name}}"],
    ["sms", SmsPage, "sms", "Update", "Hello {{first_name}}"],
    ["social", SocialPage, "social", "Update", "Hello {{first_name}}"],
    ["DM", DmPage, "social_message", "Update", "Hello {{first_name}}"],
    ["blog", BlogPage, "blog", "Update", JSON.stringify({ title: "Launch notes", body: "Hello {{first_name}}" })],
    ["ad", AdsPage, "ad_copy", "Update", JSON.stringify({ headline: "Launch", body: "Hello {{first_name}}", callToAction: "Learn more", platform: "facebook" })],
  ] as const)("edits a reusable %s template and sends the update payload", async (_label, Page, type, saveButton, content) => {
    mocks.templates = [{ ...template, type, content }];
    mount(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Reusable sample" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByDisplayValue("Reusable sample"), { target: { value: "Edited reusable template" } });
    fireEvent.click(within(dialog).getByRole("button", { name: saveButton }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith("/api/content/templates/17", expect.objectContaining({ type, name: "Edited reusable template" })));
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it.each([
    [SocialPage, 'social', 'caption', { hashtags: ['#qa'], callToAction: 'Learn more' }],
    [DmPage, 'social_message', 'message', { context: 'Internal QA' }],
  ] as const)('edits structured %s template text without exposing JSON or losing metadata', async (Page, type, bodyKey, extra) => {
    mocks.templates = [{ ...template, type, category: 'linkedin', content: JSON.stringify({ [bodyKey]: 'Readable draft', platform: 'linkedin', ...extra }) }];
    mount(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Reusable sample' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByDisplayValue('Readable draft'), { target: { value: 'Edited draft' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/content/templates/17', expect.any(Object)));
    expect(JSON.parse(mocks.put.mock.calls[0][1].content)).toMatchObject({ [bodyKey]: 'Edited draft', platform: 'linkedin', ...extra });
  });

  it.each([
    ["email", EmailPage, "Create email draft", "/dashboard/saved-templates/email/generate"],
    ["sms", SmsPage, "Create SMS draft", "/dashboard/saved-templates/sms/generate"],
    ["social", SocialPage, "New Template", "/dashboard/saved-templates/social/generate"],
    ["DM", DmPage, "New Template", "/dashboard/saved-templates/dm/generate"],
    ["blog", BlogPage, "New Post", "/dashboard/saved-templates/blog/generate"],
    ["ad", AdsPage, "New Ad", "/dashboard/saved-templates/ads/generate"],
  ] as const)("routes the %s generator button without mutating templates", (_label, Page, button, route) => {
    mount(<Page />);
    fireEvent.click(screen.getByRole("button", { name: button }));
    expect(mocks.push).toHaveBeenCalledWith(route);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it.each([
    ["email", EmailPage, "No email templates yet", "Create Your First Template", "/dashboard/saved-templates/email/generate"],
    ["sms", SmsPage, "No SMS content in this collection", "Create Template", "/dashboard/saved-templates/sms/generate"],
    ["social", SocialPage, "No saved social posts yet", "Create post", "/dashboard/saved-templates/social/generate"],
    ["DM", DmPage, "No DM templates yet", "Create Template", "/dashboard/saved-templates/dm/generate"],
    ["blog", BlogPage, "No blog posts yet", "Create Post", "/dashboard/saved-templates/blog/generate"],
    ["ad", AdsPage, "No ad templates yet", "Create Ad", "/dashboard/saved-templates/ads/generate"],
  ] as const)("shows the %s empty library action and routes to its generator", async (_label, Page, emptyState, button, route) => {
    mocks.templates = [];
    mount(<Page />);
    expect(await screen.findByText(emptyState)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: button }));
    expect(mocks.push).toHaveBeenCalledWith(route);
  });

  it.each([
    ["sms", SmsPage, "/api/content/studio/sms", { content: "AI generated SMS body" }, "Hi {{first_name}}, just following up on...", "AI generated SMS body"],
    ["social", SocialPage, "/api/content/studio/social", { content: "AI generated social post" }, "Hi {{first_name}}, I noticed you...", "AI generated social post"],
    ["DM", DmPage, "/api/content/studio/social-message", { message: "AI generated direct message" }, "Hi {{first_name}}, I noticed you...", "AI generated direct message"],
    ["blog", BlogPage, "/api/content/studio/blog-post", { title: "AI blog title", content: "AI generated blog body" }, "Write your blog post content here...", "AI generated blog body"],
    ["ad", AdsPage, "/api/content/studio/ad-copy-content", { headline: "AI ad headline", primaryText: "AI generated ad body" }, "Ad body copy...", "AI generated ad body"],
  ] as const)("runs the %s reusable-form AI Generate button", async (_label, Page, endpoint, response, contentPlaceholder, generatedContent) => {
    mocks.post.mockResolvedValueOnce(response);
    mount(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Build reusable template" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "AI Generate" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(endpoint, expect.objectContaining({ persist: false })));
    expect(within(screen.getByRole("dialog")).getByPlaceholderText(contentPlaceholder)).toHaveValue(generatedContent);
  });

  it("runs the email builder AI Generate tab and keeps the generated HTML available for review", async () => {
    mocks.post.mockResolvedValueOnce({ content: "<p>AI welcome</p>", subject: "Welcome from AI" });
    mount(<EmailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Build reusable template" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "AI Generate" }));
    fireEvent.click(screen.getByRole("tab", { name: "AI Generate" }));
    fireEvent.change(screen.getByPlaceholderText(/^Create a professional welcome email/), { target: { value: "Create an onboarding email" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate Template" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/content/generate-email-template", { prompt: "Create an onboarding email" }));
    expect(screen.getByText("Template generated. Review in preview panel.")).toBeVisible();
    expect(screen.getByPlaceholderText(/^Create a professional welcome email/)).toHaveValue("Create an onboarding email");
  });

  it.each([
    ["email", EmailPage, "email", "Use in campaign", ["Preview Reusable sample"], []],
    ["sms", SmsPage, "sms", undefined, [], []],
    ["social", SocialPage, "social", undefined, [], ["Instagram", "Facebook", "Twitter / X", "LinkedIn"]],
    ["DM", DmPage, "social_message", "Use in outreach", [], ["Instagram", "Facebook", "Twitter / X", "LinkedIn"]],
    ["blog", BlogPage, "blog", undefined, ["Preview Reusable sample"], []],
    ["ad", AdsPage, "ad_copy", "Review campaign", [], ["Meta Ads", "Google Ads"]],
  ] as const)("exercises the %s library card controls", async (_label, Page, type, primary, previewButtons, platformButtons) => {
    mocks.templates = [{ ...template, type }];
    mount(<Page />);
    expect(await screen.findByText("Reusable sample")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy Reusable sample" }));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalled());

    for (const platform of platformButtons) {
      fireEvent.click(screen.getByRole("button", { name: platform }));
    }

    if (primary) {
      fireEvent.click(screen.getByRole("button", { name: primary }));
      if (primary === "Use in outreach") {
        expect(mocks.push).toHaveBeenCalledWith("/dashboard/outreach/facebook/create?message=Hello%20%7B%7Bfirst_name%7D%7D");
      } else if (primary === "Use in campaign") {
        expect(mocks.push).toHaveBeenCalledWith('/dashboard/outreach/email/create?sourceTemplateId=17');
      } else if (primary === "Review campaign") {
        expect(mocks.push).toHaveBeenCalledWith("/dashboard/saved-templates/ads/publish?templateId=17&from=%2Fdashboard%2Fsaved-templates%2Fads");
      } else {
        fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close" }));
      }
    }

    for (const previewButton of previewButtons) {
      fireEvent.click(screen.getByRole("button", { name: previewButton }));
      const preview = await screen.findByRole("dialog");
      expect(preview).toBeVisible();
      fireEvent.click(within(preview).getByRole("button", { name: "Close" }));
    }

    fireEvent.click(screen.getByRole("button", { name: "Version history for Reusable sample" }));
    const historyDialog = await screen.findByRole("dialog");
    expect(await within(historyDialog).findByText("No saved versions are available for this template.")).toBeVisible();
    fireEvent.click(within(historyDialog).getByRole("button", { name: "Close" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit Reusable sample" }));
    const editor = await screen.findByRole("dialog");
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete Reusable sample" }));
    const confirmation = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Reusable sample" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith("/api/content/templates/17"));
  });

  it("opens the real email builder and saves reusable HTML", async () => {
    mount(<EmailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Build reusable template" }));
    fireEvent.change(screen.getByPlaceholderText("e.g. Welcome Email"), { target: { value: "Reusable email" } });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Rich Text" }));
    fireEvent.click(screen.getByRole("tab", { name: "Rich Text" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Email rich text" }), { target: { value: "<p>Hello {{first_name}}</p>" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Template" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/content/templates", expect.objectContaining({ name: "Reusable email", type: "email", htmlContent: "<p>Hello {{first_name}}</p>", content: "Hello {{first_name}}" })));
  });

  it.each([SmsPage, SocialPage, DmPage, BlogPage, AdsPage, EmailPage])("shows history for reusable records but not same-ID generated assets", async (Page) => {
    mocks.templates = [template];
    mocks.get.mockResolvedValue([{ id: 17, type: "text_only", title: "Generated asset", content: "Asset text", createdAt: template.createdAt }]);
    mount(<Page />);
    expect(await screen.findByRole("button", { name: "Version history for Reusable sample" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Version history for Generated asset" })).not.toBeInTheDocument();
  });

  it("preserves form input and gives the actionable API error after save failure", async () => {
    mocks.post.mockRejectedValueOnce(new Error("Approve your brand toolkit before saving."));
    mount(<SmsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Build reusable template" }));
    fireEvent.change(screen.getByLabelText("Template Name"), { target: { value: "My draft" } });
    fireEvent.change(screen.getByLabelText("Message Content"), { target: { value: "Draft message" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "Approve your brand toolkit before saving.", variant: "destructive" })));
    expect(screen.getByLabelText("Message Content")).toHaveValue("Draft message");
  });

  it("allows clearing saved SMS metadata during edits", async () => {
    mocks.templates = [template];
    mount(<SmsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Reusable sample" }));
    fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Category (optional)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith("/api/content/templates/17", expect.objectContaining({ description: "", category: "" })));
  });

  it("preserves variable names and URL underscores in the library preview", async () => {
    mocks.templates = [{ ...template, content: "Hello {{first_name}} — https://example.com/workflow_note" }];
    mount(<SmsPage />);
    expect(await screen.findByText("Hello {{first_name}} — https://example.com/workflow_note")).toBeInTheDocument();
  });

  it("loads newest-first history on demand and safely previews an older snapshot", async () => {
    mocks.get.mockResolvedValue(history);
    mount(<TemplateVersionHistory templateId={17} templateName="Reusable sample" />);
    expect(mocks.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Version history for Reusable sample" }));
    expect(await screen.findByText("Updated text")).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith("/api/content/templates/17/versions");
    fireEvent.click(screen.getByRole("button", { name: /Version 1/ }));
    expect(screen.getByText("Original text")).toBeInTheDocument();
    const frame = screen.getByTitle("Email preview for version 1");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("srcdoc")).not.toMatch(/script|onmouseover/);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("cycles through every media carousel control on a template card", () => {
    render(
      <TemplatePreviewCard
        kind="video"
        title="Carousel draft"
        content="A media-backed draft"
        imageUrls={["/uploads/one.png", "/uploads/two.png"]}
        videoUrls={["/uploads/three.mp4"]}
      />,
    );
    expect(screen.getByText("1/3")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next media for Carousel draft" }));
    expect(screen.getByText("2/3")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Previous media for Carousel draft" }));
    expect(screen.getByText("1/3")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show media 3 for Carousel draft" }));
    expect(screen.getByText("3/3")).toBeVisible();
  });

  it("shows loading, retry and empty version-history states", async () => {
    let rejectLoad!: (error: Error) => void;
    mocks.get.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLoad = reject; }));
    mount(<TemplateVersionHistory templateId={17} templateName="Reusable sample" />);
    fireEvent.click(screen.getByRole("button", { name: "Version history for Reusable sample" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading saved versions");
    rejectLoad(new Error("Unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    mocks.get.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No saved versions are available for this template.")).toBeInTheDocument();
  });
});
