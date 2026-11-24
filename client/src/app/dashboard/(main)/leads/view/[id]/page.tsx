"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Edit, Trash2, ChevronRight, Shield, Star, MessageSquare, Zap, Bot, ChevronDown, Clock, Sparkles } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { api } from '@/lib/api';
import { formatLeadStatus, getLeadStatus } from '../../../../../../../../shared/leadStatus';
import { formatLeadLocation } from '../../../../../../../../shared/leadDisplayValues';
import { LeadDetailSkeleton } from "@/components/skeletons";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import { PageErrorState } from "@/components/ui/page-state";
import { PageShell } from "@/components/ui/page-shell";

interface Lead {
  id: number;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  role: string | null;
  headline: string | null;
  location: string | Record<string, unknown> | null;
  website: string | null;
  linkedin: string | null;
  twitter: string | null;
  linkedinUsername: string | null;
  linkedinUrl?: string | null;
  score: number;
  fitScore: number | null;
  relevanceScore: number | null;
  qualityScore: number | null;
  source: string;
  leadType?: string;
  platformType?: string;
  status: string | null;
  leadStatus?: string | null;
  verificationStatus: string | null;
  createdAt: string;
  updatedAt: string | null;
  // Engagement fields
  messagesSent?: number;
  messagesReceived?: number;
  inboxReplies?: number;
  openedEmails?: number;
  clickedLinks?: number;
  lastContactedAt?: string;
  firstContactedAt?: string;
  // Enriched data fields
  industry: string | null;
  companyDescription: string | null;
  companySize: string | null;
  companyDomain: string | null;
  campaignData?: {
    name?: string;
    id?: number;
  };
  enrichedData?: Record<string, unknown>;
  rawData?: Record<string, unknown>;
}

interface SupportChatMessage {
  id: number;
  role: string;
  content: string;
  createdAt: string;
}

interface SupportSession {
  id: number;
  title: string | null;
  metadata: { source?: string; visitorName?: string; visitorEmail?: string } | null;
  messageCount: number;
  lastMessage: { content: string; role: string; createdAt: string } | null;
  memberName: string;
  createdAt: string;
  updatedAt: string;
}

// --- Helper Components ---

function InfoCard({ title, children, rightElement }: { title: string, children: React.ReactNode, rightElement?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-[14px] font-bold text-foreground uppercase tracking-wider font-heading">{title}</h3>
        {rightElement}
      </div>
      <div className="space-y-4 flex-1">
        {children}
      </div>
    </div>
  );
}

function InfoItem({ label, value }: { label: string, value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <div className="text-sm leading-snug text-foreground">{value === null || value === undefined || value === '' ? '—' : value}</div>
    </div>
  );
}

