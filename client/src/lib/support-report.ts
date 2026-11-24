import { writeSupportQueryHistory } from "./support-query-history";
export type SupportSource = "all" | "widget" | "internal";
export interface SupportFilters {
  from: string;
  to: string;
  source: SupportSource;
  teamId: string;
  assistantId: string;
}
export interface SupportPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
export interface SupportFilterOptions {
  teams: { id: string | number; name: string }[];
  assistants: { id: string | number; name: string }[];
}
export interface SupportReportSession {
  id: number;
  title: string | null;
  memberName: string;
  messageCount: number;
  ticketId?: number | null;
  automationMode?: string;
  teamName?: string;
  leadId: number | null;
  leadInfo: {
    id: number;
    name: string | null;
    email: string;
    phone: string | null;
  } | null;
  metadata: {
    source?: string;
    visitorName?: string;
    visitorEmail?: string;
    [key: string]: unknown;
  } | null;
  createdAt: string;
  updatedAt: string;
}
export interface SupportReportLead {
  id: number;
  name: string | null;
  email: string;
  phone: string | null;
  source: string;
  status: string | null;
  createdAt: string;
}
export interface SupportReportData {
  sessions: SupportReportSession[];
  leads: SupportReportLead[];
  stats: {
    totalSessions: number;
    widgetSessions: number;
    totalMessages: number;
    leadsGenerated: number;
  };
  pagination: { sessions: SupportPagination; leads: SupportPagination };
  filters: SupportFilterOptions;
  metrics: {
    averageResponseSeconds: number | null;
    responseSampleCount?: number;
    feedbackCount: number;
    helpfulRate: number | null;
    csatCount: number;
    satisfactionRate: number | null;
    handoffCount: number;
    handoffRate: number | null;
    convertedLeads: number;
    leadConversionRate: number | null;
  };
}
export interface SupportQualityItem {
  messageId: number;
  sessionId: number;
  sessionTitle: string | null;
  question: string;
  answer: string;
  sources: { title: string; excerpt: string; similarity: number }[] | null;
  confidence: number | null;
  createdAt: string;
  feedback: {
    rating: "helpful" | "needs_review";
    reason?: "incorrect" | "missing_information" | "outdated" | "other";
    notes?: string;
    status: "open" | "reviewed";
    updatedAt: string;
  };
  teamName: string;
}
export interface SupportQualityData {
  items: SupportQualityItem[];
  pagination: SupportPagination;
  summary: { open: number; reviewed: number; helpful: number };
  filters?: SupportFilterOptions;
}
export const supportCommonQueryKeys = [
  "from",
  "to",
  "source",
  "teamId",
  "assistantId",
] as const;
export const supportPrivateQueryKeys = [
  "sessionId",
  "sessionSearch",
  "leadSearch",
  "teamId",
  "assistantId",
  "sessionPage",
  "leadPage",
  "search",
  "page",
] as const;

function validDate(value: string | null): string {
  if (!value || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
    ? ""
    : value;
}
export function readSupportFilters(params: URLSearchParams): SupportFilters {
  const source = params.get("source");
  const today = new Date();
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 29);
  const defaultRange = !params.has('from') && !params.has('to');
  return {
    from: defaultRange ? start.toISOString().slice(0, 10) : validDate(params.get("from")),
    to: defaultRange ? today.toISOString().slice(0, 10) : validDate(params.get("to")),
    source: source === "widget" || source === "internal" ? source : "all",
    teamId: params.get("teamId") || "",
    assistantId: params.get("assistantId") || "",
  };
}

/** Optional filters must be absent, rather than empty, in the API query. */
export function supportFilterParams(filters: SupportFilters) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== ''));
}

export function supportDateRangeError(params: URLSearchParams): string {
  for (const key of ['from', 'to']) {
    const value = params.get(key);
    if (value && !validDate(value)) return `Choose a valid ${key} date.`;
  }
  const from = params.get('from');
  const to = params.get('to');
  return from && to && from > to ? 'From date must be on or before To date.' : '';
}
export function supportPageNumber(value: string | null): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}
export function supportNavigationHref(
  path: string,
  params: URLSearchParams,
): string {
  const query = new URLSearchParams();
  for (const key of supportCommonQueryKeys) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  return query.size ? `${path}?${query}` : path;
}
export function updateSupportQuery(
  params: URLSearchParams,
  changes: Record<string, string | number | null>,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") next.delete(key);
    else next.set(key, String(value));
  }
  return next;
}
export function sameSupportScope(
  previousKey: readonly unknown[],
  currentKey: readonly unknown[],
): boolean {
  return (
    previousKey[0] === currentKey[0] &&
    previousKey[1] === currentKey[1] &&
    previousKey[2] === currentKey[2]
  );
}
export function supportDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

/** Route state belongs to one signed-in account and one business. */
export function supportRouteMemoryKey(
  userId: number,
  profileId: number,
): string {
  return `support-ai-navigation:${userId}:${profileId}`;
}
export function restoreSupportNavigationHref(
  path: string,
  current: URLSearchParams,
  saved = "",
): string {
  const query = new URLSearchParams(saved);
  for (const key of supportCommonQueryKeys) {
    if (current.has(key)) {
      const value = current.get(key);
      if (value) query.set(key, value);
      else query.delete(key);
    }
  }
  return query.size ? `${path}?${query}` : path;
}
export function parseSupportRouteMemory(
  raw: string | null,
): Record<string, string> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([key, query]) =>
          /^\/dashboard\/support-ai\/(chat|reports|quality|embed|widget-settings)$/.test(
            key,
          ) &&
          typeof query === "string" &&
          query.length <= 4000,
      ),
    );
  } catch {
    return {};
  }
}

/** Keep custom history state while letting Next update useSearchParams without an RSC navigation. */
export function replaceSupportQueryHistory(url: string): void {
  writeSupportQueryHistory(url, 'replace');
}
