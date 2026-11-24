"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Edit3,
  Eye,
  LayoutGrid,
  List,
  Loader2,
  MessageCircle,
  Plus,
  RefreshCw,
} from "lucide-react";
import api from "@/lib/api";
import { whatsappTemplateControls } from "@/lib/whatsapp-template-controls";
import { useToast } from "@/hooks/use-toast";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  curatedWhatsAppTemplates,
  type WhatsAppAuthConfig,
  type WhatsAppTemplateCategory,
} from "./templateData";
import { WhatsAppPreview } from "./WhatsAppPreview";

interface SavedWhatsAppTemplate {
  id: number;
  name: string;
  language: string;
  category: WhatsAppTemplateCategory;
  body: string;
  header?: string | null;
  headerType?: string | null;
  headerMediaUrl?: string | null;
  footer?: string | null;
  buttons?: Array<{ type: string; text: string }> | null;
  examples?: Record<string, string> | null;
  submissionStatus?: string;
  status: string;
  metaStatus?: string | null;
  wabaTemplateId?: string | null;
  hasLocalChanges?: boolean;
  updatedAt?: string | null;
  authConfig?: WhatsAppAuthConfig | null;
}
interface LibraryResponse {
  templates: SavedWhatsAppTemplate[];
  total?: number;
  page?: number;
  pageSize?: number;
  statusCounts?: Record<string, number>;
  languages?: string[];
}
interface Filters {
  query: string;
  category: string;
  submissionStatus?: string;
  status: string;
  language: string;
  sort: string;
  source: "saved" | "library";
  layout: "cards" | "table";
  page: number;
  patternCategory: WhatsAppTemplateCategory;
  task: string;
}
const templatesPath = "/dashboard/integrations/whatsapp/templates";
const PAGE_SIZE = 6;
const categories: WhatsAppTemplateCategory[] = [
  "UTILITY",
  "AUTHENTICATION",
  "MARKETING",
];
const categoryLabels = {
  UTILITY: "Utility",
  AUTHENTICATION: "Authentication",
  MARKETING: "Marketing",
};
const statuses = [
  "LOCAL_ONLY",
  "APPROVED",
  "PENDING",
  "REJECTED",
  "PAUSED",
  "DISABLED",
];
const control =
  "h-10 rounded-[10px] border border-input bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30";
const action =
  "inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50";
const taskLabels: Record<string, string> = {
  "Account protection": "Protect accounts",
  "Account updates": "Update accounts",
  "Customer feedback": "Collect feedback",
  "Event reminder": "Manage appointments",
  Offers: "Run promotions",
  "Order management": "Update orders",
  Payments: "Manage payments",
  "Product updates": "Announce products",
};
function readFilters(params: URLSearchParams): Filters {
  return {
    query: params.get("search") || "",
    category: categories.includes(
      params.get("category") as WhatsAppTemplateCategory,
    )
      ? params.get("category")!
      : "ALL",
    status: statuses.includes(params.get("status") || "")
      ? params.get("status")!
      : "ALL",
    language: params.get("language") || "ALL",
    sort: ["updated_desc", "updated_asc", "name_asc", "name_desc"].includes(
      params.get("sort") || "",
    )
      ? params.get("sort")!
      : "updated_desc",
    source:
      params.get("source") === "library" || params.get("view") === "library"
        ? "library"
        : "saved",
    layout: params.get("layout") === "table" ? "table" : "cards",
    page: Math.max(1, Number.parseInt(params.get("page") || "1", 10) || 1),
    patternCategory: categories.includes(
      params.get("patternCategory") as WhatsAppTemplateCategory,
    )
      ? (params.get("patternCategory") as WhatsAppTemplateCategory)
      : "UTILITY",
    task: params.get("task") || "",
  };
}
function filterParams(filters: Filters) {
  const params = new URLSearchParams();
  if (filters.query) params.set("search", filters.query);
  for (const key of ["category", "status", "language"] as const)
    if (filters[key] !== "ALL") params.set(key, filters[key]);
  if (filters.sort !== "updated_desc") params.set("sort", filters.sort);
  if (filters.source !== "saved") params.set("view", filters.source);
  if (filters.layout !== "cards") params.set("layout", filters.layout);
  if (filters.page > 1) params.set("page", String(filters.page));
  if (filters.patternCategory !== "UTILITY")
    params.set("patternCategory", filters.patternCategory);
  if (filters.task) params.set("task", filters.task);
  return params;
}
function effectiveStatus(template: SavedWhatsAppTemplate) {
  return template.wabaTemplateId
    ? template.metaStatus || template.status
    : "LOCAL_ONLY";
}
function statusTone(status: string): StatusTone {
  return status === "APPROVED"
    ? "success"
    : ["REJECTED", "DISABLED"].includes(status)
      ? "danger"
      : "warning";
}
function Status({ template }: { template: SavedWhatsAppTemplate }) {
  const status = effectiveStatus(template);
  return (
    <div className="flex flex-wrap gap-1">
      <StatusBadge
        tone={statusTone(status)}
        label={status === "LOCAL_ONLY"
          ? "Local only"
          : `Meta ${status.toLowerCase()}`}
      />
      {template.hasLocalChanges && template.wabaTemplateId && (
        <span className="rounded-full bg-primary/10 px-2 py-1 text-[11px] text-primary">
          Local changes
        </span>
      )}
    </div>
  );
}

