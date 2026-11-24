"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  AlertTriangle, Bot, ChevronLeft, ChevronRight, Clock3,
  Inbox, Kanban, MessageSquare, ShieldCheck, TicketCheck, UserCheck,
} from "lucide-react";
import { useSupportAuth } from "@/contexts/SupportAuthContext";
import { supportApi } from "@/lib/support-api";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { SearchInput } from "@/components/ui/search-input";
import { LoadingState } from "@/components/ui/loading-state";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { SUPPORT_QUEUE_SEARCH_LIMIT, shouldRetrySupportQueue, DEFAULT_SUPPORT_QUEUE_FILTERS, parseSupportQueueFilters, pushSupportQueueHistory, supportQueueCanonicalHref, supportQueueSearch, type SupportQueueFilters } from "@/lib/support-queue-query";
import { replaceSupportQueryHistory } from "@/lib/support-report";
import { formatSupportTicketStatus } from "@/lib/supportStatus";
import {
  isSlaBreached, supportOwnershipLabel, type SupportMemberTicket, type SupportTeamMemberOption,
} from "@/lib/supportTicketWorkspace";
import { SUPPORT_STATUS_CLASSES as STATUS_TONES } from "@/lib/support-styles";

interface TicketPage { tickets: SupportMemberTicket[]; totalPages: number; total: number; page: number }
const EMPTY_TICKETS: SupportMemberTicket[] = [];


