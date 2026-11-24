"use client";
import { RelatedProposals } from "@/components/proposals/RelatedProposals";

import React, { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  ArrowLeft, Clock, MessageSquare, AlertCircle, CheckCircle2,
  User, ShieldCheck, Calendar, Hash, Star, Archive, Send, LockKeyhole,
  Paperclip, X, FileText, Bot, Radio, Globe2, Users, RotateCcw, ShieldAlert
} from "lucide-react";
import { api } from "@/lib/api";
import { sendSupportReply } from "@/lib/support-reply-intent";
import { useSupportReplyScope } from "@/hooks/use-support-reply-scope";
import { selectedBusinessProfileId, subscribeBusinessProfile } from "@/lib/business-profile";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useSupportRealtimeRefresh } from "@/hooks/use-support-realtime-refresh";
import { SUPPORT_AI_READINESS_NOTICE, supportHandoffDescription, supportOwnershipLabel } from "@/lib/supportTicketWorkspace";

interface Ticket {
  id: number;
  ticketNumber: string;
  subject: string;
  description: string | null;
  status: string;
  priority: string;
  category: string | null;
  contactId: number | null;
  teamId: number | null;
  assignedMemberId: number | null;
  slaDeadline: string | null;
  tags: string[];
  totalMessages: number;
  closedAt: string | null;
  reviewRequestSentAt: string | null;
  rating: number | null;
  reviewComment: string | null;
  reviewSubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  customerName: string;
  customerEmail: string | null;
  channel: string;
  conversationId: number | null;
  teamName: string | null;
  assignedMemberName: string | null;
  assignedMemberPresent: boolean;
  ownershipMode: string;
  handoffId: number | null;
  handoffAssignedMemberId: number | null;
  handoffStatus: string | null;
  handoffReason: string | null;
  handoffTriggerType: string | null;
  handoffConfidenceScore: number | null;
  handoffSlaDeadline: string | null;
  aiReplyEnabled: boolean;
  aiPausedAt: string | null;
  aiPausedBy: number | null;
  deliveryStatus: string | null;
  deliveryError: string | null;
  providerMessageId: string | null;
  metadata?: {
    ownershipResolution?: {
      handoffId: number;
      supportTicketId: number | null;
      resolution: string;
      outcome: "human_retained" | "ai_resumed" | "closed";
      resumeAi: boolean;
      resolvedBy: number | null;
      resolvedAt: string;
    };
  };
  latestTicketAutomation: {
    id: number;
    disposition: "read_only_ai" | "human_queue";
    replyText: string | null;
    deliveryStatus: string | null;
    providerMessageId: string | null;
    createdAt: string | null;
    verified: boolean;
    ownershipResumed: boolean;
  } | null;
}

interface SupportTeam {
  id: number;
  name: string;
  isActive: boolean;
  members: Array<{ id: number; name: string | null; email: string | null; isActive: boolean }>;
}

interface TicketMessage {
  restricted?: boolean;
  key?: string;
  id: number;
  source?: "conversation" | "support_chat" | "ticket" | "handoff";
  type?: "customer" | "agent" | "internal_note" | "system";
  direction: string;
  content: string;
  isInternal: boolean;
  attachments?: Array<{ fileId: number; name: string; url: string; type: string }>;
  createdAt: string;
  actorName: string | null;
  actorEmail: string | null;
  deliveryStatus: string | null;
  providerMessageId: string | null;
  deliveryError: string | null;
  deliveryAttemptCount: number;
}

const STATUS_CONFIG: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  open: { label: "Open", icon: AlertCircle },
  in_progress: { label: "In Progress", icon: Clock },
  waiting_on_customer: { label: "Waiting on Customer", icon: Clock },
  resolved: { label: "Resolved", icon: CheckCircle2 },
  closed: { label: "Closed", icon: Archive },
};

const PRIORITY_CONFIG: Record<string, { label: string; bg: string; color: string }> = {
  low: { label: "Low", bg: "bg-muted", color: "text-muted-foreground" },
  medium: { label: "Medium", bg: "bg-warning/10", color: "text-warning" },
  high: { label: "High", bg: "bg-info/10", color: "text-info" },
  urgent: { label: "Urgent", bg: "bg-destructive/10", color: "text-destructive" },
  critical: { label: "Critical", bg: "bg-destructive/10", color: "text-destructive" },
};

function toLocalDateTimeInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetAdjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return offsetAdjusted.toISOString().slice(0, 16);
}

function getSlaSnapshot(ticket: Ticket) {
  const deadline = ticket.handoffSlaDeadline || ticket.slaDeadline;
  if (!deadline || ["resolved", "closed"].includes(ticket.status)) return { label: "No active SLA", tone: "text-muted-foreground", detail: "No open response target" };
  const remaining = new Date(deadline).getTime() - Date.now();
  if (remaining < 0) return { label: "SLA breached", tone: "text-destructive", detail: `${Math.max(1, Math.ceil(Math.abs(remaining) / 60_000))} min overdue` };
  if (remaining <= 30 * 60_000) return { label: "SLA at risk", tone: "text-warning", detail: `${Math.max(1, Math.ceil(remaining / 60_000))} min remaining` };
  return { label: "SLA on track", tone: "text-success", detail: `${Math.max(1, Math.ceil(remaining / 60_000))} min remaining` };
}

