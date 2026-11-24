"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  MoreVertical, Users, Trash2, Edit, ArrowLeft,
  UserPlus, Ticket, Clock, ExternalLink, MessageSquare, KeyRound, Power, Eye, EyeOff,
  CircleDot, ListFilter, UserCheck
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/loading-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useRouter, useParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { isStrongPassword, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";
import { useSupportRealtimeRefresh } from "@/hooks/use-support-realtime-refresh";
import {
  EMPTY_SUPPORT_MEMBER_NOTIFICATION_ONBOARDING,
  SupportMemberNotificationOnboardingFields,
  type SupportMemberNotificationOnboardingValue,
} from "@/components/support/SupportMemberNotificationOnboardingFields";
import { SUPPORT_PRIORITY_CLASSES as PRIORITY_COLORS } from "@/lib/support-styles";

interface TeamMember {
  id: number;
  userId: number;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  isOnCall: boolean;
  createdAt: string;
  presenceState?: "active" | "away";
  lastSeenAt?: string | null;
  unrepliedWorkload?: number;
  projectedResponseMinutes?: number;
}

interface Team {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  isActive: boolean;
  members: TeamMember[];
  createdAt: string;
}

interface SupportTicket {
  id: number;
  ticketNumber: string;
  subject: string;
  description: string | null;
  status: string;
  priority: string;
  category: string | null;
  assignedTo: number | null;
  slaDeadline: string | null;
  resolvedAt: string | null;
  totalMessages: number;
  unreadCount: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  customerName?: string;
  assignedMemberName?: string | null;
  lastMessagePreview?: string | null;
  lastMessageAt?: string | null;
}

const STATUS_CONFIG: Record<string, { label: string; rail: string; badge: string }> = {
  open: { label: "Open", rail: "bg-info", badge: "bg-info/10 text-info" },
  in_progress: { label: "In progress", rail: "bg-warning", badge: "bg-warning/10 text-warning" },
  waiting_on_customer: { label: "Waiting on customer", rail: "bg-primary", badge: "bg-primary/10 text-primary" },
  resolved: { label: "Resolved", rail: "bg-success", badge: "bg-success/10 text-success" },
  closed: { label: "Closed", rail: "bg-muted-foreground/60", badge: "bg-muted text-muted-foreground" },
};
type TicketFilter = "all" | "open" | "in_progress" | "waiting_on_customer" | "resolved" | "closed";
const PIPELINE_STAGES: Array<{ key: Exclude<TicketFilter, "all">; label: string }> = [
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In progress" },
  { key: "waiting_on_customer", label: "Waiting" },
  { key: "resolved", label: "Resolved" },
  { key: "closed", label: "Closed" },
];

export default function TeamDetailPage() {
  const { toast } = useToast();
  const router = useRouter();
  const params = useParams();
  const teamId = params.id as string;

  const [team, setTeam] = useState<Team | null>(null);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [showMemberDialog, setShowMemberDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showResetPasswordDialog, setShowResetPasswordDialog] = useState<number | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState("");
  const [showResetPw, setShowResetPw] = useState(false);
  const [memberForm, setMemberForm] = useState({ name: "", email: "", role: "member", password: "" });
  const [memberNotifications, setMemberNotifications] = useState<SupportMemberNotificationOnboardingValue>(
    EMPTY_SUPPORT_MEMBER_NOTIFICATION_ONBOARDING,
  );
  const [editForm, setEditForm] = useState({ name: "", description: "", color: "#3B82F6" });
  const [showMemberPw, setShowMemberPw] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<TeamMember | null>(null);
  const [removingMember, setRemovingMember] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
  const [enabledFilter, setEnabledFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [presenceFilter, setPresenceFilter] = useState<"all" | "active" | "away">("all");
  const [ticketFilter, setTicketFilter] = useState<TicketFilter>("all");

  const fetchTeam = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    try {
      const data = await api.get<Team>(`/api/support/teams/${teamId}`);
      setTeam(data);
      setEditForm({ name: data.name, description: data.description || "", color: data.color || "#3B82F6" });
    } catch {
      toast({ title: "Error", description: "Failed to fetch team", variant: "destructive" });
    } finally {
      if (showLoader) setLoading(false);
    }
  }, [teamId, toast]);

  const fetchTeamTickets = useCallback(async (showLoader = true) => {
    if (showLoader) setTicketsLoading(true);
    try {
      const data = await api.get<SupportTicket[]>(`/api/support/teams/${teamId}/tickets`);
      setTickets(Array.isArray(data) ? data : []);
    } catch {
      toast({ title: "Error", description: "Failed to fetch tickets", variant: "destructive" });
    } finally {
      if (showLoader) setTicketsLoading(false);
    }
  }, [teamId, toast]);

  useEffect(() => { fetchTeam(); fetchTeamTickets(); }, [fetchTeam, fetchTeamTickets]);

  const refreshTeamWorkspace = useCallback(async () => {
    await Promise.all([fetchTeam(false), fetchTeamTickets(false)]);
  }, [fetchTeam, fetchTeamTickets]);
  useSupportRealtimeRefresh(refreshTeamWorkspace, 30_000);

  const handleAddMember = async () => {
    if (!memberForm.name.trim() || !memberForm.email.trim()) {
      toast({ title: "Error", description: "Name and email required", variant: "destructive" });
      return;
    }
    if (!isStrongPassword(memberForm.password)) {
      toast({ title: "Strong password required", description: PASSWORD_POLICY_MESSAGE, variant: "destructive" });
      return;
    }
    try {
      await api.post(`/api/support/teams/${teamId}/members`, { ...memberForm, ...memberNotifications });
      toast({ title: "Member added" });
      setShowMemberDialog(false);
      setMemberForm({ name: "", email: "", role: "member", password: "" });
      setMemberNotifications(EMPTY_SUPPORT_MEMBER_NOTIFICATION_ONBOARDING);
      fetchTeam();
    } catch {
      toast({ title: "Error", description: "Failed to add member", variant: "destructive" });
    }
  };

  const handleResetMemberPassword = async () => {
    if (!showResetPasswordDialog) return;
    if (!isStrongPassword(resetPasswordValue)) {
      toast({ title: "Strong password required", description: PASSWORD_POLICY_MESSAGE, variant: "destructive" });
      return;
    }
    try {
      await api.put(`/api/support/teams/${teamId}/members/${showResetPasswordDialog}/reset-password`, { newPassword: resetPasswordValue });
      toast({ title: "Password reset" });
      setShowResetPasswordDialog(null);
      setResetPasswordValue("");
    } catch {
      toast({ title: "Error", description: "Failed to reset password", variant: "destructive" });
    }
  };

  const handleToggleMemberActive = async (memberId: number) => {
    try {
      await api.put(`/api/support/teams/${teamId}/members/${memberId}/toggle-active`);
      toast({ title: "Member status toggled" });
      fetchTeam();
    } catch {
      toast({ title: "Error", description: "Failed to toggle status", variant: "destructive" });
    }
  };

  const handleMemberRole = async (memberId: number, role: "member" | "lead" | "admin") => {
    try {
      await api.put(`/api/support/teams/${teamId}/members/${memberId}`, { role });
      toast({ title: "Member role updated" });
      await fetchTeam();
    } catch (error) {
      toast({
        title: "Unable to update role",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };
  const handleOnCall = async (member: TeamMember) => {
    try { await api.put(`/api/support/teams/${teamId}/members/${member.id}`, { isOnCall: !member.isOnCall });
      toast({ title: member.isOnCall ? "Removed from on-call" : "Added to on-call" }); await fetchTeam(); }
    catch (error) { toast({ title: "Unable to update on-call status", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" }); }
  };

  const handleRemoveMember = async () => {
    if (!memberToRemove) return;
    setRemovingMember(true);
    try {
      await api.delete(`/api/support/teams/${teamId}/members/${memberToRemove.id}`);
      toast({ title: "Member removed" });
      setMemberToRemove(null);
      fetchTeam();
    } catch {
      toast({ title: "Error", description: "Failed to remove member", variant: "destructive" });
    } finally {
      setRemovingMember(false);
    }
  };

  const handleUpdateTeam = async () => {
    try {
      await api.put(`/api/support/teams/${teamId}`, editForm);
      toast({ title: "Team updated" });
      setShowEditDialog(false);
      fetchTeam();
    } catch {
      toast({ title: "Error", description: "Failed to update team", variant: "destructive" });
    }
  };

  const filteredMembers = (team?.members || []).filter((member) => {
    const query = memberSearch.trim().toLowerCase();
    if (query && !`${member.name} ${member.email}`.toLowerCase().includes(query)) return false;
    if (enabledFilter !== "all" && (member.isActive ? "enabled" : "disabled") !== enabledFilter) return false;
    if (presenceFilter !== "all" && (member.presenceState || "away") !== presenceFilter) return false;
    return true;
  });
  const openTicket = (id: number) => router.push(`/dashboard/support/${id}`);

  if (loading) {
    return <LoadingState size="section" label="Loading support team…" />;
  }
  if (!team) {
    return (
      <div className="p-5">
        <p className="text-sm text-muted-foreground mb-3">Team not found</p>
        <Button variant="outline" size="sm" className="h-8 text-xs rounded-lg gap-1.5"
          onClick={() => router.push("/dashboard/support/teams")}>
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Teams
        </Button>
      </div>
    );
  }

  const ticketStats = {
    total: tickets.length,
    open: tickets.filter(t => t.status === "open").length,
    inProgress: tickets.filter(t => t.status === "in_progress").length,
    waitingOnCustomer: tickets.filter(t => t.status === "waiting_on_customer").length,
    resolved: tickets.filter(t => t.status === "resolved").length,
    closed: tickets.filter(t => t.status === "closed").length,
  };
  const ticketCountByStatus: Record<Exclude<TicketFilter, "all">, number> = {
    open: ticketStats.open,
    in_progress: ticketStats.inProgress,
    waiting_on_customer: ticketStats.waitingOnCustomer,
    resolved: ticketStats.resolved,
    closed: ticketStats.closed,
  };
  const visibleTickets = ticketFilter === "all" ? tickets : tickets.filter((ticket) => ticket.status === ticketFilter);
  const worklistLoading = ticketsLoading;

  return (
    <div className="p-5 space-y-5 max-w-screen-xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg shrink-0"
            onClick={() => router.push("/dashboard/support/teams")} aria-label="Back to support teams">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center text-white text-sm font-bold shrink-0"
            style={{ backgroundColor: team.color || "#3B82F6" }}
          >
            {team.name.charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <h1 className="text-base font-semibold">{team.name}</h1>
              <Badge className={cn(
                "text-xs font-medium px-1.5 py-0.5 h-auto rounded-md border-none",
                team.isActive ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"
              )}>
                {team.isActive ? "Active" : "Inactive"}
              </Badge>
            </div>
            {team.description && <p className="text-xs text-muted-foreground">{team.description}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 text-xs rounded-lg border-border/60 gap-1.5"
            onClick={() => setShowEditDialog(true)}>
            <Edit className="h-3.5 w-3.5" /> Edit
          </Button>
          <Button size="sm" className="h-8 text-xs rounded-lg gap-1.5"
            onClick={() => setShowMemberDialog(true)}>
            <UserPlus className="h-3.5 w-3.5" /> Add Member
          </Button>
        </div>
      </div>

      <section aria-labelledby="queue-pipeline-title" className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm">
        <div className="flex flex-col gap-3 border-b border-border/50 bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <CircleDot className="h-4 w-4 text-primary" />
              <h2 id="queue-pipeline-title" className="text-sm font-semibold">Queue pipeline</h2>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">Filter the worklist by its current support stage.</p>
          </div>
          <button type="button" onClick={() => setTicketFilter("all")}
            className={cn("rounded-lg border px-3 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50", ticketFilter === "all" ? "border-primary/50 bg-primary/10 text-primary" : "border-border/60 bg-background hover:bg-muted/40")}>
            <span className="block text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground">All tickets</span>
            <span className="font-mono text-base font-semibold tabular-nums">{ticketStats.total}</span>
          </button>
        </div>
        <div className="grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-5">
          {PIPELINE_STAGES.map((stage) => {
            const config = STATUS_CONFIG[stage.key];
            const active = ticketFilter === stage.key;
            return (
              <button key={stage.key} type="button" onClick={() => setTicketFilter(stage.key)} aria-pressed={active}
                className={cn("relative bg-card px-3 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50", active && "bg-muted/50")}>
                <span className={cn("absolute inset-x-3 top-0 h-0.5 rounded-full", config.rail, !active && "opacity-60")} />
                <span className="block truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{stage.label}</span>
                <span className={cn("font-mono text-xl font-semibold tabular-nums", active && config.badge.split(" ").find((name) => name.startsWith("text-")))}>{ticketCountByStatus[stage.key]}</span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Card className="overflow-hidden rounded-2xl border-border/60 shadow-none xl:col-span-4">
          <div className="flex items-center justify-between border-b border-border/50 bg-muted/20 px-4 py-3">
            <div>
              <p className="text-sm font-semibold">Team roster</p>
              <p className="text-xs text-muted-foreground">{team.members.filter((member) => member.presenceState === "active").length} active of {team.members.length} members</p>
            </div>
            <UserCheck className="h-4 w-4 text-primary" />
          </div>
          <CardContent className="space-y-3 p-3">
            <div className="space-y-2 rounded-xl border border-border/50 bg-muted/10 p-2">
              <Input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="Search members" aria-label="Search team members" className="h-8 text-xs" />
              <div className="grid grid-cols-2 gap-2">
                <select aria-label="Enabled state" value={enabledFilter} onChange={(event) => setEnabledFilter(event.target.value as typeof enabledFilter)} className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                  <option value="all">All access</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option>
                </select>
                <select aria-label="Presence state" value={presenceFilter} onChange={(event) => setPresenceFilter(event.target.value as typeof presenceFilter)} className="h-8 rounded-md border border-input bg-background px-2 text-xs">
                  <option value="all">All presence</option><option value="active">Active</option><option value="away">Away</option>
                </select>
              </div>
            </div>
            {team.members.length === 0 ? (
              <div className="flex min-h-44 flex-col items-center justify-center rounded-xl border border-dashed border-border/60 px-4 text-center">
                <Users className="mb-2 h-5 w-5 text-muted-foreground/40" />
                <p className="text-sm font-medium">No members yet</p>
                <p className="mt-1 text-xs text-muted-foreground">Add a member to start assigning team tickets.</p>
                <Button variant="outline" size="sm" className="mt-3 h-8 gap-1.5 text-xs" onClick={() => setShowMemberDialog(true)}><UserPlus className="h-3.5 w-3.5" /> Add member</Button>
              </div>
            ) : filteredMembers.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/60 px-4 py-8 text-center text-xs text-muted-foreground">No members match these filters.</div>
            ) : (
              <div className="space-y-2">
                {filteredMembers.map((member) => (
                  <div key={member.id} role="button" tabIndex={0} aria-label={`Open ${member.name} assigned tickets`}
                    onClick={() => router.push(`/dashboard/support/teams/${teamId}/members/${member.id}`)}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); router.push(`/dashboard/support/teams/${teamId}/members/${member.id}`); } }}
                    className="group rounded-xl border border-border/50 p-3 transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
                    <div className="flex items-start gap-3">
                      <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-semibold text-primary">
                        {(member.name || "?").charAt(0).toUpperCase()}
                        <span className={cn("absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card", member.presenceState === "active" ? "bg-success" : "bg-muted-foreground/60")} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-xs font-semibold">{member.name || "Unnamed"}</p>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" aria-label={`Manage ${member.name}`} onClick={(event) => event.stopPropagation()}><MoreVertical className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44 rounded-xl border-border/60 p-1">
                              <DropdownMenuItem className="text-xs" onClick={(event) => { event.stopPropagation(); void handleOnCall(member); }}>{member.isOnCall ? "Remove from on-call" : "Set as on-call"}</DropdownMenuItem>
                              <DropdownMenuItem className="text-xs" onClick={(event) => { event.stopPropagation(); setShowResetPasswordDialog(member.id); setResetPasswordValue(""); }}><KeyRound className="mr-2 h-3.5 w-3.5" /> Reset password</DropdownMenuItem>
                              {member.role !== "member" && <DropdownMenuItem className="text-xs" onClick={(event) => { event.stopPropagation(); void handleMemberRole(member.id, "member"); }}>Set role: Member</DropdownMenuItem>}
                              {member.role !== "lead" && <DropdownMenuItem className="text-xs" onClick={(event) => { event.stopPropagation(); void handleMemberRole(member.id, "lead"); }}>Set role: Lead</DropdownMenuItem>}
                              {member.role !== "admin" && <DropdownMenuItem className="text-xs" onClick={(event) => { event.stopPropagation(); void handleMemberRole(member.id, "admin"); }}>Set role: Admin</DropdownMenuItem>}
                              <DropdownMenuItem className="text-xs" onClick={(event) => { event.stopPropagation(); void handleToggleMemberActive(member.id); }}><Power className="mr-2 h-3.5 w-3.5" /> {member.isActive === false ? "Activate" : "Disable"}</DropdownMenuItem>
                              <DropdownMenuItem className="text-xs text-destructive" onClick={(event) => { event.stopPropagation(); setMemberToRemove(member); }}><Trash2 className="mr-2 h-3.5 w-3.5" /> Remove</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        <p className="truncate text-[11px] text-muted-foreground">{member.email}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                          <Badge variant="outline" className="h-5 px-1.5 capitalize">{member.role}</Badge>
                          <Badge variant={member.isActive ? "secondary" : "outline"} className="h-5 px-1.5">{member.isActive ? "Enabled" : "Disabled"}</Badge>
                          {member.isOnCall && <Badge variant="secondary" className="h-5 px-1.5">On call</Badge>}
                          <span className="ml-auto text-muted-foreground">{member.unrepliedWorkload || 0} waiting</span>
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border/40 pt-3">
                      <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-[11px]" onClick={(event) => { event.stopPropagation(); void handleToggleMemberActive(member.id); }}><Power className="h-3 w-3" />{member.isActive ? "Disable" : "Activate"}</Button>
                      <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-[11px]" onClick={(event) => { event.stopPropagation(); setShowResetPasswordDialog(member.id); setResetPasswordValue(""); }}><KeyRound className="h-3 w-3" />Reset password</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden rounded-2xl border-border/60 shadow-none xl:col-span-8">
          <div className="flex flex-col gap-3 border-b border-border/50 bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2"><ListFilter className="h-4 w-4 text-primary" /><p className="text-sm font-semibold">Team task list</p></div>
              <p className="mt-0.5 text-xs text-muted-foreground">{visibleTickets.length} shown · {ticketFilter === "all" ? "all pipeline stages" : STATUS_CONFIG[ticketFilter]?.label}</p>
            </div>
          </div>
          <CardContent className="p-3">
            {worklistLoading ? (
              <LoadingState size="section" label="Loading team tickets…" className="min-h-52" />
            ) : visibleTickets.length === 0 ? (
              <div className="flex min-h-52 flex-col items-center justify-center rounded-xl border border-dashed border-border/60 px-5 text-center">
                <Ticket className="mb-2 h-5 w-5 text-muted-foreground/40" />
                <p className="text-sm font-medium">No {ticketFilter === "all" ? "tickets" : STATUS_CONFIG[ticketFilter]?.label.toLowerCase()} in this view</p>
                <p className="mt-1 text-xs text-muted-foreground">Tickets assigned to this team will appear here.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                {visibleTickets.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} onClick={() => openTicket(ticket.id)} />)}
              </div>
            )}
          </CardContent>
        </Card>
      </div>


      {/* Add Member Dialog */}
      <Dialog open={showMemberDialog} onOpenChange={(open) => {
        setShowMemberDialog(open);
        if (!open) setMemberNotifications(EMPTY_SUPPORT_MEMBER_NOTIFICATION_ONBOARDING);
      }}>
        <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto border-border p-6 shadow-lg">
          <DialogHeader className="mb-4">
            <DialogTitle className="text-base font-semibold">Add Team Member</DialogTitle>
          </DialogHeader>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void handleAddMember(); }}>
            <div className="space-y-1.5">
              <Label htmlFor="new-member-name" className="text-xs font-medium text-muted-foreground">Name *</Label>
              <Input id="new-member-name" name="name" autoComplete="name" value={memberForm.name} onChange={(e) => setMemberForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Member name" className="h-9 rounded-lg text-sm border-border/60" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-member-email" className="text-xs font-medium text-muted-foreground">Email *</Label>
              <Input id="new-member-email" name="email" autoComplete="email" type="email" value={memberForm.email} onChange={(e) => setMemberForm(f => ({ ...f, email: e.target.value }))}
                placeholder="member@company.com" className="h-9 rounded-lg text-sm border-border/60" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-member-password" className="text-xs font-medium text-muted-foreground">Password *</Label>
              <div className="relative">
                <Input id="new-member-password" name="password" autoComplete="new-password" type={showMemberPw ? "text" : "password"} value={memberForm.password}
                  onChange={(e) => setMemberForm(f => ({ ...f, password: e.target.value }))}
                  placeholder="12+ characters, mixed case, number, symbol" className="h-9 pr-9 rounded-lg text-sm border-border/60" />
                <Button type="button" variant="ghost" size="icon" className="absolute right-0.5 top-0.5 h-8 w-8 rounded-md"
                  aria-label={showMemberPw ? "Hide password" : "Show password"}
                  onClick={() => setShowMemberPw(!showMemberPw)}>
                  {showMemberPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
            <SupportMemberNotificationOnboardingFields value={memberNotifications} onChange={setMemberNotifications} />
            <DialogFooter className="mt-5 gap-2">
              <Button type="button" variant="outline" size="sm" className="h-8 rounded-lg text-xs border-border/60"
                onClick={() => setShowMemberDialog(false)}>Cancel</Button>
              <Button type="submit" size="sm" className="h-8 rounded-lg text-xs px-5"
                disabled={!memberForm.name.trim() || !memberForm.email.trim() || !isStrongPassword(memberForm.password)}>Add Member</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!memberToRemove} onOpenChange={(open) => { if (!open && !removingMember) setMemberToRemove(null); }}>
        <DialogContent className="max-w-sm rounded-2xl border-border/60">
          <DialogHeader>
            <DialogTitle>Remove support member?</DialogTitle>
            <DialogDescription>
              {memberToRemove?.name} will lose portal access. Their existing tickets will remain in the team queue.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setMemberToRemove(null)} disabled={removingMember}>Cancel</Button>
            <Button variant="destructive" onClick={handleRemoveMember} loading={removingMember}>
              Remove member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Dialog */}
      <Dialog open={!!showResetPasswordDialog} onOpenChange={(open) => { if (!open) { setShowResetPasswordDialog(null); setResetPasswordValue(""); } }}>
        <DialogContent className="max-w-sm border-border p-6 shadow-lg">
          <DialogHeader className="mb-4">
            <DialogTitle className="text-base font-semibold">Reset Password</DialogTitle>
          </DialogHeader>
          <form className="space-y-1.5" onSubmit={(event) => { event.preventDefault(); void handleResetMemberPassword(); }}>
            <Label htmlFor="reset-member-password" className="text-xs font-medium text-muted-foreground">New Password *</Label>
            <div className="relative">
              <Input id="reset-member-password" name="password" autoComplete="new-password" type={showResetPw ? "text" : "password"} value={resetPasswordValue}
                onChange={(e) => setResetPasswordValue(e.target.value)}
                placeholder="12+ characters, mixed case, number, symbol" className="h-9 pr-9 rounded-lg text-sm border-border/60" />
              <Button type="button" variant="ghost" size="icon" className="absolute right-0.5 top-0.5 h-8 w-8 rounded-md"
                aria-label={showResetPw ? "Hide password" : "Show password"}
                onClick={() => setShowResetPw(!showResetPw)}>
                {showResetPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <DialogFooter className="mt-5 gap-2">
              <Button type="button" variant="outline" size="sm" className="h-8 rounded-lg text-xs border-border/60"
                onClick={() => { setShowResetPasswordDialog(null); setResetPasswordValue(""); }}>Cancel</Button>
              <Button type="submit" size="sm" className="h-8 rounded-lg text-xs px-5"
                disabled={!isStrongPassword(resetPasswordValue)}>Reset</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Team Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-sm border-border p-6 shadow-lg">
          <DialogHeader className="mb-4">
            <DialogTitle className="text-base font-semibold">Edit Team</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-team-name" className="text-xs font-medium text-muted-foreground">Team Name</Label>
              <Input id="edit-team-name" value={editForm.name} onChange={(e) => setEditForm(f => ({ ...f, name: e.target.value }))}
                className="h-9 rounded-lg text-sm border-border/60" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-team-description" className="text-xs font-medium text-muted-foreground">Description</Label>
              <Input id="edit-team-description" value={editForm.description} onChange={(e) => setEditForm(f => ({ ...f, description: e.target.value }))}
                className="h-9 rounded-lg text-sm border-border/60" />
            </div>
          </div>
          <DialogFooter className="mt-5 gap-2">
            <Button variant="outline" size="sm" className="h-8 rounded-lg text-xs border-border/60"
              onClick={() => setShowEditDialog(false)}>Cancel</Button>
            <Button size="sm" className="h-8 rounded-lg text-xs px-5" onClick={handleUpdateTeam}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatRelativeTime(value: string) {
  const milliseconds = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) return "—";
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function TicketCard({ ticket, onClick }: { ticket: SupportTicket; onClick: () => void }) {
  const status = STATUS_CONFIG[ticket.status] || { label: ticket.status.replaceAll("_", " "), rail: "bg-muted-foreground/60", badge: "bg-muted text-muted-foreground" };
  return (
    <Card
      role="button"
      tabIndex={0}
      className="group cursor-pointer overflow-hidden rounded-xl border border-border/50 bg-card transition-all hover:border-border hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      onClick={onClick}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); } }}
    >
      <div className={cn("h-0.5 w-full", status.rail)} />
      <CardContent className="p-3">
        <div className="mb-1.5 flex items-center justify-between gap-1.5">
          <span className="text-xs text-muted-foreground font-mono">{ticket.ticketNumber}</span>
          <Badge className={cn("h-auto rounded-md border-none px-1.5 py-0.5 text-[10px] font-medium capitalize", PRIORITY_COLORS[ticket.priority] || "")}>
            {ticket.priority}
          </Badge>
        </div>
        <h4 className="mb-1 line-clamp-2 text-xs font-medium leading-relaxed text-foreground/90 transition-colors group-hover:text-primary">
          {ticket.subject}
        </h4>
        <p className="mb-2 truncate text-[10px] text-muted-foreground">{ticket.customerName || ticket.assignedMemberName || "Unassigned customer"}</p>
        <div className="mb-2 flex items-center justify-between gap-2">
          <StatusBadge status={ticket.status} label={status.label} className="px-1.5 text-[10px]" />
          <span className="truncate text-[10px] text-muted-foreground">{ticket.assignedMemberName || "No assignee"}</span>
        </div>
        <div className="flex items-center justify-between border-t border-border/40 pt-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatRelativeTime(ticket.lastMessageAt || ticket.updatedAt || ticket.createdAt)}
            </span>
            {ticket.totalMessages > 0 && (
              <span className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3" />{ticket.totalMessages}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {ticket.unreadCount > 0 && <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />}
            <ExternalLink className="h-3 w-3 opacity-30 group-hover:opacity-70 transition-opacity" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
