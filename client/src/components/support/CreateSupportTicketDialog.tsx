"use client";
import { useEffect, useState, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useControlledDialogReturnFocus } from "@/hooks/use-controlled-dialog-return-focus";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
interface SupportTicket { id: number; ticketNumber: string }
interface ContactOption { id: number; firstName: string | null; lastName: string | null; email: string | null }
interface TeamOption { id: number; name: string; isActive: boolean }
interface RoutingEstimate { memberId: number | null; active: boolean; unrepliedWorkload: number; estimatedMinutes: number }

export function CreateSupportTicketDialog({ open: createOpen, onOpenChange: setCreateOpen, chatThreadId, onCreated, returnFocusRef }: { open: boolean; onOpenChange: (open:boolean) => void; chatThreadId?: string; onCreated?: () => void; returnFocusRef?: RefObject<HTMLElement | null> }) {
  const router = useRouter();
  const { toast } = useToast();
  const returnFocus = useControlledDialogReturnFocus(createOpen, returnFocusRef);
  const [creating, setCreating] = useState(false);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [contactSearch, setContactSearch] = useState("");
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [routingEstimate, setRoutingEstimate] = useState<RoutingEstimate | null>(null);
  const [routingLoading, setRoutingLoading] = useState(false);
  const [createForm, setCreateForm] = useState({ subject: "", description: "", priority: "medium", category: "support", contactId: "none", teamId: "none" });
  useEffect(() => {
    if (!createOpen) return;
    let active = true;
    const timeout = window.setTimeout(async () => {
      try {
        const query = new URLSearchParams({ limit: "25" }); if (contactSearch.trim()) query.set("search", contactSearch.trim());
        const data = await api.get<{ contacts?: ContactOption[]; items?: ContactOption[] }>(`/api/crm/contacts?${query}`);
        if (active) setContacts(data.contacts || data.items || []);
      } catch { if (active) setContacts([]); }
    }, 250);
    return () => { active = false; window.clearTimeout(timeout); };
  }, [contactSearch, createOpen]);
  useEffect(() => {
    if (!createOpen || createForm.teamId === "none") { setRoutingEstimate(null); return; }
    let active = true; setRoutingLoading(true);
    api.get<RoutingEstimate>(`/api/support/teams/routing-estimate?channel=web&teamId=${createForm.teamId}`)
      .then((value) => { if (active) setRoutingEstimate(value); }).catch(() => { if (active) setRoutingEstimate(null); }).finally(() => { if (active) setRoutingLoading(false); });
    return () => { active = false; };
  }, [createForm.teamId, createOpen]);

  useEffect(() => {
    if (!createOpen) return;
    let active = true; setOptionsLoading(true);
    const loadTeams = async () => {
    try { const data = await api.get<TeamOption[]>("/api/support/teams"); if (active) setTeams((Array.isArray(data) ? data : []).filter((team) => team.isActive)); }
    catch { toast({ title: "Teams are temporarily unavailable", variant: "destructive" }); } finally { if (active) setOptionsLoading(false); }
    };
    void loadTeams();
    return () => { active = false; };
  }, [createOpen, toast]);
  const createTicket = async () => {
    if (!createForm.subject.trim() || creating) return; setCreating(true);
    try {
      const ticket = await api.post<SupportTicket>("/api/support", { ...(chatThreadId ? { chatThreadId: Number(chatThreadId) } : {}), subject: createForm.subject.trim(), description: createForm.description.trim() || undefined, priority: createForm.priority, category: createForm.category, contactId: createForm.contactId === "none" ? undefined : Number(createForm.contactId), teamId: createForm.teamId === "none" ? undefined : Number(createForm.teamId), autoAssign: createForm.teamId !== "none" });
      setCreateOpen(false); setCreateForm({ subject: "", description: "", priority: "medium", category: "support", contactId: "none", teamId: "none" });
      toast({ title: "Ticket created", description: `${ticket.ticketNumber} is ready for triage.` }); onCreated?.(); router.push(`/dashboard/support/${ticket.id}`);
    } catch (error) { toast({ title: "Unable to create ticket", description: error instanceof Error ? error.message : "Review the ticket and try again.", variant: "destructive" }); }
    finally { setCreating(false); }
  };

  return (
    <Dialog open={createOpen} onOpenChange={value => { if (!creating) setCreateOpen(value); }}><DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl" {...returnFocus}><DialogHeader><DialogTitle>Create support ticket</DialogTitle><DialogDescription>{chatThreadId ? "Link the issue to this campaign workspace and choose its customer and support team." : "Capture the customer issue, then route it with a visible response target."}</DialogDescription></DialogHeader><div className="space-y-4 py-2">
      <div className="space-y-1.5"><Label htmlFor="ticket-subject">Subject</Label><Input id="ticket-subject" value={createForm.subject} maxLength={500} onChange={(event) => setCreateForm((form) => ({ ...form, subject: event.target.value }))} placeholder="What does the customer need?" /></div>
      <div className="space-y-1.5"><Label htmlFor="ticket-description">Description</Label><Textarea id="ticket-description" value={createForm.description} maxLength={20_000} rows={4} onChange={(event) => setCreateForm((form) => ({ ...form, description: event.target.value }))} placeholder="Add the context the next responder needs." /></div>
      <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label>Priority</Label><Select value={createForm.priority} onValueChange={(value) => setCreateForm((form) => ({ ...form, priority: value }))}><SelectTrigger aria-label="New ticket priority"><SelectValue /></SelectTrigger><SelectContent>{["low","medium","high","urgent","critical"].map((value) => <SelectItem key={value} value={value} className="capitalize">{value}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1.5"><Label>Category</Label><Select value={createForm.category} onValueChange={(value) => setCreateForm((form) => ({ ...form, category: value }))}><SelectTrigger aria-label="New ticket category"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="support">General support</SelectItem><SelectItem value="billing">Billing</SelectItem><SelectItem value="booking">Booking</SelectItem><SelectItem value="technical">Technical</SelectItem><SelectItem value="account">Account</SelectItem><SelectItem value="complaint">Complaint</SelectItem></SelectContent></Select></div></div>
      <div className="space-y-1.5"><Label htmlFor="contact-search">CRM customer</Label><Input id="contact-search" value={contactSearch} onChange={(event) => setContactSearch(event.target.value)} placeholder="Search contacts by name or email" /><Select value={createForm.contactId} onValueChange={(value) => setCreateForm((form) => ({ ...form, contactId: value }))}><SelectTrigger aria-label="Link CRM customer"><SelectValue placeholder="No linked customer" /></SelectTrigger><SelectContent><SelectItem value="none">No linked customer</SelectItem>{contacts.map((contact) => <SelectItem key={contact.id} value={String(contact.id)}>{[contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email || `Contact ${contact.id}`}{contact.email ? ` · ${contact.email}` : ""}</SelectItem>)}</SelectContent></Select></div>
      <div className="space-y-1.5"><Label>Support team</Label><Select value={createForm.teamId} disabled={optionsLoading} onValueChange={(value) => setCreateForm((form) => ({ ...form, teamId: value }))}><SelectTrigger aria-label="Assign new ticket to support team"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Canonical queue (unassigned)</SelectItem>{teams.map((team) => <SelectItem key={team.id} value={String(team.id)}>{team.name}</SelectItem>)}</SelectContent></Select></div>
      {createForm.teamId !== "none" && <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground">{routingLoading ? <span className="flex items-center gap-2"><Spinner size="xs" label={null} />Calculating live route…</span> : routingEstimate?.active ? <span><strong className="text-foreground">Active responder available.</strong> {routingEstimate.unrepliedWorkload} waiting; projected response in about {routingEstimate.estimatedMinutes} minutes.</span> : <span><strong className="text-foreground">No active responder.</strong> The ticket remains visible in the selected team queue with a {routingEstimate?.estimatedMinutes || "channel"}-minute target.</span>}</div>}
    </div><DialogFooter><Button variant="outline" disabled={creating} onClick={() => setCreateOpen(false)}>Cancel</Button><Button loading={creating} disabled={!createForm.subject.trim()} onClick={() => void createTicket()}>Create and open</Button></DialogFooter></DialogContent></Dialog>
  );
}
