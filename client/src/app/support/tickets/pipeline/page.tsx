"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext, KeyboardSensor, PointerSensor, useDraggable, useDroppable,
  useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Clock3, GripVertical, Kanban, UserCheck, X } from "lucide-react";
import { supportApi } from "@/lib/support-api";
import { useSupportAuth } from "@/contexts/SupportAuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { LoadingState } from "@/components/ui/loading-state";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  SUPPORT_MEMBER_PIPELINE_STAGES, isSlaBreached, supportOwnershipLabel,
  type SupportMemberTicket, type SupportTeamMemberOption, type TicketStatus,
} from "@/lib/supportTicketWorkspace";

type Scope = "my" | "team" | "unassigned";
interface TicketPage { tickets: SupportMemberTicket[]; totalPages: number }

export default function SupportTicketPipelinePage() {
  const router = useRouter();
  const { toast } = useToast();
  const { member, isAuthenticated, isLoading: authLoading } = useSupportAuth();
  const [tickets, setTickets] = useState<SupportMemberTicket[]>([]);
  const [members, setMembers] = useState<SupportTeamMemberOption[]>([]);
  const [scope, setScope] = useState<Scope>("my");
  const [assignee, setAssignee] = useState("all");
  const [search, setSearch] = useState("");
  const [ownership, setOwnership] = useState("all");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<number | null>(null);
  const [pendingMove, setPendingMove] = useState<{ ticket: SupportMemberTicket; status: TicketStatus } | null>(null);
  const [resumeAi, setResumeAi] = useState(false);
  const [reviewMessage, setReviewMessage] = useState("Thank you for working with our support team. Please share your experience.");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));

  useEffect(() => { if (!authLoading && !isAuthenticated) router.push("/support/login"); }, [authLoading, isAuthenticated, router]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const first = await supportApi.get<TicketPage>(`/api/support-portal/tickets?scope=${scope}&page=1&limit=100`);
      const rest = first.totalPages > 1 ? await Promise.all(Array.from({ length: first.totalPages - 1 }, (_, index) => supportApi.get<TicketPage>(`/api/support-portal/tickets?scope=${scope}&page=${index + 2}&limit=100`))) : [];
      setTickets([...(first.tickets || []), ...rest.flatMap((page) => page.tickets || [])]);
    } catch (error) {
      toast({ title: "Pipeline could not be loaded", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    } finally { setLoading(false); }
  }, [scope, toast]);
  useEffect(() => { if (isAuthenticated) void load(); }, [isAuthenticated, load]);
  useEffect(() => { if (isAuthenticated) void supportApi.get<SupportTeamMemberOption[]>("/api/support-portal/team-members").then(setMembers).catch(() => setMembers([])); }, [isAuthenticated]);

  const visible = useMemo(() => tickets.filter((ticket) => {
    if (assignee !== "all" && String(ticket.assignedMemberId || "unassigned") !== assignee) return false;
    if (ownership !== "all" && ticket.ownershipMode !== ownership) return false;
    const query = search.trim().toLowerCase();
    return !query || `${ticket.ticketNumber} ${ticket.subject} ${ticket.customerName || ""}`.toLowerCase().includes(query);
  }), [assignee, ownership, search, tickets]);

  const requestMove = (ticket: SupportMemberTicket, status: TicketStatus) => {
    if (ticket.status === status || working) return;
    if (status === "resolved" || status === "closed") {
      setResumeAi(status === "closed"); setPendingMove({ ticket, status }); return;
    }
    void applyMove(ticket, status);
  };
  const applyMove = async (ticket: SupportMemberTicket, status: TicketStatus, options?: { resumeAi?: boolean; reviewMessage?: string }) => {
    const previous = tickets;
    setWorking(ticket.id);
    setTickets((items) => items.map((item) => item.id === ticket.id ? { ...item, status, version: item.version + 1 } : item));
    try {
      if (status === "closed") {
        await supportApi.post(`/api/support-portal/tickets/${ticket.id}/close`, { reviewMessage: options?.reviewMessage || reviewMessage, expectedVersion: ticket.version });
      } else {
        await supportApi.put(`/api/support-portal/tickets/${ticket.id}`, { status, expectedVersion: ticket.version, ...(status === "resolved" ? { resumeAi: options?.resumeAi === true } : {}) });
      }
      toast({ title: `Moved to ${SUPPORT_MEMBER_PIPELINE_STAGES.find((stage) => stage.key === status)?.label}` });
      await load();
    } catch (error) {
      setTickets(previous);
      toast({ title: "Ticket was not moved", description: error instanceof Error ? error.message : "The ticket changed. The pipeline has been refreshed.", variant: "destructive" });
      await load();
    } finally { setWorking(null); setPendingMove(null); }
  };
  const claim = async (ticket: SupportMemberTicket) => {
    setWorking(ticket.id);
    try {
      await supportApi.post(`/api/support-portal/tickets/${ticket.id}/claim`, { expectedVersion: ticket.version });
      toast({ title: "Ticket claimed" }); await load();
    } catch (error) {
      toast({ title: "Ticket was not claimed", description: error instanceof Error ? error.message : "Another member may own it.", variant: "destructive" }); await load();
    } finally { setWorking(null); }
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const ticket = active.data.current?.ticket as SupportMemberTicket | undefined;
    const status = over.id as TicketStatus;
    if (ticket && SUPPORT_MEMBER_PIPELINE_STAGES.some((stage) => stage.key === status)) requestMove(ticket, status);
  };

  if (authLoading || (loading && !tickets.length)) return <LoadingState className="py-16" label="Loading ticket pipeline…" />;
  if (!isAuthenticated) return null;

  return <div className="mx-auto max-w-[1800px] space-y-5">
    <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"><div><div className="flex items-center gap-2"><Kanban className="h-5 w-5 text-primary" /><h1 className="text-lg font-semibold">Ticket pipeline</h1></div><p className="mt-1 text-xs text-muted-foreground">Move authorized work through the shared lifecycle without mixing ticket stage and AI ownership.</p></div><Button variant="outline" size="sm" onClick={() => router.push("/support/tickets")}>Back to queue</Button></header>
    <section className="grid gap-2 rounded-2xl border border-border/60 bg-card p-3 sm:grid-cols-2 xl:grid-cols-[auto_minmax(260px,1fr)_200px_200px_auto]">
      <div className="inline-flex rounded-xl bg-muted/50 p-1">{([['my','My work'],['team','Team queue'],['unassigned','Unassigned']] as const).map(([value,label]) => <button key={value} type="button" onClick={() => setScope(value)} className={cn("rounded-lg px-3 py-2 text-xs font-semibold", scope === value ? "bg-background shadow-sm" : "text-muted-foreground")}>{label}</button>)}</div>
      <SearchInput size="sm" aria-label="Search pipeline" value={search} onValueChange={setSearch} placeholder="Search ticket or customer" className="rounded-lg border-border/60 bg-background text-sm" />
      <select aria-label="Filter pipeline by assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)} className="h-9 rounded-lg border border-border/60 bg-background px-2 text-xs"><option value="all">All assignees</option><option value="unassigned">Unassigned</option>{members.map((option) => <option key={option.id} value={String(option.id)}>{option.name}</option>)}</select>
      <select aria-label="Filter pipeline by ownership" value={ownership} onChange={(event) => setOwnership(event.target.value)} className="h-9 rounded-lg border border-border/60 bg-background px-2 text-xs"><option value="all">All ownership</option><option value="human_owned">Human owned</option><option value="ai_active">No human takeover</option></select>
      <div className="flex items-center justify-end px-2 text-xs text-muted-foreground"><strong className="mr-1 font-mono text-foreground">{visible.length}</strong> tickets</div>
    </section>

    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="overflow-x-auto pb-3"><div className="grid min-w-[1320px] grid-cols-5 gap-3">{SUPPORT_MEMBER_PIPELINE_STAGES.map((stage) => <PipelineColumn key={stage.key} stage={stage} tickets={visible.filter((ticket) => ticket.status === stage.key)} memberId={member?.id || 0} canManage={Boolean(member && ["lead", "admin"].includes(member.role))} working={working} onOpen={(ticket) => router.push(`/support/tickets/${ticket.id}`)} onMove={requestMove} onClaim={claim} />)}</div></div>
    </DndContext>

    {pendingMove && <div className="fixed inset-0 z-[var(--layer-modal)] flex items-center justify-center p-4"><button className="absolute inset-0 bg-background/65 backdrop-blur-sm" aria-label="Cancel status change" onClick={() => setPendingMove(null)} /><div role="dialog" aria-modal="true" aria-labelledby="pipeline-confirm-title" className="relative w-full max-w-md rounded-2xl border border-border/70 bg-card p-5 shadow-2xl"><button className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground hover:bg-muted" onClick={() => setPendingMove(null)} aria-label="Close"><X className="h-4 w-4" /></button><h2 id="pipeline-confirm-title" className="text-base font-semibold">{pendingMove.status === "closed" ? "Close ticket" : "Resolve ticket"}</h2><p className="mt-1 text-xs text-muted-foreground">{pendingMove.ticket.ticketNumber} · {pendingMove.ticket.subject}</p>{pendingMove.ticket.handoffId && <label className="mt-4 flex items-start gap-3 rounded-xl border border-border/60 p-3"><input type="checkbox" className="mt-0.5" checked={resumeAi} onChange={(event) => setResumeAi(event.target.checked)} disabled={pendingMove.status === "closed"} /><span><span className="block text-sm font-medium">Resume AI after resolution</span><span className="mt-0.5 block text-xs text-muted-foreground">{pendingMove.status === "closed" ? "Closing always restores AI for the next customer message." : "Leave off to keep this conversation human-owned."}</span></span></label>}{pendingMove.status === "closed" && <label className="mt-4 block"><span className="text-xs font-medium">Review request message</span><textarea value={reviewMessage} onChange={(event) => setReviewMessage(event.target.value)} rows={3} className="mt-1.5 w-full rounded-xl border border-border/60 bg-background p-3 text-sm" /></label>}<div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setPendingMove(null)}>Cancel</Button><Button variant={pendingMove.status === "closed" ? "destructive" : "default"} disabled={working === pendingMove.ticket.id} onClick={() => void applyMove(pendingMove.ticket, pendingMove.status, { resumeAi, reviewMessage })}>{pendingMove.status === "closed" ? "Close & request review" : "Resolve ticket"}</Button></div></div></div>}
  </div>;
}

