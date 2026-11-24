import React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  toast: vi.fn(),
  complete: vi.fn(),
  profileSaved: vi.fn(),
  toolkitSaved: vi.fn(),
}));
const router = { push: mocks.push, replace: mocks.replace };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: 987, name: "Setup Test", email: "setup@example.invalid" },
    logout: vi.fn(),
  }),
}));
vi.mock("@/hooks/useSetupComplete", () => ({
  useSetupComplete: () => ({
    isLoading: false,
    hasBusinessProfile: true,
    setHasBusinessProfile: mocks.profileSaved,
    completeSetup: mocks.complete,
    setHasBrandToolkit: mocks.toolkitSaved,
  }),
}));
const subscribe = () => () => {};
vi.mock("@/contexts/WebSocketContext", () => ({
  useWebSocket: () => ({ subscribe }),
}));
vi.mock("@/lib/api", async () => {
  const { setupApiFixture } = await import("./fixtures/setupApi");
  const fixture = setupApiFixture(mocks);
  return ({
  default: {
    get: fixture.get,
    post: fixture.post,
    put: fixture.put,
    delete: fixture.delete,
    postForm: vi.fn(),
  },
  ApiError: class extends Error {},
  buildApiUrl: (url: string) => url,
}); });
import BusinessProfile from "@/app/setup/business-profile/page";
import { KnowledgeBasePreview } from "@/components/setup/KnowledgeBasePreview";
import BrandToolkit from "@/app/setup/brand-toolkit/page";
import { workspaceProfileData } from "@/lib/workspace-profile";

const savedProfile = {
  id: 19,
  isDefault: true,
  companyName: "Strike",
  industry: "Finance",
  companySize: "11-50",
  businessGoals: ["brand_awareness"],
  website: "https://strike.money",
  email: "hello@strike.example",
  phone: "+91 1234567890",
  linkedinUrl: "https://linkedin.com/company/strike",
  targetRegions: ["India"],
};

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.setItem("user", JSON.stringify({ id: 987 }));
  sessionStorage.setItem("active-business-profile:987", "19");
  mocks.get.mockImplementation(async (url: string) =>
    url.includes("business-categories")
      ? []
      : url.includes("business-profiles")
        ? url.endsWith("/19")
          ? savedProfile
          : [savedProfile]
        : [],
  );
  mocks.post.mockResolvedValue({ id: 45 });
  mocks.put.mockResolvedValue({ id: 45 });
});
afterEach(cleanup);