function replyBusinessProfileSnapshot(): number | null {
  try { return selectedBusinessProfileId(); } catch { return null; }
}

export default function TicketDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const ticketId = params.id as string;
  const messagesEnd = useRef<HTMLDivElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);

  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [ticketLoadError, setTicketLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [messagesRefreshing, setMessagesRefreshing] = useState(false);
  const messagesRequest = useRef(0);
  useEffect(() => () => { messagesRequest.current++; }, [ticketId]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();
  const selectedReplyBusiness = useSyncExternalStore(subscribeBusinessProfile, replyBusinessProfileSnapshot, () => null);
  const replyScope = user ? JSON.stringify(["owner", user.id, selectedReplyBusiness ?? user.businessProfileId, ticketId]) : null;
  const isReplyScopeCurrent = useSupportReplyScope(replyScope);
  const [reply, setReply] = useState("");
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [sendingReply, setSendingReply] = useState(false);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [teams, setTeams] = useState<SupportTeam[]>([]);
  const [tagsInput, setTagsInput] = useState("");
  const [savingDetails, setSavingDetails] = useState(false);
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  useEffect(() => { setReply(""); setAttachmentFiles([]); setIsInternalNote(false); setSendingReply(false); }, [replyScope]);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [pendingResolveStatus, setPendingResolveStatus] = useState<"resolved" | "closed">("resolved");
  const [resumeAi, setResumeAi] = useState(false);
  const [resolvingOwnership, setResolvingOwnership] = useState(false);
  const [revealReason, setRevealReason] = useState("");
  const [revealedMessages, setRevealedMessages] = useState<Record<string, { content: string; expiresAt: string }>>({});
  const [revealingKey, setRevealingKey] = useState<string | null>(null);
  const revealGeneration = useRef(0);
  const revealTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearReveals = useCallback(() => {
    revealGeneration.current++;
    revealTimers.current.forEach(clearTimeout);
    revealTimers.current = [];
    setRevealedMessages({});
    setRevealingKey(null);
  }, []);
  useEffect(() => {
    clearReveals();
    setRevealReason("");
    return clearReveals;
  }, [ticketId, clearReveals]);

  const revealMessage = async (message: TicketMessage) => {
    if (!revealReason.trim() || !message.restricted || !["conversation", "support_chat"].includes(message.source || "")) return;
    const key = message.key || `${message.source}:${message.id}`;
    const generation = revealGeneration.current;
    setRevealingKey(key);
    try {
      const result = await api.post<{ content: string; revealExpiresAt: string }>(
        `/api/support/${ticketId}/messages/${message.source}/${message.id}/reveal`, { reason: revealReason.trim() });
      if (generation !== revealGeneration.current) return;
      const serverExpiry = Date.parse(result.revealExpiresAt);
      const expiresAt = Math.min(Number.isFinite(serverExpiry) ? serverExpiry : Date.now(), Date.now() + 5 * 60_000);
      if (expiresAt <= Date.now()) throw new Error("Restricted content has expired.");
      setRevealedMessages((current) => ({ ...current, [key]: { content: result.content, expiresAt: new Date(expiresAt).toISOString() } }));
      revealTimers.current.push(setTimeout(() => setRevealedMessages((current) => { const next = { ...current }; delete next[key]; return next; }), expiresAt - Date.now()));
    } catch (error) {
      if (generation === revealGeneration.current) toast({ title: "Restricted content was not revealed", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    } finally { if (generation === revealGeneration.current) setRevealingKey(null); }
  };

  const fetchTicket = useCallback(async () => {
    try {
      const data = await api.get<Ticket>(`/api/support/${ticketId}`);
      setTicket(data);
      setTicketLoadError(null);
      setTagsInput((data.tags || []).join(", "));
    } catch (error) {
      setTicket(null);
      setTicketLoadError(
        error instanceof Error && !/not found/i.test(error.message)
          ? "The ticket workspace could not be loaded. Try again or return to the queue."
          : "This ticket does not exist or is no longer available in this workspace.",
      );
    }
  }, [ticketId]);

  const fetchMessages = useCallback(async () => {
    const request = ++messagesRequest.current;
    setMessagesRefreshing(true);
    try {
      const data = await api.get<{ events: Array<{
        key: string; id: number; source: TicketMessage["source"]; type: TicketMessage["type"];
        direction: string; content: string; actorName: string | null;
        attachments?: TicketMessage["attachments"]; createdAt: string;
        deliveryStatus: string | null; providerMessageId: string | null; deliveryError: string | null;
        restricted?: boolean;
      }> }>(`/api/support/${ticketId}/timeline?latest=true&limit=200`);
      if (request !== messagesRequest.current) return;
      setMessages((data?.events || []).filter((event) => event.type !== "system").map((event) => ({
        ...event,
        isInternal: event.type === "internal_note",
        actorEmail: null,
        deliveryAttemptCount: 0,
      })));
      setMessagesError(null);
    } catch {
      if (request === messagesRequest.current) {
        setMessagesError("Conversation history could not be loaded. Displayed messages may be out of date.");
      }
    } finally {
      if (request === messagesRequest.current) setMessagesRefreshing(false);
    }
  }, [ticketId]);

  const fetchTeams = useCallback(async () => {
    try {
      const data = await api.get<SupportTeam[]>("/api/support/teams");
      setTeams((Array.isArray(data) ? data : []).filter((team) => team.isActive));
    } catch {
      setTeams([]);
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchTicket(), fetchMessages(), fetchTeams()]).finally(() => setLoading(false));
  }, [fetchTicket, fetchMessages, fetchTeams]);

  const refreshWorkspace = useCallback(async () => {
    await Promise.all([fetchTicket(), fetchMessages()]);
  }, [fetchMessages, fetchTicket]);
  const { isRealtimeConnected } = useSupportRealtimeRefresh(refreshWorkspace, 20_000);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendReply = async (event: React.FormEvent) => {
    event.preventDefault();
    const content = reply.trim();
    if (!content || sendingReply || !replyScope || ticket?.id !== Number(ticketId)) return;

    setSendingReply(true);
    try {
      const upload = async (file: File) => {
        const formData = new FormData();
        formData.append("file", file);
        return api.postForm<{ fileId: number; name: string; type: string; size: number }>(
          `/api/support/${ticketId}/attachments`, formData,
        );
      };
      const send = (body: { content: string; isInternal: boolean; idempotencyKey?: string; attachments: Array<{ fileId: number; name: string; type: string }> }) =>
        api.post(`/api/support/${ticketId}/messages`, body);
      if (isInternalNote) {
        const attachments = await Promise.all(attachmentFiles.map(upload));
        if (!isReplyScopeCurrent()) return;
        await send({ content: content.trim(), isInternal: true, attachments });
      } else {
        await sendSupportReply({ scope: replyScope || "", content: content, files: attachmentFiles, upload, send, isCurrent: isReplyScopeCurrent });
      }
      if (!isReplyScopeCurrent()) return;
      await fetchMessages();
      setReply(current => current === reply ? "" : current);
      setAttachmentFiles(current => current === attachmentFiles ? [] : current);
      setTicket((current) => current ? {
        ...current,
        totalMessages: current.totalMessages + 1,
        status: !isInternalNote && (current.status === "resolved" || current.status === "closed") ? "in_progress" : current.status,
        updatedAt: new Date().toISOString(),
      } : current);
      toast({ title: isInternalNote ? "Internal note added" : "Reply sent" });
    } catch (error) {
      toast({
        title: "Unable to send message",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      if (isReplyScopeCurrent()) setSendingReply(false);
    }
  };

  const changeStatus = async (nextStatus: string) => {
    if (!ticket || nextStatus === ticket.status || updatingStatus) return;
    if (ticket.handoffId && (nextStatus === "resolved" || nextStatus === "closed")) {
      setPendingResolveStatus(nextStatus);
      setResumeAi(false);
      setResolveOpen(true);
      return;
    }
    setUpdatingStatus(true);
    try {
      const updated = await api.put<Ticket>(`/api/support/${ticketId}`, { status: nextStatus });
      setTicket(updated);
      toast({ title: `Ticket marked ${STATUS_CONFIG[nextStatus]?.label.toLowerCase() || nextStatus}` });
    } catch {
      toast({ title: "Unable to update status", description: "Please try again.", variant: "destructive" });
    } finally {
      setUpdatingStatus(false);
    }
  };

  const resolveOwnership = async () => {
    if (!ticket?.handoffId || resolvingOwnership) return;
    setResolvingOwnership(true);
    try {
      const updated = await api.post<Ticket>(`/api/support/${ticketId}/resolve-ownership`, {
        resolution: pendingResolveStatus === "closed" ? "closed" : "manual_reply",
        resumeAi: pendingResolveStatus === "resolved" && resumeAi,
      });
      setTicket(updated);
      setResolveOpen(false);
      toast({ title: pendingResolveStatus === "closed" ? "Ticket closed; human takeover ended" : resumeAi ? "Resolved; human takeover ended" : "Resolved with human ownership retained", description: pendingResolveStatus === 'closed' || resumeAi ? 'Assistant readiness and delivery rules still apply to future messages.' : undefined });
    } catch (error) {
      toast({ title: "Unable to resolve ownership", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally { setResolvingOwnership(false); }
  };

  const updateDetails = async (updates: Record<string, unknown>, successMessage: string) => {
    if (!ticket || savingDetails) return;
    setSavingDetails(true);
    try {
      const updated = await api.put<Ticket>(`/api/support/${ticketId}`, updates);
      setTicket(updated);
      setTagsInput((updated.tags || []).join(", "));
      toast({ title: successMessage });
    } catch (error) {
      toast({
        title: "Unable to update ticket",
        description: error instanceof Error ? error.message : "Review the selected values and try again.",
        variant: "destructive",
      });
    } finally {
      setSavingDetails(false);
    }
  };

  if (loading) {
    return (
      <LoadingState size="section" label="Loading ticket…" className="py-24" />
    );
  }

  if (!ticket) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-xl items-center justify-center p-5">
        <Card className="w-full rounded-2xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center px-6 py-12 text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
              <AlertCircle className="h-5 w-5 text-muted-foreground" />
            </div>
            <h1 className="text-lg font-semibold">Ticket unavailable</h1>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
              {ticketLoadError || "This ticket could not be found in the current workspace."}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <Button onClick={() => router.push("/dashboard/support")}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to support queue
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setLoading(true);
                  void Promise.all([fetchTicket(), fetchMessages(), fetchTeams()]).finally(() => setLoading(false));
                }}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Try again
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const ownershipResolution = ticket.metadata?.ownershipResolution;
  const ownershipResolutionLabel = ownershipResolution?.outcome === "ai_resumed"
    ? ownershipResolution.resolution === "closed" ? "Ticket closed; human takeover ended" : "Human takeover ended by operator"
    : ownershipResolution?.outcome === "closed"
      ? "Conversation explicitly closed"
      : "Human ownership retained";
  const status = STATUS_CONFIG[ticket.status] || STATUS_CONFIG.open;
  const priority = PRIORITY_CONFIG[ticket.priority] || PRIORITY_CONFIG.medium;
  const hasUnifiedConversation = messages.some((message) => message.source === "conversation" || message.source === "support_chat");
  return (
    <div className="p-5 space-y-5 max-w-screen-xl mx-auto">
      <RelatedProposals supportTicketId={ticket.id}/>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg shrink-0 mt-0.5"
            onClick={() => router.push("/dashboard/support")} aria-label="Back to support tickets">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="text-xs text-muted-foreground font-mono">{ticket.ticketNumber}</span>
              <StatusBadge status={STATUS_CONFIG[ticket.status] ? ticket.status : "open"} label={status.label} />
              <Badge className={cn("text-xs font-medium px-1.5 py-0.5 h-auto rounded-md border-none", priority.bg, priority.color)}>
                {priority.label}
              </Badge>
              <span className={cn("inline-flex items-center gap-1 text-[10px]", isRealtimeConnected ? "text-success" : "text-muted-foreground")}>
                <Radio className="h-3 w-3" /> {isRealtimeConnected ? "Live" : "Polling"}
              </span>
            </div>
            <h1 className="text-base font-semibold leading-tight max-w-2xl">{ticket.subject}</h1>
          </div>
        </div>
        <Select value={ticket.status} onValueChange={changeStatus} disabled={updatingStatus}>
          <SelectTrigger aria-label="Update ticket status" className="h-9 w-40 text-xs">
            <SelectValue placeholder="Update status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="in_progress">In Progress</SelectItem>
            <SelectItem value="waiting_on_customer">Waiting on customer</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid overflow-hidden rounded-2xl border border-border/60 bg-card sm:grid-cols-2 lg:grid-cols-4">
        <WorkspaceMetric label="Customer" value={ticket.customerName || "Unlinked customer"} detail={ticket.customerEmail || "No customer email"} />
        <WorkspaceMetric label="Source" value={ticket.channel || "email"} detail={ticket.conversationId ? `Conversation #${ticket.conversationId}` : "Ticket-created case"} capitalize />
        <WorkspaceMetric label="Ownership" value={supportOwnershipLabel(ticket)} detail={ticket.assignedMemberName || ticket.teamName || "Canonical queue"} />
        {(() => { const snapshot = getSlaSnapshot(ticket); return <WorkspaceMetric label="Response target" value={snapshot.label} detail={snapshot.detail} valueClassName={snapshot.tone} />; })()}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Messages */}
        <div className="lg:col-span-3">
          <Card className="border border-border/50 rounded-xl shadow-none flex flex-col min-h-[500px]">
            <CardHeader className="px-4 pt-4 pb-3 border-b border-border/30">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-sm font-semibold">Messages</CardTitle>
                <span className="text-xs text-muted-foreground ml-auto">{messagesError
                  ? `${messages.length ? `${messages.length} last loaded` : "History unavailable"} · ${ticket.totalMessages} stored`
                  : `${messages.length + (!hasUnifiedConversation && ticket.description ? 1 : 0)} events · ${ticket.totalMessages} stored`}</span>
              </div>
            </CardHeader>
            <CardContent className="p-4 flex-1 overflow-y-auto space-y-4 max-h-[480px]">
              {messagesError && <Callout tone="danger" actions={
                <Button type="button" variant="outline" size="sm" aria-label="Retry conversation history" disabled={messagesRefreshing} onClick={() => void fetchMessages()}>
                  {messagesRefreshing ? "Retrying history…" : "Retry history"}
                </Button>
              }>
                {messagesError}
              </Callout>}
              {messages.some((message) => message.restricted) && <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3 text-xs"><p>Restricted details are shown for up to five minutes. Each reveal records your account and reason.</p><label className="block space-y-1"><span>Reason for access</span><Input aria-label="Reason for restricted content access" value={revealReason} onChange={(event) => setRevealReason(event.target.value)} maxLength={240} placeholder="Why are these customer details needed?" /></label>{Object.keys(revealedMessages).length > 0 && <Button type="button" variant="outline" size="sm" onClick={clearReveals}>Hide revealed details now</Button>}</div>}
              {/* Initial description */}
              {!hasUnifiedConversation && <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <User className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="flex-1">
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="text-xs font-medium">{ticket.customerName || "Customer"}</span>
                    <span className="text-xs text-muted-foreground">{new Date(ticket.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="p-3 rounded-xl rounded-tl-none bg-muted/40 border border-border/30 text-sm leading-relaxed">
                    {ticket.description || "No description provided."}
                  </div>
                </div>
              </div>}

              {/* Messages */}
              {messages.map((message) => (
                <div
                  key={message.key || `ticket:${message.id}`}
                  className={`flex items-start gap-3 ${message.direction === "outbound" ? "flex-row-reverse" : ""}`}
                >
                  <div className={cn(
                    "w-7 h-7 rounded-lg flex items-center justify-center shrink-0",
                    message.isInternal ? "bg-warning/10 text-warning" :
                    message.direction === "outbound" ? "bg-primary/10 text-primary" : "bg-muted"
                  )}>
                    {message.direction === "outbound" || message.isInternal
                      ? <ShieldCheck className="h-3.5 w-3.5" />
                      : <User className="h-3.5 w-3.5 text-muted-foreground" />}
                  </div>
                  <div className={`flex flex-col gap-1 max-w-[80%] ${message.direction === "outbound" ? "items-end" : ""}`}>
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-medium">
                        {message.isInternal ? `${message.actorName || "Support"} · Internal note` : message.direction === "outbound" ? message.actorName || "Workspace owner" : ticket.customerName || "Customer"}
                      </span>
                      <span className="text-xs text-muted-foreground">{new Date(message.createdAt).toLocaleString()}</span>
                    </div>
                    <div className={cn(
                      "p-3 rounded-xl whitespace-pre-wrap break-words text-sm leading-relaxed",
                      message.isInternal
                        ? "rounded-tl-none border border-warning/15 bg-warning/5 italic text-warning"
                        : message.direction === "outbound"
                          ? "bg-primary text-primary-foreground rounded-tr-none"
                          : "bg-muted/40 border border-border/30 rounded-tl-none"
                    )}>
                      {revealedMessages[message.key || `${message.source}:${message.id}`]?.content || message.content}
                    </div>
                    {message.restricted && ["conversation", "support_chat"].includes(message.source || "") && (
                      revealedMessages[message.key || `${message.source}:${message.id}`]
                        ? <p className="text-xs text-muted-foreground">Revealed to workspace owner · hidden at {new Date(revealedMessages[message.key || `${message.source}:${message.id}`].expiresAt).toLocaleTimeString()}</p>
                        : <Button type="button" variant="outline" size="sm" disabled={!revealReason.trim() || revealingKey !== null} onClick={() => void revealMessage(message)}>{revealingKey === (message.key || `${message.source}:${message.id}`) ? "Revealing…" : "Reveal restricted content"}</Button>
                    )}
                    {(message.attachments || []).length > 0 && (
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {(message.attachments || []).map((attachment) => (
                          <a
                            key={attachment.fileId}
                            href={`/api/support/${ticketId}/attachments/${attachment.fileId}`}
                            className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/70 px-2 py-1 text-xs text-foreground hover:bg-muted"
                          >
                            <FileText className="h-3.5 w-3.5" />
                            <span className="max-w-48 truncate">{attachment.name}</span>
                          </a>
                        ))}
                      </div>
                    )}
                    {message.direction === "outbound" && !message.isInternal && (
                      <div className={cn("flex flex-wrap items-center gap-1.5 text-[10px]", ["failed", "uncertain", "dead_letter"].includes(message.deliveryStatus || "") ? "text-destructive" : "text-muted-foreground")}>
                        <span className="capitalize">{message.deliveryStatus || "recorded"}</span>
                        {message.providerMessageId && <span>· provider {message.providerMessageId}</span>}
                        {message.deliveryAttemptCount > 1 && <span>· {message.deliveryAttemptCount} attempts</span>}
                        {message.deliveryError && <span className="max-w-sm truncate" title={message.deliveryError}>· {message.deliveryError}</span>}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEnd} />
            </CardContent>
            <form className="border-t border-border/40 p-4" onSubmit={sendReply}>
              {ticket.status === "closed" && !isInternalNote && (
                <Callout tone="info" size="sm" announce className="mb-3">
                  This ticket is closed. Sending a customer reply from the client workspace will reopen it as in progress.
                </Callout>
              )}
              <Textarea
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder={isInternalNote ? "Add a private note for your team…" : "Write a reply to the customer…"}
                aria-label={isInternalNote ? "Write an internal note" : "Write a reply to the customer"}
                className="min-h-[88px] resize-y text-sm"
                disabled={sendingReply}
              />
              <input
                ref={attachmentInput}
                type="file"
                className="hidden"
                multiple
                accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv,.docx,.xlsx"
                onChange={(event) => {
                  const selected = Array.from(event.target.files || []);
                  const oversized = selected.find((file) => file.size > 10 * 1024 * 1024);
                  if (oversized) {
                    toast({ title: "Attachment too large", description: `${oversized.name} exceeds 10 MB.`, variant: "destructive" });
                  }
                  setAttachmentFiles((current) => [...current, ...selected.filter((file) => file.size <= 10 * 1024 * 1024)].slice(0, 10));
                  event.target.value = "";
                }}
              />
              {attachmentFiles.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {attachmentFiles.map((file, index) => (
                    <span key={`${file.name}-${file.lastModified}-${index}`} className="inline-flex max-w-56 items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs">
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{file.name}</span>
                      <button
                        type="button"
                        className="rounded-sm text-muted-foreground hover:text-foreground"
                        aria-label={`Remove ${file.name}`}
                        onClick={() => setAttachmentFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant={isInternalNote ? "secondary" : "outline"}
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setIsInternalNote((current) => !current)}
                    disabled={sendingReply}
                  >
                    <LockKeyhole className="h-3.5 w-3.5" />
                    {isInternalNote ? "Internal note" : "Reply to customer"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => attachmentInput.current?.click()}
                    disabled={sendingReply || attachmentFiles.length >= 10}
                  >
                    <Paperclip className="h-3.5 w-3.5" />
                    Attach
                  </Button>
                </div>
                <Button type="submit" size="sm" className="gap-1.5" disabled={!reply.trim()} loading={sendingReply} loadingText={isInternalNote ? "Add note" : "Send reply"}>
                  <Send className="h-3.5 w-3.5" />
                  {isInternalNote ? "Add note" : "Send reply"}
                </Button>
              </div>
            </form>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="lg:col-span-1 space-y-3">
          <Card className={cn("rounded-xl border shadow-none", ticket.handoffId && !ticket.aiReplyEnabled ? "border-warning/30 bg-warning/[0.03]" : "border-border/50")}>
            <CardHeader className="border-b border-border/30 px-4 pb-3 pt-4">
              <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {ticket.handoffId && !ticket.aiReplyEnabled ? <ShieldAlert className="h-3.5 w-3.5 text-warning" /> : <Bot className="h-3.5 w-3.5 text-primary" />} Ownership
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 px-4 py-3 text-xs">
              <div><p className="font-medium">{supportOwnershipLabel(ticket)}</p><p className="mt-1 leading-relaxed text-muted-foreground">{supportHandoffDescription(ticket)}</p>{ticket.handoffReason && <p className="mt-1 leading-relaxed text-muted-foreground">Handoff reason: {ticket.handoffReason}</p>}</div>
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3"><p className="font-medium">AI reply readiness not verified here</p><p className="mt-1 leading-relaxed text-muted-foreground">{SUPPORT_AI_READINESS_NOTICE}</p></div>
              {ownershipResolution && (
                <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    <p className="font-medium">{ownershipResolutionLabel}</p>
                  </div>
                  <p className="mt-1 leading-relaxed text-muted-foreground">
                    {ownershipResolution.outcome === "ai_resumed"
                      ? ownershipResolution.resolution === "closed" ? "Closing the ticket ended human takeover. Assistant readiness and delivery rules still apply to future messages." : "An operator ended human takeover. This does not enable the runtime or verify assistant readiness."
                      : ownershipResolution.outcome === "closed"
                        ? "An operator closed the source conversation; AI remains unavailable."
                        : "An operator resolved the ticket without resuming AI. Future messages remain human-owned."}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                    {ownershipResolution.resolvedAt && <span>{new Date(ownershipResolution.resolvedAt).toLocaleString()}</span>}
                    {ownershipResolution.resolvedBy && <span>· operator #{ownershipResolution.resolvedBy}</span>}
                  </div>
                </div>
              )}
              {ticket.latestTicketAutomation && (
                <div className={cn("rounded-lg border p-3", ticket.latestTicketAutomation.disposition === "read_only_ai" ? "border-info/20 bg-info/5" : "border-warning/20 bg-warning/5")}>
                  <div className="flex items-center gap-2">
                    <Bot className="h-3.5 w-3.5" />
                    <p className="font-medium">{ticket.latestTicketAutomation.disposition === "read_only_ai" ? "Bounded informational AI answer" : "Message retained for the human queue"}</p>
                  </div>
                  <p className="mt-1 leading-relaxed text-muted-foreground">
                    {ticket.latestTicketAutomation.disposition === "read_only_ai"
                      ? "AI answered one verified factual question. Human ownership did not resume."
                      : "AI did not take ownership or perform the requested action."}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                    {ticket.latestTicketAutomation.createdAt && <span>{new Date(ticket.latestTicketAutomation.createdAt).toLocaleString()}</span>}
                    {ticket.latestTicketAutomation.deliveryStatus && <span>· {ticket.latestTicketAutomation.deliveryStatus.replaceAll("_", " ")}</span>}
                    {ticket.latestTicketAutomation.providerMessageId && <span>· provider receipt recorded</span>}
                  </div>
                </div>
              )}
              {ticket.handoffTriggerType && <div className="flex justify-between gap-2"><span className="text-muted-foreground">Trigger</span><span className="font-medium capitalize">{ticket.handoffTriggerType.replaceAll("_", " ")}</span></div>}
              {ticket.handoffConfidenceScore !== null && <div className="flex justify-between gap-2"><span className="text-muted-foreground">AI confidence</span><span className="font-mono font-medium">{Math.round(ticket.handoffConfidenceScore * 100)}%</span></div>}
              {ticket.handoffId && <Button size="sm" className="w-full gap-1.5" onClick={() => { setPendingResolveStatus("resolved"); setResumeAi(false); setResolveOpen(true); }}><CheckCircle2 className="h-3.5 w-3.5" />Resolve ownership</Button>}
            </CardContent>
          </Card>

          <Card className="border border-border/50 rounded-xl shadow-none">
            <CardHeader className="px-4 pt-4 pb-3 border-b border-border/30">
              <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Ticket Details</CardTitle>
            </CardHeader>
            <CardContent className="px-4 py-3 space-y-3">
              {[
                { label: "Ticket ID", value: ticket.ticketNumber, icon: Hash },
                { label: "Category", value: ticket.category || "General", icon: MessageSquare },
                { label: "Created", value: new Date(ticket.createdAt).toLocaleDateString(), icon: Calendar },
                { label: "Updated", value: new Date(ticket.updatedAt).toLocaleDateString(), icon: Clock },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-2.5 text-xs">
                  <item.icon className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                  <span className="text-muted-foreground">{item.label}:</span>
                  <span className="font-medium ml-auto">{item.value}</span>
                </div>
              ))}
              <div className="flex items-center gap-2.5 text-xs">
                <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                <span className="text-muted-foreground">CRM contact:</span>
                {ticket.contactId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="ml-auto h-auto p-0 text-xs text-primary hover:bg-transparent hover:underline"
                    onClick={() => router.push(`/dashboard/crm/contacts/${ticket.contactId}`)}
                  >
                    View #{ticket.contactId}
                  </Button>
                ) : <span className="ml-auto font-medium">Not linked</span>}
              </div>
              <div className="flex items-center gap-2.5 text-xs">
                <Globe2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                <span className="text-muted-foreground">Source:</span>
                {ticket.conversationId ? <Button type="button" variant="ghost" className="ml-auto h-auto p-0 text-xs text-primary hover:bg-transparent hover:underline" onClick={() => router.push(`/dashboard/conversations/${ticket.conversationId}`)}>Open {ticket.channel}</Button> : <span className="ml-auto font-medium capitalize">{ticket.channel || "Ticket"}</span>}
              </div>
            </CardContent>
          </Card>

          <Card className="border border-border/50 rounded-xl shadow-none">
            <CardHeader className="px-4 pt-4 pb-3 border-b border-border/30">
              <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Routing and SLA</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 px-4 py-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Priority</label>
                <Select
                  value={ticket.priority}
                  onValueChange={(priorityValue) => void updateDetails({ priority: priorityValue }, "Priority updated")}
                  disabled={savingDetails}
                >
                  <SelectTrigger aria-label="Update ticket priority" className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Team</label>
                <Select
                  value={ticket.teamId ? String(ticket.teamId) : "none"}
                  onValueChange={(value) => void updateDetails({
                    teamId: value === "none" ? null : Number(value),
                    assignedMemberId: null,
                  }, "Support team updated")}
                  disabled={savingDetails}
                >
                  <SelectTrigger aria-label="Assign support team" className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {teams.map((team) => <SelectItem key={team.id} value={String(team.id)}>{team.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Assigned member</label>
                <Select
                  value={ticket.assignedMemberId ? String(ticket.assignedMemberId) : "none"}
                  onValueChange={(value) => void updateDetails({
                    assignedMemberId: value === "none" ? null : Number(value),
                  }, "Assignee updated")}
                  disabled={savingDetails || !ticket.teamId}
                >
                  <SelectTrigger aria-label="Assign support team member" className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No individual assignee</SelectItem>
                    {(teams.find((team) => team.id === ticket.teamId)?.members || [])
                      .filter((member) => member.isActive)
                      .map((member) => (
                        <SelectItem key={member.id} value={String(member.id)}>
                          {member.name || member.email || `Member ${member.id}`}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="ticket-sla-deadline" className="text-xs text-muted-foreground">SLA deadline</label>
                <Input
                  id="ticket-sla-deadline"
                  type="datetime-local"
                  key={ticket.slaDeadline || "no-sla"}
                  defaultValue={toLocalDateTimeInput(ticket.slaDeadline)}
                  onBlur={(event) => {
                    const value = event.currentTarget.value;
                    void updateDetails({ slaDeadline: value ? new Date(value).toISOString() : null }, "SLA deadline updated");
                  }}
                  disabled={savingDetails}
                  className="h-9 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="ticket-tags" className="text-xs text-muted-foreground">Tags</label>
                <Input
                  id="ticket-tags"
                  value={tagsInput}
                  onChange={(event) => setTagsInput(event.target.value)}
                  placeholder="billing, refund, priority"
                  maxLength={1_000}
                  className="h-9 text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full"
                  disabled={savingDetails}
                  onClick={() => void updateDetails({
                    tags: [...new Set(tagsInput.split(",").map((tag) => tag.trim()).filter(Boolean))],
                  }, "Tags updated")}
                >
                  Save tags
                </Button>
              </div>
            </CardContent>
          </Card>

          {ticket.status === "closed" && ticket.rating !== null && ticket.rating !== undefined && (
            <Card className="border border-border/50 rounded-xl shadow-none">
              <CardHeader className="px-4 pt-4 pb-3 border-b border-border/30">
                <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                  <Star className="h-3.5 w-3.5 text-warning" /> Customer Review
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 py-3 space-y-2">
                <div className="flex items-center gap-1">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <Star key={star}
                      className={`h-4 w-4 ${star <= ticket.rating! ? "fill-warning text-warning" : "text-muted-foreground/20"}`} />
                  ))}
                  <span className="text-xs font-semibold ml-1">{ticket.rating}/5</span>
                </div>
                {ticket.reviewComment && (
                  <p className="text-xs text-muted-foreground italic leading-relaxed">&ldquo;{ticket.reviewComment}&rdquo;</p>
                )}
                {ticket.reviewSubmittedAt && (
                  <p className="text-xs text-muted-foreground">
                    {new Date(ticket.reviewSubmittedAt).toLocaleDateString()}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Dialog open={resolveOpen} onOpenChange={setResolveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Resolve this human handoff</DialogTitle><DialogDescription>{pendingResolveStatus === "closed" ? "Closing the ticket ends human takeover. It does not enable the runtime or verify assistant readiness." : "Choose who owns the next customer message. Ending human takeover does not verify AI reply readiness."}</DialogDescription></DialogHeader>
          <div className="space-y-2 py-2">
            {pendingResolveStatus !== "closed" && <button type="button" onClick={() => setResumeAi(false)} className={cn("w-full rounded-xl border p-3 text-left", !resumeAi ? "border-primary bg-primary/5" : "border-border")}>
              <span className="flex items-center gap-2 text-sm font-medium"><Users className="h-4 w-4" />Keep human ownership</span><span className="mt-1 block text-xs text-muted-foreground">Resolve the ticket, but future messages stay with the support team.</span>
            </button>}
            {pendingResolveStatus !== "closed" && <button type="button" onClick={() => setResumeAi(true)} className={cn("w-full rounded-xl border p-3 text-left", resumeAi ? "border-primary bg-primary/5" : "border-border")}>
              <span className="flex items-center gap-2 text-sm font-medium"><RotateCcw className="h-4 w-4" />End human takeover after resolution</span><span className="mt-1 block text-xs text-muted-foreground">Allow automation ownership. AI replies still require runtime, assistant and delivery readiness.</span>
            </button>}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setResolveOpen(false)} disabled={resolvingOwnership}>Cancel</Button><Button onClick={() => void resolveOwnership()} loading={resolvingOwnership}>{pendingResolveStatus === "closed" ? "Close ticket & end takeover" : resumeAi ? "Resolve and end takeover" : "Resolve, keep human"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WorkspaceMetric({ label, value, detail, capitalize, valueClassName }: { label: string; value: string; detail: string; capitalize?: boolean; valueClassName?: string }) {
  return <div className="border-b border-r border-border/50 p-3 last:border-r-0 sm:last:border-b-0 lg:border-b-0"><p className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</p><p className={cn("mt-1 truncate text-sm font-semibold", capitalize && "capitalize", valueClassName)}>{value}</p><p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p></div>;
}
