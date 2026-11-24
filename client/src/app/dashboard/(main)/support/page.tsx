"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowUpRight, BarChart3, Bot, CheckCircle2, CircleUserRound, Clock3, Globe2, Instagram, Mail, MessageCircle, MessageSquare, Plus, Radio, ShieldAlert, Sparkles, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent } from "@/components/ui/card";
import { CreateSupportTicketDialog } from "@/components/support/CreateSupportTicketDialog";
import { LoadingState } from "@/components/ui/loading-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { useSupportRealtimeRefresh } from "@/hooks/use-support-realtime-refresh";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SUPPORT_AI_READINESS_NOTICE, supportOwnershipLabel } from "@/lib/supportTicketWorkspace";
import { supportQueuePresentation, withReadablePrivacyTokens } from "@/lib/supportQueuePresentation";
import type { SupportCurrentQueue } from '../../../../../../shared/supportQueueMetrics';
import { SUPPORT_PRIORITY_CLASSES as PRIORITY_CONFIG } from "@/lib/support-styles";

interface SupportTicket {
  id: number; ticketNumber: string; subject: string | null; description: string | null; status: string; priority: string;
  category: string | null; teamId: number | null; totalMessages: number; createdAt: string; updatedAt: string;
  slaDeadline: string | null; customerName: string; customerEmail: string | null; channel: string; teamName: string | null;
  assignedMemberName: string | null; assignedMemberPresent: boolean; lastMessagePreview: string | null; lastMessageAt: string | null;
  lastMessageDirection: string | null; lastMessageInternal?: boolean; unreadCount: number; ownershipMode: string; handoffReason: string | null;
  aiReplyEnabled: boolean; handoffId: number | null; handoffAssignedMemberId: number | null;
  deliveryStatus: string | null; deliveryError: string | null;
}
interface SupportAnalytics { currentQueue?: SupportCurrentQueue; totalTickets: number; openTickets: number; activeTickets: number; waitingOnCustomerTickets: number; resolvedTickets: number; slaBreaches: number; deliveryFailures: number }
const STATUS_CONFIG: Record<string, { label: string; rail: string }> = {
  open: { label: "Open", rail: "bg-info" },
  in_progress: { label: "In progress", rail: "bg-warning" },
  waiting_on_customer: { label: "Waiting on customer", rail: "bg-primary" },
  resolved: { label: "Resolved", rail: "bg-success" },
  closed: { label: "Closed", rail: "bg-muted-foreground/60" },
};

function initialQuery(key: string, fallback = "all") { return typeof window === "undefined" ? fallback : new URLSearchParams(window.location.search).get(key) || fallback; }
function ChannelIcon({ channel, className }: { channel: string; className?: string }) {
  if (channel === "email") return <Mail className={className} />;
  if (channel === "whatsapp") return <MessageCircle className={className} />;
  if (channel === "instagram") return <Instagram className={className} />;
  return <Globe2 className={className} />;
}
function formatRelative(value: string | null) {
  if (!value) return "No messages yet";
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "just now"; if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60); return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
function slaState(ticket: SupportTicket) {
  if (!ticket.slaDeadline || ["resolved", "closed"].includes(ticket.status)) return null;
  const remaining = new Date(ticket.slaDeadline).getTime() - Date.now();
  if (remaining < 0) {
    const hours = Math.max(1, Math.ceil(Math.abs(remaining) / 3_600_000));
    return { label: hours >= 48 ? `${Math.floor(hours / 24)}d overdue` : `${hours}h overdue`, className: "text-destructive" };
  }
  if (remaining <= 30 * 60_000) return { label: `${Math.max(1, Math.ceil(remaining / 60_000))}m left`, className: "text-warning" };
  return { label: `${Math.max(1, Math.ceil(remaining / 3_600_000))}h left`, className: "text-success" };
}

