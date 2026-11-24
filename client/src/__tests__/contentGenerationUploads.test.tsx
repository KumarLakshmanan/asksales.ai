import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SocialGenerationPage from "@/app/dashboard/(main)/saved-templates/social/generate/page";
import { ManualContentComposer } from "@/components/content-studio/GeneratorMode";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  postForm: vi.fn(),
  delete: vi.fn(),
  push: vi.fn(),
  toast: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/api", () => ({ default: mocks, api: mocks }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/contexts/WebSocketContext", () => ({ useWebSocket: () => ({ subscribe: mocks.subscribe }) }));
vi.mock("@/hooks/use-content-brand-context", () => ({
  useContentBrandContext: () => ({ brandToolkitId: 7, businessProfileId: 9, missingMessage: "" }),
}));
vi.mock("@/components/content-cards", () => ({
  SocialPostCard: ({ title, imageUrl, videoUrl }: { title: string; imageUrl?: string; videoUrl?: string }) => (
    <div data-testid="social-card" data-image-url={imageUrl} data-video-url={videoUrl}>{title}</div>
  ),
}));
vi.mock("@/components/modals", () => ({ ContentFullscreenModal: () => null }));
vi.mock("@/components/content-studio/GenerationEstimate", () => ({ GenerationEstimate: () => <p>Estimated credits</p> }));