function SupportTicketsQueue() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { member, isAuthenticated, isLoading: authLoading } = useSupportAuth();
  const pathname = usePathname();
  const rawQuery = searchParams.toString();
  const filters = useMemo(() => parseSupportQueueFilters(new URLSearchParams(rawQuery)), [rawQuery]);
  const { scope, page, status, priority, handoff, ownership, sla, channel, assignee, unread: unreadOnly } = filters;
  const [search, setSearch] = useState(filters.search);
  const [members, setMembers] = useState<SupportTeamMemberOption[]>([]);
  const [claiming, setClaiming] = useState<number | null>(null);
  const update = useCallback((values: Partial<SupportQueueFilters>, replace = false) => {
    const current = new URL(window.location.href);
    if (current.pathname !== pathname || (replace && current.searchParams.toString() !== rawQuery)) return;
    // Read the synchronously updated address so rapid filter changes compose,
    // even before useSearchParams has rendered the preceding selection.
    const next = { ...parseSupportQueueFilters(current.searchParams), ...values, page: values.page ?? 1 };
    const query = supportQueueSearch(next, current.searchParams.toString());
    const href = pathname + (query ? `?${query}` : "") + current.hash;
    if (replace) replaceSupportQueryHistory(href);
    else pushSupportQueueHistory(href);
  }, [pathname, rawQuery]);
  useEffect(() => {
    const href = supportQueueCanonicalHref(pathname, rawQuery, window.location.href);
    if (href !== null) replaceSupportQueryHistory(href);
  }, [pathname, rawQuery]);
  useEffect(() => { setSearch(filters.search); }, [filters.search]);
  useEffect(() => {
    if (search.trim() === filters.search) return;
    const timer = window.setTimeout(() => update({ search: search.trim() }, true), 300);
    return () => window.clearTimeout(timer);
  }, [search, filters.search, update]);
  const invalidSearch = search.trim().length > SUPPORT_QUEUE_SEARCH_LIMIT || filters.search.length > SUPPORT_QUEUE_SEARCH_LIMIT;
  const query = supportQueueSearch(filters, "", true);
  const queue = useQuery({
    queryKey: ["support-ticket-queue", member?.id, member?.teamId, query],
    queryFn: ({ signal }) => supportApi.get<TicketPage>(`/api/support-portal/tickets?${query}`, { signal }),
    enabled: isAuthenticated && !invalidSearch,
    retry: shouldRetrySupportQueue,
  });
  const tickets = queue.data?.tickets ?? EMPTY_TICKETS;
  const total = queue.data?.total ?? 0, totalPages = queue.data?.totalPages ?? 1;
  const loading = !invalidSearch && (queue.isPending || (queue.isFetching && !queue.data));
  const setPage = (value: number | ((page: number) => number)) => update({ page: typeof value === "function" ? value(page) : value });
  const setStatus = (value: string) => update({ status: value });
  const setPriority = (value: string) => update({ priority: value });
  const setHandoff = (value: string) => update({ handoff: value });
  const setOwnership = (value: string) => update({ ownership: value });
  const setSla = (value: string) => update({ sla: value });
  const setChannel = (value: string) => update({ channel: value });
  const setAssignee = (value: string) => update({ assignee: value });
  useEffect(() => {
    if (!isAuthenticated) return;
    let active = true;
    void supportApi.get<SupportTeamMemberOption[]>("/api/support-portal/team-members")
      .then(data => { if (active) setMembers(data); }).catch(() => { if (active) setMembers([]); });
    return () => { active = false; };
  }, [isAuthenticated]);
  const resetFilters = () => update({ ...DEFAULT_SUPPORT_QUEUE_FILTERS, scope });
  const activeFilters = [status, priority, handoff, ownership, sla, channel, assignee].filter((value) => value !== "all").length + Number(unreadOnly);
  const queueCounts = useMemo(() => ({
    needsHuman: tickets.filter((ticket) => ticket.handoffId && !ticket.handoffAssignedMemberId).length,
    breached: tickets.filter(isSlaBreached).length,
    unread: tickets.reduce((sum, ticket) => sum + Number(ticket.unreadCount || 0), 0),
  }), [tickets]);

  const claim = async (ticket: SupportMemberTicket) => {
    setClaiming(ticket.id);
    try {
      const claimed = await supportApi.post<{ aiReplyEnabled?: boolean }>(`/api/support-portal/tickets/${ticket.id}/claim`, { expectedVersion: ticket.version });
      const description = claimed.aiReplyEnabled === true
        ? "The ticket’s AI reply setting is enabled."
        : claimed.aiReplyEnabled === false
          ? "The ticket’s AI reply setting is disabled."
          : "Refresh this ticket to check its AI reply setting.";
      toast({ title: "Ticket claimed", description });
      await queue.refetch();
    } catch (error) {
      toast({ title: "Ticket was not claimed", description: error instanceof Error ? error.message : "Another member may have claimed it.", variant: "destructive" });
      await queue.refetch();
    } finally { setClaiming(null); }
  };

  if (authLoading) return <LoadingState className="py-16" label="Loading tickets…" />;
  if (!isAuthenticated) return null;

  return <div className="mx-auto max-w-[1500px] space-y-5">
    <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
      <div>
        <div className="flex items-center gap-2">
          <TicketCheck className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Ticket operations</h1>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">One queue for customer tickets, AI handoffs, and team ownership.</p>
      </div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={queue.isFetching} onClick={() => void queue.refetch()}>Refresh queue</Button>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => router.push("/support/tickets/pipeline")}>
        <Kanban className="h-3.5 w-3.5" /> Open pipeline
      </Button></div>
    </header>

    <section aria-label="Queue scope" className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-card p-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="inline-flex w-full rounded-xl bg-muted/50 p-1 lg:w-auto">
        {([['my', 'My work'], ['team', 'Team queue'], ['unassigned', 'Unassigned']] as const).map(([value, label]) =>
          <button key={value} type="button" aria-pressed={scope === value} onClick={() => update({ scope: value })} className={cn("flex-1 rounded-lg px-4 py-2 text-xs font-semibold transition lg:flex-none", scope === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{label}</button>)}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="rounded-full bg-warning/10 px-2 py-1 text-warning"><strong>{queue.data ? queueCounts.needsHuman : "—"}</strong> need human</span>
        <span className="rounded-full bg-destructive/10 px-2 py-1 text-destructive"><strong>{queue.data ? queueCounts.breached : "—"}</strong> SLA breached</span>
        <span className="rounded-full bg-info/10 px-2 py-1 text-info"><strong>{queue.data ? queueCounts.unread : "—"}</strong> unread</span>
      </div>
    </section>

    <section aria-label="Ticket filters" className="rounded-2xl border border-border/60 bg-card p-3">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(240px,1.4fr)_repeat(6,minmax(125px,0.7fr))]">
        <SearchInput size="sm" maxLength={SUPPORT_QUEUE_SEARCH_LIMIT} aria-invalid={invalidSearch || undefined} aria-describedby={invalidSearch ? "ticket-search-error" : undefined} aria-label="Search assigned tickets" value={search} onValueChange={setSearch} placeholder="Ticket number or subject" className="rounded-lg border-border/60 bg-background text-sm" />
        <FilterSelect label="Status" ariaLabel="Filter tickets by status" value={status} onChange={setStatus} options={[["all","All statuses"],["open","Open"],["in_progress","In progress"],["waiting_on_customer","Waiting"],["resolved","Resolved"],["closed","Closed"]]} />
        <FilterSelect label="Handoff" value={handoff} onChange={setHandoff} options={[["all","All handoffs"],["active","Needs human"],["none","No handoff"]]} />
        <FilterSelect label="Ownership" value={ownership} onChange={setOwnership} options={[["all","All ownership"],["human_owned","Human owned"],["ai_active","No human takeover"]]} />
        <FilterSelect label="Priority" value={priority} onChange={setPriority} options={[["all","All priorities"],["critical","Critical"],["urgent","Urgent"],["high","High"],["medium","Medium"],["low","Low"]]} />
        <FilterSelect label="SLA" value={sla} onChange={setSla} options={[["all","All SLA"],["breached","Breached"],["at_risk","At risk"]]} />
        <FilterSelect label="Channel" value={channel} onChange={setChannel} options={[["all","All channels"],["web","Web"],["email","Email"],["gmail","Gmail"],["whatsapp","WhatsApp"],["instagram","Instagram"],["facebook","Facebook"]]} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select aria-label="Filter tickets by assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)} className="h-8 rounded-lg border border-border/60 bg-background px-2 text-xs"><option value="all">All assignees</option><option value="unassigned">Unassigned</option>{members.map((option) => <option key={option.id} value={String(option.id)}>{option.name}</option>)}</select>
        <button type="button" aria-pressed={unreadOnly} onClick={() => update({ unread: !unreadOnly })} className={cn("h-8 rounded-lg border px-3 text-xs", unreadOnly ? "border-primary/40 bg-primary/10 text-primary" : "border-border/60 text-muted-foreground")}>Unread only</button>
        {activeFilters > 0 && <button type="button" onClick={resetFilters} className="h-8 px-2 text-xs text-primary hover:underline">Clear {activeFilters} filters</button>}
        <span className="ml-auto text-xs text-muted-foreground">{queue.data ? <><strong className="font-mono text-foreground">{total}</strong> tickets</> : "Ticket count unavailable"}</span>
      </div>
    </section>

    {invalidSearch && <p id="ticket-search-error" role="alert" className="text-sm text-destructive">Search must contain at most {SUPPORT_QUEUE_SEARCH_LIMIT} characters. Shorten it to load tickets.</p>}
    {queue.isError && !invalidSearch && <Callout tone="danger" title="Ticket queue could not be loaded"
      actions={<Button variant="outline" disabled={queue.isFetching} onClick={() => { if (shouldRetrySupportQueue(0, queue.error)) void queue.refetch(); else resetFilters(); }}>{queue.isFetching ? "Retrying…" : shouldRetrySupportQueue(0, queue.error) ? "Try again" : "Clear filters"}</Button>}>
      <p>{queue.error instanceof Error ? queue.error.message : "Try again."}</p>{queue.data && <p>Showing the last loaded results for this view.</p>}
    </Callout>}
    <Card className="overflow-hidden rounded-2xl border-border/60 shadow-none" aria-busy={queue.isFetching}>
      {invalidSearch ? null : loading ? <LoadingState className="py-20" label="Loading ticket operations…" showLabel />
        : queue.isError && !queue.data ? null : tickets.length === 0 ? <div className="flex flex-col items-center py-20 text-center"><Inbox className="mb-3 h-8 w-8 text-muted-foreground/30" /><p className="text-sm font-medium">No tickets match this view</p><p className="mt-1 text-xs text-muted-foreground">Change the scope or clear filters to see more work.</p></div>
        : <div className="divide-y divide-border/50">{tickets.map((ticket) => {
          const breached = isSlaBreached(ticket);
          const needsHuman = Boolean(ticket.handoffId && !ticket.handoffAssignedMemberId);
          return <article key={ticket.id} className="group grid gap-3 p-4 transition hover:bg-muted/20 lg:grid-cols-[minmax(320px,1.6fr)_minmax(180px,0.7fr)_minmax(180px,0.7fr)_auto] lg:items-center">
            <button type="button" onClick={() => router.push(`/support/tickets/${ticket.id}`)} className="min-w-0 text-left focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
              <div className="mb-1.5 flex flex-wrap items-center gap-2"><span className="font-mono text-[10px] text-muted-foreground">{ticket.ticketNumber}</span>{ticket.unreadCount > 0 && <span className="rounded-full bg-destructive px-1.5 py-0.5 text-[9px] font-bold text-destructive-foreground">{ticket.unreadCount}</span>}<Badge className={cn("h-5 border-0 text-[10px]", STATUS_TONES[ticket.status])}>{formatSupportTicketStatus(ticket.status)}</Badge></div>
              <p className="truncate text-sm font-semibold group-hover:text-primary">{ticket.subject}</p>
              <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{ticket.lastMessagePreview || ticket.description || "No conversation preview yet"}</p>
            </button>
            <div className="space-y-1 text-xs"><p className="font-medium">{ticket.customerName || "Unlinked customer"}</p><p className="capitalize text-muted-foreground">{ticket.channel || "unknown"} · {ticket.priority}</p></div>
              <div className="space-y-1 text-xs"><p className={cn("flex items-center gap-1.5 font-medium", needsHuman ? "text-warning" : ticket.ownershipMode === "human_owned" ? "text-primary" : "text-info")}>{needsHuman ? <AlertTriangle className="h-3.5 w-3.5" /> : ticket.ownershipMode === "human_owned" ? <ShieldCheck className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}{supportOwnershipLabel(ticket)}</p><p className={cn("flex items-center gap-1 text-muted-foreground", breached && "font-medium text-destructive")}><Clock3 className="h-3 w-3" />{breached ? "SLA breached" : ticket.slaDeadline ? new Date(ticket.slaDeadline).toLocaleString() : "No SLA deadline"}</p></div>
            <div className="flex items-center justify-end gap-2">{ticket.claimable && ticket.assignedMemberId !== member?.id && <Button size="sm" className="h-8 gap-1.5" loading={claiming === ticket.id} onClick={() => void claim(ticket)}><UserCheck className="h-3.5 w-3.5" /> Claim</Button>}<Button size="sm" variant="outline" className="h-8" onClick={() => router.push(`/support/tickets/${ticket.id}`)}><MessageSquare className="mr-1.5 h-3.5 w-3.5" />Open</Button></div>
          </article>;
        })}</div>}
    </Card>

    {totalPages > 1 && <div className="flex items-center justify-between"><p className="text-xs text-muted-foreground">Page {page} of {totalPages}</p><div className="flex gap-1"><Button size="icon" variant="outline" className="h-8 w-8" aria-label="Previous page" disabled={page === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft className="h-4 w-4" /></Button><Button size="icon" variant="outline" className="h-8 w-8" aria-label="Next page" disabled={page === totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}><ChevronRight className="h-4 w-4" /></Button></div></div>}
  </div>;
}

function FilterSelect({ label, ariaLabel, value, onChange, options }: { label: string; ariaLabel?: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return <select aria-label={ariaLabel || `Filter tickets by ${label.toLowerCase()}`} value={value} onChange={(event) => onChange(event.target.value)} className="h-9 rounded-lg border border-border/60 bg-background px-2 text-xs outline-none focus:border-primary/50">{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select>;
}

export default function SupportTicketsPage() {
  return <Suspense fallback={<LoadingState className="py-16" label="Loading tickets…" />}><SupportTicketsQueue /></Suspense>;
}
