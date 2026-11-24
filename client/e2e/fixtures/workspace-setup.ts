import type { Page } from "@playwright/test";

export type Workspace = {
  id: number;
  name: string;
  companyName: string;
  isDefault: boolean;
  role: string;
  [key: string]: unknown;
};
export async function onboardingFixture(page: Page, options: { initialAccount?: boolean; profiles?: Workspace[] } = {}) {
  const profiles: Workspace[] = options.profiles || (options.initialAccount ? [] : [
    {
      id: 26,
      name: "Northstar Studio",
      companyName: "Northstar Studio",
      isDefault: true,
      role: "owner",
      description: "We help small brands grow.",
      profileType: "SaaS",
      businessGoals: '["brand_awareness"]',
      companySize: "51-200",
    },
  ]);
  profiles.forEach(profile => { profile.version ??= 1; });
  const drafts = new Map<string, { data: unknown; step: number; revision: number; updatedAt: string }>();
  const jobs = new Map<number, Record<string, unknown>>();
  const toolkits: Array<Record<string, unknown>> = [];
  const account = { id: 4101, email: "regression-alpha@example.test", name: "Regression Alpha", isSetupComplete: !options.initialAccount, isApproved: !options.initialAccount, hasBusinessProfile: !options.initialAccount, hasBrandToolkit: !options.initialAccount };
  const requests: Array<{
    path: string;
    method: string;
    business?: string;
    body?: Record<string, unknown>;
  }> = [];
  const extracted = {
    companyName: "Creator Studio",
    description: "I create tutorials and support my community.",
    industry: "Education",
    email: "hello@creator.example",
    phone: "+91 98765 43210",
    brandName: "Creator Studio",
    primaryColor: "#7c3aed",
    colorPalette: ["#7c3aed", "#202020"],
    fontFamilies: ["Inter"],
    fonts: { heading: "Inter", body: "Inter" },
    voicePersonalityTraits: ["Friendly"],
    tagline: "Make something worth sharing.",
    logoUrl: "/uploads/41/logo.png",
    voiceDos: ["Use simple, practical examples"],
    voiceDonts: ["Promise overnight success"],
    screenshotUrl: "/uploads/41/screenshot.png",
    extractedImages: [
      {
        url: "/uploads/41/one.png",
        originalUrl: "https://creator.example/one.png",
      },
      { url: "/uploads/41/two.png" },
    ],
  };
  await page.route("**/uploads/**", (route) => {
    const filename = new URL(route.request().url()).pathname.split("/").at(-1);
    const screenshot = filename === "screenshot.png";
    const logo = filename?.includes("logo");
    const color = filename === "two.png" ? "#0f766e" : "#7c3aed";
    const body = logo
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="100"><rect width="180" height="100" rx="20" fill="#7c3aed"/><text x="90" y="67" text-anchor="middle" fill="white" font-size="52" font-family="sans-serif">CS</text></svg>'
      : `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${screenshot ? 480 : 400}"><rect width="800" height="480" fill="#f7f4ff"/><rect x="24" y="24" width="752" height="${screenshot ? 432 : 352}" rx="20" fill="${color}"/><circle cx="650" cy="320" r="180" fill="#ffffff" opacity=".15"/><text x="70" y="90" fill="white" font-family="sans-serif" font-size="22">CREATOR STUDIO</text><text x="70" y="185" fill="white" font-family="sans-serif" font-size="42">Make something</text><text x="70" y="240" fill="white" font-family="sans-serif" font-size="42">worth sharing.</text><text x="70" y="310" fill="white" font-family="sans-serif" font-size="18">Practical tutorials. Creative community.</text>${screenshot ? '<rect x="70" y="350" width="180" height="46" rx="10" fill="white"/><text x="92" y="381" fill="#7c3aed" font-size="18" font-family="sans-serif">Explore tutorials</text>' : ''}</svg>`;
    return route.fulfill({ contentType: "image/svg+xml", body });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const reply = (json: unknown) => route.fulfill({ json });
    if (path === "/api/auth/me" && options.initialAccount) return reply({ user: account });
    if (
      [
        "/api/auth/me",
        "/api/platform/access",
        "/api/settings/preferences",
        "/api/settings/outreach/assistants/catalog",
        "/api/wallet",
        "/api/notifications/unread/count",
      ].includes(path)
    )
      return route.fallback();
    const business = request.headers()["x-business-profile-id"];
    if (request.method() !== "GET")
      requests.push({
        path,
        method: request.method(),
        business,
        body: request.headers()["content-type"]?.includes("application/json") ? request.postDataJSON() : undefined,
      });
    if (path.startsWith("/api/setup/drafts/")) {
      const key = decodeURIComponent(path.split("/").at(-1)!);
      const existing = drafts.get(key);
      if (request.method() === "GET") return reply({ draft: existing || null });
      const body = request.postDataJSON();
      if (body.expectedRevision !== (existing?.revision || 0)) return route.fulfill({ status: 409, json: { error: "Draft changed elsewhere", draft: existing || null } });
      if (request.method() === "DELETE") { drafts.delete(key); return reply({ draft: null }); }
      const draft = { data: body.data, step: body.step, revision: (existing?.revision || 0) + 1, updatedAt: new Date().toISOString() };
      drafts.set(key, draft); return reply({ draft });
    }
    if (path === "/api/setup/onboarding-status") {
      const profile = profiles.find(item => item.id === Number(business));
      return reply({ profile, brandToolkitComplete: toolkits.some(item => item.businessProfileId === Number(business)), contentCount: 0, campaignCount: 0, staffCount: 0, connectedChannels: [], connectionsAvailable: false });
    }
    if (path.startsWith("/api/setup/website-analysis/jobs")) {
      const id = Number(business);
      if (request.method() === "GET") return reply({ job: jobs.get(id) || null });
      if (request.method() === "DELETE") {
        const job = { ...jobs.get(id), status: "cancelled", stage: "cancelled" };
        jobs.set(id, job); return reply({ job });
      }
      const profile = profiles.find(item => item.id === id)!;
      profile.websiteAnalysis = { data: extracted, url: request.postDataJSON().url, analyzedAt: new Date().toISOString(), kbEntryId: 88, summary: { pages: 4, knowledgeSaved: true, warnings: [] } };
      const job = { id: crypto.randomUUID(), url: request.postDataJSON().url, status: "completed", stage: "complete", detail: "Analysis complete", updatedAt: new Date().toISOString(), result: { success: true, data: extracted, kbEntryId: 88, analysisSummary: { pages: 4, knowledgeSaved: true, warnings: [] } } };
      jobs.set(id, job); return reply({ job });
    }
    if (/^\/api\/settings\/business-profiles\/\d+\/(archive|restore)$/.test(path)) {
      const profile = profiles.find(item => item.id === Number(path.split("/").at(-2)))!;
      profile.archivedAt = path.endsWith("/archive") ? new Date().toISOString() : null;
      profile.version = Number(profile.version) + 1;
      return reply(profile);
    }
    if (path === "/api/settings/business-profiles") {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        const profile = { ...body, id: 41, isDefault: false, role: "owner", version: 1 };
        profiles.push(profile);
        account.hasBusinessProfile = true;
        return reply(profile);
      }
      return reply(["true", "1"].includes(new URL(request.url()).searchParams.get("includeArchived") || "") ? profiles : profiles.filter(item => !item.archivedAt));
    }
    if (/^\/api\/settings\/business-profiles\/\d+$/.test(path)) {
      const profile = profiles.find(
        (item) => item.id === Number(path.split("/").at(-1)),
      );
      if (request.method() === "PUT")
        Object.assign(profile!, request.postDataJSON(), { version: Number(profile!.version) + 1 });
      return reply(profile);
    }
    if (path === "/api/setup/analyze-website") {
      const profile = profiles.find((item) => item.id === Number(business))!;
      profile.websiteAnalysis = {
        data: extracted,
        url: request.postDataJSON().url,
        analyzedAt: new Date().toISOString(),
        kbEntryId: 88,
        summary: { pages: 4, knowledgeSaved: true, warnings: [] },
      };
      return reply({
        success: true,
        data: extracted,
        kbEntryId: 88,
        analysisSummary: { pages: 4, knowledgeSaved: true, warnings: [] },
      });
    }
    if (path === "/api/content/brand-toolkits") {
      if (request.method() === "POST") {
        const toolkit = { ...request.postDataJSON(), id: 55, version: 1, businessProfileId: Number(business) };
        toolkits.push(toolkit);
        account.hasBrandToolkit = true;
        return reply(toolkit);
      }
      return reply(toolkits.filter(item => item.businessProfileId === Number(business)));
    }
    if (/^\/api\/content\/brand-toolkits\/\d+$/.test(path)) {
      const toolkit = toolkits.find(item => item.id === Number(path.split("/").at(-1)));
      if (request.method() === "PUT") Object.assign(toolkit!, request.postDataJSON(), { version: Number(toolkit!.version) + 1 });
      return reply(toolkit);
    }
    if (path.endsWith("/upload-image")) return reply({ success: true, url: `/uploads/${business}/uploaded-${requests.filter(item => item.path.endsWith('/upload-image')).length}.png` });
    if (path.endsWith("/upload-logo") || path.endsWith("/logo")) return reply({ success: true, url: `/uploads/${business}/uploaded-logo.png`, originalName: "logo.png" });
    if (path === "/api/auth/mark-setup-complete") { account.isSetupComplete = true; return reply({ success: true }); }
    if (path === "/api/settings/knowledge-base/88/extracted-text")
      return reply({
        extractedText: "Creator Studio website knowledge",
        chunks: [],
        embeddingsGenerated: true,
      });
    if (path === "/api/organizations")
      return reply({
        organizations: [
          {
            id: 91,
            businessProfileId: Number(business) || 26,
            name: "Workspace",
            ownerUserId: 4101,
            role: "owner",
            canManageBilling: true,
          },
        ],
        invitations: [],
        selectedOrganizationId: 91,
      });
    if (path === "/api/chat/threads") return reply({ threads: [], total: 0 });
    return reply([]);
  });
  return { requests, profiles, toolkits, account, drafts, jobs };
}
