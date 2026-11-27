import { getTabLabel, normalizeTabType, TAB_TYPES } from "@/lib/tabConfig";

/**
 * Workspace tabs with one fixed purpose always show the registry name, so the
 * picker, the tab bar and saved tabs agree ("Agents", not "Choose Agent" in one
 * place and "Agent Choose" in another). Content tabs keep their own titles.
 */
const FIXED_NAME_TABS = new Set<string>([
  TAB_TYPES.OVERVIEW, TAB_TYPES.SEARCH, TAB_TYPES.ICP, TAB_TYPES.AGENT_CHOOSE,
  TAB_TYPES.LEADS, TAB_TYPES.LEAD_INPUTS, TAB_TYPES.OUTREACH, TAB_TYPES.CAMPAIGNS,
  TAB_TYPES.ADS, TAB_TYPES.PERFORMANCE_MARKETING, TAB_TYPES.CRM, TAB_TYPES.SUPPORT,
  TAB_TYPES.PROPOSALS,
]);

const PLATFORM_NAMES: Record<string, string> = {
  linkedin: "LinkedIn", facebook: "Facebook", instagram: "Instagram", twitter: "X", x: "X",
  tiktok: "TikTok", youtube: "YouTube", pinterest: "Pinterest", threads: "Threads", universal: "Universal",
};

export function displayTabLabel(tabType: string, label?: string | null): string {
  const type = normalizeTabType(tabType);
  if (FIXED_NAME_TABS.has(type)) return getTabLabel(type);
  const text = (label || "").trim() || getTabLabel(type);
  // Older saved post plans were titled from the raw platform value: "linkedin plan (5 posts)".
  return text.replace(/^([a-z]+)(?= plan \()/i, (name) => PLATFORM_NAMES[name.toLowerCase()] ?? name);
}
