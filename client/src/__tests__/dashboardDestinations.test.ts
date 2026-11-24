import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDashboardDestinationIndex, isFinderDestinationAllowed, scoreDashboardDestination } from "@/lib/dashboard-destinations";
import { bottomNavItems, navSections } from "@/lib/sidebarConfig";

const destinations = buildDashboardDestinationIndex({ canManageAssistants: true, workspaceRole: "owner" });
const search = (query: string, index = destinations) => index
  .map(destination => ({ ...destination, score: scoreDashboardDestination(destination, query) }))
  .filter(destination => destination.score > 0).sort((a, b) => b.score - a.score);

describe("dashboard destination search", () => {
  it.each([
    ["blog", "/dashboard/saved-templates/blog"], ["blog posts", "/dashboard/saved-templates/blog"],
    ["email library", "/dashboard/saved-templates/email"], ["dm", "/dashboard/saved-templates/dm"],
    ["follow-ups", "/dashboard/outreach/follow-ups"], [" FOLLOW–UP   HISTORY ", "/dashboard/outreach/follow-ups?tab=history"],
    ["followup", "/dashboard/outreach/follow-ups"], ["follow-up templates", "/dashboard/outreach/follow-ups?tab=templates"],
    ["assistants", "/dashboard/settings/outreach"], ["Outreach Settings", "/dashboard/settings/outreach"],
    ["widget settings", "/dashboard/support-ai/widget-settings"], ["widget configuration", "/dashboard/support-ai/widget-settings"],
    ["paid ads overview", "/dashboard/ads?tab=overview"], ["ads campaigns", "/dashboard/ads?tab=campaigns"],
    ["ad recommendations", "/dashboard/ads?tab=recommendations"], ["ads activity", "/dashboard/ads?tab=automation"],
    ["new blog post", "/dashboard/saved-templates/blog/generate"], ["generate email", "/dashboard/saved-templates/email/generate"],
    ["new dm template", "/dashboard/saved-templates/dm/generate"], ["new assistant", "/dashboard/settings/outreach/new"],
  ])("ranks %s first at its verified destination", (query, href) => {
    expect(search(query)[0].href).toBe(href);
    expect(search(query)[0].score).toBeGreaterThanOrEqual(0.99);
  });

  it("keeps fuzzy discovery below exact names and aliases", () => {
    expect(search("blg").some(destination => destination.href === "/dashboard/saved-templates/blog")).toBe(true);
    expect(search("widgt settngs").some(destination => destination.href === "/dashboard/support-ai/widget-settings")).toBe(true);
    expect(search("folow up history")[0].href).toBe("/dashboard/outreach/follow-ups?tab=history");
    expect(search("create assistant", buildDashboardDestinationIndex({ enabledModules: ["content", "support_ai"] }))).toEqual([]);
    const blog = search("blog");
    const unrelated = blog.filter(destination => ["/dashboard/billing", "/dashboard/proposals/catalog"].includes(destination.href));
    expect(blog[0].href).toBe("/dashboard/saved-templates/blog");
    expect(unrelated.every(destination => destination.score < blog[0].score)).toBe(true);
    expect(search("zzzz-no-destination-98765")).toEqual([]);
    expect(search("  ")).toHaveLength(destinations.length);
  });

  it("preserves every current sidebar term and legacy finder terms without duplicate destinations", () => {
    const sidebarItems = navSections.flatMap(section => section.children.length ? section.children : [{ label: section.label, path: section.activePath }]).concat(bottomNavItems);
    for (const item of sidebarItems) {
      expect(search(item.label).some(destination => destination.href === item.path)).toBe(true);
      expect(search(`Navigate to ${item.label} ${item.path}`).some(destination => destination.href === item.path && destination.score >= 0.99)).toBe(true);
    }
    for (const [query, href] of [["Dashboard home page", "/dashboard/home"], ["My profile settings", "/dashboard/settings"], ["Integrations settings", "/dashboard/integrations"], ["View All Campaigns", "/dashboard/chats"], ["Content library", "/dashboard/saved-templates"]]) {
      expect(search(query)[0]?.href, query).toBe(href);
    }
    expect(new Set(destinations.map(destination => destination.href)).size).toBe(destinations.length);
  });

  it("gives repeated labels explicit parents", () => {
    for (const title of ["Templates", "Pipeline", "Reports", "Analytics", "Campaigns"]) {
      const matches = destinations.filter(destination => destination.title === title);
      expect(new Set(matches.map(destination => destination.parent)).size).toBe(matches.length);
      expect(matches.every(destination => destination.parent !== "Page")).toBe(true);
    }
  });

  it("indexes real pages and only source-confirmed query tabs", () => {
    for (const destination of destinations) {
      if (destination.href === "/documentation") {
        expect(existsSync(resolve(process.cwd(), "src/app/documentation/[[...slug]]/page.tsx"))).toBe(true);
        continue;
      }
      const path = destination.href.split("?", 1)[0].replace("/dashboard/", "");
      const file = `src/app/dashboard/(main)/${path}/page.tsx`;
      const optionalCatchAll = `src/app/dashboard/(main)/${path}/[[...threadId]]/page.tsx`;
      expect(existsSync(resolve(process.cwd(), file)) || existsSync(resolve(process.cwd(), optionalCatchAll)), destination.href).toBe(true);
      const tab = new URL(destination.href, "https://example.test").searchParams.get("tab");
      if (tab) {
        const source = readFileSync(resolve(process.cwd(), `src/app/dashboard/(main)/${path}/page.tsx`), "utf8");
        expect(source, destination.href).toMatch(new RegExp(`["']${tab}["']`));
      }
    }
    expect(destinations.filter(destination => destination.kind === "form-entry").map(destination => destination.href)).toEqual([
      "/dashboard/saved-templates/blog/generate", "/dashboard/saved-templates/email/generate", "/dashboard/saved-templates/dm/generate", "/dashboard/settings/outreach/new",
    ]);
    expect(destinations.some(destination => /[?&](?:send|generate|publish|billing|businessProfileId|team)=/.test(destination.href))).toBe(false);
  });
});