function PipelineColumn({ stage, tickets, memberId, canManage, working, onOpen, onMove, onClaim }: { stage: (typeof SUPPORT_MEMBER_PIPELINE_STAGES)[number]; tickets: SupportMemberTicket[]; memberId: number; canManage: boolean; working: number | null; onOpen: (ticket: SupportMemberTicket) => void; onMove: (ticket: SupportMemberTicket, status: TicketStatus) => void; onClaim: (ticket: SupportMemberTicket) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.key });
  return <section ref={setNodeRef} aria-labelledby={`member-pipeline-${stage.key}`} className={cn("min-h-[480px] rounded-2xl border border-border/60 bg-muted/15 transition", isOver && "border-primary/50 bg-primary/[0.04]")}><header className="sticky top-0 z-10 flex items-center justify-between rounded-t-2xl border-b border-border/50 bg-card/95 px-3 py-3 backdrop-blur"><div className="flex items-center gap-2"><span className={cn("h-2 w-2 rounded-full", stage.tone)} /><h2 id={`member-pipeline-${stage.key}`} className="text-xs font-semibold">{stage.label}</h2></div><Badge variant="outline" className="h-5 min-w-6 justify-center font-mono text-[10px]">{tickets.length}</Badge></header><div className="space-y-2 p-2">{tickets.length === 0 ? <p className="px-3 py-12 text-center text-[11px] text-muted-foreground">Drop a ticket here</p> : tickets.map((ticket) => <PipelineCard key={ticket.id} ticket={ticket} memberId={memberId} canManage={canManage} working={working} onOpen={onOpen} onMove={onMove} onClaim={onClaim} />)}</div></section>;
}

