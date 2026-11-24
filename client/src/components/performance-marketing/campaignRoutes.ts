export type CampaignPageTab = "summary" | "delivery" | "creative" | "recommendations" | "automation" | "google" | "meta" | "technical";

export function campaignPageTab(value?: string | null): CampaignPageTab {
  return ({
    performance: "summary",
    summary: "summary",
    units: "delivery",
    delivery: "delivery",
    creative: "creative",
    recommendations: "recommendations",
    policy: "automation",
    history: "automation",
    automation: "automation",
    google: "google",
    meta: "meta",
    evidence: "technical",
    technical: "technical",
  } as Record<string, CampaignPageTab>)[value || ""] || "summary";
}

function suffix(tab: CampaignPageTab, unit?: string | null) {
  const query = new URLSearchParams();
  if (tab !== "summary") query.set("tab", tab);
  if (unit) query.set(tab === "creative" ? "ad" : "unit", unit);
  const value = query.toString();
  return value ? `?${value}` : "";
}

export function managedCampaignHref(id: string | number, tab: CampaignPageTab = "summary", unit?: string | null) {
  return `/dashboard/ads/campaigns/managed/${encodeURIComponent(String(id))}${suffix(tab, unit)}`;
}

export function providerCampaignHref(platform: string, id: string, tab: CampaignPageTab = "summary", unit?: string | null) {
  return `/dashboard/ads/campaigns/provider/${encodeURIComponent(platform)}/${encodeURIComponent(id)}${suffix(tab, unit)}`;
}

const WORKSPACE_FILTER_KEYS = ['tab', 'account', 'platform', 'currency', 'period', 'comparison', 'objective', 'status', 'metric', 'search', 'date', 'start', 'end', 'layout', 'sort', 'direction', 'columns', 'savedView'];

/** Only local Paid Ads filters can be retained as the return destination. */
export function paidAdsReturnHref(value?: string | null) {
  if (!value) return '/dashboard/ads?tab=campaigns';
  try {
    const url = new URL(value, 'https://asksales.local');
    if (url.origin !== 'https://asksales.local' || url.pathname !== '/dashboard/ads') return '/dashboard/ads?tab=campaigns';
    const query = new URLSearchParams();
    for (const key of WORKSPACE_FILTER_KEYS) {
      const entry = url.searchParams.get(key);
      if (entry && entry.length <= 500) query.set(key, entry);
    }
    if (!query.has('tab')) query.set('tab', 'campaigns');
    return `/dashboard/ads?${query.toString()}`;
  } catch { return '/dashboard/ads?tab=campaigns'; }
}

/** Switch workspace sections without losing the selected reporting scope. */
export function paidAdsWorkspaceHref(tab: 'overview' | 'campaigns' | 'recommendations' | 'automation', workspaceSearch: string) {
  const destination = new URL(paidAdsReturnHref(`/dashboard/ads?${workspaceSearch}`), 'https://asksales.local');
  destination.searchParams.set('tab', tab);
  return `${destination.pathname}?${destination.searchParams.toString()}`;
}

/** Keep the reporting scope while replacing the active research step. */
export function paidAdsCreativeResearchHref(workspaceSearch: string, selection: { briefId?: string | number; researchId?: string | number }) {
  const destination = new URL(paidAdsWorkspaceHref('recommendations', workspaceSearch), 'https://asksales.local');
  const campaignId = new URLSearchParams(workspaceSearch).get('creativeCampaign');
  if (campaignId && /^[1-9]\d*$/.test(campaignId)) destination.searchParams.set('creativeCampaign', campaignId);
  if (selection.briefId && /^[1-9]\d*$/.test(String(selection.briefId))) destination.searchParams.set('creativeBrief', String(selection.briefId));
  else if (selection.researchId && /^[1-9]\d*$/.test(String(selection.researchId))) destination.searchParams.set('creativeResearch', String(selection.researchId));
  else destination.searchParams.set('research', '1');
  return `${destination.pathname}?${destination.searchParams.toString()}`;
}

export function withPaidAdsContext(href: string, workspaceSearch: string) {
  const destination = new URL(href, 'https://asksales.local');
  const current = new URLSearchParams(workspaceSearch);
  const returnTo = current.get('returnTo') || `/dashboard/ads?${current.toString()}`;
  destination.searchParams.set('returnTo', paidAdsReturnHref(returnTo));
  for (const key of ['account', 'period', 'date', 'start', 'end']) {
    const value = current.get(key);
    if (value && (key !== "account" || /^\d+$/.test(value))) destination.searchParams.set(key, value);
  }
  return `${destination.pathname}?${destination.searchParams.toString()}`;
}
