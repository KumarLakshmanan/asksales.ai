import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  upload: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  toast: vi.fn(),
  profileSaved: vi.fn(),
  toolkitSaved: vi.fn(),
  complete: vi.fn(),
  invalidate: vi.fn(),
  dashboard: vi.fn(),
  setupComplete: false,
}));
const router = { push: mocks.push, replace: mocks.replace };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: 987, name: "Setup user", isSetupComplete: mocks.setupComplete },
    logout: vi.fn(),
  }),
}));
vi.mock("@/hooks/useSetupComplete", () => ({
  useSetupComplete: () => ({
    isLoading: false,
    hasBusinessProfile: true,
    setHasBusinessProfile: mocks.profileSaved,
    setHasBrandToolkit: mocks.toolkitSaved,
    completeSetup: mocks.complete,
  }),
}));
const subscribe = () => () => {};
vi.mock("@/contexts/WebSocketContext", () => ({
  useWebSocket: () => ({ subscribe }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock("@/lib/business-profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/business-profile")>()),
  openBusinessDashboard: mocks.dashboard,
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
    postForm: mocks.upload,
  },
  ApiError: class extends Error {},
  buildApiUrl: (url: string) => url,
}); });

import { BusinessProfileSetup } from "@/components/setup/BusinessProfileSetup";
import { BrandToolkitSetup } from "@/components/setup/BrandToolkitSetup";
import { BusinessProfileForm } from "@/components/BusinessProfileForm";
import { selectBusinessProfile } from "@/lib/business-profile";

const profile = {
  id: 26,
  role: "owner",
  isDefault: true,
  name: "Northstar",
  companyName: "Northstar",
  profileType: "SaaS",
  description: "We help creators and small businesses.",
  companySize: "51-200",
  industry: "Design & creative",
  email: "hello@example.com",
  businessGoals: '["brand_awareness"]',
  keyBuyerRoles: '["Founder"]',
  restrictions: "No exaggerated claims",
  linkedinUrl: "https://linkedin.com/company/northstar",
};
const analysis = {
  url: "https://northstar.example",
  analyzedAt: new Date().toISOString(),
  kbEntryId: 99,
  summary: { pages: 3, knowledgeSaved: true, warnings: [] },
  data: {
    companyName: "Northstar",
    brandName: "Northstar Brand",
    description: "We help creators.",
    website: "https://northstar.example",
    primaryColor: "#223344",
    colorPalette: ["#223344", "#556677"],
    fonts: { heading: "Inter", body: "Inter" },
    fontFamilies: ["Inter"],
    voicePersonalityTraits: ["Friendly"],
    screenshotUrl: "/uploads/northstar/screenshot.png",
    extractedImages: [
      {
        url: "/uploads/northstar/one.png",
        originalUrl: "https://northstar.example/one.png",
      },
      { url: "/uploads/northstar/two.png" },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setupComplete = false;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  sessionStorage.clear();
  localStorage.setItem("user", JSON.stringify({ id: 987 }));
  selectBusinessProfile(26);
  mocks.get.mockImplementation(async (url: string) =>
    url === "/api/settings/business-profiles"
      ? [profile]
      : url.startsWith("/api/settings/business-profiles/")
        ? profile
        : [],
  );
  mocks.post.mockImplementation(async (url: string) =>
    url === "/api/setup/website-analysis/jobs"
      ? {
          data: analysis.data,
          kbEntryId: 99,
          analysisSummary: analysis.summary,
        }
      : { id: 45 },
  );
  mocks.put.mockResolvedValue({ id: 26 });
  mocks.upload.mockResolvedValue({ url: "/uploads/northstar/upload.png" });
  mocks.invalidate.mockResolvedValue(undefined);
});
afterEach(cleanup);

async function newProfileSteps(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: "Enter details manually" }),
  );
  await user.click(screen.getByRole("button", { name: "Creator" }));
  await user.type(screen.getByLabelText("Workspace name *"), "Creator Studio");
  await user.selectOptions(screen.getByLabelText("Country"), "India");
  await user.selectOptions(screen.getByLabelText("Time zone"), "Asia/Kolkata");
  await user.click(
    screen.getByRole("button", { name: "Continue" }),
  );
  await user.type(
    screen.getByLabelText("Short description *"),
    "I create tutorials and support my community.",
  );
  await user.click(
    screen.getByRole("button", { name: "Continue" }),
  );
  await user.click(screen.getByRole("button", { name: /Customer support/ }));
  await user.click(
    screen.getByRole("button", { name: /Content & social media/ }),
  );
  await user.type(
    screen.getByLabelText("First goal (optional)"),
    "Reply faster",
  );
  await user.type(
    screen.getByLabelText("Current tools (optional)"),
    "Instagram, Gmail",
  );
  await user.click(
    screen.getByRole("button", { name: "Continue" }),
  );
}