function PipelineCard({ ticket, memberId, canManage, working, onOpen, onMove, onClaim }: { ticket: SupportMemberTicket; memberId: number; canManage: boolean; working: number | null; onOpen: (ticket: SupportMemberTicket) => void; onMove: (ticket: SupportMemberTicket, status: TicketStatus) => void; onClaim: (ticket: SupportMemberTicket) => void }) {
  const canMove = ticket.assignedMemberId === memberId || canManage;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: `ticket-${ticket.id}`, data: { ticket }, disabled: working === ticket.id || !canMove });
  const breached = isSlaBreached(ticket);
  return <article ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform) }} className={cn("rounded-xl border border-border/60 bg-card p-3 shadow-sm transition", isDragging && "z-30 opacity-70 shadow-xl")}><div className="flex items-start justify-between gap-2"><button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(ticket)}><span className="font-mono text-[9px] text-muted-foreground">{ticket.ticketNumber}</span><p className="mt-1 line-clamp-2 text-xs font-semibold leading-5 hover:text-primary">{ticket.subject}</p></button><button type="button" aria-label={canMove ? `Drag ${ticket.ticketNumber}` : `Claim ${ticket.ticketNumber} before moving it`} disabled={!canMove} className="cursor-grab rounded p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-35" {...attributes} {...listeners}><GripVertical className="h-4 w-4" /></button></div><p className="mt-1 truncate text-[10px] text-muted-foreground">{ticket.customerName || "Unlinked customer"} · {ticket.channel}</p><div className="mt-3 flex flex-wrap gap-1"><span className={cn("rounded-md px-1.5 py-0.5 text-[9px]", ticket.handoffId && !ticket.handoffAssignedMemberId ? "bg-warning/10 text-warning" : ticket.ownershipMode === "human_owned" ? "bg-primary/10 text-primary" : "bg-info/10 text-info")}>{supportOwnershipLabel(ticket)}</span><span className={cn("rounded-md bg-muted px-1.5 py-0.5 text-[9px] capitalize", breached && "bg-destructive/10 text-destructive")}>{breached ? "SLA breached" : ticket.priority}</span>{ticket.unreadCount > 0 && <span className="rounded-md bg-destructive px-1.5 py-0.5 text-[9px] text-destructive-foreground">{ticket.unreadCount} unread</span>}</div><div className="mt-3 flex items-center gap-2 border-t border-border/50 pt-2">{ticket.claimable && ticket.assignedMemberId !== memberId ? <Button size="sm" className="h-7 flex-1 gap-1 text-[10px]" loading={working === ticket.id} onClick={() => onClaim(ticket)}><UserCheck className="h-3 w-3" />Claim</Button> : <div className="min-w-0 flex-1"><p className="truncate text-[10px] font-medium">{ticket.assignedMemberName || "Unassigned"}</p><p className={cn("flex items-center gap-1 text-[9px] text-muted-foreground", breached && "text-destructive")}><Clock3 className="h-2.5 w-2.5" />{ticket.slaDeadline ? new Date(ticket.slaDeadline).toLocaleString() : "No SLA"}</p></div>}<select aria-label={`Move ${ticket.ticketNumber} to stage`} value={ticket.status} disabled={working === ticket.id || !canMove} title={canMove ? "Move ticket" : "Claim this ticket before moving it"} onChange={(event) => onMove(ticket, event.target.value as TicketStatus)} className="h-7 max-w-24 rounded-md border border-border/60 bg-background px-1 text-[9px] disabled:cursor-not-allowed disabled:opacity-50">{SUPPORT_MEMBER_PIPELINE_STAGES.map((stage) => <option key={stage.key} value={stage.key}>{stage.label}</option>)}</select></div></article>;
}
