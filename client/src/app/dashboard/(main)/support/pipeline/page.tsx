"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Kanban, Radio, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from "@/components/ui/button";
import { PageErrorState, PageLoadingState } from "@/components/ui/page-state";
import { SearchInput } from "@/components/ui/search-input";
import { useSupportRealtimeRefresh } from "@/hooks/use-support-realtime-refresh";
import { api } from "@/lib/api";
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';
import { cn } from "@/lib/utils";
import { formatSupportDate, SUPPORT_PIPELINE_STAGES, type SupportOperationsTicket, type SupportTeam } from "@/lib/supportOperations";

export default function SupportPipelinePage() {
  const router = useRouter();
  const profileId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const activeRequest = useRef<AbortController | null>(null);
  const [teams, setTeams] = useState<SupportTeam[]>([]);
  const [tickets, setTickets] = useState<SupportOperationsTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [remainingPages, setRemainingPages] = useState(0);
  const [totalTickets, setTotalTickets] = useState(0);
  const [teamFilter, setTeamFilter] = useState("all");
  const [memberFilter, setMemberFilter] = useState("all");
  const [search, setSearch] = useState("");

  const load = useCallback(async (showLoader = true) => {
    // Realtime/polling must not restart a slow in-flight initial load.
    if (!showLoader && activeRequest.current) return;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const current = () => activeRequest.current === controller && !controller.signal.aborted;
    const options = { signal: controller.signal };
    if (showLoader) setLoading(true);
    setRefreshing(true); setError(null); setTeamsError(null);
    // Team metadata must not hold the first useful tickets behind a full-screen loader.
    const teamRequest = api.get<SupportTeam[]>('/api/support/teams', options).then(nextTeams => {
      if (current()) setTeams(Array.isArray(nextTeams) ? nextTeams : []);
    }).catch(cause => {
      if (current()) setTeamsError(cause instanceof Error ? cause.message : 'Team details could not be loaded.');
    });
    try {
      const firstPage = await api.get<{ tickets: SupportOperationsTicket[]; totalPages: number; total?: number }>("/api/support?page=1&limit=100&sort=operational&view=pipeline", options);
      if (!current()) return;
      const groups = new Map([[1, firstPage.tickets || []]]);
      const pageCount = Math.max(1, Number(firstPage.totalPages || 1));
      setTotalTickets(firstPage.total ?? (firstPage.tickets || []).length);
      setTickets(firstPage.tickets || []); setRemainingPages(pageCount - 1); setLoading(false);
      // Fetch every page, with bounded concurrency and progressive rendering.
      for (let start = 2; start <= pageCount && current(); start += 3) {
        const batch = await Promise.allSettled(Array.from({ length: Math.min(3, pageCount - start + 1) }, async (_, index) => {
          const pageNumber = start + index;
          const page = await api.get<{ tickets: SupportOperationsTicket[] }>(`/api/support?page=${pageNumber}&limit=100&sort=operational&view=pipeline`, options);
          if (!current()) return;
          groups.set(pageNumber, page.tickets || []);
          const byId = new Map<number, SupportOperationsTicket>();
          [...groups].sort(([a], [b]) => a - b).flatMap(([, rows]) => rows).forEach(ticket => byId.set(ticket.id, ticket));
          setTickets([...byId.values()]); setRemainingPages(pageCount - groups.size);
        }));
        const failed = batch.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "Failed to load the support pipeline."); }
    finally {
      await teamRequest;
      if (current()) { setLoading(false); setRefreshing(false); activeRequest.current = null; }
    }
  }, [profileId]);
  const refresh = useCallback(() => load(false), [load]);
  const { isRealtimeConnected } = useSupportRealtimeRefresh(refresh, 30_000);
  useEffect(() => {
    setTickets([]); setTeams([]); setTotalTickets(0); setRemainingPages(0);
    setTeamFilter('all'); setMemberFilter('all'); setSearch('');
    void load();
    return () => { activeRequest.current?.abort(); activeRequest.current = null; };
  }, [load]);

  const members = useMemo(() => teams.filter((team) => teamFilter === "all" || String(team.id) === teamFilter).flatMap((team) => team.members.map((member) => ({ ...member, teamName: team.name }))), [teamFilter, teams]);
  useEffect(() => { if (memberFilter !== "all" && memberFilter !== "unassigned" && !members.some((member) => String(member.id) === memberFilter)) setMemberFilter("all"); }, [memberFilter, members]);
  const teamById = useMemo(() => new Map(teams.map((team) => [team.id, team])), [teams]);
  const memberById = useMemo(() => new Map(teams.flatMap((team) => team.members).map((member) => [member.id, member])), [teams]);
  const visible = useMemo(() => tickets.filter((ticket) => {
    if (teamFilter !== "all" && String(ticket.teamId) !== teamFilter) return false;
    if (memberFilter === "unassigned" && ticket.assignedMemberId) return false;
    if (memberFilter !== "all" && memberFilter !== "unassigned" && String(ticket.assignedMemberId) !== memberFilter) return false;
    const query = search.trim().toLowerCase();
    return !query || `${ticket.ticketNumber} ${ticket.subject} ${ticket.customerName || ""} ${ticket.assignedMemberName || ""}`.toLowerCase().includes(query);
  }), [memberFilter, search, teamFilter, tickets]);

  if (loading && tickets.length === 0) return <PageLoadingState label="Loading support tickets…" />;
  if (error && tickets.length === 0) return <PageErrorState title="Support pipeline could not be loaded" description={error} reset={() => void load()} />;

  return <div className="mx-auto max-w-[1800px] space-y-5 p-4 sm:p-5">
    <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"><div><div className="flex items-center gap-2"><Kanban className="h-5 w-5 text-primary" /><h1 className="text-lg font-semibold">Support ticket pipeline</h1><span className={cn("flex items-center gap-1 text-[10px]", isRealtimeConnected ? "text-success" : "text-muted-foreground")}><Radio className="h-3 w-3" />{isRealtimeConnected ? "Live" : "Polling"}</span></div><p className="mt-1 text-xs text-muted-foreground">See every team member’s workload across the complete support lifecycle.</p></div><Button variant="outline" size="sm" className="gap-1.5" onClick={() => router.push("/dashboard/support/teams")}><Users className="h-3.5 w-3.5" /> Team members</Button></div>

    {error && <Alert variant="destructive"><AlertTitle>Some tickets could not be loaded</AlertTitle><AlertDescription>{error} Showing {tickets.length} of {totalTickets} tickets. <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void load()}>Try again</Button></AlertDescription></Alert>}
    {teamsError && <Alert><AlertTitle>Team details unavailable</AlertTitle><AlertDescription>{teamsError} <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void load()}>Reload team details</Button></AlertDescription></Alert>}
    {refreshing && <p role="status" className="text-sm text-muted-foreground">{remainingPages > 0 ? `Loaded ${tickets.length} of ${totalTickets} tickets. Loading remaining tickets…` : 'Updating pipeline details…'}</p>}
    <div className="grid gap-2 rounded-2xl border border-border/60 bg-card p-3 sm:grid-cols-2 xl:grid-cols-[minmax(260px,1fr)_220px_240px_auto]">
      <SearchInput size="sm" aria-label="Search support pipeline" value={search} onValueChange={setSearch} placeholder="Search ticket, customer, or member" />
      <select aria-label="Filter pipeline by support team" value={teamFilter} onChange={(event) => { setTeamFilter(event.target.value); setMemberFilter("all"); }} className="h-9 rounded-md border border-input bg-background px-3 text-sm"><option value="all">All support teams</option>{teams.map((team) => <option key={team.id} value={String(team.id)}>{team.name}</option>)}</select>
      <select aria-label="Filter pipeline by team member" value={memberFilter} onChange={(event) => setMemberFilter(event.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm"><option value="all">All team members</option><option value="unassigned">Unassigned tickets</option>{members.map((member) => <option key={member.id} value={String(member.id)}>{member.name} · {member.teamName}</option>)}</select>
      <div className="flex items-center justify-end rounded-lg bg-muted/30 px-3 text-xs text-muted-foreground"><span className="font-mono font-semibold text-foreground">{visible.length}</span>&nbsp;ticket{visible.length === 1 ? "" : "s"}</div>
    </div>

    <div className="overflow-x-auto pb-3"><div className="grid min-w-[1320px] grid-cols-5 gap-3">{SUPPORT_PIPELINE_STAGES.map((stage) => { const stageTickets = visible.filter((ticket) => ticket.status === stage.key); return <section key={stage.key} aria-labelledby={`pipeline-${stage.key}`} className="min-h-[420px] rounded-2xl border border-border/60 bg-muted/15"><div className="sticky top-0 z-10 flex items-center justify-between rounded-t-2xl border-b border-border/50 bg-card/95 px-3 py-3 backdrop-blur"><div className="flex items-center gap-2"><span className={cn("h-2 w-2 rounded-full", stage.tone)} /><h2 id={`pipeline-${stage.key}`} className="text-xs font-semibold">{stage.label}</h2></div><Badge variant="outline" className="h-5 min-w-6 justify-center font-mono text-[10px]">{stageTickets.length}</Badge></div><div className="space-y-2 p-2">{stageTickets.length === 0 ? <p className="px-3 py-10 text-center text-[11px] text-muted-foreground">{remainingPages > 0 ? (refreshing ? 'Loading remaining tickets…' : 'No loaded tickets in this stage') : 'No tickets in this stage'}</p> : stageTickets.map((ticket) => { const team = ticket.teamId ? teamById.get(ticket.teamId) : null; const member = ticket.assignedMemberId ? memberById.get(ticket.assignedMemberId) : null; const unread = Number(ticket.operationalUnreadCount ?? ticket.unreadCount ?? 0); return <button type="button" key={ticket.id} className="group w-full rounded-xl border border-border/60 bg-card p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50" onClick={() => router.push(`/dashboard/support/${ticket.id}`)}><div className="mb-2 flex items-center justify-between gap-2"><span className="font-mono text-[9px] text-muted-foreground">{ticket.ticketNumber}</span><div className="flex items-center gap-1">{unread > 0 && <span className="rounded-full bg-destructive px-1.5 py-0.5 text-[9px] font-semibold text-destructive-foreground">{unread}</span>}<span className={cn("rounded-md px-1.5 py-0.5 text-[9px] capitalize", ticket.priority === "urgent" || ticket.priority === "critical" ? "bg-destructive/10 text-destructive" : ticket.priority === "high" ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground")}>{ticket.priority}</span></div></div><p className="line-clamp-2 text-xs font-semibold leading-5 group-hover:text-primary">{ticket.subject}</p><p className="mt-1 line-clamp-1 text-[10px] text-muted-foreground">{ticket.customerName || "Unknown customer"}</p><div className="mt-3 border-t border-border/50 pt-2"><div className="flex items-center justify-between gap-2"><div className="min-w-0"><p className="truncate text-[10px] font-medium">{member?.name || ticket.assignedMemberName || "Unassigned"}</p><p className="truncate text-[9px] text-muted-foreground">{team?.name || "No team"}</p></div><ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 group-hover:text-primary" /></div><p className="mt-2 text-[9px] text-muted-foreground">Updated {formatSupportDate(ticket.updatedAt)}</p></div></button>; })}</div></section>; })}</div></div>
  </div>;
}