export default function SupportPage() {
  const router = useRouter();
  const { toast } = useToast();
  const searchInput = useRef<HTMLInputElement>(null);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [analytics, setAnalytics] = useState<SupportAnalytics | null>(null);
  const [analyticsError, setAnalyticsError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ticketsError, setTicketsError] = useState(false);
  const [search, setSearch] = useState(() => initialQuery("search", ""));
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const [status, setStatus] = useState(() => initialQuery("status"));
  const [priority, setPriority] = useState(() => initialQuery("priority"));
  const [channel, setChannel] = useState(() => initialQuery("channel"));
  const [ownership, setOwnership] = useState(() => initialQuery("ownership"));
  const [sla, setSla] = useState(() => initialQuery("sla"));
  const [unread, setUnread] = useState(() => initialQuery("unread"));
  const [sort, setSort] = useState(() => initialQuery("sort", "operational"));
  const [page, setPage] = useState(() => Number(initialQuery("page", "1")) || 1);
  const [pageSize, setPageSize] = useState(() => { const limit = Number(initialQuery("limit", "20")); return [10, 20, 50].includes(limit) ? limit : 20; });
  const [total, setTotal] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const createTicketOpener = useRef<HTMLButtonElement | null>(null);

  useEffect(() => { const timeout = window.setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1); }, 300); return () => window.clearTimeout(timeout); }, [search]);

  const fetchTickets = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    setTicketsError(false);
    try {
      const query = new URLSearchParams({ page: String(page), limit: String(pageSize), sort });
      if (debouncedSearch) query.set("search", debouncedSearch);
      if (status !== "all") query.set("status", status); if (priority !== "all") query.set("priority", priority);
      if (channel !== "all") query.set("channel", channel); if (ownership !== "all") query.set("ownership", ownership);
      if (sla !== "all") query.set("sla", sla); if (unread === "true") query.set("unread", "true");
      const data = await api.get<{ tickets: SupportTicket[]; totalPages: number; total: number }>(`/api/support?${query}`);
      setTickets(data.tickets || []); setTotal(data.total || 0);
      window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
    } catch {
      setTicketsError(true); if (showLoader) toast({ title: "Support queue unavailable", description: "Try refreshing the queue.", variant: "destructive" });
    } finally { if (showLoader) setLoading(false); }
  }, [channel, debouncedSearch, ownership, page, pageSize, priority, sla, sort, status, toast, unread]);
  const fetchAnalytics = useCallback(async () => { try { setAnalytics(await api.get<SupportAnalytics>("/api/support/analytics?days=30")); setAnalyticsError(false); } catch { setAnalyticsError(true); } }, []);
  const refreshSupport = useCallback(async () => { await Promise.all([fetchTickets(false), fetchAnalytics()]); }, [fetchAnalytics, fetchTickets]);
  const { isRealtimeConnected } = useSupportRealtimeRefresh(refreshSupport);
  useEffect(() => { void fetchTickets(); }, [fetchTickets]);
  useEffect(() => { void fetchAnalytics(); }, [fetchAnalytics]);

  const openCreate = (button: HTMLButtonElement) => { createTicketOpener.current = button; setCreateOpen(true); };

  const activeFilters = useMemo(() => [status, priority, channel, ownership, sla, unread].filter((value) => value !== "all").length + Number(Boolean(search.trim())), [channel, ownership, priority, search, sla, status, unread]);
  const hasFilteredView = activeFilters > 0 || Boolean(debouncedSearch) || page > 1;
  const resetFilters = () => { setStatus("all"); setPriority("all"); setChannel("all"); setOwnership("all"); setSla("all"); setUnread("all"); setSearch(""); setDebouncedSearch(""); setPage(1); searchInput.current?.focus(); };

  return <div className="mx-auto max-w-screen-2xl space-y-5 p-4 sm:p-5">
    <PageHeader icon={MessageSquare} title="Support control board" subtitle="One queue for customer urgency, AI handoffs, ownership, and delivery health" actions={<div className="flex flex-wrap items-center gap-2">
      <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]", isRealtimeConnected ? "border-success/30 bg-success/5 text-success" : "border-border text-muted-foreground")}><Radio className={cn("h-3 w-3", isRealtimeConnected && "animate-pulse")} />{isRealtimeConnected ? "Live queue" : "Polling"}</span>
      <Button variant="outline" size="sm" onClick={() => router.push("/dashboard/support/analytics")}><BarChart3 className="mr-1.5 h-3.5 w-3.5" />Analytics</Button>
      <Button variant="outline" size="sm" onClick={() => router.push("/dashboard/support/teams")}><Users className="mr-1.5 h-3.5 w-3.5" />Teams</Button>
      <Button size="sm" onClick={(event) => openCreate(event.currentTarget)}><Plus className="mr-1.5 h-3.5 w-3.5" />New ticket</Button>
    </div>} />
    <p className="text-xs leading-relaxed text-muted-foreground">{SUPPORT_AI_READINESS_NOTICE}</p>
    {analyticsError && <Callout tone="warning" announce role="alert" actions={<Button variant="outline" size="sm" onClick={() => void fetchAnalytics()}>Retry totals</Button>}>{analytics ? 'Queue totals could not be refreshed. Showing the previous snapshot.' : 'Queue totals are unavailable. Your tickets are shown below.'}</Callout>}

    {analytics && <div className="grid overflow-hidden rounded-2xl border border-border/60 bg-card sm:grid-cols-2 xl:grid-cols-5">
      {[
        { label: "Active queue", value: analytics.currentQueue?.activeTickets ?? '—', detail: analytics.currentQueue ? `${analytics.currentQueue.openTickets} open · all dates` : 'Queue totals unavailable', icon: Sparkles, tone: "text-info" },
        { label: "SLA breached", value: analytics.currentQueue?.slaBreaches ?? '—', detail: "current queue · all dates", icon: ShieldAlert, tone: "text-destructive" },
        { label: "Waiting", value: analytics.currentQueue?.waitingOnCustomerTickets ?? '—', detail: "on customer · all dates", icon: Clock3, tone: "text-primary" },
        { label: "Delivery issues", value: analytics.deliveryFailures, detail: "last 30 days", icon: AlertCircle, tone: "text-warning" },
        { label: "Resolved", value: analytics.resolvedTickets, detail: "last 30 days", icon: CheckCircle2, tone: "text-success" },
      ].map((metric) => <div key={metric.label} className="border-b border-r border-border/50 p-4 last:border-r-0 sm:last:border-b-0 xl:border-b-0"><div className="flex items-start justify-between gap-3"><div><p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{metric.label}</p><p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{metric.value}</p><p className="text-xs text-muted-foreground">{metric.detail}</p></div><metric.icon className={cn("mt-0.5 h-4 w-4", metric.tone)} /></div></div>)}
    </div>}

    <Card className="rounded-2xl border-border/60 shadow-none"><CardContent className="space-y-3 p-3 sm:p-4">
      <div className="flex flex-col gap-2 lg:flex-row"><SearchInput ref={searchInput} aria-label="Search support tickets" value={search} onValueChange={setSearch} placeholder="Search ticket number or subject" wrapperClassName="flex-1" /><Select value={sort} onValueChange={(value) => { setSort(value); setPage(1); }}><SelectTrigger aria-label="Sort support tickets" className="w-full lg:w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="operational">Operational priority</SelectItem><SelectItem value="updated">Recently updated</SelectItem><SelectItem value="newest">Newest created</SelectItem><SelectItem value="oldest">Oldest created</SelectItem></SelectContent></Select></div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <QueueFilter label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[["all","All statuses"],["open","Open"],["in_progress","In progress"],["waiting_on_customer","Waiting"],["resolved","Resolved"],["closed","Closed"]]} />
        <QueueFilter label="Priority" value={priority} onChange={(v) => { setPriority(v); setPage(1); }} options={[["all","All priorities"],["critical","Critical"],["urgent","Urgent"],["high","High"],["medium","Medium"],["low","Low"]]} />
        <QueueFilter label="Channel" value={channel} onChange={(v) => { setChannel(v); setPage(1); }} options={[["all","All channels"],["web","Web"],["email","Email"],["whatsapp","WhatsApp"],["instagram","Instagram"],["facebook","Facebook"]]} />
        <QueueFilter label="Ownership" value={ownership} onChange={(v) => { setOwnership(v); setPage(1); }} options={[["all","All ownership"],["human_owned","Human owned"],["ai_active","No human takeover"],["unassigned","Unassigned"]]} />
        <QueueFilter label="SLA" value={sla} onChange={(v) => { setSla(v); setPage(1); }} options={[["all","All SLA states"],["breached","Breached"],["at_risk","At risk"],["on_track","On track"],["none","No target"]]} />
        <QueueFilter label="Read state" value={unread} onChange={(v) => { setUnread(v); setPage(1); }} options={[["all","All tickets"],["true","Unread only"]]} />
      </div>
      {activeFilters > 0 && <div className="flex items-center justify-between border-t border-border/50 pt-3 text-xs text-muted-foreground"><span>{activeFilters} active filter{activeFilters === 1 ? "" : "s"}</span><Button variant="ghost" size="sm" className="h-7 text-xs" onClick={resetFilters}>Clear filters</Button></div>}
    </CardContent></Card>

    {loading ? <LoadingState size="section" label="Loading support tickets…" showLabel className="h-56" /> : ticketsError ? <div className="flex h-56 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed"><p className="text-sm font-medium">The queue could not be loaded</p><Button variant="outline" size="sm" onClick={() => void fetchTickets()}>Try again</Button></div> : tickets.length === 0 ? <div className="flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed p-4 text-center" role="status" aria-live="polite"><MessageSquare className="mb-3 h-6 w-6 text-muted-foreground/40" /><p className="text-sm font-medium">{hasFilteredView ? "No tickets match this view" : "No support tickets yet"}</p><p className="mt-1 text-xs text-muted-foreground">{hasFilteredView ? "Clear the search and filters to return to the queue." : "Customer tickets will appear here when they are received or created."}</p>{hasFilteredView && <Button variant="outline" size="sm" className="mt-3" onClick={resetFilters}>Clear filters</Button>}</div> : <div className="space-y-2">
      {tickets.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} onOpen={() => router.push(`/dashboard/support/${ticket.id}`)} />)}
      <Pagination className="pt-3" aria-label="Ticket pages" page={page} pageSize={pageSize} totalItems={total} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} pageSizeOptions={[10, 20, 50]} itemLabel="tickets" />
    </div>}

    <CreateSupportTicketDialog open={createOpen} onOpenChange={setCreateOpen} returnFocusRef={createTicketOpener} onCreated={() => void refreshSupport()} />
  </div>;
}

