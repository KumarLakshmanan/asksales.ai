import type { ReactNode } from "react";
import { defaultFilter } from "cmdk";
import * as navigation from "./sidebarConfig";
import type { NavItem, NavSection } from "./sidebarConfig";
import { isHiddenDashboardPath, moduleForDashboardPath, moduleForNavigationSection, type PlatformModuleKey } from "./platform-access";
import type { BusinessProfileSummary } from "@/hooks/use-business-profiles";

type WorkspaceRole = NonNullable<BusinessProfileSummary["role"]>;
type NavigationQuery = { get: (name: string) => string | null };
// The published sidebar branch adds these fields/helpers. Accept them on v8
// without importing absent exports or copying the sidebar's implementation.
type FinderNavItem = NavItem & { aliases?: readonly string[]; module?: PlatformModuleKey; roles?: readonly WorkspaceRole[]; preserveQueryParams?: readonly string[] };
type FinderNavSection = NavSection & { aliases?: readonly string[] };
const sharedNavigation = navigation as typeof navigation & {
  availableNavigationSections?: (modules: readonly PlatformModuleKey[], role?: WorkspaceRole) => NavSection[];
  navigationItemHref?: (item: FinderNavItem, query: NavigationQuery) => string;
};
const { bottomNavItems, navSections } = navigation;
const allWorkspaceRoles = ["owner", "billing_admin", "member"] as const;
const workspaceConnections = "Workspace configuration / Workspace & connections";
const workspaceSales = "Workspace configuration / Sales configuration";
const workspaceSupport = "Workspace configuration / Customer support & replies";

export interface DashboardDestination {
  /** Dashboard pages, plus the public documentation the sidebar links to. */
  href: `/dashboard/${string}` | "/documentation";
  title: string;
  parent: string;
  aliases: readonly string[];
  kind: "page" | "form-entry";
  modules: readonly PlatformModuleKey[];
  anyModule?: readonly PlatformModuleKey[];
  permission?: "manageAssistants";
  workspaceRoles?: readonly WorkspaceRole[];
  preserveQueryParams?: readonly string[];
  icon?: ReactNode;
}

export interface DestinationAccess {
  enabledModules?: readonly PlatformModuleKey[];
  canManageAssistants?: boolean;
  workspaceRole?: WorkspaceRole;
  query?: NavigationQuery;
}

