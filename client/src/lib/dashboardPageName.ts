// Human name for a dashboard route, used by full-screen loaders and error
// cards that render before the sidebar so the user still knows where they are.

const SEGMENT_NAMES: Record<string, string> = {
  home: "Home",
  chats: "Campaign history",
  chat: "Campaign",
  "saved-templates": "Content library",
  "brand-toolkit": "Brand toolkit",
  "content-calendar": "Content calendar",
  crm: "CRM",
  work: "My work",
  ads: "Ads",
  "ads-analytics": "Ads analytics",
  "ads-campaigns": "Ad campaigns",
  "ai-visibility": "AI visibility",
  "knowledge-base": "Knowledge base",
  "support-ai": "Support AI",
  "outreach-analytics": "Outreach analytics",
  "follow-ups": "Follow-ups",
  "business-profiles": "Business profiles",
  "user-profile": "Your profile",
  "change-password": "Change password",
  "social-posts": "Social posts",
};

// IDs and other opaque path parts are not page names.
const OPAQUE_SEGMENT = /^(\d+|[0-9a-f]{8,}(-[0-9a-f]{4,})*|[A-Za-z0-9_-]{20,})$/i;

function nameSegment(segment: string): string {
  const known = SEGMENT_NAMES[segment];
  if (known) return known;
  const words = decodeURIComponent(segment).replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "/dashboard/crm/contacts" -> "CRM · Contacts". Null outside the dashboard. */
export function dashboardPageName(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const [path] = pathname.split(/[?#]/);
  const segments = path.split("/").filter(Boolean);
  if (segments[0] !== "dashboard") return null;
  const named = segments.slice(1).filter((segment) => !OPAQUE_SEGMENT.test(segment)).slice(0, 2).map(nameSegment);
  return named.length ? named.join(" · ") : "Dashboard";
}
