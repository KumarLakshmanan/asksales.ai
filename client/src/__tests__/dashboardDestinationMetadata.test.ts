import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDashboardDestinationIndex, scoreDashboardDestination } from "@/lib/dashboard-destinations";

// Relevant metadata contract from sidebar-orientation at 0992048. This fixture
// models parent integration; it does not add that branch's pages to base v8.
const mocks = vi.hoisted(() => ({
  sections: [
    { section: "campaigns", label: "Campaign History", aliases: ["Campaigns", "Conversational campaigns"], activePath: "/dashboard/chat", children: [{ label: "All Campaigns", aliases: ["View All", "View all campaigns", "Campaign History"], path: "/dashboard/chats" }] },
    { section: "content-agent", label: "Content Creator", activePath: "/dashboard/saved-templates", children: [{ label: "Content library", aliases: ["Templates", "Saved templates"], path: "/dashboard/saved-templates" }] },
    { section: "performance-marketing", label: "Marketing", aliases: ["Performance Marketing"], activePath: "/dashboard/ads", children: [{ label: "Paid Ads", path: "/dashboard/ads" }] },
    { section: "settings", label: "Settings", activePath: "/dashboard/settings", children: [
      { label: "Account settings", aliases: ["Profile & Security"], path: "/dashboard/settings" },
      { label: "Workspace config", aliases: ["Workspace configuration", "Workspace settings"], path: "/dashboard/settings/workspace", roles: ["owner", "billing_admin", "member"] },
    ] },
    { section: "support", label: "Support", activePath: "/dashboard/support", children: [{ label: "Teams", path: "/dashboard/support/teams", roles: ["owner"] }] },
    { section: "support-ai", label: "Support AI", activePath: "/dashboard/support-ai", children: [{ label: "Widget settings", path: "/dashboard/support-ai/widget-settings", module: "support_ai", roles: ["owner", "billing_admin", "member"], preserveQueryParams: ["team"] }] },
    { section: "integrations", label: "Integrations", activePath: "/dashboard/integrations", children: [{ label: "Email", path: "/dashboard/integrations/email" }] },
  ],
  sectionsHelper: vi.fn(),
  hrefHelper: vi.fn(),
}));

vi.mock("@/lib/sidebarConfig", () => ({ navSections: mocks.sections, bottomNavItems: [], availableNavigationSections: mocks.sectionsHelper, navigationItemHref: mocks.hrefHelper }));

const modules = ["campaigns", "content", "performance_marketing", "support", "support_ai", "integrations"] as const;
const search = (query: string, index = buildDashboardDestinationIndex({ enabledModules: modules, workspaceRole: "owner" })) => index
  .map(destination => ({ ...destination, score: scoreDashboardDestination(destination, query) }))
  .filter(destination => destination.score > 0).sort((a, b) => b.score - a.score);

beforeEach(() => {
  mocks.sectionsHelper.mockReset().mockReturnValue(mocks.sections);
  mocks.hrefHelper.mockReset().mockReturnValue("/dashboard/support-ai/widget-settings?team=4105");
});

describe("published sidebar metadata compatibility", () => {
  it("consumes canonical item names and old aliases without an independently added overview route", () => {
    for (const [query, href] of [
      ["Workspace configuration", "/dashboard/settings/workspace"], ["Workspace settings", "/dashboard/settings/workspace"],
      ["Campaign History", "/dashboard/chats"], ["View All", "/dashboard/chats"],
      ["Templates", "/dashboard/saved-templates"], ["Profile & Security", "/dashboard/settings"],
    ]) {
      expect(search(query)[0].href, query).toBe(href);
      expect(search(query)[0].score, query).toBeGreaterThanOrEqual(0.99);
    }
    expect(search("Workspace configuration")[0].title).toBe("Workspace config");
    expect(search("Profile & Security")[0].title).toBe("Account settings");
  });

  it("retains previous section names in full navigation phrases and uses current Paid Ads parents", () => {
    expect(search("Navigate to Paid Ads in Performance Marketing /dashboard/ads")[0].href).toBe("/dashboard/ads");
    expect(search("Navigate to View All in Campaigns /dashboard/chats")[0].href).toBe("/dashboard/chats");
    for (const query of ["paid ads overview", "ads campaigns", "ad recommendations", "ads activity"]) {
      expect(search(query)[0].parent).toBe("Marketing / Paid Ads");
    }
  });

  it("matches known workspace-role metadata while retaining permitted provider read pages", () => {
    for (const workspaceRole of ["owner", "billing_admin", "member", undefined] as const) {
      const index = buildDashboardDestinationIndex({ enabledModules: modules, workspaceRole });
      expect(index.some(destination => destination.href === "/dashboard/support/teams")).toBe(workspaceRole === "owner");
      expect(index.some(destination => destination.href === "/dashboard/settings/workspace")).toBe(!!workspaceRole);
      expect(index.some(destination => destination.href === "/dashboard/integrations/email")).toBe(true);
      expect(index.some(destination => destination.href === "/dashboard/integrations")).toBe(workspaceRole === "owner" || workspaceRole === "billing_admin");
    }
  });

  it("uses the shared section helper's result with the selected role instead of restoring filtered children", () => {
    mocks.sectionsHelper.mockReturnValue([]);
    const index = buildDashboardDestinationIndex({ enabledModules: modules, workspaceRole: "member" });
    expect(mocks.sectionsHelper).toHaveBeenCalledWith(modules, "member");
    expect(index.some(destination => destination.href === "/dashboard/chats" || destination.href === "/dashboard/settings/workspace")).toBe(false);
  });

  it("hands the explicit widget context to the shared URL helper and uses its result", () => {
    const query = new URLSearchParams("team=4105&tab=appearance");
    const index = buildDashboardDestinationIndex({ enabledModules: modules, workspaceRole: "member", query });
    expect(search("widget settings", index)[0].href).toBe("/dashboard/support-ai/widget-settings?team=4105");
    expect(mocks.hrefHelper).toHaveBeenCalledWith(expect.objectContaining({ path: "/dashboard/support-ai/widget-settings", preserveQueryParams: ["team"] }), query);
  });

  it("keeps explicit module requirements and owner catalog permission after metadata integration", () => {
    const index = buildDashboardDestinationIndex({ enabledModules: ["outreach", "integrations"], workspaceRole: "member", canManageAssistants: true });
    expect(index.some(destination => destination.href.includes("widget-settings") || destination.href.includes("settings/outreach"))).toBe(false);
    expect(index.some(destination => destination.href === "/dashboard/integrations/email")).toBe(true);
  });
});