export default function WhatsAppTemplateLibrary() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [filters, setFilters] = useState(() =>
    readFilters(new URLSearchParams(searchParams.toString())),
  );
  const [debouncedQuery, setDebouncedQuery] = useState(filters.query);
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const cache = useRef(
    new Map<string, { at: number; data: LibraryResponse }>(),
  );
  const pending = useRef(new Map<string, Promise<LibraryResponse>>());
  const request = useRef(0);
  const setFilter = (patch: Partial<Filters>, resetPage = true) =>
    setFilters((current) => ({
      ...current,
      ...patch,
      ...(resetPage ? { page: 1 } : {}),
    }));
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(filters.query), 300);
    return () => clearTimeout(timer);
  }, [filters.query]);
  const serialized = filterParams(filters).toString();
  useEffect(() => {
    window.history.replaceState(
      window.history.state,
      "",
      `${templatesPath}${serialized ? `?${serialized}` : ""}`,
    );
  }, [serialized]);
  useEffect(() => {
    const restore = () =>
      setFilters(readFilters(new URLSearchParams(window.location.search)));
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const queryParams = useMemo(
    () => ({
      page: filters.page,
      pageSize: PAGE_SIZE,
      search: debouncedQuery,
      category: filters.category,
      status: filters.status,
      language: filters.language,
      sort: filters.sort,
    }),
    [
      filters.page,
      filters.category,
      filters.status,
      filters.language,
      filters.sort,
      debouncedQuery,
    ],
  );
  const queryKey = JSON.stringify(queryParams);
  const load = useCallback(
    async (force = false) => {
      const sequence = ++request.current;
      const cached = cache.current.get(queryKey);
      if (cached && !force) {
        setData(cached.data);
        setError(null);
        if (Date.now() - cached.at < 30_000) {
          setLoading(false);
          return;
        }
      }
      setLoading(true);
      setError(null);
      try {
        let promise = pending.current.get(queryKey);
        if (!promise) {
          promise = api.get<LibraryResponse>("/api/whatsapp/templates", {
            params: queryParams,
          });
          pending.current.set(queryKey, promise);
        }
        const response = await promise;
        cache.current.set(queryKey, { at: Date.now(), data: response });
        if (sequence === request.current) setData(response);
      } catch (loadError) {
        if (sequence === request.current)
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Saved templates could not be loaded.",
          );
      } finally {
        pending.current.delete(queryKey);
        if (sequence === request.current) setLoading(false);
      }
    },
    [queryKey, queryParams],
  );
  const invalidateRequest = useCallback(() => {
    request.current++;
  }, []);
  useEffect(() => {
    if (filters.source === "saved") void load();
    return invalidateRequest;
  }, [load, filters.source, invalidateRequest]);
  // Templates created or approved in Meta only appear here after a sync, so
  // sync quietly when the page opens (at most every 10 minutes per session).
  // A failure stays silent: the Sync button reports errors on demand.
  const autoSynced = useRef(false);
  useEffect(() => {
    if (autoSynced.current) return;
    autoSynced.current = true;
    const key = "whatsapp-templates-auto-sync";
    try {
      const last = Number(sessionStorage.getItem(key) || 0);
      if (Date.now() - last < 10 * 60_000) return;
      sessionStorage.setItem(key, String(Date.now()));
    } catch {
      // Storage unavailable: still sync once for this visit.
    }
    void (async () => {
      try {
        await api.post("/api/whatsapp/templates/sync", {});
        cache.current.clear();
        await load(true);
      } catch {
        // Silent: the Sync button shows sync errors when asked.
      }
    })();
  }, [load]);
  const saved = data?.templates || [];
  const serverPaginated = typeof data?.total === "number";
  const localFiltered = saved
    .filter(
      (template) =>
        (filters.category === "ALL" ||
          template.category === filters.category) &&
        (filters.status === "ALL" ||
          effectiveStatus(template) === filters.status) &&
        (filters.language === "ALL" ||
          template.language === filters.language) &&
        (!filters.query.trim() ||
          `${template.name} ${template.body} ${template.header || ""} ${template.footer || ""} ${template.language}`
            .toLowerCase()
            .includes(filters.query.trim().toLowerCase())),
    )
    .sort((left, right) =>
      filters.sort.startsWith("name")
        ? left.name.localeCompare(right.name) *
          (filters.sort === "name_desc" ? -1 : 1)
        : (new Date(left.updatedAt || 0).getTime() -
            new Date(right.updatedAt || 0).getTime()) *
          (filters.sort === "updated_desc" ? -1 : 1),
    );
  const patterns = curatedWhatsAppTemplates.filter(
    (template) =>
      template.category === filters.patternCategory &&
      (!filters.task || template.feature === filters.task) &&
      `${template.title} ${template.body} ${template.feature}`
        .toLowerCase()
        .includes(filters.query.trim().toLowerCase()),
  );
  const total =
    filters.source === "library"
      ? patterns.length
      : serverPaginated
        ? data!.total!
        : localFiltered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pages);
  useEffect(() => {
    if (
      serverPaginated &&
      !loading &&
      !error &&
      filters.source === "saved" &&
      filters.page > pages
    )
      setFilters((current) => ({ ...current, page: pages }));
  }, [serverPaginated, loading, error, filters.source, filters.page, pages]);
  const visible = serverPaginated
    ? saved
    : localFiltered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const counts =
    data?.statusCounts ||
    saved.reduce<Record<string, number>>((result, template) => {
      const status = effectiveStatus(template);
      result[status] = (result[status] || 0) + 1;
      return result;
    }, {});
  const languages =
    data?.languages ||
    Array.from(new Set(saved.map((template) => template.language))).sort();
  const hasFilters = Boolean(
    filters.query ||
    filters.category !== "ALL" ||
    filters.status !== "ALL" ||
    filters.language !== "ALL",
  );
  const returnTo = `${templatesPath}${serialized ? `?${serialized}` : ""}`;
  const navigate = (path: string, params?: URLSearchParams) => {
    const target = params || new URLSearchParams();
    target.set("returnTo", returnTo);
    router.push(`${path}?${target}`);
  };
  const openCreate = (preset?: string) =>
    navigate(
      `${templatesPath}/create`,
      new URLSearchParams(preset ? { preset } : {}),
    );
  const sync = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const response = await api.post<{
        count: number;
        skipped?: Array<{ name: string; reason: string }>;
      }>("/api/whatsapp/templates/sync", {});
      cache.current.clear();
      await load(true);
      if (response.skipped?.length)
        setSyncError(
          response.skipped
            .map((item) => `${item.name}: ${item.reason}`)
            .join(" "),
        );
      toast({
        title: response.skipped?.length
          ? "Templates synced with items to review"
          : "Templates synced",
        description: `${response.count || 0} templates updated from WhatsApp.`,
      });
    } catch (syncFailure) {
      const message =
        syncFailure instanceof Error
          ? syncFailure.message
          : "Connect WhatsApp Business and try again.";
      setSyncError(message);
      toast({
        title: "Could not sync templates",
        description: message,
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  };
  const pagination = total > PAGE_SIZE && (
    <Pagination
      aria-label="Template pagination"
      className="mt-5 border-t pt-4"
      page={page}
      pageSize={PAGE_SIZE}
      totalItems={total}
      onPageChange={(next) => setFilter({ page: next }, false)}
      itemLabel="templates"
    />
  );
  const rowActions = (template: SavedWhatsAppTemplate) => (
    <div className="flex gap-2">
      <button
        className={action}
        onClick={() => navigate(`${templatesPath}/${template.id}`)}
      >
        <Eye className="h-3.5 w-3.5" /> View
      </button>
      <button
        className={action}
        disabled={!whatsappTemplateControls(template).canEdit}
        title={
          !whatsappTemplateControls(template).canEdit
            ? "Refresh the approval status before editing"
            : undefined
        }
        onClick={() => navigate(`${templatesPath}/${template.id}/edit`)}
      >
        <Edit3 className="h-3.5 w-3.5" /> Edit
      </button>
    </div>
  );
  return (
    <div className="outreach-workspace wa-template-library min-h-full bg-background px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1460px]">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              WhatsApp templates
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage drafts, approval status, and reusable messages.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className={control + " inline-flex items-center gap-2"}
              disabled={syncing}
              onClick={() => void sync()}
            >
              {syncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}{" "}
              Sync from Meta
            </button>
            <button
              className={
                control +
                " inline-flex items-center gap-2 border-primary bg-primary font-semibold text-primary-foreground"
              }
              onClick={() => openCreate()}
            >
              <Plus className="h-4 w-4" /> Create template
            </button>
          </div>
        </header>
        {syncError && (
          <Callout
            tone="danger"
            className="mb-4"
            onDismiss={() => setSyncError(null)}
          >
            Meta sync needs attention: {syncError}
          </Callout>
        )}
        <div className="workspace-panel overflow-hidden rounded-xl border border-card-border bg-card">
          <div className="flex flex-wrap gap-6 p-4 pb-0 sm:p-5 sm:pb-0">
            <div
              role="group"
              aria-label="Template source"
              className="flex rounded-[10px] border bg-muted/60 p-1"
            >
              {(["saved", "library"] as const).map((source) => (
                <button
                  key={source}
                  aria-pressed={filters.source === source}
                  onClick={() => setFilter({ source, query: "" })}
                  className={`min-h-9 rounded-md px-3 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring ${filters.source === source ? "bg-card text-primary shadow-sm" : "text-muted-foreground"}`}
                >
                  {source === "saved" ? "My templates" : "Pattern library"}
                </button>
              ))}
            </div>
            <SearchInput
              aria-label="Search templates"
              value={filters.query}
              onValueChange={(query) => setFilter({ query })}
              placeholder={
                filters.source === "library"
                  ? "Search patterns"
                  : "Search my templates"
              }
              wrapperClassName="min-w-[180px] flex-1"
            />
          </div>
          {filters.source === "saved" ? (
            <section className="min-h-[480px] p-4 sm:p-5">
              <div className="workspace-status-filters mb-2 flex flex-wrap gap-2">
                {statuses.map((status) => (
                  <button
                    key={status}
                    aria-pressed={filters.status === status}
                    onClick={() =>
                      setFilter({
                        status: filters.status === status ? "ALL" : status,
                      })
                    }
                    className={`min-h-8 rounded-md border px-3 py-1.5 text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring ${filters.status === status ? "border-primary/60 bg-primary/5 text-primary" : "text-muted-foreground hover:bg-muted/40"}`}
                  >
                    {status === "LOCAL_ONLY"
                      ? "Local drafts"
                      : status.charAt(0) + status.slice(1).toLowerCase()}{" "}
                    <span className="ml-1 font-semibold">
                      {counts[status] || 0}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mb-4 text-xs text-muted-foreground">Approval counts use Meta status. Local drafts and local changes are tracked separately.</p>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <select
                  aria-label="Filter by category"
                  value={filters.category}
                  onChange={(event) =>
                    setFilter({ category: event.target.value })
                  }
                  className={control}
                >
                  <option value="ALL">All categories</option>
                  {categories.map((item) => (
                    <option key={item} value={item}>
                      {categoryLabels[item]}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by status"
                  value={filters.status}
                  onChange={(event) =>
                    setFilter({ status: event.target.value })
                  }
                  className={control}
                >
                  <option value="ALL">All statuses</option>
                  {statuses.map((item) => (
                    <option key={item} value={item}>
                      {item === "LOCAL_ONLY"
                        ? "Local only"
                        : `Meta ${item.toLowerCase()}`}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by language"
                  value={filters.language}
                  onChange={(event) =>
                    setFilter({ language: event.target.value })
                  }
                  className={control}
                >
                  <option value="ALL">All languages</option>
                  {languages.map((language) => (
                    <option key={language} value={language}>
                      {language.replace("_", "-")}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Sort templates"
                  value={filters.sort}
                  onChange={(event) => setFilter({ sort: event.target.value })}
                  className={control}
                >
                  <option value="updated_desc">Recently updated</option>
                  <option value="updated_asc">Oldest updates</option>
                  <option value="name_asc">Name A–Z</option>
                  <option value="name_desc">Name Z–A</option>
                </select>
                <div
                  role="group"
                  aria-label="Template layout"
                  className="ml-auto flex gap-1"
                >
                  <button
                    aria-label="Card view"
                    aria-pressed={filters.layout === "cards"}
                    onClick={() => setFilter({ layout: "cards" }, false)}
                    className={action}
                  >
                    <LayoutGrid className="h-4 w-4" />
                  </button>
                  <button
                    aria-label="Table view"
                    aria-pressed={filters.layout === "table"}
                    onClick={() => setFilter({ layout: "table" }, false)}
                    className={action}
                  >
                    <List className="h-4 w-4" />
                  </button>
                </div>
                <button
                  aria-label="Refresh templates"
                  disabled={loading}
                  className={action}
                  onClick={() => void load(true)}
                >
                  <RefreshCw
                    className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"}
                  />
                  Refresh list
                </button>
                {visible.length > 0 && <button className={action + " border-transparent text-primary"} disabled={!hasFilters} onClick={() => setFilter({ query: "", category: "ALL", status: "ALL", language: "ALL" })}>Clear filters</button>}
              </div>
              {error && (
                <Callout tone="danger" className="mb-4">
                  {data
                    ? "The latest results could not be loaded. Showing the previous results. "
                    : "Templates could not be loaded. "}
                  {error}
                  <button
                    className="ml-3 font-semibold underline"
                    onClick={() => void load(true)}
                  >
                    Try again
                  </button>
                </Callout>
              )}
              {loading && !data ? (
                <LoadingState
                  className="min-h-64"
                  label="Loading templates"
                  showLabel
                />
              ) : visible.length ? (
                <>
                  <p
                    role="status"
                    className="mb-3 text-xs text-muted-foreground"
                  >
                    {loading ? "Refreshing… " : ""}Showing {visible.length} of{" "}
                    {total} templates
                  </p>
                  {filters.layout === "table" ? (
                    <div className="overflow-x-auto rounded-lg border">
                      <table className="w-full min-w-[650px] text-left text-sm">
                        <caption className="sr-only">
                          Saved WhatsApp templates
                        </caption>
                        <thead className="bg-muted/50">
                          <tr>
                            {[
                              "Template",
                              "Category",
                              "Language",
                              "Status",
                              "Updated",
                              "Actions",
                            ].map((heading) => (
                              <th
                                key={heading}
                                scope="col"
                                className="px-4 py-3 text-xs font-semibold text-muted-foreground"
                              >
                                {heading}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {visible.map((template) => (
                            <tr key={template.id}>
                              <th
                                scope="row"
                                className="max-w-[280px] break-words px-4 py-3 font-medium"
                              >
                                {template.name}
                              </th>
                              <td className="px-4 py-3">
                                {categoryLabels[template.category]}
                              </td>
                              <td className="px-4 py-3">
                                {template.language.replace("_", "-")}
                              </td>
                              <td className="px-4 py-3">
                                <Status template={template} />
                              </td>
                              <td className="px-4 py-3 text-xs text-muted-foreground">
                                {template.updatedAt
                                  ? new Date(
                                      template.updatedAt,
                                    ).toLocaleDateString()
                                  : "—"}
                              </td>
                              <td className="px-4 py-3">
                                {rowActions(template)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
                      {visible.map((template) => (
                        <article
                          key={template.id}
                          className="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card p-2"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2 px-2 pb-3 pt-1">
                            <div className="min-w-0 flex-1"><h2 className="break-words text-sm font-semibold">{template.name}</h2><p className="mt-1 text-xs text-muted-foreground">{categoryLabels[template.category]} · {template.language.replace("_", "-")}</p></div>
                            <Status template={template} />
                          </div>
                          <div className="wa-library-preview wa-preview-pattern flex-1 overflow-hidden rounded-lg">
                          <WhatsAppPreview
                            title={
                              template.headerType === "TEXT"
                                ? template.header || undefined
                                : undefined
                            }
                            body={template.body}
                            footer={template.footer || undefined}
                            buttons={template.buttons || []}
                            authConfig={template.authConfig}
                            mediaType={template.headerType}
                            mediaUrl={template.headerMediaUrl}
                            examples={template.examples}
                            compact
                          />
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-2 px-0.5 pt-2">
                            {rowActions(template)}
                            {template.updatedAt && <span className="text-[11px] text-muted-foreground">Updated {new Date(template.updatedAt).toLocaleDateString()}</span>}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                  {pagination}
                  <p className="mt-4 border-t pt-3 text-xs leading-5 text-muted-foreground">Approval applies to the approved snapshot; media and personalization are completed when composing outreach.</p>
                </>
              ) : (
                !error && (
                  <div className="flex min-h-64 flex-col items-center justify-center text-center">
                    <MessageCircle className="mb-3 h-8 w-8 text-primary" />
                    <h2 className="text-lg font-semibold">
                      {hasFilters
                        ? "No templates match these filters"
                        : "No WhatsApp templates yet"}
                    </h2>
                    <p className="mt-2 max-w-md text-sm text-muted-foreground">
                      {hasFilters
                        ? "Clear the search and filters to see your other templates."
                        : "Create your first draft or sync your connected WhatsApp Business account."}
                    </p>
                    <button
                      className={action + " mt-4"}
                      onClick={() =>
                        hasFilters
                          ? setFilter({
                              query: "",
                              category: "ALL",
                              status: "ALL",
                              language: "ALL",
                            })
                          : openCreate()
                      }
                    >
                      {hasFilters ? "Clear filters" : "Create template"}
                    </button>
                  </div>
                )
              )}
            </section>
          ) : (
            <div className="grid lg:grid-cols-[230px_minmax(0,1fr)]">
              <aside className="border-b p-4 lg:border-b-0 lg:border-r">
                <fieldset>
                  <legend className="mb-3 text-sm font-semibold">
                    Message category
                  </legend>
                  {categories.map((item) => (
                    <label key={item} className="mb-3 flex gap-2 text-sm">
                      <input
                        type="radio"
                        name="wa-category"
                        checked={filters.patternCategory === item}
                        onChange={() =>
                          setFilter({ patternCategory: item, task: "" })
                        }
                        className="accent-primary"
                      />
                      {categoryLabels[item]}
                    </label>
                  ))}
                </fieldset>
                <h2 className="mb-2 mt-5 text-sm font-semibold">
                  What do you want to do?
                </h2>
                <button
                  className={action + " mb-2 w-full justify-start"}
                  aria-pressed={!filters.task}
                  onClick={() => setFilter({ task: "" })}
                >
                  All tasks
                </button>
                {Array.from(
                  new Set(
                    curatedWhatsAppTemplates
                      .filter(
                        (template) =>
                          template.category === filters.patternCategory,
                      )
                      .map((template) => template.feature),
                  ),
                ).map((task) => (
                  <button
                    key={task}
                    aria-pressed={filters.task === task}
                    className={action + " mb-2 w-full justify-start"}
                    onClick={() => setFilter({ task })}
                  >
                    {taskLabels[task] || task}
                  </button>
                ))}
              </aside>
              <section className="bg-muted/20 p-5">
                <div className="mb-5 rounded-lg border bg-card p-4">
                  <h2 className="font-semibold">
                    Start with a pattern, then make it yours
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Replace each numbered variable with a realistic sample,
                    choose your language, and add your own button destinations.
                    Authentication patterns use a verification-code button.
                  </p>
                </div>
                <p className="mb-4 text-xs text-muted-foreground">
                  {patterns.length} patterns
                </p>
                {patterns.length ? (
                  <div className="grid gap-5 xl:grid-cols-2">
                    {patterns
                      .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
                      .map((template) => (
                        <article
                          key={template.id}
                          className="overflow-hidden rounded-[14px] border bg-card shadow-sm"
                        >
                          <WhatsAppPreview
                            title={template.title}
                            body={template.body}
                            footer={template.footer}
                            buttons={template.buttons}
                            authConfig={template.authConfig}
                            compact
                          />
                          <div className="border-t p-4">
                            <h3 className="text-sm font-semibold">
                              {template.title}
                            </h3>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {taskLabels[template.feature] || template.feature}{" "}
                              ·{" "}
                              {template.authConfig
                                ? "Choose expiry and code delivery settings"
                                : `Add variable samples${template.buttons?.some((button) => button.type !== "QUICK_REPLY") ? " and button destinations" : ""}`}
                            </p>
                            <button
                              className={
                                action + " mt-3 border-primary/40 text-primary"
                              }
                              onClick={() => openCreate(template.id)}
                            >
                              Use template
                            </button>
                          </div>
                        </article>
                      ))}
                  </div>
                ) : (
                  <div className="py-16 text-center">
                    <h2 className="font-semibold">No matching patterns</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Try another search or task.
                    </p>
                  </div>
                )}
                {pagination}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