// These destinations are verified in the corresponding App Router pages. Query
// values are accepted by follow-ups/page.tsx and ads/page.tsx. Form entries only
// open an editor: no generated content, recipient, publish or billing action.
const taskDestinations: readonly DashboardDestination[] = [
  { href: "/dashboard/saved-templates/blog", title: "Blog posts", parent: "Content Creator / Content library", aliases: ["blog", "blogs", "blog library", "blog templates"], kind: "page", modules: ["content"] },
  { href: "/dashboard/saved-templates/email", title: "Email templates", parent: "Content Creator / Content library", aliases: ["email library", "email content", "email drafts"], kind: "page", modules: ["content"] },
  { href: "/dashboard/saved-templates/dm", title: "Social DM templates", parent: "Content Creator / Content library", aliases: ["dm", "dm templates", "dm library", "direct messages", "social message templates"], kind: "page", modules: ["content"] },
  { href: "/dashboard/saved-templates/blog/generate", title: "Create blog post", parent: "Content Creator / Blog posts / Editor", aliases: ["new blog post", "generate blog", "blog generator"], kind: "form-entry", modules: ["content"] },
  { href: "/dashboard/saved-templates/email/generate", title: "Create email template", parent: "Content Creator / Email templates / Editor", aliases: ["new email template", "generate email", "email generator"], kind: "form-entry", modules: ["content"] },
  { href: "/dashboard/saved-templates/dm/generate", title: "Create DM template", parent: "Content Creator / Social DM templates / Editor", aliases: ["new dm template", "generate dm", "dm generator"], kind: "form-entry", modules: ["content"] },
  { href: "/dashboard/outreach/inbox", title: "Inbox", parent: "Outreach", aliases: ["outreach inbox", "replies"], kind: "page", modules: ["outreach"] },
  { href: "/dashboard/outreach/follow-ups", title: "Follow-ups", parent: "Outreach", aliases: ["follow ups", "followup", "followups", "follow-up settings", "follow-up defaults"], kind: "page", modules: ["outreach"] },
  { href: "/dashboard/outreach/follow-ups?tab=history", title: "Follow-up history", parent: "Outreach / Follow-ups", aliases: ["follow up history", "followups history", "follow-up delivery history"], kind: "page", modules: ["outreach"] },
  { href: "/dashboard/outreach/follow-ups?tab=templates", title: "Follow-up templates", parent: "Outreach / Follow-ups", aliases: ["follow up templates", "followups templates"], kind: "page", modules: ["outreach"] },
  // The assistant API requires support_ai, even though its legacy URL is in Settings.
  // Settings names, scope and roles match settings-navigation.ts on the verified
  // settings-scope-overview branch (44a8823). Its new overview page is not on v8.
  { href: "/dashboard/settings/outreach", title: "Assistants", parent: workspaceSupport, aliases: ["assistant", "manage assistants", "outreach settings", "specialist settings", "Support AI settings"], kind: "page", modules: ["support_ai"], workspaceRoles: allWorkspaceRoles },
  { href: "/dashboard/settings/outreach/new", title: "Create assistant", parent: "Support AI / Assistants / Editor", aliases: ["new assistant", "assistant setup"], kind: "form-entry", modules: ["support_ai"], permission: "manageAssistants", workspaceRoles: ["owner"] },
  { href: "/dashboard/support-ai/widget-settings", title: "Widget settings", parent: `${workspaceSupport} / Support team`, aliases: ["widget configuration", "customize widget", "chat widget", "widget appearance", "Support AI widget settings"], kind: "page", modules: ["support_ai"], workspaceRoles: allWorkspaceRoles, preserveQueryParams: ["team"] },
  { href: "/dashboard/settings/team", title: "Staff", parent: workspaceConnections, aliases: ["team", "team settings"], kind: "page", modules: [], workspaceRoles: allWorkspaceRoles },
  { href: "/dashboard/integrations", title: "Integrations", parent: workspaceConnections, aliases: ["Integrations settings", "workspace connections"], kind: "page", modules: ["integrations"], workspaceRoles: ["owner", "billing_admin"] },
  { href: "/dashboard/crm/configuration", title: "CRM configuration", parent: workspaceSales, aliases: ["Configuration", "crm settings", "contact stages"], kind: "page", modules: ["crm"], workspaceRoles: allWorkspaceRoles },
  { href: "/dashboard/proposals/settings", title: "Proposal settings", parent: workspaceSales, aliases: ["proposal configuration"], kind: "page", modules: ["proposals"], workspaceRoles: allWorkspaceRoles },
  { href: "/dashboard/ads?tab=overview", title: "Overview", parent: "Performance Marketing / Paid Ads", aliases: ["paid ads overview", "ad performance", "ads analytics"], kind: "page", modules: ["performance_marketing"] },
  { href: "/dashboard/ads?tab=campaigns", title: "Campaigns", parent: "Performance Marketing / Paid Ads", aliases: ["paid ads campaigns", "ad campaigns", "ads campaigns"], kind: "page", modules: ["performance_marketing"] },
  { href: "/dashboard/ads?tab=recommendations", title: "Recommendations", parent: "Performance Marketing / Paid Ads", aliases: ["paid ads recommendations", "ad recommendations"], kind: "page", modules: ["performance_marketing"] },
  { href: "/dashboard/ads?tab=automation", title: "Automation & activity", parent: "Performance Marketing / Paid Ads", aliases: ["paid ads automation", "ads activity", "automation and activity"], kind: "page", modules: ["performance_marketing"] },
];

const legacyAliases: Record<string, readonly string[]> = {
  "/dashboard/chats": ["View All", "View All Campaigns", "campaign history"],
  "/dashboard/conversations": ["New Campaign"],
  "/dashboard/saved-templates": ["Templates", "saved templates", "Content library"],
  "/dashboard/settings": ["My profile", "My profile settings", "profile settings", "Profile & Security"],
  "/dashboard/integrations": ["Integrations settings"],
  "/dashboard/settings/team": ["Staff", "team", "team settings"],
  "/dashboard/support-ai/embed": ["Embed & Integrate", "embed", "widget embed"],
};