describe("new-user setup", () => {
  it("reads saved knowledge content from its entry and shows page text and source", async () => {
    mocks.get.mockResolvedValue({
      extractedText: "Saved text",
      chunks: [
        {
          index: 0,
          text: "## About Strike\nURL: https://strike.money/about\n\nActual saved company content",
        },
      ],
      embeddingsGenerated: false,
    });
    render(<KnowledgeBasePreview entryId={27} />);
    expect(
      await screen.findByRole("heading", {
        name: "Saved knowledge base content",
      }),
    ).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/settings/knowledge-base/27/extracted-text",
    );
    expect(screen.getByText(/Actual saved company content/)).toBeVisible();
    expect(
      screen.getByRole("link", { name: "https://strike.money/about" }),
    ).toHaveAttribute("href", "https://strike.money/about");
    expect(screen.getByText(/indexing is not ready/)).toBeInTheDocument();
  });
  it("retries a failed knowledge preview without rerunning analysis", async () => {
    const user = userEvent.setup();
    mocks.get
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({
        extractedText: "Recovered saved content",
        chunks: [],
        embeddingsGenerated: true,
      });
    render(<KnowledgeBasePreview entryId={27} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be loaded",
    );
    await user.click(
      screen.getByRole("button", { name: "Retry loading content" }),
    );
    expect(await screen.findByText("Recovered saved content")).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("keeps extraction results open until the user chooses to continue", async () => {
    const user = userEvent.setup();
    mocks.post.mockResolvedValue({
      data: { companyName: "Strike", industry: "Finance", fonts: ["Roboto"] },
      kbEntryId: 1,
      analysisSummary: { pages: 12, knowledgeSaved: true, warnings: [] },
    });
    render(<BusinessProfile />);
    await user.click(
      await screen.findByRole("button", { name: "Analyze website" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Your website results" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace name *")).not.toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Review extracted details" }),
    );
    expect(await screen.findByLabelText("Workspace name *")).toHaveValue(
      "Strike",
    );
  });
  it("keeps an actionable analysis error visible and preserves saved details", async () => {
    const user = userEvent.setup();
    mocks.post.mockRejectedValue(new Error("HTTP 500"));
    render(<BusinessProfile />);
    await user.click(
      await screen.findByRole("button", { name: "Analyze website" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "connection was interrupted",
    );
    expect(
      screen.getByRole("button", { name: "Retry analysis" }),
    ).toBeEnabled();
    await user.click(
      screen.getByRole("button", { name: "Continue with saved details" }),
    );
    expect(await screen.findByLabelText("Workspace name *")).toHaveValue(
      "Strike",
    );
  });

  it("restores the current section and the created profile after refresh", async () => {
    sessionStorage.setItem(
      "setup:workspace-creation:987:initial",
      JSON.stringify({
        updatedAt: Date.now(),
        phase: "profile",
        profileId: 19,
        step: 3,
        data: {
          ...workspaceProfileData(savedProfile),
          applicationUses: ["customer_support"],
        },
      }),
    );
    render(<BusinessProfile />);
    expect(
      await screen.findByRole("heading", {
        name: "What will you use AskSales for?",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Customer support/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("blocks saving when existing data cannot load, instead of creating a duplicate", async () => {
    mocks.get.mockRejectedValue(new Error("Network unavailable"));
    render(<BusinessProfile />);
    expect(
      await screen.findByText("We couldn’t load your saved profile"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save business profile" }),
    ).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("carries Business DNA into the toolkit and reuses the created toolkit after completion fails", async () => {
    const user = userEvent.setup();
    let completionAttempts = 0;
    mocks.post.mockImplementation(async (url: string) => {
      if (url.includes("mark-setup-complete") && completionAttempts++ === 0)
        throw new Error("Temporary failure");
      return { id: 45 };
    });
    render(<BrandToolkit />);
    expect(await screen.findByLabelText("Brand name *")).toHaveValue("Strike");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Professional" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("Connected to your business profile"),
    ).toBeInTheDocument();
    expect(screen.getByText("https://strike.money")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Unable to complete setup" }),
      ),
    );
    expect(mocks.complete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
    expect(
      mocks.post.mock.calls.filter(
        ([url]) => url === "/api/content/brand-toolkits",
      ),
    ).toHaveLength(1);
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/content/brand-toolkits/45",
      expect.objectContaining({
        website: "https://strike.money",
        industry: "Finance",
        email: "hello@strike.example",
        linkedinUrl: "https://linkedin.com/company/strike",
      }),
      { headers: { "X-Business-Profile-Id": "19" } },
    );
    expect(mocks.push).toHaveBeenCalledWith(
      "/setup/account-verification?justFinished=1",
    );
  });

  it("preserves custom values and guidance when reopening an existing toolkit", async () => {
    const user = userEvent.setup();
    mocks.get.mockImplementation(async (url: string) =>
      url.includes("business-profiles")
        ? [savedProfile]
        : [
            {
              id: 45,
              isDefault: true,
              name: "Strike Brand",
              brandValues: ["Precision"],
              voicePersonalityTraits: ["Analytical"],
              voiceDos: ["Explain the evidence"],
              primaryColors: ["#223344"],
            },
          ],
    );
    render(<BrandToolkit />);
    expect(await screen.findByLabelText("Brand name *")).toHaveValue(
      "Strike Brand",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("button", { name: "Precision" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Analytical" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Explain the evidence")).toBeInTheDocument();
  });
});
