import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VideoGenerationPage from "@/app/dashboard/(main)/saved-templates/video/generate/page";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), subscribe: vi.fn(() => () => undefined), toolkit: { logoUrl: "" } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ default: mocks }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/hooks/use-content-brand-context", () => ({ useContentBrandContext: () => ({ brandToolkitId: 7, businessProfileId: 9, toolkit: mocks.toolkit }) }));
vi.mock("@/contexts/WebSocketContext", () => ({ useWebSocket: () => ({ subscribe: mocks.subscribe }) }));
vi.mock("@/components/content-cards", () => ({ VideoCard: () => null }));
vi.mock("@/components/content-studio/GenerationEstimate", () => ({ GenerationEstimate: () => null }));
vi.mock("@/components/content-studio/CreatorPreview", () => ({ CreatorPreview: ({ model }: { model: unknown }) => <pre data-testid="proof">{JSON.stringify(model)}</pre> }));
vi.mock("@/components/content-studio/ContentCreatorShell", () => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { ContentCreatorBody: Wrapper, ContentCreatorComposer: Wrapper, ContentCreatorHeader: Wrapper, ContentCreatorShell: Wrapper, CreatorResultsPane: Wrapper, ContentCreatorStage: ({ preview, children }: { preview: React.ReactNode; children: React.ReactNode }) => <div>{preview}{children}</div> };
});
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); mocks.toolkit.logoUrl = ""; mocks.get.mockResolvedValue([]); });
const preview = () => JSON.parse(screen.getByTestId("proof").textContent || "{}");

describe("video request and proof boundaries", () => {
  it("does not preview unsent prompt or settings, and preserves failed submitted prompt", async () => {
    mocks.post.mockRejectedValue(new Error("Provider is unavailable"));
    render(<VideoGenerationPage />);
    fireEvent.change(screen.getByPlaceholderText(/smooth product reveal/), { target: { value: "Reviewed scene" } });
    expect(preview()).toMatchObject({ status: "empty", prompt: "" });
    fireEvent.click(screen.getByRole("button", { name: "Generate Video" }));
    await waitFor(() => expect(preview()).toMatchObject({ status: "failed", submittedPrompt: "Reviewed scene", error: "Provider is unavailable" }));
    fireEvent.change(screen.getByPlaceholderText(/smooth product reveal/), { target: { value: "Unsubmitted change" } });
    expect(preview().submittedPrompt).toBe("Reviewed scene");
  });
  it("allows short clips without logo references, submits durable background and explicit audio choices", async () => {
    mocks.post.mockResolvedValue({ success: true, assetId: 40, persisted: true, videoUrl: "/uploads/result.mp4" });
    render(<VideoGenerationPage />);
    fireEvent.click(screen.getByRole("button", { name: "Generation Settings" }));
    expect(screen.getByRole("button", { name: "4s" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "4s" }));
    fireEvent.change(screen.getByPlaceholderText(/smooth product reveal/), { target: { value: "Reviewed scene" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate Video" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/content/studio/video", expect.objectContaining({ background: true, duration: "4", generateAudio: true, includeBrandLogo: true })));
    await waitFor(() => expect(preview().status).toBe("ready"));
    mocks.post.mockRejectedValueOnce(new Error("New request failed"));
    fireEvent.change(screen.getByPlaceholderText(/smooth product reveal/), { target: { value: "Another scene" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate Video" }));
    await waitFor(() => expect(preview()).toMatchObject({ status: "ready", videoUrl: "/uploads/result.mp4", error: "New request failed" }));
  });
  it("requires approval after changing storyboard", async () => {
    render(<VideoGenerationPage />);
    fireEvent.change(screen.getByPlaceholderText(/smooth product reveal/), { target: { value: "Reviewed scene" } });
    fireEvent.change(screen.getByLabelText("Storyboard (optional)"), { target: { value: "Open → close" } });
    expect(screen.getByRole("button", { name: "Generate Video" })).toBeDisabled();
    fireEvent.click(screen.getByRole("switch", { name: "Approve this storyboard" }));
    expect(screen.getByRole("button", { name: "Generate Video" })).not.toBeDisabled();
  });
});
