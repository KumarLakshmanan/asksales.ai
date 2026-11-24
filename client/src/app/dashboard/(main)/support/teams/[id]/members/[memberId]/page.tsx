"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, CalendarDays, ChevronRight, Clock3, ContactRound, Eye, EyeOff, Inbox, KeyRound, Power, TicketCheck, UserRoundCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { PageErrorState, PageLoadingState } from "@/components/ui/page-state";
import { SearchInput } from "@/components/ui/search-input";
import { StatusBadge } from "@/components/ui/status-badge";
import { useSupportRealtimeRefresh } from "@/hooks/use-support-realtime-refresh";
import { api } from "@/lib/api";
import { isStrongPassword, PASSWORD_POLICY_MESSAGE } from "@/lib/password-policy";
import { cn } from "@/lib/utils";
import { formatSupportDate, SUPPORT_PIPELINE_STAGES, type SupportOperationsTicket, type SupportTeam } from "@/lib/supportOperations";
import { withReadablePrivacyTokens } from "@/lib/supportQueuePresentation";

type StatusFilter = "all" | SupportOperationsTicket["status"];

export default function SupportMemberTicketsPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const teamId = String(params.id);
  const memberId = String(params.memberId);
  const [team, setTeam] = useState<SupportTeam | null>(null);
  const [tickets, setTickets] = useState<SupportOperationsTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [resetPasswordOpen, setResetPasswordOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [accountUpdating, setAccountUpdating] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactEmail, setContactEmail] = useState("");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [whatsappTouched, setWhatsappTouched] = useState(false);
  const [whatsappConsent, setWhatsappConsent] = useState(false);
  const [contactReadiness, setContactReadiness] = useState<{ emailReady: boolean; emailHint?: string | null; whatsappHint?: string | null } | null>(null);

  const load = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    setLoadError(null);
    try {
      const [nextTeam, nextTickets, notificationSettings] = await Promise.all([
        api.get<SupportTeam>(`/api/support/teams/${teamId}`),
        api.get<SupportOperationsTicket[]>(`/api/support/teams/${teamId}/members/${memberId}/tickets`),
        api.get<{ recipients: Array<{ memberId: number; emailReady: boolean; emailHint?: string | null; whatsappHint?: string | null }> }>("/api/support/notification-settings").catch(() => null),
      ]);
      setTeam(nextTeam);
      setTickets(Array.isArray(nextTickets) ? nextTickets : []);
      setContactReadiness(notificationSettings?.recipients.find((recipient) => String(recipient.memberId) === memberId) || null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load this support member.");
    } finally {
      if (showLoader) setLoading(false);
    }
  }, [memberId, teamId]);

  const refresh = useCallback(() => load(false), [load]);
  useSupportRealtimeRefresh(refresh, 30_000);
  useEffect(() => { void load(); }, [load]);

  const member = team?.members.find((item) => String(item.id) === memberId) || null;
  const visibleTickets = useMemo(() => tickets.filter((ticket) => {
    if (status !== "all" && ticket.status !== status) return false;
    const query = search.trim().toLowerCase();
    return !query || `${ticket.ticketNumber} ${ticket.subject} ${ticket.customerName || ""}`.toLowerCase().includes(query);
  }), [search, status, tickets]);
  const activeTickets = tickets.filter((ticket) => ["open", "in_progress", "waiting_on_customer"].includes(ticket.status)).length;
  const unreadTickets = tickets.filter((ticket) => Number(ticket.operationalUnreadCount ?? ticket.unreadCount ?? 0) > 0).length;
  const resolvedTickets = tickets.filter((ticket) => ticket.status === "resolved" || ticket.status === "closed").length;

  const toggleMemberActive = async () => {
    if (!member) return;
    setAccountUpdating(true);
    try {
      await api.put(`/api/support/teams/${teamId}/members/${memberId}/toggle-active`);
      await load(false);
      toast({ title: member.isActive ? "Member disabled" : "Member activated" });
    } catch (error) {
      toast({ title: "Unable to update member", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setAccountUpdating(false);
    }
  };

  const resetMemberPassword = async () => {
    if (!isStrongPassword(newPassword)) {
      toast({ title: "Strong password required", description: PASSWORD_POLICY_MESSAGE, variant: "destructive" });
      return;
    }
    setAccountUpdating(true);
    try {
      await api.put(`/api/support/teams/${teamId}/members/${memberId}/reset-password`, { newPassword });
      setNewPassword("");
      setShowPassword(false);
      setResetPasswordOpen(false);
      toast({ title: "Password updated", description: "The member can sign in with the new password now." });
    } catch (error) {
      toast({ title: "Unable to update password", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setAccountUpdating(false);
    }
  };

  const openContactEditor = () => {
    if (!member) return;
    setContactEmail(member.email || "");
    setWhatsappNumber("");
    setWhatsappTouched(false);
    setWhatsappConsent(false);
    setContactOpen(true);
  };

  const saveNotificationContact = async () => {
    if (!member) return;
    if (whatsappTouched && !whatsappConsent) {
      toast({ title: "Authorization required", description: "Confirm this member may receive WhatsApp assignment alerts.", variant: "destructive" });
      return;
    }
    setAccountUpdating(true);
    try {
      await api.put(`/api/support/teams/${teamId}/members/${memberId}`, {
        email: contactEmail,
        ...(whatsappTouched ? { whatsappNumber, whatsappConsentAcknowledged: whatsappConsent } : {}),
      });
      setContactOpen(false);
      await load(false);
      toast({ title: "Notification contact updated" });
    } catch (error) {
      toast({ title: "Unable to update contact", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally { setAccountUpdating(false); }
  };

  if (loading) return <PageLoadingState label="Loading member tickets…" />;
  if (loadError) return <PageErrorState title="Member workspace could not be loaded" description={loadError} reset={() => void load()} />;
  if (!team || !member) return <PageErrorState title="Support member not found" description="This member may have been moved or removed." reset={() => router.push("/dashboard/support/teams")} />;

  return <div className="mx-auto max-w-screen-xl space-y-5 p-4 sm:p-5">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Back to team members" onClick={() => router.push("/dashboard/support/teams")}><ArrowLeft className="h-4 w-4" /></Button>
        <div className="relative flex h-11 w-11 items-center justify-center rounded-xl text-sm font-semibold text-white" style={{ backgroundColor: team.color || "#3B82F6" }}>{member.name.charAt(0).toUpperCase()}<span className={cn("absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-background", member.presenceState === "active" ? "bg-success" : "bg-muted-foreground/60")} /></div>
        <div><div className="flex flex-wrap items-center gap-2"><h1 className="text-lg font-semibold">{member.name}</h1><Badge variant="outline" className="text-[10px]">{team.name}</Badge><Badge variant={member.isActive ? "secondary" : "outline"} className="text-[10px]">{member.isActive ? "Enabled" : "Disabled"}</Badge><Badge variant="outline" className="text-[10px]">{member.presenceState === "active" ? "Active now" : "Away"}</Badge>{member.isOnCall && <Badge className="border-0 bg-info/10 text-[10px] text-info">On call</Badge>}</div><p className="text-xs text-muted-foreground">{member.email} · <span className="capitalize">{member.role}</span></p></div>
      </div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" className="gap-1.5" loading={accountUpdating} loadingText={member.isActive ? "Disable member" : "Activate member"} onClick={() => void toggleMemberActive()}><Power className="h-3.5 w-3.5" /> {member.isActive ? "Disable member" : "Activate member"}</Button><Button variant="outline" size="sm" className="gap-1.5" onClick={openContactEditor}><ContactRound className="h-3.5 w-3.5" /> Notification contact</Button><Button variant="outline" size="sm" className="gap-1.5" onClick={() => setResetPasswordOpen(true)}><KeyRound className="h-3.5 w-3.5" /> Reset password</Button><Button variant="outline" size="sm" className="gap-1.5" onClick={() => router.push(`/dashboard/support/teams/${teamId}`)}><UserRoundCheck className="h-3.5 w-3.5" /> Team page</Button><Button size="sm" className="gap-1.5" onClick={() => router.push(`/dashboard/support/teams/${teamId}/members/${memberId}/activity`)}><CalendarDays className="h-3.5 w-3.5" /> Activity history</Button></div>
    </div>

    <div className="grid overflow-hidden rounded-2xl border border-border/60 bg-card sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="All assigned" value={tickets.length} icon={TicketCheck} />
      <Metric label="Active work" value={activeTickets} icon={Clock3} tone="text-warning" />
      <Metric label="Awaiting reply" value={unreadTickets || Number(member.unrepliedWorkload || 0)} icon={Inbox} tone="text-primary" />
      <Metric label="Resolved" value={resolvedTickets} icon={UserRoundCheck} tone="text-success" />
    </div>

    <Card className="overflow-hidden rounded-2xl border-border/60 shadow-none">
      <div className="border-b border-border/50 bg-muted/20 p-4"><div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between"><div><h2 className="text-sm font-semibold">Assigned tickets</h2><p className="mt-0.5 text-xs text-muted-foreground">Every current and historical ticket assigned to {member.name}.</p></div><div className="grid gap-2 sm:grid-cols-[minmax(220px,1fr)_170px]"><SearchInput size="sm" aria-label="Search assigned tickets" value={search} onValueChange={setSearch} placeholder="Search tickets or customers" /><select aria-label="Filter tickets by status" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} className="h-9 rounded-md border border-input bg-background px-3 text-sm"><option value="all">All statuses</option>{SUPPORT_PIPELINE_STAGES.map((stage) => <option key={stage.key} value={stage.key}>{stage.label}</option>)}</select></div></div></div>
      <CardContent className="p-0">{visibleTickets.length === 0 ? <div className="px-5 py-16 text-center"><TicketCheck className="mx-auto mb-3 h-6 w-6 text-muted-foreground/40" /><p className="text-sm font-medium">No assigned tickets found</p><p className="mt-1 text-xs text-muted-foreground">Try another status or search term.</p></div> : <div className="divide-y divide-border/50">{visibleTickets.map((ticket) => { const config = SUPPORT_PIPELINE_STAGES.find((item) => item.key === ticket.status)!; const unread = Number(ticket.operationalUnreadCount ?? ticket.unreadCount ?? 0); return <button key={ticket.id} type="button" className="group grid w-full gap-3 px-4 py-4 text-left transition-colors hover:bg-muted/25 sm:px-5 lg:grid-cols-[minmax(280px,1.4fr)_140px_180px_28px] lg:items-center" onClick={() => router.push(`/dashboard/support/${ticket.id}`)}><div className="min-w-0"><div className="mb-1 flex items-center gap-2"><span className="font-mono text-[10px] text-muted-foreground">{ticket.ticketNumber}</span>{unread > 0 && <Badge className="h-5 border-0 bg-destructive px-1.5 text-[10px] text-destructive-foreground">{unread} new</Badge>}</div><p className="truncate text-sm font-medium group-hover:text-primary">{ticket.subject}</p><p className="mt-1 truncate text-xs text-muted-foreground">{ticket.customerName || "Unknown customer"}{ticket.lastMessagePreview ? ` · ${withReadablePrivacyTokens(ticket.lastMessagePreview)}` : ""}</p></div><StatusBadge status={ticket.status} label={config.label} className="w-fit text-[10px]" /><div className="text-xs"><p className="capitalize">{ticket.priority} priority</p><p className="mt-0.5 text-muted-foreground">Updated {formatSupportDate(ticket.updatedAt)}</p></div><ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-primary" /></button>; })}</div>}</CardContent>
    </Card>

    <Dialog open={resetPasswordOpen} onOpenChange={(open) => { setResetPasswordOpen(open); if (!open) { setNewPassword(""); setShowPassword(false); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Reset member password</DialogTitle><DialogDescription>Set a new sign-in password for {member.name}. Existing sessions remain governed by the current authentication policy.</DialogDescription></DialogHeader>
        <div className="space-y-2 py-2"><Label htmlFor="support-member-new-password">New password</Label><div className="relative"><Input id="support-member-new-password" type={showPassword ? "text" : "password"} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="12+ characters, mixed case, number, symbol" className="pr-10" /><Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1 h-8 w-8" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((current) => !current)}>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button></div><p className="text-xs text-muted-foreground">{PASSWORD_POLICY_MESSAGE}</p></div>
        <DialogFooter><Button variant="outline" onClick={() => setResetPasswordOpen(false)}>Cancel</Button><Button loading={accountUpdating} disabled={!isStrongPassword(newPassword)} onClick={() => void resetMemberPassword()}>Update password</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={contactOpen} onOpenChange={setContactOpen}>
      <DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Notification contact</DialogTitle><DialogDescription>Workspace-wide notification switches use these saved destinations when this member is assigned a ticket.</DialogDescription></DialogHeader><div className="space-y-4 py-2"><div className="space-y-1.5"><Label htmlFor="member-notification-email">Support login email</Label><Input id="member-notification-email" type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} /><p className="text-xs text-muted-foreground">{contactReadiness ? contactReadiness.emailReady ? `Current destination: ${contactReadiness.emailHint}` : "No valid email destination saved." : "Email contact status unavailable."}</p></div><div className="space-y-1.5"><Label htmlFor="member-notification-whatsapp">WhatsApp number with country code</Label><Input id="member-notification-whatsapp" inputMode="tel" value={whatsappNumber} onChange={(event) => { setWhatsappNumber(event.target.value); setWhatsappTouched(true); }} placeholder={contactReadiness?.whatsappHint || "+919876543210"} /><p className="text-xs text-muted-foreground">{contactReadiness?.whatsappHint ? `Saved destination: ${contactReadiness.whatsappHint}. Enter a number only to replace it.` : "No WhatsApp destination saved."}</p>{contactReadiness?.whatsappHint && <Button type="button" variant="ghost" size="sm" className="h-7 px-0 text-xs text-destructive" onClick={() => { setWhatsappNumber(""); setWhatsappTouched(true); setWhatsappConsent(false); }}>Remove saved WhatsApp number</Button>}</div>{whatsappTouched && <label className="flex items-start gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={whatsappConsent} onChange={(event) => setWhatsappConsent(event.target.checked)} className="mt-0.5 h-4 w-4" />I confirm this member is authorized to {whatsappNumber.trim() ? "add or replace" : "remove"} the operational WhatsApp notification contact.</label>}</div><DialogFooter><Button variant="outline" onClick={() => setContactOpen(false)}>Cancel</Button><Button loading={accountUpdating} disabled={!contactEmail.trim()} onClick={() => void saveNotificationContact()}>Save contact</Button></DialogFooter></DialogContent>
    </Dialog>
  </div>;
}

function Metric({ label, value, icon: Icon, tone = "text-primary" }: { label: string; value: number; icon: typeof TicketCheck; tone?: string }) {
  return <div className="border-b border-r border-border/50 p-4 last:border-r-0 xl:border-b-0"><div className="flex items-start justify-between"><div><p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</p><p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{value}</p></div><Icon className={cn("h-4 w-4", tone)} /></div></div>;
}
