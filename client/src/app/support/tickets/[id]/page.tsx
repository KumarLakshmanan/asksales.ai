"use client";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useRouter, useParams } from "next/navigation";
import {
  ArrowLeft, Send, Clock, CheckCircle2,
  AlertTriangle, MessageSquare, Lock, User, Bot, Sparkles, BookOpen, X,
  Star, XCircle, Zap, Target, ClipboardList, Paperclip, FileText,
  RefreshCw, ShieldCheck, ListTree, Quote, CircleDot
} from "lucide-react";
import { useSupportAuth } from "@/contexts/SupportAuthContext";
import { supportApi } from "@/lib/support-api";
import { sendSupportReply } from "@/lib/support-reply-intent";
import { useSupportReplyScope } from "@/hooks/use-support-reply-scope";
import { useToast } from "@/hooks/use-toast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import DOMPurify from "dompurify";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatSupportTicketStatus } from "@/lib/supportStatus";
import { supportOwnershipStage } from "@/lib/supportTicketWorkspace";
import { SUPPORT_STATUS_CLASSES as STATUS_COLORS } from "@/lib/support-styles";

interface TicketMessage {
  id: number; ticketId: number; userId: number | null;
  direction: string; content: string; isInternal: boolean;
  attachments: Array<{ fileId: number; name: string; url: string; type: string }>; createdAt: string;
}

interface TicketDetail {
  id: number; ticketNumber: string; subject: string; description: string | null;
  status: string; priority: string; category: string | null; totalMessages: number;
  unreadCount: number; tags: string[]; slaDeadline: string | null; resolvedAt: string | null;
  closedAt: string | null; reviewRequestSentAt: string | null; rating: number | null;
  reviewComment: string | null; reviewSubmittedAt: string | null;
  handoffId: number | null; handoffStatus: string | null; ownershipMode: string;
  handoffReason: string | null; handoffConfidenceScore: number | null;
  handoffAssignedMemberId: number | null; assignedMemberId: number | null;
  assignedMemberName: string | null; customerName: string | null; channel: string;
  version: number; claimable: boolean;
  aiReplyEnabled: boolean; aiPausedAt: string | null; aiPausedBy: number | null;
  summary: TicketSummaryRecord | null;
  createdAt: string; updatedAt: string; messages: TicketMessage[];
}

interface TicketSummaryPayload {
  issue: string; customerIntent: string; importantFacts: string[]; actionsAttempted: string[];
  unresolvedQuestions: string[]; recommendedNextAction: string; sentiment: string | null; risk: string | null;
  sourceReferences: Array<{ source: string; messageId: number; label: string }>;
}
interface TicketSummaryRecord {
  status: "stale" | "generating" | "current" | "failed";
  summary: TicketSummaryPayload | null; generatedAt: string | null; error: string | null;
}
interface TimelineEvent {
  key: string; id: number; source: "conversation" | "support_chat" | "ticket" | "handoff";
  type: "customer" | "agent" | "internal_note" | "system";
  direction: "inbound" | "outbound" | "system"; content: string; actorName: string | null;
  attachments: Array<{ fileId?: number; name?: string; fileName?: string; url?: string }>;
  deliveryStatus: string | null; deliveryError: string | null; restricted: boolean; createdAt: string;
}
interface TimelinePage { canRevealRestrictedContent?: boolean; revealBlockedReason?: string; events: TimelineEvent[]; nextCursor: string | null; total: number }

interface AIChatMessage {
  id: number; sessionId: number; role: "user" | "assistant"; content: string;
  sources: { title: string; excerpt: string; similarity: number }[];
  confidence: number | null; createdAt: string;
}

interface AIChatSession {
  id: number; memberId: number; ticketId: number | null; title: string;
  createdAt: string; updatedAt: string; messages?: AIChatMessage[];
}

const STATUS_OPTIONS = [
  { value: "open", label: "Open", icon: AlertTriangle },
  { value: "in_progress", label: "In Progress", icon: Clock },
  { value: "waiting_on_customer", label: "Waiting on Customer", icon: Clock },
  { value: "resolved", label: "Resolved", icon: CheckCircle2 },
  { value: "closed", label: "Closed", icon: Lock },
];

const PRIORITY_OPTIONS = ["low", "medium", "high", "urgent", "critical"];

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-info/10 text-info",
  high: "bg-warning/10 text-warning",
  urgent: "bg-destructive/10 text-destructive",
  critical: "bg-destructive/10 text-destructive",
};