describe("finder destination permissions", () => {
  it("filters every route and query tab by its module, including Settings children", () => {
    const empty = buildDashboardDestinationIndex({ enabledModules: [], canManageAssistants: true });
    expect(empty.every(destination => destination.modules.length === 0 && !destination.anyModule)).toBe(true);
    const content = buildDashboardDestinationIndex({ enabledModules: ["content"] });
    expect(search("blog posts", content)[0].href).toBe("/dashboard/saved-templates/blog");
    expect(content.some(destination => destination.href.includes("follow-ups") || destination.href.includes("widget-settings") || destination.href.includes("settings/ads") || destination.href.includes("settings/outreach") || destination.href.includes("ads?tab="))).toBe(false);
    const support = buildDashboardDestinationIndex({ enabledModules: ["support_ai"], workspaceRole: "member" });
    expect(support.some(destination => destination.href === "/dashboard/settings/outreach")).toBe(true);
    expect(support.some(destination => destination.href.includes("follow-ups"))).toBe(false);
    const outreach = buildDashboardDestinationIndex({ enabledModules: ["outreach"] });
    expect(outreach.some(destination => destination.href.includes("settings/outreach"))).toBe(false);
    expect(outreach.some(destination => destination.href.includes("follow-ups?tab=history"))).toBe(true);
  });

  it("requires owner scope and confirmed catalog permission without inferring management from role", () => {
    for (const canManageAssistants of [undefined, false]) {
      expect(buildDashboardDestinationIndex({ enabledModules: ["support_ai"], workspaceRole: "owner", canManageAssistants }).some(destination => destination.href.endsWith("outreach/new"))).toBe(false);
    }
    expect(buildDashboardDestinationIndex({ enabledModules: ["support_ai"], workspaceRole: "owner", canManageAssistants: true }).some(destination => destination.href.endsWith("outreach/new"))).toBe(true);
    for (const workspaceRole of [undefined, "member", "billing_admin"] as const) {
      expect(buildDashboardDestinationIndex({ enabledModules: ["support_ai"], workspaceRole, canManageAssistants: true }).some(destination => destination.href.endsWith("outreach/new"))).toBe(false);
    }
    expect(buildDashboardDestinationIndex({ enabledModules: [], workspaceRole: "owner", canManageAssistants: true }).some(destination => destination.href.endsWith("outreach/new"))).toBe(false);
  });

  it("retains Insights' any-module access rule", () => {
    for (const enabledModules of [[], ["content"], ["support"], ["outreach"], ["crm"], ["billing"]] as const) {
      const index = buildDashboardDestinationIndex({ enabledModules });
      expect(index.some(destination => destination.href === "/dashboard/insights")).toBe(enabledModules.some(module => ["support", "outreach", "crm", "billing"].includes(module)));
    }
  });

  it("matches verified settings metadata roles and canonical names while retaining old aliases", () => {
    for (const workspaceRole of ["owner", "billing_admin", "member", undefined] as const) {
      const index = buildDashboardDestinationIndex({ enabledModules: ["integrations", "crm", "proposals", "support_ai"], workspaceRole });
      expect(index.some(destination => destination.href === "/dashboard/integrations")).toBe(workspaceRole === "owner" || workspaceRole === "billing_admin");
      // The shared sidebar helper allows provider read pages; their existing
      // server write boundaries remain stronger than navigation visibility.
      expect(index.some(destination => destination.href.startsWith("/dashboard/integrations/"))).toBe(true);
      for (const href of ["/dashboard/support/teams", "/dashboard/support/notifications"]) {
        const support = buildDashboardDestinationIndex({ enabledModules: ["support"], workspaceRole });
        expect(support.some(destination => destination.href === href)).toBe(workspaceRole === "owner");
      }
      for (const href of ["/dashboard/settings/team", "/dashboard/crm/configuration", "/dashboard/proposals/settings", "/dashboard/settings/outreach", "/dashboard/support-ai/widget-settings"]) {
        expect(index.some(destination => destination.href === href), `${workspaceRole}: ${href}`).toBe(!!workspaceRole);
      }
    }
    expect(search("Configuration")[0].title).toBe("CRM configuration");
    expect(search("Outreach Settings")[0].parent).toBe("Workspace configuration / Customer support & replies");
    // The new overview enters via verified sidebar metadata after parent
    // integration; the standalone finder must not manufacture that entry.
    expect(destinations.some(destination => destination.href === "/dashboard/settings/workspace"))
      .toBe(navSections.some(section => section.children.some(item => item.path === "/dashboard/settings/workspace")));
  });

  it("does not fuzzy-match forbidden or unrelated tasks through long settings breadcrumbs", () => {
    const index = buildDashboardDestinationIndex({ enabledModules: ["content", "support_ai", "integrations"], workspaceRole: "member" });
    for (const query of ["Twitter", "LinkedIn", "AI Studio", "Approvals", "create assistant", "follow-ups", "paid ads recommendations"]) {
      expect(search(query, index), query).toEqual([]);
    }
    expect(search("widget settings", index)[0].href).toBe("/dashboard/support-ai/widget-settings");
    expect(search("Navigate to Configuration in CRM /dashboard/crm/configuration")[0].href).toBe("/dashboard/crm/configuration");
  });

  it("preserves explicit widget team context, encoding only whitelisted context parameters", () => {
    for (const widgetTeam of ["4104", "4105", "", "-1", "0", "other&businessProfileId=99", null]) {
      const query = new URLSearchParams({ tab: "appearance", businessProfileId: "99", publish: "true" });
      if (widgetTeam !== null) query.set("team", widgetTeam);
      const index = buildDashboardDestinationIndex({ enabledModules: ["support_ai"], workspaceRole: "member", query });
      const expected = widgetTeam !== null ? `/dashboard/support-ai/widget-settings?${new URLSearchParams({ team: widgetTeam })}` : "/dashboard/support-ai/widget-settings";
      expect(search("widget settings", index)[0].href).toBe(expected);
      expect([...new URL(expected, "https://example.test").searchParams.keys()]).toEqual(widgetTeam === null ? [] : ["team"]);
    }
  });

  it.each(["/dashboard/content", "/dashboard/content/approvals", "/dashboard/outreach/twitter", "/dashboard/outreach/linkedin/create", "/dashboard/integrations/twitter", "/dashboard/integrations/linkedin", "/dashboard/saved-templates/whatsapp", "/dashboard/saved-templates/whatsapp/generate", "/outside"])("excludes hidden or retired destination %s", href => {
    expect(isFinderDestinationAllowed(href + "?tab=history")).toBe(false);
    expect(destinations.some(destination => destination.href === href)).toBe(false);
  });
});
