import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), postForm: vi.fn(), push: vi.fn(), toast: vi.fn(), clear: vi.fn(), flush: vi.fn(), toolkit: null as Record<string, unknown> | null }));
const router = { push: mocks.push, replace: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: 987, name: "Owner", isSetupComplete: false }, logout: vi.fn() }) }));
vi.mock("@/hooks/useSetupComplete", () => ({ useSetupComplete: () => ({ hasBusinessProfile: true, isLoading: false, completeSetup: vi.fn(), setHasBrandToolkit: vi.fn() }) }));
vi.mock("@/components/setup/useSetupDraft", () => ({ useSetupDraft: () => Object.assign(mocks.clear, { ready: true, status: "saved", savedAt: null, error: "", flush: mocks.flush, retry: vi.fn(), reload: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ default: { get: mocks.get, post: mocks.post, put: mocks.put, postForm: mocks.postForm }, ApiError: class extends Error { constructor(message: string, public status?: number) { super(message); } }, buildApiUrl: (url: string) => url }));
import { ApiError } from "@/lib/api";
import { BrandToolkitSetup } from "@/components/setup/BrandToolkitSetup";
const profile = { id: 26, role: "owner", workspaceType: "creator", name: "Edited creator name", companyName: "Edited creator name", websiteAnalysis: { url: "https://example.com", analyzedAt: new Date().toISOString(), data: { brandName: "Crawler proposal", voicePersonalityTraits: ["Friendly"], primaryColor: "#223344", contentPillars: ["Tutorials"], customToneGuidelines: "Use plain language" } } };
beforeEach(() => {
  vi.clearAllMocks(); mocks.toolkit = null; sessionStorage.clear(); localStorage.setItem("user", JSON.stringify({ id: 987 }));
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  mocks.get.mockImplementation(async (url: string) => url.includes("business-profiles") ? profile : mocks.toolkit ? [mocks.toolkit] : []);
  mocks.post.mockResolvedValue({ id: 88, version: 1 }); mocks.put.mockResolvedValue({ id: 42, version: 5 });
  mocks.flush.mockResolvedValue(undefined); mocks.clear.mockResolvedValue(undefined);
});
afterEach(cleanup);
async function reviewEssentials() {
  await screen.findByLabelText(/Creator or brand name/);
  await userEvent.click(screen.getByRole("button", { name: /^Continue/ }));
  await userEvent.click(screen.getByRole("button", { name: /^Continue/ }));
  await userEvent.click(screen.getByRole("button", { name: "Review essentials" }));
  await screen.findByRole("button", { name: "Finish setup" });
}
describe("Brand essentials completion", () => {
  it("skips optional steps while retaining extracted guidance and the edited profile name", async () => {
    render(<BrandToolkitSetup profileId={26} />);
    await reviewEssentials();
    expect(screen.getByRole("heading", { name: "Review your brand toolkit." })).toBeVisible();
    expect(screen.queryByText("A foundation for every campaign.")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Identity review" })).toHaveTextContent("Edited creator name");
    expect(screen.getByRole("region", { name: "Content review" })).toHaveTextContent("Tutorials");
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/setup/account-verification?justFinished=1"));
    expect(mocks.post).toHaveBeenCalledWith("/api/content/brand-toolkits", expect.objectContaining({ name: "Edited creator name", contentPillars: ["Tutorials"], customToneGuidelines: "Use plain language", idempotencyKey: expect.any(String) }), expect.objectContaining({ headers: { "X-Business-Profile-Id": "26" } }));
    expect(mocks.flush).toHaveBeenCalledTimes(2);
    expect(mocks.flush).toHaveBeenLastCalledWith(expect.objectContaining({ step: 7, sourceVersion: 1 })); expect(mocks.clear).toHaveBeenCalledOnce();
  });
  it("preserves saved toolkit choices, permits editing from review, and sends the loaded version", async () => {
    mocks.toolkit = { id: 42, version: 4, name: "Saved brand", voicePersonalityTraits: ["Professional"], primaryColors: ["#112233"], isDefault: true, updatedAt: "2020-01-01", contentPillars: ["Original pillar"], imageAssets: [{ url: "/uploads/one.png", alt: "Team", width: 1200, height: 600 }] };
    render(<BrandToolkitSetup profileId={26} />); await reviewEssentials();
    expect(screen.getByRole("region", { name: "Identity review" })).toHaveTextContent("Saved brand");
    expect(screen.getByRole("region", { name: "Content review" })).toHaveTextContent("Original pillar");
    await userEvent.click(screen.getByRole("button", { name: "Edit voice" }));
    await userEvent.click(screen.getByRole("button", { name: "Casual" }));
    await userEvent.click(screen.getByRole("button", { name: "Back to review" }));
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalled());
    expect(mocks.put).toHaveBeenCalledWith("/api/content/brand-toolkits/42", expect.objectContaining({ expectedVersion: 4, name: "Saved brand", voicePersonalityTraits: ["Professional", "Casual"], imageAssets: [{ url: "/uploads/one.png", alt: "Team", width: 1200, height: 600 }] }), expect.any(Object));
  });
  it("keeps the review and draft when saving rejects a changed version", async () => {
    mocks.toolkit = { id: 42, version: 4, name: "Saved brand", voicePersonalityTraits: ["Professional"], primaryColors: ["#112233"] };
    mocks.put.mockRejectedValueOnce(new ApiError("This toolkit changed in another tab. Reload before saving.", 409));
    render(<BrandToolkitSetup profileId={26} />); await reviewEssentials();
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "This toolkit changed in another tab. Reload before saving." })));
    expect(mocks.clear).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Finish setup" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload saved toolkit" })).toBeInTheDocument();
  });
  it("blocks completion when durable draft synchronization fails", async () => {
    mocks.flush.mockRejectedValueOnce(new Error("Draft changed in another tab."));
    render(<BrandToolkitSetup profileId={26} />); await reviewEssentials();
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "Draft changed in another tab." })));
    expect(mocks.post).not.toHaveBeenCalled(); expect(mocks.clear).not.toHaveBeenCalled();
  });
});