function QueueFilter({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="w-full"><SelectValue placeholder={label} /></SelectTrigger><SelectContent>{options.map(([optionValue, optionLabel]) => <SelectItem key={optionValue} value={optionValue}>{optionLabel}</SelectItem>)}</SelectContent></Select>;
}
function TicketRow({ ticket, onOpen }: { ticket: SupportTicket; onOpen: () => void }) {
  const status = STATUS_CONFIG[ticket.status] || STATUS_CONFIG.open; const sla = slaState(ticket);
  const ownershipLabel = supportOwnershipLabel(ticket);
  const { headline, classificationUnavailable } = supportQueuePresentation(ticket);
  const deliveryIssue = ticket.deliveryStatus && ["failed", "uncertain", "dead_letter"].includes(ticket.deliveryStatus);
  return <Card role="link" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }} className="group relative cursor-pointer overflow-hidden rounded-2xl border-border/50 shadow-none transition hover:border-border hover:shadow-sm">
    <div className={cn("absolute inset-y-0 left-0 w-1", sla?.className === "text-destructive" ? "bg-destructive" : status.rail)} />
    <CardContent className="grid gap-3 p-4 pl-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(190px,.65fr)_minmax(180px,.55fr)] lg:items-center">
      <div className="min-w-0"><div className="mb-1.5 flex flex-wrap items-center gap-1.5"><span className="font-mono text-[11px] text-muted-foreground">{ticket.ticketNumber}</span><StatusBadge status={STATUS_CONFIG[ticket.status] ? ticket.status : "open"} label={status.label} className="px-1.5 text-[10px]" /><Badge className={cn("h-auto border-0 px-1.5 py-0.5 text-[10px] capitalize", PRIORITY_CONFIG[ticket.priority])}>{ticket.priority}</Badge>{ticket.unreadCount > 0 && <Badge className="h-auto border-0 bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">{ticket.unreadCount} unread</Badge>}</div><h3 title={headline} className="line-clamp-2 break-words text-sm font-semibold [overflow-wrap:anywhere] group-hover:text-primary">{headline}</h3>{classificationUnavailable && <div className="mt-1.5 space-y-1"><Badge variant="outline" className="h-auto border-warning/30 bg-warning/5 px-1.5 py-0.5 text-[10px] text-warning">Classification unavailable</Badge><p className="text-[11px] text-muted-foreground">Automatic classification could not assess this request. Review the conversation for context.</p></div>}<div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><CircleUserRound className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{ticket.customerName}{ticket.customerEmail ? ` · ${ticket.customerEmail}` : ""}</span></div><p className="mt-2 truncate text-xs text-muted-foreground/90">{withReadablePrivacyTokens(ticket.lastMessagePreview || ticket.description) || "No conversation preview"}</p></div>
      <div className="space-y-2 text-xs"><div className="flex items-center gap-2"><ChannelIcon channel={ticket.channel} className="h-3.5 w-3.5 text-muted-foreground" /><span className="capitalize">{ticket.channel}</span><span className="text-muted-foreground">· {formatRelative(ticket.lastMessageAt || ticket.updatedAt)}</span></div><div className="flex items-center gap-2"><Users className="h-3.5 w-3.5 text-muted-foreground" /><span className="truncate">{ticket.teamName || "Canonical queue"}</span></div><div className="flex items-center gap-2"><span className={cn("h-2 w-2 rounded-full", ticket.assignedMemberPresent ? "bg-success" : "bg-muted-foreground/40")} /><span className="truncate">{ticket.assignedMemberName || "No individual assignee"}</span></div></div>
      <div className="space-y-2 text-xs"><div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-muted-foreground">{ownershipLabel === "No human takeover" ? <Bot className="h-3.5 w-3.5" /> : <Users className="h-3.5 w-3.5" />}{ownershipLabel}</span>{sla && <span className={cn("font-medium", sla.className)}>{sla.label}</span>}</div>{ticket.handoffReason && <p className="line-clamp-2 rounded-md bg-warning/5 px-2 py-1 text-[11px] text-warning">{ticket.aiReplyEnabled ? "Human review" : "Handoff pauses AI"}: {ticket.handoffReason}</p>}{deliveryIssue && <p className="line-clamp-2 flex items-start gap-1.5 text-[11px] text-destructive"><AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />Delivery {ticket.deliveryStatus}{ticket.deliveryError ? `: ${ticket.deliveryError}` : ""}</p>}<div className="flex items-center justify-end gap-1 font-medium text-primary opacity-0 transition group-hover:opacity-100">Open workspace <ArrowUpRight className="h-3.5 w-3.5" /></div></div>
    </CardContent>
  </Card>;
}