describe("content generation uploads", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    mocks.get.mockResolvedValue([]);
    mocks.delete.mockResolvedValue({ success: true });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test-preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.stubGlobal("FileReader", class {
      result: string | ArrayBuffer | null = null;
      onload: ((event: { target: { result: string } }) => void) | null = null;
      readAsDataURL() {
        this.result = "data:image/png;base64,cmVmZXJlbmNl";
        this.onload?.({ target: { result: this.result } });
      }
    });
  });

  it("saves the manual email subject separately and updates the same draft", async () => {
    mocks.post.mockResolvedValue({ id: 92 });
    mocks.put.mockResolvedValue({ id: 92 });
    const onDraftChange = vi.fn();
    render(<ManualContentComposer assetType="email_template" channel="email" returnHref="/dashboard/saved-templates/email" contentLabel="Email body" onDraftChange={onDraftChange} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "QA welcome" } });
    fireEvent.change(screen.getByLabelText("Subject line"), { target: { value: "Welcome aboard" } });
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: "Hello, welcome to the shop." } });
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ subject: "Welcome aboard", content: "Hello, welcome to the shop." }));
    fireEvent.click(screen.getByRole("button", { name: "Save manual draft" }));
    await screen.findByRole("button", { name: "Draft saved" });
    expect(JSON.parse(mocks.post.mock.calls[0][1].content)).toMatchObject({ subject: "Welcome aboard", body: "Hello, welcome to the shop." });
    fireEvent.change(screen.getByLabelText("Subject line"), { target: { value: "Updated subject" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith("/api/content/assets/92", expect.any(Object)));
    expect(JSON.parse(mocks.put.mock.calls.at(-1)![1].content).subject).toBe("Updated subject");
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("preserves a recoverable draft receipt and user input if manual media upload fails", async () => {
    mocks.post.mockResolvedValue({ id: 42 });
    mocks.postForm.mockRejectedValue(new Error("Upload failed"));
    const user = userEvent.setup();

    render(
      <ManualContentComposer
        assetType="image"
        channel="image"
        returnHref="/dashboard/saved-templates/image"
        uploadLabel="Image file"
        accept="image/*"
        requireFile
        requireContent={false}
        mediaKind="image"
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Title" }), "Rollback proof");
    await user.upload(screen.getByLabelText("Image file"), new File(["image"], "proof.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: "Save manual draft" }));

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Draft saved; completion needs attention", variant: "destructive" })));
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Draft #42 already exists');
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Rollback proof');
  });

  it("keeps custom social videos in the social library and exposes the uploaded media immediately", async () => {
    mocks.post.mockResolvedValue({ id: 73 });
    mocks.postForm.mockResolvedValue({ url: "/uploads/social-proof.mp4" });
    const user = userEvent.setup();
    render(<SocialGenerationPage />);

    await user.click(screen.getByRole("button", { name: "Custom Post" }));
    await user.type(screen.getByPlaceholderText("Write your custom post caption here..."), "A durable custom video post");
    fireEvent.change(screen.getByLabelText("Upload Media (Image or Video)"), {
      target: { files: [new File(["video"], "proof.mp4", { type: "video/mp4" })] },
    });
    await user.click(screen.getByRole("button", { name: "Save Template" }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/api/content/assets",
      expect.objectContaining({ type: "social_post", channel: "linkedin" }),
    ));
    expect(mocks.postForm).toHaveBeenCalledWith("/api/content/assets/upload", expect.any(FormData));
    await user.click(screen.getAllByRole("tab", { name: /Recent/ })[0]);
    expect(await screen.findByTestId("social-card")).toHaveAttribute("data-video-url", "/uploads/social-proof.mp4");
  }, 15_000);

  it("restores the uncertain social save warning and allows retry after library review", async () => {
    mocks.post.mockRejectedValueOnce(Object.assign(new Error("HTTP 502"), { status: 502 })).mockResolvedValueOnce({ id: 74 });
    const user = userEvent.setup();
    const first = render(<SocialGenerationPage />);
    await user.click(screen.getByRole("button", { name: "Custom Post" }));
    await user.type(screen.getByPlaceholderText("Write your custom post caption here..."), "Internal QA draft");
    await user.click(screen.getByRole("button", { name: "Save Template" }));
    await screen.findByRole("alert");
    first.unmount();
    render(<SocialGenerationPage />);
    await user.click(screen.getByRole("button", { name: "Custom Post" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("previous post save could not be confirmed");
    expect(screen.getByRole("button", { name: "Save Template" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "I checked the library; try saving again" }));
    await user.click(screen.getByRole("button", { name: "Save Template" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
  }, 15_000);

  it("sends a selected social reference image to AI companion-image generation", async () => {
    mocks.post.mockImplementation((path: string) => {
      if (path === "/api/content/studio/enhance-prompt") return Promise.resolve({ success: true, enhancedPrompt: "Enhanced social brief" });
      if (path === "/api/content/studio/social") return Promise.resolve({ success: true, content: "Generated social proof", assetId: 81, imagePrompt: "Companion image" });
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<SocialGenerationPage />);

    fireEvent.change(screen.getByLabelText("Reference image (optional)"), {
      target: { files: [new File(["reference"], "reference.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(screen.getByAltText("Social post reference")).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText(/Enter a prompt for the social post/), "Launch announcement");
    await user.click(screen.getByRole("button", { name: "Generate Post" }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/api/content/studio/social",
      expect.objectContaining({
        platform: "linkedin",
        mediaGeneration: { image: false, video: false },
        postType: "engagement",
        referenceImage: expect.objectContaining({ mimeType: "image/png", base64Data: expect.any(String) }),
      }),
    ));
  }, 15_000);

  it('shows the submitted platform while generating and exposes a later generation failure', async () => {
    let finish!: (value: unknown) => void;
    mocks.post.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<SocialGenerationPage />);
    fireEvent.change(screen.getByLabelText('Social Post Prompt'), { target: { value: 'QA draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate Post' }));
    expect(await screen.findByText('Generating', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('linkedin', { exact: true })).toBeInTheDocument();
    finish({ success: true, content: 'First draft', assetId: 81 });
    expect(await screen.findByText('First draft')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate Post' })).toBeEnabled());

    mocks.post.mockRejectedValueOnce(new Error('Generation failed for this request'));
    fireEvent.click(screen.getByRole('button', { name: 'Generate Post' }));
    expect(await screen.findByRole('heading', { name: 'Generation failed' })).toBeInTheDocument();
    expect(screen.getByText('Generation failed for this request')).toBeInTheDocument();
  });

  it('retries partial manual social uploads without recreating the draft or uploading completed media twice', async () => {
    mocks.post.mockResolvedValue({ id: 174 });
    mocks.postForm.mockReset();
    mocks.postForm.mockResolvedValueOnce({ success: true, url: '/uploads/first.png' })
      .mockRejectedValueOnce(Object.assign(new Error('Second image rejected'), { status: 422 }))
      .mockResolvedValueOnce({ success: true, url: '/uploads/second.png' });
    render(<SocialGenerationPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom Post' }));
    fireEvent.change(screen.getByPlaceholderText('Write your custom post caption here...'), { target: { value: 'Manual carousel reviewed copy' } });
    fireEvent.change(screen.getByLabelText('Upload Media (Image or Video)'), { target: { files: [new File(['first'], 'first.png', { type: 'image/png' }), new File(['second'], 'second.png', { type: 'image/png' })] } });
    const save = screen.getByRole('button', { name: 'Save Template' });
    fireEvent.click(save); fireEvent.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent('Second image rejected');
    expect(screen.getByRole('status')).toHaveTextContent('Draft #174 already exists');
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.delete).not.toHaveBeenCalled();
    fireEvent.click(save);
    await waitFor(() => expect(mocks.postForm).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByPlaceholderText('Write your custom post caption here...')).toHaveValue(''));
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.postForm.mock.calls[2][1].get('assetId')).toBe('174');
    fireEvent.click(screen.getAllByRole('tab', { name: /Recent/ })[0]);
    expect(await screen.findByTestId('social-card')).toHaveAttribute('data-image-url', '/uploads/first.png');
  });
});
