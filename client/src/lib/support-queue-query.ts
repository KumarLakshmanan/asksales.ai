import { writeSupportQueryHistory } from "./support-query-history";
// Keep these client bounds aligned with the mounted Support queue validator.
export const SUPPORT_QUEUE_SEARCH_LIMIT = 200;
export const SUPPORT_QUEUE_PAGE_LIMIT = 100_000;

export type SupportQueueFilters = {
  scope: "my" | "team" | "unassigned";
  page: number; search: string; status: string; priority: string; handoff: string;
  ownership: string; sla: string; channel: string; assignee: string; unread: boolean;
};
export const DEFAULT_SUPPORT_QUEUE_FILTERS: SupportQueueFilters = {
  scope: "my", page: 1, search: "", status: "all", priority: "all", handoff: "all",
  ownership: "all", sla: "all", channel: "all", assignee: "all", unread: false,
};
const options = {
  scope: ["my", "team", "unassigned"], status: ["all", "open", "in_progress", "waiting_on_customer", "resolved", "closed"],
  priority: ["all", "critical", "urgent", "high", "medium", "low"], handoff: ["all", "active", "none"],
  ownership: ["all", "human_owned", "ai_active"], sla: ["all", "breached", "at_risk"],
  channel: ["all", "web", "email", "gmail", "whatsapp", "instagram", "facebook"],
};
export function parseSupportQueueFilters(params: Pick<URLSearchParams, "get">): SupportQueueFilters {
  const filters = { ...DEFAULT_SUPPORT_QUEUE_FILTERS };
  for (const key of Object.keys(options) as Array<keyof typeof options>) {
    const value = params.get(key);
    if (value && options[key].includes(value)) Object.assign(filters, { [key]: value });
  }
  const page = Number(params.get("page"));
  if (Number.isSafeInteger(page) && page > 0 && page <= SUPPORT_QUEUE_PAGE_LIMIT) filters.page = page;
  const assignee = params.get("assignee");
  if (assignee === "unassigned" || (assignee && /^[1-9]\d*$/.test(assignee) && Number.isSafeInteger(Number(assignee)) && Number(assignee) <= 2_147_483_647)) filters.assignee = assignee;
  filters.search = (params.get("search") || "").trim();
  filters.unread = params.get("unread") === "true";
  return filters;
}
export function supportQueueSearch(filters: SupportQueueFilters, existing = "", api = false) {
  const params = new URLSearchParams(existing);
  for (const key of Object.keys(DEFAULT_SUPPORT_QUEUE_FILTERS)) params.delete(key);
  if (api) { params.set("page", String(filters.page)); params.set("limit", "25"); params.set("scope", filters.scope); }
  for (const key of Object.keys(DEFAULT_SUPPORT_QUEUE_FILTERS) as Array<keyof SupportQueueFilters>) {
    if (filters[key] !== DEFAULT_SUPPORT_QUEUE_FILTERS[key]) params.set(key, String(filters[key]));
  }
  return params.toString();
}

/** Only normalize the URL that produced this render; a newer navigation wins. */
export function supportQueueCanonicalHref(pathname: string, expectedQuery: string, currentHref: string): string | null {
  const current = new URL(currentHref);
  if (current.pathname !== pathname || current.searchParams.toString() !== expectedQuery) return null;
  const normalized = supportQueueSearch(parseSupportQueueFilters(current.searchParams), expectedQuery);
  return normalized === expectedQuery ? null : pathname + (normalized ? `?${normalized}` : "") + current.hash;
}

/** Query selections get their own Back/Forward entry without an RSC navigation. */
export function pushSupportQueueHistory(href: string): void {
  writeSupportQueryHistory(href, 'push');
}

/** Validation/auth failures need correction, rather than an unchanged retry loop. */
export function shouldRetrySupportQueue(failureCount: number, error: unknown): boolean {
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  return failureCount < 1 && !(typeof status === "number" && status >= 400 && status < 500);
}
