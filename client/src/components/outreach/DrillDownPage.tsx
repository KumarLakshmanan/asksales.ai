"use client";
import { RelatedProposals } from "@/components/proposals/RelatedProposals";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ConversationLoadMore } from "@/components/outreach/ConversationLoadMore";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { IntegrationRequired } from "@/components/IntegrationRequired";
import { PageErrorState, PageLoadingState } from "@/components/ui/page-state";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";
import {
  useOutreachPage,
  scrollElementToNearestBottom,
  OutreachMessageBubble,
  OutreachComposeArea,
  OutreachDeleteDialog,
  TemplateSelector,
  OfficialApiStatus,
} from "@/components/outreach";
import type { OutreachConversation, OutreachChannel } from "@/components/outreach";
import {
  Sparkles,
  LayoutTemplate,
  RefreshCw,
  Plus,
  ArrowLeft,
  Users,
  MessageSquare,
  Clock,
  Inbox,
  Filter,
  CheckCircle,
  Trash2,
  MoreVertical,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { ConversationHeader } from "@/components/conversation/ConversationHeader";

// ─── Config Types ──────────────────────────────────────────────────
export interface DrillDownPageConfig {
  channel: Extract<OutreachChannel, "linkedin" | "twitter">;
  icon: LucideIcon;
  displayName: string;
  iconBgClass: string;
  iconTextClass: string;
  selectedBorderClass: string;
  selectedBgClass: string;
  selectedRingClass: string;
  integrationName: string;
  integrationDescription: string;
  iconColorClass: string;
  features: string[];
  integrationPath: string;
  oauthEndpoint: string;
  messagesEndpoint: (convId: number) => string;
  leadHandleField: string;
  formatLeadSubtext: (lead: { handle: string | null; company: string | null }) => string;
  formatConversationSubtext: (conv: OutreachConversation | null, lead: { handle: string | null } | null) => string;
  formatDraftPrompt: (leadName: string) => string;
  formatSentToast: () => string;
  formatEmptyStateTitle: () => string;
  formatEmptyStateDescription: () => string;
  formatNewDraftTitle: () => string;
  formatNewDraftDescription: (leadName: string) => string;
}

// ─── Types ────────────────────────────────────────────────────────
interface LeadGroup {
  leadId: number;
  leadName: string | null;
  leadHandle: string | null;
  leadCompany: string | null;
  leadAvatar: string | null;
  conversationCount: number;
  totalMessages: number;
  unreadCount: number;
  lastMessageAt: string | null;
  conversations: OutreachConversation[];
}

type ViewMode = "leads" | "conversations" | "messages";
type SortBy = "recent" | "unread" | "name" | "messages";

export default function DrillDownPage({ config }: { config: DrillDownPageConfig }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ─── Connection State ──────────────────────────────────────────
  const [isConnected, setIsConnected] = useState(false);
  const [checkingConnection, setCheckingConnection] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionRetry, setConnectionRetry] = useState(0);
  const [officialApiConnected, setOfficialApiConnected] = useState(false);
  const [dailyLimit, setDailyLimit] = useState(50);
  const [sentToday, setSentToday] = useState(0);

  // ─── UI State ──────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>("leads");
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);
  const [selectedLead, setSelectedLead] = useState<LeadGroup | null>(null);
  const [leadSearchQuery, setLeadSearchQuery] = useState("");
  const [conversationSearchQuery, setConversationSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("recent");
  const [generatingAI, setGeneratingAI] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [draftMode, setDraftMode] = useState(false);
  const [templateSelectorOpen, setTemplateSelectorOpen] = useState(false);

  // ─── Outreach Hook ──────────────────────────────────────────────
  const outreach = useOutreachPage({
    channel: config.channel,
    autoLoad: false,
  });

  // ─── Group conversations by lead ────────────────────────────────
  const leadGroups = useMemo<LeadGroup[]>(() => {
    const groups = new Map<number, LeadGroup>();

    for (const conv of outreach.conversations) {
      const existing = groups.get(conv.leadId);
      if (existing) {
        existing.conversationCount++;
        existing.totalMessages += conv.totalMessages;
        existing.unreadCount += conv.unreadCount;
        existing.conversations.push(conv);
        if (conv.lastMessageAt && (!existing.lastMessageAt || conv.lastMessageAt > existing.lastMessageAt)) {
          existing.lastMessageAt = conv.lastMessageAt;
        }
      } else {
        groups.set(conv.leadId, {
          leadId: conv.leadId,
          leadName: conv.leadName,
          leadHandle: ((conv as unknown as Record<string, unknown>)[config.leadHandleField] as string) || null,
          leadCompany: conv.leadCompany,
          leadAvatar: conv.leadAvatar,
          conversationCount: 1,
          totalMessages: conv.totalMessages,
          unreadCount: conv.unreadCount,
          lastMessageAt: conv.lastMessageAt,
          conversations: [conv],
        });
      }
    }

    const sorted = Array.from(groups.values());
    switch (sortBy) {
      case "unread":
        sorted.sort((a, b) => b.unreadCount - a.unreadCount);
        break;
      case "name":
        sorted.sort((a, b) => (a.leadName || "").localeCompare(b.leadName || ""));
        break;
      case "messages":
        sorted.sort((a, b) => b.totalMessages - a.totalMessages);
        break;
      case "recent":
      default:
        sorted.sort((a, b) => {
          if (!a.lastMessageAt) return 1;
          if (!b.lastMessageAt) return -1;
          return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
        });
    }

    return sorted;
  }, [outreach.conversations, sortBy, config.leadHandleField]);

  // ─── Filtered lead groups ──────────────────────────────────────
  const filteredLeadGroups = useMemo(() => {
    if (!leadSearchQuery.trim()) return leadGroups;
    const query = leadSearchQuery.toLowerCase();
    return leadGroups.filter(
      (lead) =>
        lead.leadName?.toLowerCase().includes(query) ||
        lead.leadHandle?.toLowerCase().includes(query) ||
        lead.leadCompany?.toLowerCase().includes(query)
    );
  }, [leadGroups, leadSearchQuery]);

  // ─── Filtered conversations for selected lead ───────────────────
  const filteredConversations = useMemo(() => {
    if (!selectedLead) return [];
    const convs = selectedLead.conversations;
    if (!conversationSearchQuery.trim()) return convs;
    const query = conversationSearchQuery.toLowerCase();
    return convs.filter((conv) =>
      conv.lastMessagePreview?.toLowerCase().includes(query)
    );
  }, [selectedLead, conversationSearchQuery]);

  const totalLeads = leadGroups.length;
  const totalUnread = leadGroups.reduce((sum, lg) => sum + lg.unreadCount, 0);

  const selectedLeadIdParam = useMemo(() => {
    const raw = searchParams.get("leadId");
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }, [searchParams]);

  const selectedConversationIdParam = useMemo(() => {
    const raw = searchParams.get("conversationId");
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }, [searchParams]);

  const updatePageUrl = useCallback(
    (leadId?: number | null, conversationId?: number | null) => {
      const params = new URLSearchParams();
      if (leadId) params.set("leadId", String(leadId));
      if (conversationId) params.set("conversationId", String(conversationId));
      const query = params.toString();
      router.replace(query ? `/dashboard/outreach/${config.channel}?${query}` : `/dashboard/outreach/${config.channel}`);
    },
    [router, config.channel]
  );

  // Keep selectedLead in sync
  useEffect(() => {
    if (!selectedLead) return;
    const updated = leadGroups.find((lg) => lg.leadId === selectedLead.leadId);
    if (!updated) {
      setSelectedLead(null);
      setViewMode("leads");
      updatePageUrl(null, null);
      return;
    }
    if (updated !== selectedLead) {
      setSelectedLead(updated);
    }
  }, [leadGroups, selectedLead, updatePageUrl]);

  // Check official API connection status
  useEffect(() => {
    const checkConnection = async () => {
      try {
        const oauthRes = await api.get<{ officialApi?: { connected: boolean } }>(config.oauthEndpoint);
        const connected = Boolean(oauthRes.officialApi?.connected);
        setOfficialApiConnected(connected);
        setIsConnected(connected);
        setConnectionError(null);
        if (connected) outreach.loadConversations();

        try {
          const dailyRes = await api.get<{
            stats?: Record<string, { sentToday: number; dailyLimit: number }>;
          }>("/api/outreach-conversations/daily-stats");
          const channelStats = dailyRes.stats?.[config.channel];
          if (channelStats) {
            setSentToday(channelStats.sentToday);
            setDailyLimit(channelStats.dailyLimit);
          }
        } catch {
          // Keep the conservative default limit.
        }
      } catch (error) {
        setIsConnected(false);
        setConnectionError(error instanceof Error ? error.message : `${config.integrationName} connection status could not be checked.`);
      } finally {
        setCheckingConnection(false);
      }
    };
    void checkConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionRetry]);

  // Scroll to bottom when new messages
  useEffect(() => {
    if (viewMode === "messages" && outreach.messages.length > 0) {
      scrollElementToNearestBottom(messagesEndRef.current);
    }
  }, [viewMode, outreach.messages.length]);

  // URL param deep-link
  useEffect(() => {
    if (!leadGroups.length || !selectedLeadIdParam) return;
    if (draftMode) return;

    const matchedLead = leadGroups.find((lead) => lead.leadId === selectedLeadIdParam);
    if (!matchedLead) return;

    if (!selectedLead || selectedLead.leadId !== matchedLead.leadId) {
      setSelectedLead(matchedLead);
      setConversationSearchQuery("");
    }

    if (selectedConversationIdParam) {
      const matchedConversation = matchedLead.conversations.find(
        (conversation) => conversation.id === selectedConversationIdParam
      );
      if (matchedConversation) {
        if (outreach.selectedConversation?.id !== matchedConversation.id) {
          outreach.handleSelectConversation(matchedConversation);
        }
        setViewMode("messages");
        return;
      }
    }

    if (outreach.selectedConversation) {
      outreach.setSelectedConversation(null);
    }
    setViewMode("conversations");
  }, [leadGroups, selectedLeadIdParam, selectedConversationIdParam, selectedLead, outreach, draftMode]);

  // ─── Handlers ──────────────────────────────────────────────────
  const handleSelectLead = useCallback((lead: LeadGroup) => {
    setSelectedLead(lead);
    setConversationSearchQuery("");

    if (lead.conversations.length > 0) {
      const sorted = [...lead.conversations].sort((a, b) => {
        const dateA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
        const dateB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
        return dateB - dateA;
      });
      const latest = sorted[0];
      setDraftMode(false);
      outreach.handleSelectConversation(latest);
      setViewMode("messages");
      updatePageUrl(lead.leadId, latest.id);
    } else {
      outreach.setSelectedConversation(null);
      outreach.setNewMessage("");
      setDraftMode(true);
      setViewMode("messages");
      updatePageUrl(lead.leadId, null);
    }
  }, [outreach, updatePageUrl]);

  const handleSelectConversation = useCallback((conv: OutreachConversation) => {
    setDraftMode(false);
    outreach.handleSelectConversation(conv);
    setViewMode("messages");
    updatePageUrl(conv.leadId, conv.id);
  }, [outreach, updatePageUrl]);

  const handleBackToLeads = useCallback(() => {
    setSelectedLead(null);
    setConversationSearchQuery("");
    outreach.setSelectedConversation(null);
    setDraftMode(false);
    setViewMode("leads");
    updatePageUrl(null, null);
  }, [outreach, updatePageUrl]);

  const handleBackToConversations = useCallback(() => {
    outreach.setSelectedConversation(null);
    setDraftMode(false);
    setViewMode("conversations");
    updatePageUrl(selectedLead?.leadId || null, null);
  }, [outreach, selectedLead?.leadId, updatePageUrl]);

  const handleNewConversation = useCallback(async () => {
    if (!selectedLead) return;
    outreach.setSelectedConversation(null);
    outreach.setNewMessage("");
    setDraftMode(true);
    setViewMode("messages");
    updatePageUrl(selectedLead.leadId, null);
  }, [selectedLead, outreach, updatePageUrl]);

  const handleAIGenerate = async () => {
    if (outreach.selectedConversation) {
      setGeneratingAI(true);
      try { await outreach.handleGenerateComposerReply(); }
      finally { setGeneratingAI(false); }
      return;
    }
    const leadId = selectedLead?.leadId;
    if (!leadId) return;
    try {
      setGeneratingAI(true);
      const response = await api.post<{ content?: string; message?: string }>("/api/content/studio/social-message", {
        prompt: config.formatDraftPrompt(selectedLead?.leadName || "prospect"),
        platform: config.channel,
        persist: false,
      });
      const msg = response.message || response.content || "";
      if (msg) outreach.setNewMessage(msg);
      toast({ title: "AI Generated", description: "Message has been generated for you." });
    } catch {
      toast({ title: "Error", description: "Failed to generate message", variant: "destructive" });
    } finally {
      setGeneratingAI(false);
    }
  };

  const handleDraftSend = async () => {
    if (!selectedLead) return;
    const messageContent = outreach.newMessage.trim();
    if (!messageContent) {
      toast({ title: "Error", description: "Please enter a message", variant: "destructive" });
      return;
    }
    try {
      setCreatingConversation(true);
      const response = await api.post<{ conversation: OutreachConversation }>("/api/outreach-conversations", {
        leadId: selectedLead.leadId,
        channel: config.channel,
        forceNew: true,
      });
      if (!response.conversation) {
        toast({ title: "Error", description: "Failed to create conversation", variant: "destructive" });
        return;
      }
      const newConv = response.conversation;
      await api.post(config.messagesEndpoint(newConv.id), { content: messageContent });
      setDraftMode(false);
      outreach.setNewMessage("");
      outreach.handleSelectConversation(newConv);
      await outreach.loadConversations();
      toast({ title: "Sent", description: config.formatSentToast() });
    } catch {
      toast({ title: "Error", description: `Failed to send ${config.displayName} message`, variant: "destructive" });
    } finally {
      setCreatingConversation(false);
    }
  };

  const handleRefreshStatus = async () => {
    try {
      const result = await api.get<{ officialApi?: { connected: boolean } }>(config.oauthEndpoint);
      const connected = Boolean(result.officialApi?.connected);
      setOfficialApiConnected(connected);
      setIsConnected(connected);
      if (connected) outreach.loadConversations();
      toast({ title: "Refreshed", description: "Connection status updated" });
    } catch {
      toast({ title: "Error", description: "Failed to refresh status", variant: "destructive" });
    }
  };

  const Icon = config.icon;

  // ─── Loading / Not Connected ───────────────────────────────────
  if (checkingConnection) {
    return <PageLoadingState label={`Checking the ${config.integrationName} connection…`} />;
  }

  if (connectionError) {
    return (
      <PageErrorState
        title={`${config.integrationName} connection status could not be loaded`}
        description={connectionError}
        reset={() => {
          setCheckingConnection(true);
          setConnectionError(null);
          setConnectionRetry((value) => value + 1);
        }}
      />
    );
  }

  if (!isConnected) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center overflow-hidden p-8">
        <IntegrationRequired
          integrationName={config.integrationName}
          description={config.integrationDescription}
          icon={config.icon}
          iconColorClass={config.iconColorClass}
          features={config.features}
          integrationPath={config.integrationPath}
        />
      </div>
    );
  }

  // ─── Main Layout ───────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <OfficialApiStatus
        officialApiConnected={officialApiConnected}
        dailyLimit={dailyLimit}
        sentToday={sentToday}
        onRefreshStatus={handleRefreshStatus}
        onSettingsClick={() => router.push(config.integrationPath)}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* ─── Panel 1: Leads List ─────────────────────────────────── */}
      <AnimatePresence mode="popLayout">
        {(viewMode === "leads" || !isMobile) && (
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className={cn(
              "w-72 border-r bg-card flex flex-col relative z-20",
              viewMode !== "leads" && "hidden md:flex"
            )}
          >
            <div className="p-4 border-b space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center shrink-0", config.iconBgClass)}>
                    <Icon className={cn("w-4 h-4", config.iconTextClass)} />
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold leading-tight">{config.displayName}</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">{totalLeads} leads · {totalUnread > 0 ? `${totalUnread} unread` : "all read"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full hover:bg-muted"
                    onClick={outreach.handleSync}
                    disabled={outreach.syncing}
                  >
                    <RefreshCw className={cn("w-4 h-4", outreach.syncing && "animate-spin")} />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full hover:bg-muted">
                        <Filter className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuLabel className="text-[10px] uppercase tracking-wider">Sort by</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setSortBy("recent")} className="text-sm">
                        <Clock className="w-4 h-4 mr-2" />
                        Recent
                        {sortBy === "recent" && <CheckCircle className="w-4 h-4 ml-auto text-primary" />}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setSortBy("unread")} className="text-sm">
                        <Inbox className="w-4 h-4 mr-2" />
                        Unread
                        {sortBy === "unread" && <CheckCircle className="w-4 h-4 ml-auto text-primary" />}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setSortBy("name")} className="text-sm">
                        <Users className="w-4 h-4 mr-2" />
                        Name
                        {sortBy === "name" && <CheckCircle className="w-4 h-4 ml-auto text-primary" />}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              <SearchInput
                size="sm"
                aria-label="Search leads"
                placeholder="Search leads..."
                value={leadSearchQuery}
                onValueChange={setLeadSearchQuery}
                className="rounded-lg border-border/60"
              />
            </div>

            <ScrollArea className="flex-1" viewportClassName="[&>div]:!block">
              {outreach.loading ? (
                <div className="p-3 space-y-2">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3 p-3 border border-border/30 rounded-xl">
                      <Skeleton className="h-7 w-7 rounded-md" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-3.5 w-28 rounded-md" />
                        <Skeleton className="h-3 w-36 rounded-md" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : outreach.conversationsError ? (
                <Callout
                  tone="danger"
                  className="mx-3 mt-3 w-auto"
                  actions={<Button variant="outline" size="sm" onClick={() => void outreach.loadConversations()}>Try again</Button>}
                >
                  {outreach.conversationsError}
                </Callout>
              ) : filteredLeadGroups.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 border-2 border-dashed border-border/40 rounded-xl mx-3 mt-3">
                  <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mb-3">
                    <Users className="h-4 w-4 text-muted-foreground/50" />
                  </div>
                  <p className="text-sm font-medium">No leads found</p>
                </div>
              ) : (
                <div className="p-3 space-y-1 pb-4">
                  {filteredLeadGroups.map((lead) => (
                    <div
                      key={lead.leadId}
                      onClick={() => handleSelectLead(lead)}
                      className={cn(
                        "flex items-center gap-2.5 px-3 py-2.5 cursor-pointer rounded-xl transition-all border bg-card group",
                        selectedLead?.leadId === lead.leadId
                          ? cn(config.selectedBorderClass, config.selectedBgClass, config.selectedRingClass)
                          : "border-border/40 hover:border-border hover:shadow-sm"
                      )}
                    >
                      <div className="relative shrink-0">
                        <div className={cn("w-7 h-7 rounded-md flex items-center justify-center", config.iconBgClass)}>
                          <span className={cn("text-[11px] font-semibold", config.iconTextClass)}>
                            {(lead.leadName || "?").charAt(0).toUpperCase()}
                          </span>
                        </div>
                        {lead.unreadCount > 0 && (
                          <span className="absolute -top-1 -right-1 w-4 h-4 bg-destructive text-destructive-foreground text-[9px] font-bold rounded-full border border-background flex items-center justify-center">
                            {lead.unreadCount}
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{lead.leadName || "Unknown"}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {config.formatLeadSubtext({ handle: lead.leadHandle, company: lead.leadCompany })}
                        </p>
                      </div>
                      <div className="shrink-0">
                        <Badge variant="outline" className="text-[10px] h-4 px-1.5 rounded-md">
                          {lead.conversationCount}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!outreach.loading && !outreach.conversationsError && <ConversationLoadMore hasMore={outreach.hasMoreConversations} loading={outreach.loadingMore} error={outreach.loadMoreError} onLoadMore={outreach.loadMoreConversations} />}
            </ScrollArea>

            <div className="p-3 border-t">
              <Button
                size="sm"
                className="w-full h-8 text-xs rounded-lg gap-1.5"
                onClick={() => router.push("/dashboard/leads")}
              >
                <Plus className="w-3.5 h-3.5" />
                New {config.displayName} Campaign
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Panel 2: Conversations List ─────────────────────────── */}
      <AnimatePresence mode="popLayout">
        {(selectedLead && (viewMode === "conversations" || !isMobile)) && (
          <motion.div
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: 300 }}
            exit={{ opacity: 0, width: 0 }}
            className={cn(
              "border-r bg-card flex flex-col relative z-10",
              viewMode === "leads" && "hidden md:flex",
              viewMode === "messages" && "hidden lg:flex"
            )}
          >
            <div className="p-3 border-b space-y-3">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-lg hover:bg-muted md:hidden shrink-0"
                  onClick={handleBackToLeads}
                >
                  <ArrowLeft className="w-4 h-4" />
                </Button>
                <div className="flex-1 min-w-0">
                  <h2 className="text-sm font-semibold flex items-center gap-2">
                    <MessageSquare className="w-3.5 h-3.5 text-primary" />
                    Conversations
                    <Badge variant="outline" className="text-[10px] h-5 rounded-md px-1.5 font-bold">
                      {filteredConversations.length}
                    </Badge>
                  </h2>
                </div>
                {selectedLead && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2.5 rounded-lg text-xs gap-1.5 border-border/60"
                    onClick={handleNewConversation}
                    loading={creatingConversation}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    New
                  </Button>
                )}
              </div>

              <SearchInput
                size="sm"
                aria-label="Search conversations"
                placeholder="Search conversations..."
                value={conversationSearchQuery}
                onValueChange={setConversationSearchQuery}
                className="rounded-lg border-border/60"
              />
            </div>

            <ScrollArea className="flex-1" viewportClassName="[&>div]:!block">
              {filteredConversations.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 mx-3 mt-3 border-2 border-dashed border-border/40 rounded-xl">
                  <p className="text-xs text-muted-foreground">No conversations found</p>
                </div>
              ) : (
                <div className="p-3 space-y-1 pb-4">
                  {filteredConversations.map((conv) => (
                    <div
                      key={conv.id}
                      onClick={() => handleSelectConversation(conv)}
                      className={cn(
                        "px-3 py-2.5 cursor-pointer rounded-xl transition-all border bg-card group/conv",
                        outreach.selectedConversation?.id === conv.id
                          ? "border-primary/30 bg-primary/5 shadow-sm ring-1 ring-primary/10"
                          : "border-border/40 hover:border-border hover:shadow-sm"
                      )}
                    >
                      <div className="flex items-center justify-between gap-1.5 min-w-0 w-full mb-0.5">
                        <p className="text-sm font-medium truncate flex-1 min-w-0">
                          {conv.leadName || "Unknown"}
                        </p>
                        <span className="text-[10px] text-muted-foreground shrink-0 whitespace-nowrap">
                          {conv.lastMessageAt ? new Date(conv.lastMessageAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-1.5 min-w-0 w-full">
                        <p className="text-xs text-muted-foreground truncate flex-1 min-w-0">
                          {conv.lastMessagePreview || "No messages yet"}
                        </p>
                        <div className="flex items-center gap-1 shrink-0">
                          {conv.unreadCount > 0 && (
                            <Badge variant="destructive" className="h-4 px-1.5 text-[9px] rounded-md">
                              {conv.unreadCount}
                            </Badge>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                              <Button variant="ghost" size="icon" className="h-6 w-6 rounded-md opacity-0 group-hover/conv:opacity-100 transition-opacity">
                                <MoreVertical className="w-3.5 h-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-36">
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive text-xs gap-1.5"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  outreach.openDeleteDialog(conv, e as unknown as React.MouseEvent);
                                }}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                Delete Conversation
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <ConversationLoadMore hasMore={outreach.hasMoreConversations} loading={outreach.loadingMore} error={outreach.loadMoreError} onLoadMore={outreach.loadMoreConversations} />
            </ScrollArea>

            <div className="p-3 border-t">
              <div className="flex items-center gap-2.5 p-2.5 rounded-lg border border-border/50 bg-muted/30">
                <div className={cn("w-7 h-7 rounded-md flex items-center justify-center shrink-0", config.iconBgClass)}>
                  <span className={cn("text-[11px] font-semibold", config.iconTextClass)}>
                    {(selectedLead.leadName || "?").charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{selectedLead.leadName}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {config.formatConversationSubtext(null, { handle: selectedLead.leadHandle })}
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Panel 3: Message Thread ─────────────────────────────── */}
      <div className="flex-1 flex flex-col bg-muted/5 relative">
        <AnimatePresence mode="wait">
          {(!selectedLead && !draftMode) ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 flex flex-col items-center justify-center p-6 text-center"
            >
              <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center mb-3", config.iconBgClass)}>
                <Icon className={cn("w-5 h-5", config.iconTextClass)} />
              </div>
              <p className="text-sm font-medium mb-1">{config.formatEmptyStateTitle()}</p>
              <p className="text-xs text-muted-foreground max-w-xs mx-auto leading-relaxed">
                {config.formatEmptyStateDescription()}
              </p>
              <div className="mt-4">
                <Button
                  size="sm"
                  onClick={() => router.push("/dashboard/leads")}
                  className="h-8 px-4 rounded-lg text-xs gap-1.5"
                >
                  <Users className="w-3.5 h-3.5" /> New Campaign
                </Button>
              </div>
            </motion.div>
          ) : (viewMode === "messages" || !isMobile) ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex-1 flex flex-col h-full bg-card border-l border-border/40 relative z-30"
            >
              <ConversationHeader
                title={outreach.selectedConversation?.leadName || selectedLead?.leadName || "New message"}
                eyebrow={`${config.displayName} conversation`}
                subtitle={config.formatConversationSubtext(outreach.selectedConversation, { handle: selectedLead?.leadHandle || null })}
                className="sticky top-0"
                leading={<div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg hover:bg-muted lg:hidden shrink-0"
                    onClick={handleBackToConversations}
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </Button>
                  <div className={cn("flex h-9 w-9 items-center justify-center rounded-xl border border-border", config.iconBgClass)}>
                    <span className={cn("text-xs font-semibold", config.iconTextClass)}>{(outreach.selectedConversation?.leadName || selectedLead?.leadName || "?").charAt(0).toUpperCase()}</span>
                  </div>
                </div>}
                status={!draftMode ? <Badge variant="secondary" className="hidden rounded-full px-2 py-0.5 text-[10px] font-medium sm:inline-flex">{outreach.messages.length} messages</Badge> : <Badge variant="secondary" className="rounded-full px-2 py-0.5 text-[10px] font-medium">Draft</Badge>}
                actions={!draftMode ? (
                  <>
                  {!draftMode && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          if (outreach.selectedConversation) {
                            outreach.openDeleteDialog(outreach.selectedConversation);
                          }
                        }}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                  )}
                  </>
                ) : undefined}
              />

              {outreach.selectedConversation && <RelatedProposals outreachConversationId={outreach.selectedConversation.id}/>}
              {/* Messages Area */}
              <div className="flex-1 overflow-hidden relative">
                <ScrollArea className="h-full">
                  <div className="max-w-4xl mx-auto p-6 space-y-6">
                    {outreach.loadingMessages ? (
                      <div className="space-y-6">
                        {Array.from({ length: 3 }).map((_, i) => (
                          <div key={i} className={cn("flex flex-col gap-2", i % 2 === 0 ? "items-start" : "items-end")}>
                            <Skeleton className="h-4 w-24 rounded-full" />
                            <Skeleton className="h-14 w-full md:w-3/4 rounded-xl" />
                          </div>
                        ))}
                      </div>
                    ) : outreach.messagesError && !draftMode ? (
                      <div className="flex flex-col items-center justify-center gap-3 py-10 text-center text-destructive" role="alert">
                        <p className="text-sm font-medium">Messages could not be loaded</p>
                        <p className="text-xs opacity-80">{outreach.messagesError}</p>
                        <Button variant="outline" size="sm" onClick={() => outreach.selectedConversation && outreach.handleSelectConversation(outreach.selectedConversation)}>Try again</Button>
                      </div>
                    ) : draftMode ? (
                      <div className="flex flex-col items-center justify-center py-10 text-center">
                        <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center mb-3", config.iconBgClass)}>
                          <Icon className={cn("w-5 h-5", config.iconTextClass)} />
                        </div>
                        <p className="font-medium text-sm">{config.formatNewDraftTitle()}</p>
                        <p className="text-sm text-muted-foreground mt-2 max-w-xs mx-auto">
                          {config.formatNewDraftDescription(selectedLead?.leadName || "this lead")}
                        </p>
                      </div>
                    ) : outreach.messages.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-10 text-center">
                        <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center mb-3">
                          <MessageSquare className="w-5 h-5 text-muted-foreground/40" />
                        </div>
                        <p className="font-medium text-sm">Empty Conversation</p>
                        <p className="text-sm text-muted-foreground mt-2 max-w-xs mx-auto">
                          Send a message to start the conversation.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-6">
                        {outreach.messages.map((msg) => (
                          <OutreachMessageBubble
                            key={msg.id}
                            message={msg}
                            channel={config.channel}
                            onEditDraft={outreach.handleEditDraft}
                            onSendDraft={outreach.handleSendDraft}
                            onDiscardDraft={outreach.handleDiscardDraft}
                          />
                        ))}
                        <div ref={messagesEndRef} className="h-4" />
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </div>

              {/* AI Draft Reply Button */}
              {!draftMode && outreach.messages.length > 0 &&
                outreach.messages.some((m) => m.direction === "inbound") && (
                <div className="flex justify-center py-2 border-t bg-card/50">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={outreach.handleGenerateDraft}
                    loading={outreach.generatingDraft}
                    loadingText="Generating..."
                    className="gap-1.5 text-xs border-amber-300 dark:border-amber-600 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    AI Draft Reply
                  </Button>
                </div>
              )}

              {/* Compose Area */}
              <div className="border-t bg-card/50 backdrop-blur-xl">
                <div className="max-w-4xl mx-auto px-6 py-4">
                  <OutreachComposeArea
                    channel={config.channel}
                    message={outreach.newMessage}
                    onMessageChange={outreach.setNewMessage}
                    onSend={draftMode ? handleDraftSend : () => outreach.handleSendMessage()}
                    sending={outreach.sending || creatingConversation}
                    showAIGenerate
                    onAIGenerateClick={() => handleAIGenerate()}
                    aiGenerating={generatingAI}
                  >
                    <div className="flex flex-wrap gap-4 mt-4 py-3 border-y border-border/50">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-lg px-3 font-medium text-xs hover:bg-background/80 transition-all"
                        onClick={() => setTemplateSelectorOpen(true)}
                      >
                        <LayoutTemplate className="w-3.5 h-3.5 mr-2 opacity-60" />
                        Templates
                      </Button>
                      <TemplateSelector
                        channel={config.channel}
                        open={templateSelectorOpen}
                        onOpenChange={setTemplateSelectorOpen}
                        leadId={outreach.selectedConversation?.leadId ?? selectedLead?.leadId}
                        onSelect={(template) => {
                          outreach.setNewMessage(template.content);
                          setTemplateSelectorOpen(false);
                        }}
                      />
                    </div>
                  </OutreachComposeArea>
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      </div>

      {/* Delete confirmation dialog */}
      <OutreachDeleteDialog
        open={outreach.deleteDialogOpen}
        onOpenChange={outreach.setDeleteDialogOpen}
        conversation={outreach.conversationToDelete}
        onConfirm={async () => {
          await outreach.handleDeleteConversation();
          if (outreach.conversationToDelete?.id === outreach.selectedConversation?.id) {
            handleBackToConversations();
          }
        }}
      />
    </div>
  );
}