function pathOnly(href: string) { return href.split(/[?#]/, 1)[0]; }

export function isFinderDestinationAllowed(href: string): boolean {
  const path = pathOnly(href);
  // Documentation moved out of the dashboard shell but is still a sidebar destination.
  if (path === "/documentation") return true;
  return path.startsWith("/dashboard/") && !isHiddenDashboardPath(path)
    && path !== "/dashboard/content" && !path.startsWith("/dashboard/content/approvals")
    && !path.startsWith("/dashboard/saved-templates/whatsapp");
}

function sidebarDestination(item: FinderNavItem, parent: string, sectionModule?: PlatformModuleKey | null, parentAliases: readonly string[] = []): DashboardDestination {
  const routeModule = item.module ?? moduleForDashboardPath(pathOnly(item.path));
  const names = [item.label, ...(item.aliases || [])];
  // Match the verified owner-only support administration links on the sidebar
  // branch even while base v8 still lacks their explicit roles metadata.
  const roles = item.roles ?? (["/dashboard/support/teams", "/dashboard/support/notifications"].includes(item.path) ? ["owner"] as const : undefined);
  return {
    href: item.path as DashboardDestination["href"], title: item.label, parent,
    aliases: [...names, ...names.flatMap(name => [
      `Navigate to ${name} ${item.path}`,
      ...[parent, ...parentAliases].map(context => `Navigate to ${name} in ${context} ${item.path}`),
    ]), ...(legacyAliases[item.path] || [])],
    kind: "page", modules: [...new Set([sectionModule, routeModule].filter((key): key is PlatformModuleKey => !!key))], icon: item.icon,
    ...(roles ? { workspaceRoles: roles } : {}),
    ...(item.preserveQueryParams ? { preserveQueryParams: item.preserveQueryParams } : {}),
    ...(item.path === "/dashboard/insights" ? { anyModule: ["billing", "outreach", "support", "crm"] as const } : {}),
  };
}

export function buildDashboardDestinationIndex(access: DestinationAccess = {}): DashboardDestination[] {
  const index = new Map<string, DashboardDestination>();
  index.set("/dashboard/home", { href: "/dashboard/home", title: "Dashboard", parent: "Overview", aliases: ["Dashboard home page"], kind: "page", modules: [] });
  const addItems = (items: FinderNavItem[], parent: string, sectionModule?: PlatformModuleKey | null, parentAliases: readonly string[] = []) => {
    for (const item of items) {
      if (item.children?.length) addItems(item.children, `${parent} / ${item.label}`, sectionModule, parentAliases);
      else index.set(item.path, sidebarDestination(item, parent, sectionModule, parentAliases));
    }
  };
  const sections: FinderNavSection[] = typeof sharedNavigation.availableNavigationSections === "function" && access.enabledModules
    ? sharedNavigation.availableNavigationSections(access.enabledModules, access.workspaceRole) : navSections;
  for (const section of sections) {
    const moduleKey = moduleForNavigationSection(section.section);
    if (section.children.length) addItems(section.children, section.label, moduleKey, section.aliases);
    else index.set(section.activePath, sidebarDestination({ label: section.label, aliases: section.aliases, path: section.activePath, icon: section.icon }, "Page", moduleKey));
  }
  addItems(bottomNavItems, "Page");
  index.set("/dashboard/integrations", sidebarDestination({ label: "Integrations", path: "/dashboard/integrations" }, "Settings"));
  for (const destination of taskDestinations) {
    const previous = index.get(destination.href);
    const parent = destination.href.startsWith("/dashboard/ads?tab=") ? `${index.get("/dashboard/ads")?.parent || "Performance Marketing"} / Paid Ads` : destination.parent;
    index.set(destination.href, { ...previous, ...destination, parent, aliases: [...(previous?.aliases || []), ...destination.aliases] });
  }
  const enabled = access.enabledModules ? new Set(access.enabledModules) : null;
  return [...index.values()].filter(destination => isFinderDestinationAllowed(destination.href)
    && (!enabled || destination.modules.every(module => enabled.has(module)) && (!destination.anyModule || destination.anyModule.some(module => enabled.has(module))))
    && (!destination.permission || access.canManageAssistants === true)
    && (!destination.workspaceRoles || !!access.workspaceRole && destination.workspaceRoles.includes(access.workspaceRole)))
    .map(destination => {
      if (!access.query || !destination.preserveQueryParams?.length) return destination;
      const item: FinderNavItem = { label: destination.title, path: destination.href, preserveQueryParams: [...destination.preserveQueryParams] };
      if (sharedNavigation.navigationItemHref) return { ...destination, href: sharedNavigation.navigationItemHref(item, access.query) as DashboardDestination["href"] };
      const params = new URLSearchParams();
      for (const name of destination.preserveQueryParams) {
        const value = access.query.get(name);
        if (value !== null) params.set(name, value);
      }
      return params.size ? { ...destination, href: `${destination.href}?${params}` as DashboardDestination["href"] } : destination;
    });
}

export function normalizeDestinationSearch(value: string): string {
  return value.toLowerCase().replace(/[-_–—/]+/g, " ").replace(/\s+/g, " ").trim();
}

// Keep cmdk's fuzzy matching, but reserve the highest scores for real names and
// aliases so a short task query cannot rank a coincidental path match first.
export function scoreDashboardDestination(destination: DashboardDestination, query: string): number {
  const search = normalizeDestinationSearch(query);
  if (!search) return 1;
  const title = normalizeDestinationSearch(destination.title);
  const aliases = destination.aliases.map(normalizeDestinationSearch);
  if (title === search) return 1;
  if (aliases.includes(search)) return 0.99;
  if (title.startsWith(search)) return 0.9;
  if (aliases.some(alias => alias.startsWith(search))) return 0.85;
  if (title.includes(search)) return 0.8;
  if (aliases.some(alias => alias.includes(search))) return 0.75;
  // Preserve full legacy navigation phrases above, but fuzzy-match task names
  // and aliases only: scattered breadcrumb/path letters are not a task match.
  const fuzzy = Math.max(...[title, ...aliases.filter(alias => !alias.startsWith("navigate to "))]
    .map(term => defaultFilter(term, search)));
  // Very long route/context strings can produce almost-zero subsequence scores
  // for unrelated tasks. Retain useful typos, rather than those coincidences.
  return fuzzy >= 0.001 ? fuzzy * 0.5 : 0;
}
