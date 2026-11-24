export type PlatformModuleKey =
  | "campaigns"
  | "lead_generation"
  | "content"
  | "performance_marketing"
  | "ai_visibility"
  | "outreach"
  | "crm"
  | "support"
  | "support_ai"
  | "proposals"
  | "knowledge_base"
  | "integrations"
  | "billing"
  | "storage";

export type PlatformModuleStatus = "available" | "maintenance" | "disabled";
export type UserModuleMode = "inherit" | "enabled" | "disabled";

export interface PlatformAccessModule {
  key: PlatformModuleKey;
  name: string;
  description: string;
  status: PlatformModuleStatus;
  message: string | null;
  mode: UserModuleMode;
  enabled: boolean;
}

export interface PlatformAccessResponse {
  subscription?: import('../../../shared/subscriptions').SubscriptionAccess;
  maintenance: { enabled: boolean; message: string };
  modules: PlatformAccessModule[];
}

const PATH_MODULES: Array<[string, PlatformModuleKey]> = [
  ["/dashboard/ai-visibility", "ai_visibility"],
  ["/dashboard/support-ai", "support_ai"],
  ["/dashboard/support", "support"],
  ["/dashboard/ads-campaigns", "performance_marketing"],
  ["/dashboard/ads-analytics", "performance_marketing"],
  ["/dashboard/ads", "performance_marketing"],
  ["/dashboard/marketing", "performance_marketing"],
  ["/dashboard/outreach", "outreach"],
  ["/dashboard/enrichment", "lead_generation"],
  ["/dashboard/leads", "lead_generation"],
  ["/dashboard/saved-templates", "content"],
  ["/dashboard/content-calendar", "content"],
  ["/dashboard/brand-toolkit", "content"],
  ["/dashboard/content/templates", "content"],
  ["/dashboard/content/calendar", "content"],
  ["/dashboard/content/brand-toolkit", "content"],
  // Outreach surfaces and analytics share the outreach permission boundary.
  // Keep these mappings aligned with the channel routes and /api/outreach/stats
  // so direct links cannot open a page that the sidebar would hide (or vice versa).
  ["/dashboard/outreach-analytics", "outreach"],
  ["/dashboard/conversations", "campaigns"],
  ["/dashboard/campaigns", "campaigns"],
  ["/dashboard/chats", "campaigns"],
  ["/dashboard/chat", "campaigns"],
  ["/dashboard/crm", "crm"],
  ["/dashboard/proposals", "proposals"],
  ["/dashboard/knowledge-base", "knowledge_base"],
  ["/dashboard/integrations", "integrations"],
  ["/dashboard/settings/ads", "performance_marketing"],
  ["/dashboard/settings/leads", "lead_generation"],
  ["/dashboard/settings/integrations", "integrations"],
  ["/dashboard/billing", "billing"],
  ["/dashboard/storage", "storage"],
];

const NAV_SECTION_MODULES: Record<string, PlatformModuleKey> = {
  campaigns: "campaigns",
  "lead-agent": "lead_generation",
  "content-agent": "content",
  "performance-marketing": "performance_marketing",
  "ai-visibility": "ai_visibility",
  "outreach-agent": "outreach",
  crm: "crm",
  support: "support",
  "support-ai": "support_ai",
  proposals: "proposals",
  "knowledge-base": "knowledge_base",
  integrations: "integrations",
};

const HIDDEN_DASHBOARD_PATHS = [
  "/dashboard/outreach/twitter",
  "/dashboard/outreach/linkedin",
  "/dashboard/integrations/twitter",
  "/dashboard/integrations/linkedin",
] as const;

export function isHiddenDashboardPath(pathname: string): boolean {
  return HIDDEN_DASHBOARD_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function moduleForDashboardPath(pathname: string): PlatformModuleKey | null {
  return PATH_MODULES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.[1] ?? null;
}

export function moduleForNavigationSection(section: string): PlatformModuleKey | null {
  return NAV_SECTION_MODULES[section] ?? null;
}

export function getModuleUnavailableMessage(
  module: Pick<PlatformAccessModule, "status" | "mode" | "message"> | null | undefined,
): string {
  if (module?.message?.trim()) return module.message;
  if (!module) {
    return "This module is not configured for your account. Contact an administrator if you need access.";
  }
  if (module.status === "maintenance") {
    return "This module is temporarily under maintenance. Please try again later.";
  }
  if (module.status === "disabled") {
    return "This module is currently disabled platform-wide. A super administrator must mark it available before account-level access can take effect.";
  }
  if (module.mode === "disabled") {
    return "This module is not enabled for your account. Contact an administrator if you need access.";
  }
  return "This module is unavailable for your account. Contact an administrator if you need access.";
}