export default function TicketDetailPage() {
  const router = useRouter();
  const params = useParams();
  const { toast } = useToast();
  const { member, isAuthenticated, isLoading: authLoading } = useSupportAuth();
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [replyContent, setReplyContent] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isUpdatingAiReplies, setIsUpdatingAiReplies] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<"summary" | "conversation">("summary");
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [timelineCursor, setTimelineCursor] = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [summaryRefreshing, setSummaryRefreshing] = useState(false);
  const [claimingTicket, setClaimingTicket] = useState(false);
  const [revealAccess, setRevealAccess] = useState<{ allowed: boolean; reason: string }>({ allowed: false, reason: "Claim this handoff to request restricted content." });
  const [revealReason, setRevealReason] = useState("");
  const revealTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const revealGeneration = useRef(0);
  const [revealedTimeline, setRevealedTimeline] = useState<Record<string, string>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [aiChatOpen, setAiChatOpen] = useState(false);
  const [aiMessages, setAiMessages] = useState<AIChatMessage[]>([]);
  const [aiInput, setAiInput] = useState("");
  const [aiSending, setAiSending] = useState(false);
  const [aiSessionId, setAiSessionId] = useState<number | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const aiMessagesEndRef = useRef<HTMLDivElement>(null);
  const aiInputRef = useRef<HTMLTextAreaElement>(null);
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  const closeDialogTriggerRef = useRef<HTMLButtonElement>(null);
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [closeReviewMessage, setCloseReviewMessage] = useState(
    "This ticket has been closed. We would appreciate your feedback! Please rate your experience with our support team."
  );
  const [isClosing, setIsClosing] = useState(false);
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);

  const ticketId = params?.id as string;
  const replyScope = member ? JSON.stringify(["member", member.id, member.teamId, ticketId]) : null;
  const isReplyScopeCurrent = useSupportReplyScope(replyScope);
  useEffect(() => { setReplyContent(""); setAttachmentFiles([]); setIsInternal(false); setShowCloseDialog(false); setIsSending(false); }, [replyScope]);
  const invalidateReveals = useCallback(() => {
    revealGeneration.current++;
    revealTimers.current.forEach(clearTimeout);
    revealTimers.current = [];
  }, []);

  useEffect(() => {
    invalidateReveals();
    setRevealedTimeline({});
    setRevealReason("");
    setRevealAccess({ allowed: false, reason: "Checking reveal access…" });
    return invalidateReveals;
  }, [ticketId, invalidateReveals]);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) router.push("/support/login");
  }, [authLoading, isAuthenticated, router]);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("view") === "conversation") setWorkspaceTab("conversation");
  }, []);

  const fetchTicket = useCallback(async (options?: { background?: boolean }) => {
    if (!ticketId) return;
    if (!options?.background) setIsLoading(true);
    try {
      const data = await supportApi.get<TicketDetail>(`/api/support-portal/tickets/${ticketId}`);
      setTicket(data);
    } catch {
      toast({ title: "Error", description: "Failed to load ticket", variant: "destructive" });
      router.push("/support/tickets");
    } finally {
      if (!options?.background) setIsLoading(false);
    }
  }, [ticketId, toast, router]);

  const fetchTimeline = useCallback(async (cursor?: string | null) => {
    if (!ticketId) return;
    setTimelineLoading(true);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (cursor) params.set("cursor", cursor);
      const data = await supportApi.get<TimelinePage>(`/api/support-portal/tickets/${ticketId}/timeline?${params}`);
      setTimeline((current) => cursor ? [...current, ...(data.events || [])] : (data.events || []));
      setTimelineCursor(data.nextCursor || null);
      setRevealAccess({ allowed: data.canRevealRestrictedContent === true, reason: data.revealBlockedReason || "An active handoff assigned to you is required." });
      if (!data.canRevealRestrictedContent) setRevealedTimeline({});
    } catch (error) {
      toast({ title: "Conversation could not be loaded", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    } finally { setTimelineLoading(false); }
  }, [ticketId, toast]);

  useEffect(() => { if (isAuthenticated) { void fetchTicket(); void fetchTimeline(null); } }, [isAuthenticated, fetchTicket, fetchTimeline]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [ticket?.messages]);
  useEffect(() => { aiMessagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [aiMessages]);
  useEffect(() => {
    if (!ticket?.summary || !["stale", "generating"].includes(ticket.summary.status)) return;
    const timer = window.setTimeout(() => { void fetchTicket({ background: true }); }, 4_000);
    return () => window.clearTimeout(timer);
  }, [ticket?.summary, fetchTicket]);

  const refreshSummary = async () => {
    setSummaryRefreshing(true);
    try {
      await supportApi.post(`/api/support-portal/tickets/${ticketId}/summary/refresh`, {});
      await fetchTicket({ background: true });
      toast({ title: "Conversation summary refreshed" });
    } catch (error) {
      toast({ title: "Summary could not be refreshed", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    } finally { setSummaryRefreshing(false); }
  };

  const revealTimelineMessage = async (event: TimelineEvent) => {
    if (!ticket?.handoffId || !revealAccess.allowed || !(event.source === "conversation" || (event.source === "support_chat" && ticket.channel === "web")) || !revealReason.trim()) return;
    const generation = revealGeneration.current;
    try {
      const result = await supportApi.get<{ content: string; revealExpiresAt: string }>(`/api/support-portal/handoffs/${ticket.handoffId}/messages/${event.id}/reveal?reason=${encodeURIComponent(revealReason.trim())}`);
      if (generation !== revealGeneration.current) return;
      const serverExpiry = Date.parse(result.revealExpiresAt);
      const expiresAt = Math.min(Number.isFinite(serverExpiry) ? serverExpiry : Date.now(), Date.now() + 5 * 60_000);
      if (expiresAt <= Date.now()) throw new Error("Restricted content has expired.");
      setRevealedTimeline((current) => ({ ...current, [event.key]: result.content }));
      revealTimers.current.push(setTimeout(() => setRevealedTimeline((current) => { const next = { ...current }; delete next[event.key]; return next; }), expiresAt - Date.now()));
    } catch (error) {
      toast({ title: "Restricted content was not revealed", description: error instanceof Error ? error.message : "This action requires an active claimed handoff.", variant: "destructive" });
    }
  };

  const claimTicket = async () => {
    if (!ticket || claimingTicket) return;
    setClaimingTicket(true);
    try {
      await supportApi.post(`/api/support-portal/tickets/${ticketId}/claim`, { expectedVersion: ticket.version });
      await fetchTicket({ background: true });
      await fetchTimeline(null);
      toast({ title: "Ticket claimed", description: "The conversation is now assigned to you." });
    } catch (error) {
      toast({ title: "Ticket was not claimed", description: error instanceof Error ? error.message : "Another member may have claimed it.", variant: "destructive" });
      await fetchTicket({ background: true });
    } finally { setClaimingTicket(false); }
  };

  const initAiChat = useCallback(async () => {
    if (!ticketId || aiSessionId) return;
    setAiLoading(true);
    try {
      const resp = await supportApi.get<AIChatSession[] | { data?: AIChatSession[] }>(`/api/support-portal/chat/sessions?ticketId=${ticketId}&limit=1`);
      const sessions: AIChatSession[] = Array.isArray(resp) ? resp : (resp?.data ?? []);
      if (sessions.length > 0) {
        setAiSessionId(sessions[0].id);
        const full = await supportApi.get<AIChatSession & { messages: AIChatMessage[] }>(`/api/support-portal/chat/sessions/${sessions[0].id}`);
        setAiMessages(full.messages || []);
      } else {
        const session = await supportApi.post<AIChatSession>("/api/support-portal/chat/sessions", {
          ticketId: parseInt(ticketId), title: ticket?.subject || "Ticket Chat",
        });
        setAiSessionId(session.id);
        setAiMessages([]);
      }
    } catch {
      toast({ title: "Error", description: "Failed to initialize AI chat", variant: "destructive" });
    } finally {
      setAiLoading(false);
    }
  }, [ticketId, aiSessionId, ticket, toast]);

  useEffect(() => { if (aiChatOpen) initAiChat(); }, [aiChatOpen, initAiChat]);

  const sendAiMessage = useCallback(async () => {
    if (!aiInput.trim() || aiSending || !aiSessionId || !ticket) return;
    const userText = aiInput.trim();
    setAiInput("");
    setAiSending(true);
    const tempMsg: AIChatMessage = { id: Date.now(), sessionId: aiSessionId, role: "user", content: userText, sources: [], confidence: null, createdAt: new Date().toISOString() };
    setAiMessages((prev) => [...prev, tempMsg]);
    try {
      const result = await supportApi.post<{ userMessage: AIChatMessage; assistantMessage: AIChatMessage }>(
        `/api/support-portal/chat/sessions/${aiSessionId}/messages`,
        { message: userText, ticketContext: { ticketNumber: ticket.ticketNumber, subject: ticket.subject, description: ticket.description || "", status: ticket.status, priority: ticket.priority } }
      );
      setAiMessages((prev) => [...prev.filter((m) => m.id !== tempMsg.id), result.userMessage, result.assistantMessage]);
    } catch {
      toast({ title: "Error", description: "Failed to send message", variant: "destructive" });
      setAiMessages((prev) => prev.filter((m) => m.id !== tempMsg.id));
    } finally {
      setAiSending(false);
      aiInputRef.current?.focus();
    }
  }, [aiInput, aiSending, aiSessionId, ticket, toast]);

  const handleSendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSending || !replyScope || ticket?.id !== Number(ticketId) || !replyContent.trim() || (ticket?.status === "closed" && !isInternal)) return;
    setIsSending(true);
    try {
      const upload = async (file: File) => {
        const formData = new FormData();
        formData.append("file", file);
        return supportApi.postForm<{ fileId: number; name: string; type: string; size: number }>(
          `/api/support-portal/tickets/${ticketId}/attachments`, formData,
        );
      };
      const send = (body: { content: string; isInternal: boolean; idempotencyKey?: string; attachments: Array<{ fileId: number; name: string; type: string }> }) =>
        supportApi.post(`/api/support-portal/tickets/${ticketId}/reply`, body);
      if (isInternal) {
        const attachments = await Promise.all(attachmentFiles.map(upload));
        if (!isReplyScopeCurrent()) return;
        await send({ content: replyContent.trim(), isInternal: true, attachments });
      } else {
        await sendSupportReply({ scope: replyScope || "", content: replyContent, files: attachmentFiles, upload, send, isCurrent: isReplyScopeCurrent });
      }
      if (!isReplyScopeCurrent()) return;
      setReplyContent(current => current === replyContent ? "" : current);
      setIsInternal(false);
      setAttachmentFiles(current => current === attachmentFiles ? [] : current);
      await Promise.all([fetchTicket({ background: true }), fetchTimeline(null)]);
      toast({ title: isInternal ? "Internal note added" : "Reply sent" });
    } catch (error) {
      toast({
        title: "Unable to send reply",
        description: error instanceof Error ? error.message : "Failed to send reply",
        variant: "destructive",
      });
    } finally {
      if (isReplyScopeCurrent()) setIsSending(false);
    }
  };

  const handleUpdateTicket = async (field: "status" | "priority", value: string) => {
    if (!ticket) return;
    setIsUpdating(true);
    try {
      const resumeAi = field === "status" && value === "resolved" && ticket.handoffId
        ? window.confirm("Resume AI for the next customer message? Select Cancel to keep human ownership after resolution.")
        : undefined;
      await supportApi.put(`/api/support-portal/tickets/${ticketId}`, {
        [field]: value,
        expectedVersion: ticket.version,
        ...(resumeAi === undefined ? {} : { resumeAi }),
      });
      if (field === "status") {
        // Status changes can resolve the linked handoff and restore AI. Reload
        // the authoritative ticket projection so the page never retains a
        // stale human-takeover banner after a successful close.
        await fetchTicket({ background: true });
      } else {
        setTicket((prev) => prev ? { ...prev, [field]: value } : prev);
      }
      window.dispatchEvent(new Event("support:ticket-updated"));
      toast({
        title: `${field.charAt(0).toUpperCase() + field.slice(1)} updated to ${formatSupportTicketStatus(value)}`,
        description: field === "status" && value === "closed" ? "AI replies are active again for the next customer message." : undefined,
      });
    } catch {
      toast({ title: "Error", description: `Failed to update ${field}`, variant: "destructive" });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleAiReplyControl = async (enabled: boolean) => {
    if (!ticket?.handoffId || isUpdatingAiReplies) return;
    setIsUpdatingAiReplies(true);
    try {
      const result = await supportApi.post<{
        aiReplyEnabled: boolean; aiPausedAt: string | null; aiPausedBy: number | null;
      }>(`/api/support-portal/handoffs/${ticket.handoffId}/ai-replies`, { enabled });
      setTicket((current) => current ? {
        ...current,
        aiReplyEnabled: result.aiReplyEnabled,
        aiPausedAt: result.aiPausedAt,
        aiPausedBy: result.aiPausedBy,
        ownershipMode: result.aiReplyEnabled ? "ai_active" : "human_owned",
      } : current);
      toast({
        title: enabled ? "AI replies enabled" : "Human takeover active",
        description: enabled
          ? "AI may answer bounded, low-risk questions while the ticket remains open."
          : "Automatic replies are paused until you enable them or close the ticket.",
      });
    } catch (error) {
      toast({
        title: "Unable to update AI replies",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsUpdatingAiReplies(false);
    }
  };

  const handleCloseAndRequestReview = async () => {
    setIsClosing(true);
    try {
      const result = await supportApi.post<{
        reviewDeliveryStatus: "sent" | "failed" | "recipient_missing" | "already_sent" | "in_progress";
        reviewDeliveryError?: string | null;
      }>(`/api/support-portal/tickets/${ticketId}/close`, { reviewMessage: closeReviewMessage, expectedVersion: ticket?.version });
      if (!isReplyScopeCurrent()) return;
      setShowCloseDialog(false);
      await fetchTicket();
      window.dispatchEvent(new Event("support:ticket-updated"));
      const descriptions = {
        sent: "The linked customer received the review request.",
        already_sent: "The review request had already been delivered.",
        in_progress: "Review delivery is in progress. Check its outcome before requesting another review.",
        recipient_missing: "Ticket closed, but no linked customer email was available.",
        failed: result.reviewDeliveryError || "Ticket closed, but review delivery failed and needs attention.",
      };
      toast({
        title: "Ticket closed",
        description: `${descriptions[result.reviewDeliveryStatus] || "Review delivery outcome is unavailable. Check the conversation before retrying."} AI replies are active again for the next customer message.`,
        variant: result.reviewDeliveryStatus === "failed" || result.reviewDeliveryStatus === "recipient_missing"
          ? "destructive"
          : "default",
      });
    } catch (error) {
      toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to close ticket", variant: "destructive" });
    } finally {
      setIsClosing(false);
    }
  };

  if (authLoading || isLoading) {
    return <LoadingState label="Loading ticket…" />;
  }
  if (!ticket) return null;
  const hadHandoff = Boolean(ticket.handoffId || timeline.some((event) => event.source === "handoff"));
  const hadClaim = Boolean(ticket.handoffAssignedMemberId || timeline.some((event) => event.key.startsWith("handoff-accepted:")));
  const ownershipStage = supportOwnershipStage(ticket);
  const canOperate = ticket.assignedMemberId === member?.id || Boolean(member && ["lead", "admin"].includes(member.role));

  return (
    <div className="mx-auto flex min-h-full max-w-screen-xl flex-col lg:h-full lg:min-h-0">
      {/* Header */}
      <div className="sticky top-0 z-20 mb-3 flex flex-shrink-0 items-center gap-3 border-b border-border/50 bg-background/95 pb-3 backdrop-blur">
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg shrink-0"
          onClick={() => router.push("/support/tickets")} aria-label="Back to tickets">
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
            <span className="text-xs font-mono text-muted-foreground/60">{ticket.ticketNumber}</span>
            <Badge className={cn("text-xs font-medium px-1.5 py-0.5 h-auto rounded-md border-none capitalize",
              STATUS_COLORS[ticket.status] || "bg-muted text-muted-foreground")}>
              {formatSupportTicketStatus(ticket.status)}
            </Badge>
            <Badge className={cn("text-xs font-medium px-1.5 py-0.5 h-auto rounded-md border-none capitalize",
              PRIORITY_COLORS[ticket.priority] || "bg-muted text-muted-foreground")}>
              {ticket.priority}
            </Badge>
          </div>
          <h1 className="text-sm font-semibold truncate">{ticket.subject}</h1>
        </div>
        <Button variant="outline" size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-md border-primary/20 text-xs text-primary hover:bg-primary/10"
          onClick={() => setAiChatOpen(true)}>
          <Sparkles className="w-3.5 h-3.5" /> <span className="hidden sm:inline">AI Assistant</span>
        </Button>
      </div>

      <section aria-label="Ticket ownership" className="mb-4 grid flex-shrink-0 gap-2 rounded-2xl border border-border/60 bg-card p-3 sm:grid-cols-4">
        {[
          { label: "AI handling", complete: hadHandoff || ownershipStage === 'ai', active: ownershipStage === 'ai', icon: Bot },
          { label: "Human requested", complete: hadHandoff || ['requested', 'claimed'].includes(ownershipStage), active: ownershipStage === 'requested', icon: AlertTriangle },
          { label: ticket.assignedMemberName || "Claimed", complete: hadClaim || Boolean(ticket.assignedMemberId), active: ownershipStage === 'claimed', icon: ShieldCheck },
          { label: ["resolved", "closed"].includes(ticket.status) ? formatSupportTicketStatus(ticket.status) : "Resolution", complete: ["resolved", "closed"].includes(ticket.status), active: false, icon: CheckCircle2 },
        ].map((step, index) => <div key={step.label} aria-current={step.active ? 'step' : undefined} className={cn("relative flex items-center gap-2 rounded-xl border px-3 py-2", step.active ? "border-primary/35 bg-primary/[0.05]" : "border-border/40 bg-muted/15")}><span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full", step.complete ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}><step.icon className="h-3.5 w-3.5" /></span><div className="min-w-0"><p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">{index + 1}</p><p className="truncate text-xs font-semibold">{step.label}</p></div></div>)}
      </section>

      <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1 lg:flex-row">
        {/* Main: Messages + Reply */}
        <div className="flex h-[calc(100dvh-9rem)] min-h-[32rem] min-w-0 flex-col overflow-hidden rounded-xl border border-border/50 lg:h-auto lg:min-h-0 lg:flex-1">
          <div className="flex items-center justify-between border-b border-border/50 bg-muted/15 px-3 py-2">
            <div className="inline-flex rounded-lg bg-muted/60 p-1" role="tablist" aria-label="Ticket workspace view">
              <button role="tab" aria-selected={workspaceTab === "summary"} onClick={() => setWorkspaceTab("summary")} className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold", workspaceTab === "summary" ? "bg-background shadow-sm" : "text-muted-foreground")}><ListTree className="h-3.5 w-3.5" />Summary</button>
              <button role="tab" aria-selected={workspaceTab === "conversation"} onClick={() => setWorkspaceTab("conversation")} className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold", workspaceTab === "conversation" ? "bg-background shadow-sm" : "text-muted-foreground")}><MessageSquare className="h-3.5 w-3.5" />Full conversation <span className="font-mono text-[9px] text-muted-foreground">{timeline.length}</span></button>
            </div>
            {workspaceTab === "summary" && <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => void refreshSummary()} loading={summaryRefreshing} loadingText="Refreshing…"><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>}
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
            {workspaceTab === "summary" ? <TicketSummaryView ticket={ticket} onOpenSource={(source, messageId) => { setWorkspaceTab("conversation"); window.setTimeout(() => document.getElementById(`${source}:${messageId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100); }} /> : <>
              {timeline.some((event) => event.restricted) && <div className="space-y-2 rounded-lg border bg-muted/20 p-3 text-xs"><p>{revealAccess.allowed ? "Restricted content is available for five minutes. Each reveal records your account and reason." : revealAccess.reason}</p>{revealAccess.allowed && <label className="block space-y-1"><span>Reason for access</span><input aria-label="Reason for restricted content access" value={revealReason} onChange={(event) => setRevealReason(event.target.value)} maxLength={500} placeholder="Explain why this customer detail is needed" className="h-9 w-full rounded-md border bg-background px-3 text-sm" /></label>}{Object.keys(revealedTimeline).length > 0 && <Button variant="outline" size="sm" onClick={() => { revealGeneration.current++; setRevealedTimeline({}); }}>Hide revealed details now</Button>}</div>}
              {timelineLoading && timeline.length === 0 ? <LoadingState className="py-16" label="Loading conversation…" /> : timeline.map((event) => <TimelineMessage key={event.key} event={event} revealed={revealedTimeline[event.key]} canReveal={revealAccess.allowed && (event.source === "conversation" || (event.source === "support_chat" && ticket.channel === "web")) && Boolean(revealReason.trim())} onReveal={() => void revealTimelineMessage(event)} ticketId={ticketId} />)}
              {timelineCursor && <div className="flex justify-center py-2"><Button variant="outline" size="sm" loading={timelineLoading} onClick={() => void fetchTimeline(timelineCursor)}>Load more conversation</Button></div>}
              <div ref={messagesEndRef} />
            </>}
          </div>

          {/* Reply Form */}
          <div className="border-t border-border/40 p-4">
            {!canOperate && (
              <div className="mb-3 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-xs text-warning" role="status">
                Claim this ticket before replying or changing its lifecycle.
              </div>
            )}
            {ticket.status === "closed" && !isInternal && (
              <div className="mb-3 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-xs text-warning" role="status">
                This ticket is closed. Reopen it to send another customer reply, or switch to an internal note for private follow-up.
              </div>
            )}
            <form onSubmit={handleSendReply} className="space-y-3">
              <textarea ref={replyTextareaRef} value={replyContent} onChange={(e) => setReplyContent(e.target.value)}
                aria-label={isInternal ? "Write an internal note" : "Write a customer reply"}
                placeholder={isInternal ? "Add a private note for the support team..." : "Type your reply..."} rows={3}
                disabled={!canOperate || (ticket.status === "closed" && !isInternal)}
                className="w-full px-4 py-3 rounded-lg border border-border/60 bg-background text-sm outline-none resize-none focus:border-primary/50 transition-all" />
              <input
                ref={attachmentInputRef}
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
                <div className="flex flex-wrap gap-1.5">
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
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-lg border select-none text-xs transition-colors",
                      isInternal ? "border-warning/20 bg-warning/5 text-warning" : "border-border/50 text-muted-foreground hover:bg-muted/50"
                    )}
                    aria-pressed={isInternal}
                    onClick={() => setIsInternal(!isInternal)}
                    disabled={isSending || !canOperate}
                  >
                    <span className={cn("w-3.5 h-3.5 rounded border flex items-center justify-center",
                      isInternal ? "border-warning bg-warning" : "border-muted-foreground/40")}>
                      {isInternal && <CheckCircle2 className="h-2.5 w-2.5 text-warning-foreground" />}
                    </span>
                    Internal Note
                  </button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 rounded-lg text-xs gap-1.5"
                    disabled={isSending || !canOperate || attachmentFiles.length >= 10 || (ticket.status === "closed" && !isInternal)}
                    onClick={() => attachmentInputRef.current?.click()}
                  >
                    <Paperclip className="h-3.5 w-3.5" />
                    Attach
                  </Button>
                </div>
                <Button type="submit" size="sm" className="h-8 w-full rounded-lg px-4 text-xs gap-1.5 sm:w-auto"
                  loading={isSending} disabled={!canOperate || !replyContent.trim() || (ticket.status === "closed" && !isInternal)}>
                  <Send className="w-3.5 h-3.5" />
                  Send Reply
                </Button>
              </div>
            </form>
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-full flex-shrink-0 space-y-3 overflow-visible lg:w-64 lg:overflow-y-auto">
          {ticket.claimable && ticket.assignedMemberId !== member?.id && (
            <Card className="rounded-xl border border-warning/30 bg-warning/[0.04] shadow-none">
              <CardContent className="space-y-3 p-4"><div><p className="flex items-center gap-1.5 text-xs font-semibold text-warning"><AlertTriangle className="h-3.5 w-3.5" />Needs an owner</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Claim this ticket before replying, moving its stage, or taking control of AI.</p></div><Button size="sm" className="w-full" loading={claimingTicket} onClick={() => void claimTicket()}>Claim ticket</Button></CardContent>
            </Card>
          )}
          {ticket.handoffId && ["waiting", "assigned", "in_progress"].includes(ticket.handoffStatus || "") && (
            <Card className={cn("rounded-xl border shadow-none", ticket.aiReplyEnabled ? "border-info/25 bg-info/[0.03]" : "border-warning/30 bg-warning/[0.04]")}>
              <CardHeader className="px-4 pb-3 pt-4">
                <CardTitle className="flex items-center gap-1.5 text-xs font-semibold">
                  {ticket.aiReplyEnabled ? <Bot className="h-3.5 w-3.5 text-info" /> : <User className="h-3.5 w-3.5 text-warning" />}
                  Customer conversation
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 px-4 pb-4 pt-0">
                <div>
                  <p className="text-xs font-semibold">{ticket.aiReplyEnabled ? "AI replies enabled" : "Human takeover"}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {ticket.aiReplyEnabled
                      ? "AI may answer verified, low-risk questions. Ticket decisions and write actions remain with the support team."
                      : "No automatic AI message will be sent until replies are enabled again or this ticket is closed."}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={ticket.aiReplyEnabled ? "outline" : "default"}
                  className="h-auto w-full whitespace-normal py-2 text-xs"
                  onClick={() => void handleAiReplyControl(!ticket.aiReplyEnabled)}
                  loading={isUpdatingAiReplies}
                  disabled={!canOperate}
                >
                  {ticket.aiReplyEnabled ? "Pause AI replies & take over" : "Enable AI replies"}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Status */}
          <Card className="border border-border/50 rounded-xl shadow-none">
            <CardHeader className="px-4 pt-4 pb-3">
              <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-info" /> Status
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0 grid grid-cols-2 gap-1.5">
              {STATUS_OPTIONS.map((opt) => (
                <button key={opt.value} onClick={() => handleUpdateTicket("status", opt.value)}
                  disabled={isUpdating || !canOperate || ticket.status === opt.value}
                  className={cn(
                    "h-8 rounded-lg text-xs font-medium uppercase tracking-wide border flex items-center justify-center gap-1 transition-all",
                    ticket.status === opt.value
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background/40 border-border/50 text-muted-foreground hover:bg-muted",
                    "disabled:opacity-60"
                  )}>
                  <opt.icon className="w-3 h-3" />
                  {opt.label}
                </button>
              ))}
            </CardContent>
            {ticket.status !== "closed" && (
              <div className="px-4 pb-4">
                <Button variant="destructive" size="sm" className="w-full h-7 rounded-lg text-xs gap-1.5"
                  disabled={!canOperate}
                  ref={closeDialogTriggerRef} onClick={() => setShowCloseDialog(true)}>
                  <XCircle className="w-3.5 h-3.5" /> Close & Review
                </Button>
              </div>
            )}
          </Card>

          {/* Review pending */}
          {ticket.status === "closed" && ticket.reviewRequestSentAt && !ticket.rating && (
            <Card className="rounded-xl border border-warning/20 bg-warning/5 shadow-none">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-1">
                  <Clock className="h-3.5 w-3.5 text-warning" />
                  <p className="text-xs font-semibold text-warning">Review Pending</p>
                </div>
                <p className="text-xs text-warning/80">Waiting since {new Date(ticket.reviewRequestSentAt).toLocaleDateString()}.</p>
              </CardContent>
            </Card>
          )}

          {/* Customer review */}
          {ticket.rating !== null && ticket.rating !== undefined && (
            <Card className="border border-border/50 rounded-xl shadow-none">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Star className="h-3.5 w-3.5 text-warning" />
                  <p className="text-xs font-semibold">Customer Review</p>
                </div>
                <div className="flex items-center gap-1 mb-2">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <Star key={star} className={cn("h-4 w-4", star <= ticket.rating! ? "fill-warning text-warning" : "text-muted-foreground/20")} />
                  ))}
                  <span className="text-sm font-bold ml-1">{ticket.rating}</span>
                </div>
                {ticket.reviewComment && (
                  <p className="text-xs text-muted-foreground italic">&ldquo;{ticket.reviewComment}&rdquo;</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Priority */}
          <Card className="border border-border/50 rounded-xl shadow-none">
            <CardHeader className="px-4 pt-4 pb-3">
              <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5 text-warning" /> Priority
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0 grid grid-cols-2 gap-1.5">
              {PRIORITY_OPTIONS.map((p) => (
                <button key={p} onClick={() => handleUpdateTicket("priority", p)}
                  disabled={isUpdating || !canOperate || ticket.priority === p}
                  className={cn(
                    "h-8 rounded-lg text-xs font-medium capitalize border transition-all",
                    ticket.priority === p ? "bg-primary text-primary-foreground border-primary" : "bg-background/40 border-border/50 text-muted-foreground hover:bg-muted",
                    "disabled:opacity-60"
                  )}>
                  {p}
                </button>
              ))}
            </CardContent>
          </Card>

          {/* Details */}
          <Card className="border border-border/50 rounded-xl shadow-none">
            <CardHeader className="px-4 pt-4 pb-3">
              <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
                <BookOpen className="h-3.5 w-3.5 text-primary" /> Details
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0 space-y-2">
              {[
                { label: "Category", value: ticket.category || "General", icon: Target },
                { label: "Created", value: new Date(ticket.createdAt).toLocaleDateString(), icon: Clock },
                { label: "Updated", value: new Date(ticket.updatedAt).toLocaleDateString(), icon: Clock },
              ].map((item, idx) => (
                <div key={idx} className="flex items-center justify-between text-xs py-1.5 border-b border-border/20 last:border-0">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <item.icon className="w-3 h-3" /> {item.label}
                  </div>
                  <span className="font-medium truncate max-w-[100px]">{item.value}</span>
                </div>
              ))}
              {ticket.tags.length > 0 && (
                <div className="pt-1 flex flex-wrap gap-1">
                  {ticket.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="h-auto rounded-md px-1.5 py-0.5 text-xs">{tag}</Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Assigned Agent */}
          <Card className="border border-border/50 rounded-xl shadow-none">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <User className="w-4 h-4 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold truncate">{member?.name || "Support Agent"}</p>
                <p className="text-xs text-muted-foreground truncate">{member?.teamName || "Support Team"}</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Close Dialog */}
      <Dialog open={showCloseDialog} onOpenChange={open => { if (!isClosing) setShowCloseDialog(open); }}>
        <DialogContent className="max-w-md [&>button]:hidden"
          onEscapeKeyDown={event => { if (isClosing) event.preventDefault(); }}
          onInteractOutside={event => { if (isClosing) event.preventDefault(); }}
          onCloseAutoFocus={event => { event.preventDefault(); closeDialogTriggerRef.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>Close Ticket</DialogTitle>
            <DialogDescription>Close this ticket and send a review request to its linked customer.</DialogDescription>
          </DialogHeader>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Review Message</span>
            <textarea value={closeReviewMessage} aria-label="Review request message"
              readOnly={isClosing} onChange={event => setCloseReviewMessage(event.target.value)} rows={4}
              className="w-full rounded-lg border border-border/60 bg-background px-4 py-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50" />
          </label>
          {isClosing && <p role="status" className="text-sm text-muted-foreground">Closing ticket. Waiting for the confirmed result…</p>}
          <DialogFooter>
            <Button variant="outline" disabled={isClosing} onClick={() => setShowCloseDialog(false)}>Cancel</Button>
            <Button variant="destructive" loading={isClosing} loadingText="Closing…" onClick={handleCloseAndRequestReview}>
              Close & Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI Chat Panel */}
      {aiChatOpen && (
        <div className="fixed inset-0 z-[var(--layer-modal)] flex justify-end">
          <div className="absolute inset-0 bg-background/30 backdrop-blur-sm" onClick={() => setAiChatOpen(false)} />
          <div className="relative w-full max-w-md bg-card border-l border-border/50 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted/35">
                  <Bot className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold">AI Assistant</p>
                  <p className="text-xs text-muted-foreground">Knowledge base powered</p>
                </div>
              </div>
              <button onClick={() => setAiChatOpen(false)}
                aria-label="Close AI assistant"
                className="h-7 w-7 rounded-md hover:bg-muted flex items-center justify-center transition-colors">
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {aiLoading ? (
                <LoadingState label="Loading assistant conversation…" />
              ) : aiMessages.length === 0 ? (
                <div className="text-center py-8 px-4">
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-md border border-border bg-muted/35">
                    <Sparkles className="h-6 w-6 text-primary/70" />
                  </div>
                  <p className="text-sm font-semibold mb-1">How can I help?</p>
                  <p className="text-xs text-muted-foreground mb-6">Full access to knowledge base and ticket history.</p>
                  <div className="space-y-2">
                    {[
                      { q: "How should I handle this issue?", icon: Zap },
                      { q: "What is our policy on this?", icon: BookOpen },
                      { q: "Draft a response for me", icon: Send },
                    ].map((item) => (
                      <button key={item.q}
                        className="w-full text-left text-xs p-3 bg-muted/30 border border-border/40 rounded-xl hover:bg-muted/60 transition-colors flex items-center justify-between gap-2"
                        onClick={() => { setAiInput(item.q); aiInputRef.current?.focus(); }}>
                        <span>{item.q}</span>
                        <item.icon className="w-3 h-3 text-muted-foreground/50 shrink-0" />
                      </button>
                    ))}
                  </div>
                </div>
              ) : aiMessages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={cn(
                    "max-w-[85%] rounded-xl px-4 py-3 text-xs",
                    msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted/50 border border-border/30"
                  )}>
                    {msg.role === "assistant" && (
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <Bot className="h-3 w-3 text-primary" />
                        <span className="text-xs font-medium text-primary">Assistant</span>
                        {msg.confidence !== null && msg.confidence > 0 && (
                          <span className="rounded-full bg-success/10 px-1.5 py-0.5 text-xs font-medium text-success">
                            {Math.round(msg.confidence * 100)}%
                          </span>
                        )}
                      </div>
                    )}
                    {msg.role === "assistant" ? (
                      <div className="prose prose-xs dark:prose-invert max-w-none text-xs">
                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{msg.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <p>{msg.content}</p>
                    )}
                    {msg.role === "assistant" && Array.isArray(msg.sources) && msg.sources.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-border/20 space-y-1">
                        <p className="text-xs text-muted-foreground">Sources:</p>
                        {msg.sources.map((src, i) => (
                          <div key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <BookOpen className="h-2.5 w-2.5" />
                            <span className="font-medium truncate">{src.title}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {msg.role === "assistant" && (
                      <div className="mt-2 pt-2 border-t border-border/20 flex justify-end">
                        <button
                          onClick={() => {
                            setReplyContent(msg.content);
                            setAiChatOpen(false);
                            setTimeout(() => replyTextareaRef.current?.focus(), 100);
                          }}
                          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
                          title="Insert this reply into the reply box">
                          <ClipboardList className="h-2.5 w-2.5" />
                          Use as Reply
                        </button>
                      </div>
                    )}
                    <div className="text-xs mt-1 opacity-50">
                      {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                </div>
              ))}
              {aiSending && (
                <div className="flex justify-start">
                  <div className="bg-muted/50 border border-border/30 rounded-xl px-4 py-3">
                    <div className="flex items-center gap-1">
                      <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:0ms]" />
                      <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:150ms]" />
                      <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:300ms]" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={aiMessagesEndRef} />
            </div>

            <div className="border-t border-border/40 p-3">
              <div className="flex items-end gap-2">
                <textarea ref={aiInputRef} value={aiInput}
                  aria-label="Ask the AI assistant"
                  onChange={(e) => setAiInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAiMessage(); } }}
                  placeholder="Ask assistant anything..."
                  rows={1}
                  className="flex-1 resize-none rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 min-h-[36px] max-h-[100px]"
                  style={{ height: "auto", overflow: "hidden" }}
                  onInput={(e) => { const el = e.currentTarget; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 100) + "px"; }}
                  disabled={aiSending} />
                <button onClick={sendAiMessage} disabled={!aiInput.trim() || aiSending}
                  aria-label="Send message to AI assistant"
                  className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50">
                  {aiSending ? <Spinner size="xs" label={null} /> : <Send className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TicketSummaryView({ ticket, onOpenSource }: { ticket: TicketDetail; onOpenSource: (source: string, messageId: number) => void }) {
  const summary = ticket.summary?.summary;
  const statusLabel = ticket.summary?.status === "current" ? "Current" : ticket.summary?.status === "generating" ? "Updating" : ticket.summary?.status === "failed" ? "Generation failed" : "Out of date";
  const statusTone = ticket.summary?.status === "current" ? "bg-success/10 text-success" : ticket.summary?.status === "failed" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning";
  const sections = [
    { label: "Important facts", items: summary?.importantFacts || [] },
    { label: "Actions attempted", items: summary?.actionsAttempted || [] },
    { label: "Unresolved questions", items: summary?.unresolvedQuestions || [] },
  ];
  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-border/60 bg-muted/15 p-4"><div className="min-w-0"><div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /><h2 className="text-sm font-semibold">Conversation brief</h2></div><p className="mt-2 text-sm leading-6">{summary?.issue || ticket.description || "The conversation summary is being prepared."}</p></div><div className="text-right"><Badge className={cn("border-0 text-[10px]", statusTone)}>{statusLabel}</Badge>{ticket.summary?.generatedAt && <p className="mt-1 text-[9px] text-muted-foreground">{new Date(ticket.summary.generatedAt).toLocaleString()}</p>}</div></div>
    {ticket.summary?.status === "failed" && <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{ticket.summary.error || "The summary could not be generated. The full conversation remains available."}</div>}
    <div className="grid gap-3 md:grid-cols-2">
      <SummaryPanel title="Customer intent" icon={Target}><p className="text-sm leading-6">{summary?.customerIntent || ticket.description || "Not yet identified."}</p></SummaryPanel>
      <SummaryPanel title="Recommended next action" icon={CircleDot}><p className="text-sm leading-6">{summary?.recommendedNextAction || "Review the full conversation before replying."}</p></SummaryPanel>
    </div>
    <div className="grid gap-3 lg:grid-cols-3">{sections.map((section) => <SummaryPanel key={section.label} title={section.label} icon={ClipboardList}>{section.items.length ? <ul className="space-y-2">{section.items.map((item, index) => <li key={`${item}-${index}`} className="flex gap-2 text-xs leading-5"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary" />{item}</li>)}</ul> : <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>}</SummaryPanel>)}</div>
    {(summary?.sentiment || summary?.risk || ticket.handoffReason) && <SummaryPanel title="Risk and handoff context" icon={ShieldCheck}><div className="grid gap-3 sm:grid-cols-3"><SummaryDatum label="Sentiment" value={summary?.sentiment || "Not detected"} /><SummaryDatum label="Risk" value={summary?.risk || "No specific risk recorded"} /><SummaryDatum label="Why AI paused" value={ticket.handoffReason || "No active handoff"} /></div></SummaryPanel>}
    {!!summary?.sourceReferences?.length && <SummaryPanel title="Sources" icon={Quote}><div className="flex flex-wrap gap-2">{summary.sourceReferences.map((reference, index) => <button key={`${reference.source}-${reference.messageId}-${index}`} type="button" onClick={() => onOpenSource(reference.source, reference.messageId)} className="rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-left text-xs text-primary hover:border-primary/40 hover:bg-primary/[0.04]">{reference.label}</button>)}</div></SummaryPanel>}
  </div>;
}

function SummaryPanel({ title, icon: Icon, children }: { title: string; icon: typeof Target; children: ReactNode }) {
  return <section className="rounded-2xl border border-border/60 bg-card p-4"><div className="mb-3 flex items-center gap-2"><Icon className="h-3.5 w-3.5 text-primary" /><h3 className="text-xs font-semibold">{title}</h3></div>{children}</section>;
}

function SummaryDatum({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</p><p className="mt-1 text-xs leading-5">{value}</p></div>;
}

function TimelineMessage({ event, revealed, canReveal, onReveal, ticketId }: { event: TimelineEvent; revealed?: string; canReveal: boolean; onReveal: () => void; ticketId: string }) {
  if (event.type === "system") return <div id={event.key} className="flex justify-center py-1"><div className="max-w-xl rounded-full border border-border/50 bg-muted/30 px-3 py-1.5 text-center text-[10px] text-muted-foreground">{event.content} · {new Date(event.createdAt).toLocaleString()}</div></div>;
  const outbound = event.direction === "outbound";
  const internal = event.type === "internal_note";
  const content = revealed || event.content;
  return <article id={event.key} className={cn("flex scroll-mt-28", outbound ? "justify-end" : "justify-start")}><div className={cn("max-w-[92%] break-words rounded-2xl border px-3 py-3 sm:max-w-[82%] sm:px-4", internal ? "w-full border-warning/25 bg-warning/[0.05]" : outbound ? "border-primary/20 bg-primary/[0.07]" : "border-border/50 bg-muted/30", revealed && "border-warning bg-warning/10 text-warning")}><div className="mb-1.5 flex items-center justify-between gap-4"><div className="flex items-center gap-1.5">{internal ? <Lock className="h-3 w-3 text-warning" /> : outbound ? <ShieldCheck className="h-3 w-3 text-primary" /> : <User className="h-3 w-3 text-muted-foreground" />}<span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{internal ? "Internal note" : outbound ? event.actorName || "Support" : "Customer"}</span><span className="rounded bg-muted px-1 py-0.5 text-[8px] uppercase text-muted-foreground">{event.source.replace("_", " ")}</span></div><span className="text-[9px] text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</span></div>{event.restricted && !revealed && <Button type="button" size="sm" variant="outline" className="mb-2 h-7 text-xs" disabled={!canReveal} onClick={onReveal}>Reveal restricted content</Button>}<div className="prose prose-sm max-w-none text-xs leading-relaxed dark:prose-invert">{content.trim().startsWith("<") && content.trim().includes(">") ? <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content) }} /> : <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{content}</ReactMarkdown>}</div>{event.attachments.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{event.attachments.map((attachment, index) => attachment.fileId && event.source === "ticket" ? <a key={`${attachment.fileId}-${index}`} href={`/api/support-portal/tickets/${ticketId}/attachments/${attachment.fileId}`} className="inline-flex max-w-56 items-center gap-1 rounded-md border border-border/60 bg-background/70 px-2 py-1 text-xs"><FileText className="h-3.5 w-3.5" /><span className="truncate">{attachment.name || attachment.fileName || "Attachment"}</span></a> : <span key={index} className="inline-flex max-w-56 items-center gap-1 rounded-md border border-border/60 bg-background/70 px-2 py-1 text-xs"><FileText className="h-3.5 w-3.5" /><span className="truncate">{attachment.name || attachment.fileName || "Channel attachment"}</span></span>)}</div>}{(event.deliveryStatus || event.deliveryError) && <div className={cn("mt-2 text-[9px] text-muted-foreground", event.deliveryError && "text-destructive")}>{event.deliveryError || `Delivery: ${event.deliveryStatus}`}</div>}</div></article>;
}