export default function LeadViewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();

  const [lead, setLead] = useState<Lead | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [supportSessions, setSupportSessions] = useState<SupportSession[]>([]);
  const [expandedSession, setExpandedSession] = useState<number | null>(null);
  const [sessionMessages, setSessionMessages] = useState<Record<number, SupportChatMessage[]>>({});
  const [isDeepEnriching, setIsDeepEnriching] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchLead = async () => {
      try {
        setIsLoading(true);
        setLoadError(null);
        const data = await api.get<Lead>(`/api/leads/${id}`);
        if (cancelled) return;
        setLead(data);
      } catch (error: unknown) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Failed to fetch lead details";
        toast({
          title: "Error",
          description: message,
          variant: "destructive",
        });
        setLoadError(message);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    if (id) {
      fetchLead();
    }
    return () => { cancelled = true; };
  }, [id, router, toast]);

  // Fetch support chat sessions for this lead
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setSupportSessions([]);
    setSessionMessages({});
    setExpandedSession(null);
    api.get<SupportSession[]>(`/api/support/ai/sessions/by-lead/${id}`)
      .then((data) => {
        if (!cancelled && Array.isArray(data)) setSupportSessions(data);
      })
      .catch(() => { /* silently ignore - lead may not have support sessions */ });
    return () => { cancelled = true; };
  }, [id]);

  const toggleSessionMessages = async (sessionId: number) => {
    if (expandedSession === sessionId) {
      setExpandedSession(null);
      return;
    }
    setExpandedSession(sessionId);
    if (!sessionMessages[sessionId]) {
      try {
        const msgs = await api.get<SupportChatMessage[]>(`/api/support/ai/sessions/${sessionId}/messages`);
        if (Array.isArray(msgs)) {
          setSessionMessages((prev) => ({ ...prev, [sessionId]: msgs }));
        }
      } catch {
        // ignore
      }
    }
  };

  const handleDelete = async () => {
    setShowDeleteDialog(false);

    try {
      setIsDeleting(true);
      await api.delete(`/api/leads/${id}`);
      toast({
        title: "Success",
        description: "Lead deleted successfully",
      });
      router.push("/dashboard/leads");
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete lead",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeepEnrich = async () => {
    try {
      setIsDeepEnriching(true);
      await api.post<{ jobId: string; correlationId: string }>(`/api/leads/${id}/deep-enrich`, { async: true });
      toast({
        title: "Enrichment queued",
        description: "You can follow progress from the enrichment activity page.",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to run deep enrichment",
        variant: "destructive",
      });
    } finally {
      setIsDeepEnriching(false);
    }
  };

  if (isLoading) {
    return <LeadDetailSkeleton />;
  }

  if (loadError) {
    return (
      <PageErrorState
        title="Lead unavailable"
        description={loadError}
        reset={() => window.location.reload()}
      />
    );
  }

  if (!lead) {
    return (
      <div className="p-6">
        <div className="text-center">
          <p className="text-muted-foreground">Lead not found</p>
          <Button
            variant="outline"
            onClick={() => router.push("/dashboard/leads")}
            className="mt-4"
          >
            Back to Leads
          </Button>
        </div>
      </div>
    );
  }

  return (
    <PageShell className="overflow-x-hidden">
      <div className="relative z-10 w-full space-y-5">
        {/* Header Section */}
        <div className="flex flex-col gap-3">
          <nav className="flex items-center gap-1.5 text-[14px]" style={{ letterSpacing: '0.5px' }}>
            <button
              onClick={() => router.push("/dashboard/leads")}
              className="text-muted-foreground font-semibold hover:text-foreground transition-colors"
            >
              Lead List
            </button>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <span className="text-xs font-normal text-muted-foreground">{lead.name || `${lead.firstName} ${lead.lastName}`.trim() || "Unknown"} Lead Details</span>
          </nav>

          <div className="flex flex-col justify-between gap-4 pb-0.5 sm:flex-row sm:items-end">
            <div>
              <h1 className="text-2xl font-black tracking-tighter text-foreground leading-none" style={{ letterSpacing: '0.5px' }}>
                {lead.name || `${lead.firstName} ${lead.lastName}`.trim() || "Unknown"}
              </h1>
              {(lead.role || lead.company) && (
                <p className="text-[20px] text-muted-foreground font-medium mt-1 font-heading" style={{ letterSpacing: '0.5px' }}>
                  {lead.role || ""}{lead.role && lead.company && <span className="mx-1 opacity-30">·</span>}{lead.company || ""}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDeepEnrich}
                loading={isDeepEnriching}
                loadingText="Queueing…"
                className="h-9 rounded-md border-primary/30 bg-primary/10 px-3 text-xs font-semibold text-primary hover:bg-primary/15"
              >
                <Sparkles className="w-3 h-3 mr-1" />
                Deep Enrich
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push(`/dashboard/leads/edit/${id}`)}
                className="h-9 rounded-md px-3 text-xs font-semibold"
              >
                <Edit className="w-3 h-3 mr-1 opacity-40" />
                Edit
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowDeleteDialog(true)}
                disabled={isDeleting}
                className="h-9 rounded-md px-3 text-xs font-semibold"
              >
                <Trash2 className="w-3 h-3 mr-1" />
                Delete
              </Button>
            </div>
          </div>
        </div>


        {/* top Metrics Grid */}
        <StatGrid columns={4} className="gap-5">
          <StatCard
            icon={<Zap className="text-violet-500/80" />}
            label="Status"
            value={formatLeadStatus(getLeadStatus(lead))}
          />
          <StatCard
            icon={<Shield className="text-purple-500/80" />}
            label="Quality Score"
            value={(lead.qualityScore ?? lead.score) != null ? `${lead.qualityScore ?? lead.score}%` : null}
          />
          <StatCard
            icon={<Star className="text-indigo-500/80" />}
            label="Source"
            value={lead.platformType || lead.source || null}
          />
          {lead.campaignData?.name && (
            <StatCard
              icon={<MessageSquare className="text-rose-500/80" />}
              label="Campaign"
              value={lead.campaignData.name}
            />
          )}
        </StatGrid>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
          {/* Information Cards Grid */}
          <InfoCard title="Contact Info">
            <InfoItem label="Email" value={lead.email ? <a href={`mailto:${lead.email}`} className="font-bold text-primary transition-opacity hover:opacity-70">{lead.email}</a> : "—"} />
            <InfoItem label="Phone" value={lead.phone ? <a href={`tel:${lead.phone}`} className="text-foreground hover:opacity-70 transition-opacity font-bold">{lead.phone}</a> : "—"} />
            <div className="grid grid-cols-2 gap-4">
              <InfoItem label="Company Size" value={lead.companySize || "—"} />
              <InfoItem label="Industry" value={lead.industry || "—"} />
            </div>
          </InfoCard>

          <InfoCard title="Context" rightElement={lead.linkedinUrl ? <a href={lead.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-primary text-[10px] font-black hover:opacity-70 uppercase tracking-widest transition-opacity">View Profile</a> : undefined}>
            <InfoItem label="Campaign" value={lead.campaignData?.name || "—"} />
            <InfoItem label="Channel" value={lead.platformType || "—"} />
            <InfoItem label="Started" value={lead.firstContactedAt ? new Date(lead.firstContactedAt).toLocaleDateString() : "—"} />
          </InfoCard>

          <InfoCard title="Engagement">
            <div className="grid grid-cols-2 gap-y-6">
              <InfoItem label="Sent" value={lead.messagesSent ?? 0} />
              <InfoItem label="Inbox replies" value={lead.inboxReplies ?? 0} />
              <InfoItem label="Opened" value={lead.openedEmails ?? 0} />
              <InfoItem label="Clicked" value={lead.clickedLinks ?? 0} />
            </div>
          </InfoCard>

          <InfoCard title="Details">
            <InfoItem label="Lead Type" value={lead.leadType || "—"} />
            <InfoItem label="Location" value={formatLeadLocation(lead.location) || "—"} />
            {lead.headline && <InfoItem label="Headline" value={lead.headline} />}
            <InfoItem label="Created" value={new Date(lead.createdAt).toLocaleDateString()} />
          </InfoCard>
        </div>



        {/* Support Chat Conversations */}
        {supportSessions.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Bot className="w-5 h-5 text-violet-500" />
              <h2 className="text-[18px] font-bold text-foreground font-heading uppercase tracking-tight">Support Chat Conversations</h2>
              <Badge variant="secondary" className="text-xs">{supportSessions.length}</Badge>
            </div>
            <div className="space-y-3">
              {supportSessions.map((session) => (
                <div key={session.id} className="overflow-hidden rounded-xl border bg-card transition-all">
                  <button
                    onClick={() => toggleSessionMessages(session.id)}
                    className="flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-muted/50"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="truncate text-sm font-semibold text-foreground">
                          {session.title || "Support Chat"}
                        </span>
                        {session.metadata?.source === "widget" && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">Widget</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <MessageSquare className="w-3 h-3" />
                          {session.messageCount} messages
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(session.updatedAt || session.createdAt).toLocaleDateString()}
                        </span>
                        <span>via {session.memberName}</span>
                      </div>
                      {session.lastMessage && (
                        <p className="mt-1 truncate text-[13px] text-muted-foreground">
                          {session.lastMessage.role === "assistant" ? "AI: " : "User: "}
                          {session.lastMessage.content.substring(0, 100)}
                        </p>
                      )}
                    </div>
                    <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expandedSession === session.id ? "rotate-180" : ""}`} />
                  </button>

                  {expandedSession === session.id && (
                    <div className="max-h-[400px] space-y-3 overflow-y-auto border-t px-4 py-3">
                      {!sessionMessages[session.id] ? (
                        <div className="flex items-center justify-center py-4">
                          <Spinner size="sm" label="Loading messages" className="text-violet-400" />
                        </div>
                      ) : sessionMessages[session.id].length === 0 ? (
                        <p className="py-2 text-center text-[13px] text-muted-foreground">No messages</p>
                      ) : (
                        sessionMessages[session.id].map((msg) => (
                          <div
                            key={msg.id}
                            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                          >
                            <div className={`max-w-[80%] rounded-xl px-3.5 py-2.5 ${
                              msg.role === "user"
                                ? "bg-primary/10 text-foreground"
                                : "border bg-background text-foreground"
                            }`}>
                              <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                              <p className="mt-1 text-[10px] text-muted-foreground">
                                {new Date(msg.createdAt).toLocaleString()}
                              </p>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="pb-8" />
      </div>

      <ConfirmDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        onConfirm={handleDelete}
        title="Delete Lead"
        description="Are you sure you want to delete this lead? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />
    </PageShell>
  );
}
