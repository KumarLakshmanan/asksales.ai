"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Plus, MoreVertical, Users, Trash2, Edit, UserPlus,
  CheckCircle2, Key, Mail, User, Eye, EyeOff, Save,
  Settings2, ChevronRight, Kanban, SlidersHorizontal
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import api from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { isStrongPassword, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";
import { PageHeader } from "@/components/ui/page-header";
import { PageErrorState, PageLoadingState } from "@/components/ui/page-state";
import { SearchInput } from "@/components/ui/search-input";
import { useSupportRealtimeRefresh } from "@/hooks/use-support-realtime-refresh";
import { useSupportWorkspace } from "@/hooks/use-support-report";
import { BUSINESS_PROFILE_HEADER } from "@/lib/business-profile";
import {
  EMPTY_SUPPORT_MEMBER_NOTIFICATION_ONBOARDING,
  SupportMemberNotificationOnboardingFields,
  type SupportMemberNotificationOnboardingValue,
} from "@/components/support/SupportMemberNotificationOnboardingFields";

import { useDialogReturnFocus } from "@/hooks/use-dialog-return-focus";

interface TeamMember {
  id: number;
  teamId: number;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  isOnCall?: boolean;
  createdAt: string;
  presenceState?: "active" | "away";
  lastSeenAt?: string | null;
  unrepliedWorkload?: number;
  projectedResponseMinutes?: number;
  ticketPipeline?: TicketPipeline;
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
  activeMemberCount?: number;
  unrepliedWorkload?: number;
  ticketPipeline?: TicketPipeline;
}

interface CapacitySettings { handlingMinutesPerTicket: number; socialFallbackSlaMinutes: number; emailFallbackSlaMinutes: number }
function isCapacitySettings(value: unknown): value is CapacitySettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Record<string, unknown>;
  return Object.entries({ handlingMinutesPerTicket: 120, socialFallbackSlaMinutes: 1440, emailFallbackSlaMinutes: 10080 }).every(([field, maximum]) => {
    const minutes = settings[field];
    return typeof minutes === "number" && Number.isInteger(minutes) && minutes >= 1 && minutes <= maximum;
  });
}
interface TicketPipeline { open: number; inProgress: number; waitingOnCustomer: number; resolved: number; closed: number; total: number }

const EMPTY_PIPELINE: TicketPipeline = { open: 0, inProgress: 0, waitingOnCustomer: 0, resolved: 0, closed: 0, total: 0 };
const PIPELINE_STAGES = [
  { key: "open" as const, label: "Open", rail: "bg-info", text: "text-info" },
  { key: "inProgress" as const, label: "Working", rail: "bg-warning", text: "text-warning" },
  { key: "waitingOnCustomer" as const, label: "Waiting", rail: "bg-primary", text: "text-primary" },
  { key: "resolved" as const, label: "Resolved", rail: "bg-success", text: "text-success" },
  { key: "closed" as const, label: "Closed", rail: "bg-muted-foreground/60", text: "text-muted-foreground" },
];

const TEAM_COLORS = [
  { label: "Blue", value: "#3B82F6" },
  { label: "Emerald", value: "#10B981" },
  { label: "Crimson", value: "#EF4444" },
  { label: "Purple", value: "#A855F7" },
  { label: "Amber", value: "#F59E0B" },
  { label: "Rose", value: "#F43F5E" },
  { label: "Teal", value: "#14B8A6" },
  { label: "Slate", value: "#64748B" },
];

export default function SupportTeamsPage() {
  const workspace = useSupportWorkspace();
  if (workspace.profiles.isError) {
    return <PageErrorState title="Support workspace could not be verified" description="Retry loading your business profiles before managing support teams." reset={() => void workspace.profiles.refetch()} />;
  }
  // Loaded without a selected business (should not happen under the dashboard
  // layout, which requires one): offer a retry instead of loading forever.
  if (!workspace.profiles.isLoading && !workspace.profileId) {
    return <PageErrorState title="No business workspace selected" description="Choose a business in the sidebar, or retry loading your business profiles." reset={() => void workspace.profiles.refetch()} />;
  }
  if (!workspace.ready || !workspace.profileId) return <PageLoadingState label="Loading support workspace…" />;
  // Discard drafts and pending dialog sessions together on workspace/actor changes.
  return <SupportTeamsWorkspace key={`${workspace.userId}:${workspace.profileId}`} profileId={workspace.profileId} />;
}