describe("shared workspace profile", () => {
  it("lets an owner discard a draft whose saved workspace is no longer available", async () => {
    sessionStorage.setItem("setup:workspace-creation:987:additional", JSON.stringify({ version: 2, revision: 0, updatedAt: Date.now(), step: 2, data: { profileId: 999, phase: "profile", data: {}, step: 2, updatedAt: 0 } }));
    mocks.get.mockRejectedValue(new Error("Workspace is no longer available."));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<BusinessProfileSetup addingProfile />);
    await userEvent.click(await screen.findByRole("button", { name: "Discard unfinished setup" }));
    await screen.findByRole("heading", { name: "Start with your website" });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });
  it("collects uses and channel preferences and continues additional creation to its toolkit", async () => {
    const user = userEvent.setup();
    render(<BusinessProfileSetup addingProfile />);
    expect(
      await screen.findByRole("heading", { name: "Start with your website" }),
    ).toBeVisible();
    await newProfileSteps(user);
    expect(screen.getByRole("button", { name: /Email/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await user.click(screen.getByRole("button", { name: /Email/ }));
    await user.click(screen.getByRole("button", { name: /Instagram/ }));
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/setup/brand-toolkit/45"),
    );
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/settings/business-profiles",
      expect.objectContaining({
        name: "Creator Studio",
        workspaceType: "creator",
        timezone: "Asia/Kolkata",
        country: "India",
        applicationUses: ["customer_support", "content_social"],
        preferredChannels: ["Email", "Instagram"],
        setupGoal: "Reply faster",
        currentTools: "Instagram, Gmail",
      }),
    );
    expect(
      mocks.post.mock.calls.some(([url]) => url.includes("analyze-website")),
    ).toBe(false);
    expect(
      JSON.parse(
        sessionStorage.getItem("setup:workspace-creation:987:additional")!,
      ),
    ).toMatchObject({ data: { profileId: 45, phase: "profile" } });
  });

  it("can skip channels and still creates a workspace", async () => {
    const user = userEvent.setup();
    render(<BusinessProfileSetup addingProfile />);
    await newProfileSteps(user);
    await user.click(screen.getByRole("button", { name: /Email/ }));
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/setup/brand-toolkit/45"),
    );
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/settings/business-profiles",
      expect.objectContaining({ preferredChannels: [] }),
    );
  });

  it("reuses the analyzer's draft profile after a failed request and refresh", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    mocks.post.mockImplementation(async (url: string) => {
      if (url === "/api/settings/business-profiles") return { id: 45 };
      if (attempts++ === 0) throw new Error("Connection lost");
      return {
        data: analysis.data,
        kbEntryId: 99,
        analysisSummary: analysis.summary,
      };
    });
    mocks.get.mockResolvedValue({ ...profile, id: 45 });
    const first = render(<BusinessProfileSetup addingProfile />);
    await user.type(
      await screen.findByLabelText("Website URL"),
      "northstar.example",
    );
    await user.click(screen.getByRole("button", { name: "Analyze website" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "connection was interrupted",
    );
    first.unmount();
    render(<BusinessProfileSetup addingProfile />);
    await user.click(
      await screen.findByRole("button", { name: "Analyze website" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Your website results" }),
    ).toBeVisible();
    expect(
      mocks.post.mock.calls.filter(
        ([url]) => url === "/api/settings/business-profiles",
      ),
    ).toHaveLength(1);
    expect(mocks.post).toHaveBeenLastCalledWith(
      "/api/setup/website-analysis/jobs",
      expect.objectContaining({ url: "https://northstar.example", forceRefresh: true }),
      { headers: { "X-Business-Profile-Id": "45" } },
    );
    await user.click(
      screen.getByRole("button", { name: "Review extracted details" }),
    );
    expect(screen.getByLabelText("Workspace name *")).toHaveValue("Northstar");
  });

  it("edits the shared sections without an analyzer or toolkit and preserves hidden legacy fields", async () => {
    const user = userEvent.setup();
    const saved = vi.fn();
    render(<BusinessProfileForm profileId={26} onSaveSuccess={saved} />);
    expect(await screen.findByLabelText("Workspace name *")).toHaveValue(
      "Northstar",
    );
    expect(screen.getByRole("button", { name: "51-200" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: /Analyze/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Brand toolkit/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Individual/ }));
    await user.click(screen.getByRole("button", { name: "Uses" }));
    await user.click(
      screen.getByRole("button", { name: /Personal productivity/ }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    const payload = mocks.put.mock.calls[0][1];
    expect(payload).toMatchObject({
      companySize: "51-200",
      workspaceType: "individual",
      applicationUses: ["personal_productivity"],
    });
    for (const field of [
      "profileType",
      "businessGoals",
      "keyBuyerRoles",
      "restrictions",
      "linkedinUrl",
      "websiteAnalysis",
    ])
      expect(payload).not.toHaveProperty(field);
    expect(mocks.put.mock.calls[0][2]).toEqual({
      headers: { "X-Business-Profile-Id": "26" },
    });
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("blocks editing when the profile fails to load", async () => {
    mocks.get.mockRejectedValue(new Error("Network unavailable"));
    render(<BusinessProfileForm profileId={26} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Network unavailable",
    );
    expect(
      screen.queryByRole("button", { name: "Save changes" }),
    ).not.toBeInTheDocument();
    expect(mocks.put).not.toHaveBeenCalled();
  });
});

describe("creation brand toolkit", () => {
  it("recovers durable analysis, keeps selected/uploaded images, and finishes an additional workspace without account review", async () => {
    const user = userEvent.setup();
    mocks.setupComplete = true;
    mocks.get.mockImplementation(async (url: string) =>
      url === "/api/settings/business-profiles/26"
        ? { ...profile, websiteAnalysis: analysis }
        : [],
    );
    selectBusinessProfile(19);
    render(<BrandToolkitSetup profileId={26} />);
    expect(await screen.findByLabelText("Brand name *")).toHaveValue(
      "Northstar",
    );
    expect(mocks.get).toHaveBeenCalledWith("/api/content/brand-toolkits", {
      headers: { "X-Business-Profile-Id": "26" },
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("button", { name: "Friendly" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByRole("checkbox", { name: "Keep website screenshot" }),
    ).toBeChecked();
    await user.click(
      screen.getByRole("button", { name: "Keep brand image 1" }),
    );
    await user.upload(
      screen.getByLabelText("Upload brand images"),
      new File(["image"], "new.png", { type: "image/png" }),
    );
    await waitFor(() =>
      expect(screen.getByText("2 images selected")).toBeVisible(),
    );
    expect(mocks.upload.mock.calls[0][0]).toBe(
      "/api/content/brand-toolkits/upload-image",
    );
    expect(mocks.upload.mock.calls[0][2]).toEqual({
      headers: { "X-Business-Profile-Id": "26" },
    });
    for (let section = 4; section < 7; section++)
      await user.click(screen.getByRole("button", { name: "Continue" }));
    selectBusinessProfile(19);
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    await waitFor(() => expect(mocks.dashboard).toHaveBeenCalledOnce());
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/content/brand-toolkits",
      expect.objectContaining({
        imageAssets: [
          expect.objectContaining({ url: "/uploads/northstar/two.png" }),
          expect.objectContaining({ url: "/uploads/northstar/upload.png" }),
        ],
        websiteScreenshotUrl: "/uploads/northstar/screenshot.png",
        primaryBrandColor: "#223344",
        fonts: { heading: "Inter", body: "Inter", accent: "" },
      }),
      { headers: { "X-Business-Profile-Id": "26" } },
    );
    expect(
      mocks.post.mock.calls.some(([url]) =>
        url.includes("mark-setup-complete"),
      ),
    ).toBe(false);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("active-business-profile:987")).toBe("26");
  });

  it("uses saved toolkit values after newer toolkit edits and keeps explicitly removed images removed", async () => {
    const user = userEvent.setup();
    mocks.get.mockImplementation(async (url: string) =>
      url === "/api/settings/business-profiles/26"
        ? { ...profile, websiteAnalysis: analysis }
        : [
            {
              id: 48,
              name: "My saved brand",
              updatedAt: new Date(Date.now() + 1000).toISOString(),
              voicePersonalityTraits: ["Professional"],
              primaryColors: ["#112233"],
              imageAssets: [],
              websiteScreenshotUrl: "",
              voiceDos: ["Use plain words"],
            },
          ],
    );
    render(<BrandToolkitSetup profileId={26} />);
    expect(await screen.findByLabelText("Brand name *")).toHaveValue(
      "My saved brand",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Use plain words")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("0 images selected")).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "Keep website screenshot" }),
    ).not.toBeChecked();
  });
});