function SupportTeamsWorkspace({ profileId }: { profileId: number }) {
  const { capture: captureCreateFocus, restore: restoreCreateFocus, fallback: createFocusFallback } = useDialogReturnFocus();
  const { toast } = useToast();
  const router = useRouter();
  const requestOptions = useMemo(() => ({ headers: { [BUSINESS_PROFILE_HEADER]: String(profileId) } }), [profileId]);
  const active = useRef(true);
  const teamRead = useRef<{ id: number; controller?: AbortController }>({ id: 0 });
  const capacityRead = useRef<{ id: number; controller?: AbortController }>({ id: 0 });
  const teamSession = useRef(0);
  const memberSession = useRef(0);
  const capacitySession = useRef(0);
  // Lock before the first await, including repeated events before a re-render.
  // Closing/reopening a dialog never releases an outstanding mutation.
  const teamPending = useRef(false);
  const memberPending = useRef(false);
  const capacityPending = useRef(false);
  const hasLoadedTeams = useRef(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showMemberDialog, setShowMemberDialog] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [targetTeamId, setTargetTeamId] = useState<number | null>(null);
  const [teamForm, setTeamForm] = useState({ name: "", description: "", color: "#3B82F6", icon: "" });
  const [memberForm, setMemberForm] = useState({ name: "", email: "", role: "member", password: "" });
  const [memberNotifications, setMemberNotifications] = useState<SupportMemberNotificationOnboardingValue>(
    EMPTY_SUPPORT_MEMBER_NOTIFICATION_ONBOARDING,
  );
  const [showPassword, setShowPassword] = useState(false);
  const [teamToDelete, setTeamToDelete] = useState<Team | null>(null);
  const [deletingTeam, setDeletingTeam] = useState(false);
  const [capacity, setCapacity] = useState<CapacitySettings | null>(null);
  const [loadingCapacity, setLoadingCapacity] = useState(true);
  const [capacityLoadError, setCapacityLoadError] = useState<string | null>(null);
  const [capacitySaveError, setCapacitySaveError] = useState<string | null>(null);
  const [savingCapacity, setSavingCapacity] = useState(false);
  const [savingTeam, setSavingTeam] = useState(false);
  const [addingMember, setAddingMember] = useState(false);
  const [teamSaveError, setTeamSaveError] = useState<string | null>(null);
  const [memberSaveError, setMemberSaveError] = useState<string | null>(null);
  const [teamSearch, setTeamSearch] = useState("");
  const [teamFilter, setTeamFilter] = useState<"all" | "active" | "inactive">("all");
  const [showRoutingDialog, setShowRoutingDialog] = useState(false);

  useEffect(() => {
    active.current = true;
    const teamRequests = teamRead.current;
    const capacityRequests = capacityRead.current;
    return () => {
      active.current = false;
      teamRequests.controller?.abort();
      capacityRequests.controller?.abort();
    };
  }, []);

  const fetchTeams = useCallback(async (showLoader = true) => {
    if (!active.current) return;
    teamRead.current.controller?.abort();
    const controller = new AbortController();
    const id = ++teamRead.current.id;
    teamRead.current.controller = controller;
    const current = () => active.current && teamRead.current.id === id && !controller.signal.aborted;
    if (showLoader) setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<Team[]>("/api/support/teams", { ...requestOptions, signal: controller.signal });
      if (!current()) return;
      setTeams(Array.isArray(data) ? data : []);
      hasLoadedTeams.current = true;
    } catch (error: unknown) {
      if (!current()) return;
      if (!hasLoadedTeams.current) setLoadError(error instanceof Error ? error.message : "Failed to fetch support teams");
      toast({ title: "Error", description: "Failed to fetch support teams", variant: "destructive" });
    } finally {
      if (current()) setLoading(false);
    }
  }, [requestOptions, toast]);

  const loadCapacity = useCallback(async () => {
    capacityRead.current.controller?.abort();
    const controller = new AbortController();
    const id = ++capacityRead.current.id;
    capacityRead.current.controller = controller;
    const current = () => active.current && capacityRead.current.id === id && !controller.signal.aborted;
    setLoadingCapacity(true);
    setCapacityLoadError(null);
    setCapacity(null);
    try {
      const data = await api.get<CapacitySettings>("/api/support/teams/capacity-settings", { ...requestOptions, signal: controller.signal });
      if (!isCapacitySettings(data)) throw new Error("The server returned incomplete or invalid response targets.");
      if (current()) setCapacity(data);
    } catch (error) {
      if (current()) setCapacityLoadError(error instanceof Error ? error.message : "Unable to load response targets.");
    } finally {
      if (current()) setLoadingCapacity(false);
    }
  }, [requestOptions]);

  const refreshTeams = useCallback(() => fetchTeams(false), [fetchTeams]);
  useSupportRealtimeRefresh(refreshTeams, 30_000);

  useEffect(() => {
    void fetchTeams();
    void loadCapacity();
  }, [fetchTeams, loadCapacity]);

  const changeRoutingOpen = (open: boolean) => {
    capacitySession.current++;
    setShowRoutingDialog(open);
    setCapacitySaveError(null);
  };
  const changeTeamOpen = (open: boolean) => {
    teamSession.current++;
    setShowCreateDialog(open);
    setTeamSaveError(null);
    if (!open) setEditingTeam(null);
  };
  const changeMemberOpen = (open: boolean) => {
    memberSession.current++;
    setShowMemberDialog(open);
    setMemberSaveError(null);
    if (!open) setMemberNotifications(EMPTY_SUPPORT_MEMBER_NOTIFICATION_ONBOARDING);
  };

  const saveCapacity = async () => {
    if (!active.current || !showRoutingDialog || !capacity || loadingCapacity || capacityLoadError || capacityPending.current) return;
    const session = capacitySession.current;
    capacityPending.current = true;
    setSavingCapacity(true);
    setCapacitySaveError(null);
    try {
      const saved = await api.put<CapacitySettings>("/api/support/teams/capacity-settings", capacity, requestOptions);
      if (active.current && capacitySession.current === session) {
        setCapacity(saved);
        toast({ title: "Workspace response targets updated" });
        changeRoutingOpen(false);
      }
    } catch (error) {
      if (active.current && capacitySession.current === session) setCapacitySaveError(`${error instanceof Error ? error.message : "Unable to save response targets."} Your changes are still here. Please try again.`);
    } finally {
      capacityPending.current = false;
      if (active.current) setSavingCapacity(false);
    }
  };

  const handleCreateTeam = async () => {
    if (!active.current || !showCreateDialog || teamPending.current) return;
    if (!teamForm.name.trim()) {
      toast({ title: "Error", description: "Team name is required", variant: "destructive" });
      return;
    }
    const session = teamSession.current;
    teamPending.current = true;
    setSavingTeam(true);
    setTeamSaveError(null);
    try {
      const payload = {
        name: teamForm.name.trim(),
        description: teamForm.description.trim(),
        color: teamForm.color,
        ...(teamForm.icon.trim() ? { icon: teamForm.icon.trim() } : {}),
      };
      if (editingTeam) {
        await api.put(`/api/support/teams/${editingTeam.id}`, payload, requestOptions);
      } else {
        await api.post("/api/support/teams", payload, requestOptions);
      }
      if (!active.current) return;
      if (teamSession.current === session) {
        toast({ title: editingTeam ? "Team Updated" : "Team Created", description: editingTeam ? "Changes saved successfully" : "New support team added" });
        changeTeamOpen(false);
        setTeamForm({ name: "", description: "", color: "#3B82F6", icon: "" });
      }
      void fetchTeams(false);
    } catch (error) {
      if (active.current && teamSession.current === session) setTeamSaveError(`${error instanceof Error ? error.message : "Failed to save team."} Your entries are still here. Please try again.`);
    } finally {
      teamPending.current = false;
      if (active.current) setSavingTeam(false);
    }
  };

  const handleDeleteTeam = async () => {
    if (!teamToDelete) return;
    setDeletingTeam(true);
    try {
      await api.delete(`/api/support/teams/${teamToDelete.id}`, requestOptions);
      if (!active.current) return;
      toast({ title: "Team Deleted" });
      setTeamToDelete(null);
      void fetchTeams(false);
    } catch {
      if (active.current) toast({ title: "Error", description: "Failed to delete team", variant: "destructive" });
    } finally {
      if (active.current) setDeletingTeam(false);
    }
  };

  const handleAddMember = async () => {
    if (!active.current || !showMemberDialog || memberPending.current) return;
    if (!memberForm.name || !memberForm.email || !targetTeamId) {
      toast({ title: "Error", description: "Name and email are required", variant: "destructive" });
      return;
    }
    if (!isStrongPassword(memberForm.password)) {
      toast({ title: "Strong password required", description: PASSWORD_POLICY_MESSAGE, variant: "destructive" });
      return;
    }
    const session = memberSession.current;
    memberPending.current = true;
    setAddingMember(true);
    setMemberSaveError(null);
    try {
      await api.post(`/api/support/teams/${targetTeamId}/members`, { ...memberForm, ...memberNotifications }, requestOptions);
      if (!active.current) return;
      if (memberSession.current === session) {
        toast({ title: "Member Added" });
        changeMemberOpen(false);
        setMemberForm({ name: "", email: "", role: "member", password: "" });
        setTargetTeamId(null);
      }
      void fetchTeams(false);
    } catch (error) {
      if (active.current && memberSession.current === session) setMemberSaveError(`${error instanceof Error ? error.message : "Failed to add member."} Your entries are still here. Please try again.`);
    } finally {
      memberPending.current = false;
      if (active.current) setAddingMember(false);
    }
  };

  const openEditDialog = (team: Team) => {
    if (document.activeElement instanceof HTMLElement) captureCreateFocus(document.activeElement);
    setEditingTeam(team);
    setTeamForm({ name: team.name, description: team.description || "", color: team.color || "#3B82F6", icon: team.icon || "" });
    changeTeamOpen(true);
  };

  const openCreateDialog = (opener: HTMLElement) => {
    captureCreateFocus(opener);
    setEditingTeam(null);
    setTeamForm({ name: "", description: "", color: "#3B82F6", icon: "" });
    changeTeamOpen(true);
  };

  const openMemberDialog = (teamId: number) => {
    setTargetTeamId(teamId);
    setMemberForm({ name: "", email: "", role: "member", password: "" });
    setMemberNotifications(EMPTY_SUPPORT_MEMBER_NOTIFICATION_ONBOARDING);
    setShowPassword(false);
    changeMemberOpen(true);
  };

  if (loading) {
    return <PageLoadingState label="Loading support teams…" />;
  }

  if (loadError) {
    return <PageErrorState title="Support teams could not be loaded" description={loadError} reset={() => void fetchTeams()} />;
  }

  const visibleTeams = teams.filter((team) => {
    const query = teamSearch.trim().toLowerCase();
    if (query && !`${team.name} ${team.description || ""}`.toLowerCase().includes(query)) return false;
    if (teamFilter === "active" && !team.isActive) return false;
    if (teamFilter === "inactive" && team.isActive) return false;
    return true;
  });

  return (
    <div className="p-5 space-y-5 max-w-screen-xl mx-auto">
      <PageHeader
        icon={Users}
        title="Support teams"
        subtitle="Manage team membership, routing, and availability"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => router.push("/dashboard/support/notifications")}>
              <Settings2 className="h-3.5 w-3.5" /> Notification settings
            </Button>
            <Button size="sm" className="h-9 gap-1.5"
              onClick={(event) => openCreateDialog(event.currentTarget)}>
              <Plus className="h-3.5 w-3.5" /> Add team
            </Button>
          </div>
        }
      />

      <section aria-labelledby="team-work-title" className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm">
        <div className="border-b border-border/50 bg-muted/20 px-4 py-4 sm:px-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="team-work-title" className="text-sm font-semibold">Teams and assigned tickets</h2>
                <Badge variant="outline" className="h-5 text-[10px]">{visibleTeams.length} shown</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Choose a team to open its member roster and complete ticket worklist.</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-mono text-xl font-semibold tabular-nums">{teams.length}</p>
              <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Teams</p>
            </div>
          </div>
          <div className="mt-4 grid gap-2 md:grid-cols-[minmax(220px,1fr)_170px_auto_auto]">
            <SearchInput size="sm" aria-label="Search support teams" value={teamSearch} onValueChange={setTeamSearch} ref={createFocusFallback} placeholder="Search teams" />
            <select aria-label="Filter support teams by status" value={teamFilter} onChange={(event) => setTeamFilter(event.target.value as "all" | "active" | "inactive")} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
              <option value="all">All teams</option>
              <option value="active">Active teams</option>
              <option value="inactive">Inactive teams</option>
            </select>
            <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => router.push("/dashboard/support/pipeline")}><Kanban className="h-3.5 w-3.5" /> Open pipeline</Button>
            <Button variant="ghost" size="sm" className="h-9 gap-1.5" onClick={() => changeRoutingOpen(true)}><SlidersHorizontal className="h-3.5 w-3.5" /> Routing defaults</Button>
          </div>
        </div>
        {teams.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-5 py-16 text-center">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-muted/50"><Users className="h-4 w-4 text-muted-foreground/40" /></div>
            <p className="mb-1 text-sm font-medium">No support teams found</p>
            <p className="mb-4 max-w-xs text-xs text-muted-foreground">Create a team to start assigning members and tickets.</p>
            <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={(event) => openCreateDialog(event.currentTarget)}><Plus className="h-3.5 w-3.5" /> Create team</Button>
          </div>
        ) : visibleTeams.length === 0 ? <div className="px-5 py-14 text-center text-sm text-muted-foreground">No teams match these filters.</div> : <div className="divide-y divide-border/50">
          {visibleTeams.map((team, index) => {
            const pipeline = team.ticketPipeline || EMPTY_PIPELINE;
            return <motion.article key={team.id} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index, 8) * 0.03 }} className="group grid gap-2 px-4 py-4 transition-colors hover:bg-muted/25 sm:px-5 lg:grid-cols-[minmax(240px,1.1fr)_minmax(360px,1.6fr)_130px_40px] lg:items-center">
              <button type="button" className="col-span-1 grid min-w-0 gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 lg:col-span-3 lg:grid-cols-subgrid lg:items-center" onClick={() => router.push(`/dashboard/support/teams/${team.id}`)} aria-label={`Open ${team.name} team roster and task list`}>
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold text-white" style={{ backgroundColor: team.color || "#3B82F6" }}>{team.name.charAt(0).toUpperCase()}</div>
                  <div className="min-w-0"><div className="flex items-center gap-2"><p className="truncate text-sm font-semibold group-hover:text-primary">{team.name}</p><Badge variant={team.isActive ? "secondary" : "outline"} className="h-5 text-[10px]">{team.isActive ? "Active" : "Inactive"}</Badge></div><p className="truncate text-xs text-muted-foreground">{team.description || "No team description"}</p><p className="mt-1 text-[11px] text-muted-foreground">{team.members.length} member{team.members.length === 1 ? "" : "s"} · {Number(team.activeMemberCount || 0)} active</p></div>
                </div>
                <TeamPipeline pipeline={pipeline} />
                <div className="lg:text-right"><p className="font-mono text-xl font-semibold tabular-nums">{pipeline.total}</p><p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Assigned tickets</p>{Number(team.unrepliedWorkload || 0) > 0 && <p className="mt-1 text-[11px] text-primary">{team.unrepliedWorkload} awaiting reply</p>}</div>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-9 w-9 justify-self-end" aria-label={`Manage ${team.name}`}><MoreVertical className="h-4 w-4" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => router.push(`/dashboard/support/teams/${team.id}`)}><ChevronRight className="mr-2 h-4 w-4" />Open team</DropdownMenuItem><DropdownMenuItem onClick={() => openMemberDialog(team.id)}><UserPlus className="mr-2 h-4 w-4" />Add member</DropdownMenuItem><DropdownMenuItem onClick={() => openEditDialog(team)}><Edit className="mr-2 h-4 w-4" />Edit team</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem className="text-destructive" onClick={() => setTeamToDelete(team)}><Trash2 className="mr-2 h-4 w-4" />Delete team</DropdownMenuItem></DropdownMenuContent>
              </DropdownMenu>
            </motion.article>;
          })}
        </div>}
      </section>

      <Dialog open={showRoutingDialog} onOpenChange={changeRoutingOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Workspace routing defaults</DialogTitle><DialogDescription>Response-time assumptions used for workload and SLA projections.</DialogDescription></DialogHeader>
          <form aria-busy={loadingCapacity || savingCapacity} onSubmit={(event) => { event.preventDefault(); void saveCapacity(); }}>
            {loadingCapacity && <p role="status" className="py-4 text-sm text-muted-foreground">Loading response targets…</p>}
            {capacityLoadError && <div className="space-y-2 py-4"><p role="alert" className="text-sm text-destructive">{capacityLoadError} Saved defaults are unavailable. Retry loading before editing.</p><Button type="button" variant="outline" onClick={() => void loadCapacity()}>Retry loading defaults</Button></div>}
            {capacity && <fieldset disabled={savingCapacity} className="grid gap-4 py-2 sm:grid-cols-3">
              <CapacityField label="Minutes per waiting ticket" value={capacity.handlingMinutesPerTicket} onChange={(value) => setCapacity((current) => current && ({ ...current, handlingMinutesPerTicket: value }))} />
              <CapacityField label="Social fallback" value={capacity.socialFallbackSlaMinutes} onChange={(value) => setCapacity((current) => current && ({ ...current, socialFallbackSlaMinutes: value }))} />
              <CapacityField label="Email fallback" value={capacity.emailFallbackSlaMinutes} onChange={(value) => setCapacity((current) => current && ({ ...current, emailFallbackSlaMinutes: value }))} />
            </fieldset>}
            {capacitySaveError && <p role="alert" className="py-2 text-sm text-destructive">{capacitySaveError}</p>}
            {savingCapacity && <p role="status" className="py-2 text-sm text-muted-foreground">Saving response targets…</p>}
            <DialogFooter><Button type="button" variant="outline" onClick={() => changeRoutingOpen(false)}>Cancel</Button><Button type="submit" disabled={!capacity || loadingCapacity || !!capacityLoadError} loading={savingCapacity} loadingText="Save defaults"><Save aria-hidden="true" className="mr-2 h-4 w-4" />Save defaults</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Create/Edit Team Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={changeTeamOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto border-border p-6 shadow-lg sm:max-w-md" onCloseAutoFocus={restoreCreateFocus}>
          <DialogHeader className="mb-4">
            <DialogTitle className="text-base font-semibold">
              {editingTeam ? "Edit Team" : "Create Team"}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Configure your support team settings.
            </DialogDescription>
          </DialogHeader>
          <form aria-busy={savingTeam} onSubmit={(event) => { event.preventDefault(); void handleCreateTeam(); }}>
          <fieldset disabled={savingTeam} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="support-team-name" className="text-xs font-medium text-muted-foreground">Team name *</Label>
              <Input id="support-team-name" value={teamForm.name} onChange={(e) => setTeamForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Customer Support" className="h-9 rounded-lg text-sm border-border/60" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="support-team-description" className="text-xs font-medium text-muted-foreground">Description</Label>
              <Textarea id="support-team-description" value={teamForm.description} onChange={(e) => setTeamForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Brief description..." rows={2}
                className="rounded-lg text-sm border-border/60 resize-none" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Team Color</Label>
              <div className="flex flex-wrap gap-2">
                {TEAM_COLORS.map((c) => (
                  <button key={c.value} type="button"
                    className={cn(
                      "w-7 h-7 rounded-lg transition-all hover:scale-110 flex items-center justify-center",
                      teamForm.color === c.value ? "ring-2 ring-offset-2 ring-offset-background ring-primary" : ""
                    )}
                    style={{ backgroundColor: c.value }}
                    onClick={() => setTeamForm(f => ({ ...f, color: c.value }))}
                    title={c.label}>
                    {teamForm.color === c.value && <CheckCircle2 className="w-3.5 h-3.5 text-white" />}
                  </button>
                ))}
              </div>
            </div>
          </fieldset>
          {teamSaveError && <p role="alert" className="mt-3 text-sm text-destructive">{teamSaveError}</p>}
          {savingTeam && <p role="status" className="mt-3 text-sm text-muted-foreground">Saving team…</p>}
          <DialogFooter className="mt-5 gap-2">
            <Button type="button" variant="outline" size="sm" className="h-8 rounded-lg text-xs border-border/60"
              onClick={() => changeTeamOpen(false)}>Cancel</Button>
            <Button type="submit" size="sm" className="h-8 rounded-lg text-xs px-5" loading={savingTeam}>
              {editingTeam ? "Save Changes" : "Create Team"}
            </Button>
          </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!teamToDelete} onOpenChange={(open) => { if (!open && !deletingTeam) setTeamToDelete(null); }}>
        <DialogContent className="sm:max-w-sm rounded-2xl border-border/60">
          <DialogHeader>
            <DialogTitle>Delete support team?</DialogTitle>
            <DialogDescription>
              {teamToDelete?.name} will be removed. Existing tickets keep their history and become unassigned from this team.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setTeamToDelete(null)} disabled={deletingTeam}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteTeam} loading={deletingTeam}>
              Delete team
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Member Dialog */}
      <Dialog open={showMemberDialog} onOpenChange={changeMemberOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto border-border p-6 shadow-lg sm:max-w-xl">
          <DialogHeader className="mb-4">
            <DialogTitle className="text-base font-semibold">Add Team Member</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">Add a new member to this team.</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" aria-busy={addingMember} onSubmit={(event) => { event.preventDefault(); void handleAddMember(); }}>
            <fieldset disabled={addingMember} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="support-member-name" className="text-xs font-medium text-muted-foreground">Name *</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40 pointer-events-none" />
                <Input id="support-member-name" name="name" autoComplete="name" value={memberForm.name} onChange={(e) => setMemberForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Member name" className="h-9 pl-9 rounded-lg text-sm border-border/60" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="support-member-email" className="text-xs font-medium text-muted-foreground">Email *</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40 pointer-events-none" />
                <Input id="support-member-email" name="email" autoComplete="email" type="email" value={memberForm.email} onChange={(e) => setMemberForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="member@company.com" className="h-9 pl-9 rounded-lg text-sm border-border/60" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="support-member-password" className="text-xs font-medium text-muted-foreground">Password *</Label>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40 pointer-events-none" />
                <Input id="support-member-password" name="password" autoComplete="new-password" type={showPassword ? "text" : "password"} value={memberForm.password}
                  onChange={(e) => setMemberForm(f => ({ ...f, password: e.target.value }))}
                  placeholder="12+ characters, mixed case, number, symbol" className="h-9 pl-9 pr-9 rounded-lg text-sm border-border/60" />
                <Button type="button" variant="ghost" size="icon" className="absolute right-1 top-0.5 h-8 w-8 rounded-md"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword(!showPassword)}>
                  {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
            <SupportMemberNotificationOnboardingFields value={memberNotifications} onChange={setMemberNotifications} />
            </fieldset>
            {memberSaveError && <p role="alert" className="text-sm text-destructive">{memberSaveError}</p>}
            {addingMember && <p role="status" className="text-sm text-muted-foreground">Adding member…</p>}
            <DialogFooter className="mt-5 gap-2">
              <Button type="button" variant="outline" size="sm" className="h-8 rounded-lg text-xs border-border/60"
                onClick={() => changeMemberOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" className="h-8 rounded-lg text-xs px-5"
                loading={addingMember}
                disabled={!memberForm.name.trim() || !memberForm.email.trim() || !isStrongPassword(memberForm.password)}>
                Add Member
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TeamPipeline({ pipeline }: { pipeline: TicketPipeline }) {
  return (
    <div className="grid grid-cols-5 gap-1" aria-label={`${pipeline.total} ticket${pipeline.total === 1 ? "" : "s"} across the support pipeline`}>
      {PIPELINE_STAGES.map((stage) => (
        <div key={stage.key} className="min-w-0 rounded-lg border border-border/50 bg-background/50 px-2 py-2">
          <div className={cn("mb-1.5 h-0.5 rounded-full", stage.rail)} />
          <p className="truncate text-[9px] font-medium uppercase tracking-wide text-muted-foreground">{stage.label}</p>
          <p className={cn("font-mono text-sm font-semibold tabular-nums", stage.text)}>{pipeline[stage.key]}</p>
        </div>
      ))}
    </div>
  );
}

function CapacityField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <div className="space-y-1.5"><Label className="text-xs text-muted-foreground">{label} (min)</Label><Input aria-label={`${label} in minutes`} type="number" min={1} value={value} className="h-9" onChange={(event) => onChange(Math.max(1, Number(event.target.value) || 1))} /></div>;
}
