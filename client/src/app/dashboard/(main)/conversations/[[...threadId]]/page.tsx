"use client";

/* eslint-disable unused-imports/no-unused-vars */

import { selectedBusinessProfileId as activeBusinessProfileId } from '@/lib/business-profile';
import { ConversationTurnStatus } from "@/components/conversation/ConversationTurnStatus";
/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { conversationEventRequestId, conversationEventThreadId, matchesConversationEventScope } from '@/lib/conversation-event-scope';
import { useQuery } from "@tanstack/react-query";
import { type Message } from "@/models/message";
import type { ToolLogEntry } from "@/components/chat/ChatThinkingBubble";
import type { ICPApiResponse } from "@/models/icp";
import type {
  ICPProfile,
} from "@/models/conversationEvents";
// Re-export for consumers
export type { ICPApiResponse } from "@/models/icp";
import { useWebSocket } from "@/contexts/WebSocketContext";
import webSocketService from "@/services/WebSocketService";
import ChatInterface from "@/components/ChatInterface";
import ChromeTabs, { type Tab } from "@/components/ChromeTabs";
import ResizablePanel from "@/components/ResizablePanel";
import SearchTab from "@/components/tabs/SearchTab";
import ICPTab from "@/components/tabs/ICPTab";
import AgentChooseTab from "@/components/tabs/AgentChooseTab";
import LeadsTab from "@/components/tabs/LeadsTab";
import LeadsInputsTab from "@/components/tabs/LeadsInputsTab";
import OutreachTab from "@/components/tabs/OutreachTab";
import CampaignsTab from "@/components/tabs/CampaignsTab";
import LeadConfigTab from "@/components/tabs/LeadConfigTab";
import ContentStudioTab from "@/components/tabs/ContentStudioTab";
import PerformanceMarketingTab from "@/components/tabs/PerformanceMarketingTab";
import StructuredAnalyticsTab from "@/components/tabs/StructuredAnalyticsTab";
import OverviewTab from "@/components/tabs/OverviewTab";
import CRMTab from "@/components/tabs/CRMTab";
import SupportTab from "@/components/tabs/SupportTab";
import ProposalsTab from "@/components/tabs/ProposalsTab";
import BrandToolkitModal from "@/components/BrandToolkitModal";
import BrandToolkitSelectorModal from "@/components/BrandToolkitSelectorModal";
import ICPSelectorModal from "@/components/ICPSelectorModal";
import CampaignChatHeader from "@/components/CampaignChatHeader";
import { CampaignDashboardView } from "@/components/CampaignDashboardView";
import { ToolApprovalDialog } from "@/components/ToolApprovalDialog";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { ChatActionProvider } from "@/contexts/ChatActionContext";
import { WidgetProvider, useWidgets, toolHasWidget } from "@/components/widgets";
import {
  createConversationEventLedger,
  createConversationStreamAccumulator,
  isDurableConversationMessage,
  reconcileDurableConversationMessage,
  reconcileConversationResponseMessage,
  sealConversationStream,
  ingestConversationEventEnvelope,
  ingestConversationStreamChunk,
  type ConversationStreamAccumulator,
} from "@/lib/conversation-stream-reducer";
import { useToast } from "@/hooks/use-toast";
import { mergeConversationHistory } from '@/lib/conversation-history-reconciliation';
import api, { ApiError } from "@/lib/api";
import {
  CONTENT_TAB_INITIAL_MAP,
  AGENT_HIRE_TAB_MAP,
  getTabLabel,
  normalizeTabType,
} from "@/lib/tabConfig";
import { useAuth } from "@/contexts/AuthContext";
import { AGENT_DEFINITIONS, AGENT_DISPLAY_NAMES } from "@/lib/agent-personas";
import {
  dedupeSingletonConversationTabs,
  toConversationTabReplacement,
} from "@/lib/conversationResultTabs";
import { MessageSquareText, PanelRightOpen, PanelsTopLeft } from "lucide-react";

// Modular Hooks
import { useCampaignThreadStart } from "@/hooks/useCampaignThreadStart";
import { useInlineWidgets } from "@/hooks/useInlineWidgets";
import { useChat } from "@/hooks/useChat";
import { useToolExecution } from "@/hooks/useToolExecution";
import { readDurableApproval, shouldAutoOpenApproval } from "@/lib/conversation-approval";
import { shouldResumeConversationProcessing } from "@/lib/conversation-run-status";
import { normalizeLeadExecutionSummary } from "@/lib/lead-execution-summary";
import { useAgentRouter } from "@/hooks/useAgentRouter";

interface TabConfig {
  tabId: string;
  tabType: string;
  tabLabel: string;
  tabOrder: number;
  isActive?: boolean;
  closeable?: boolean;
  tabData?: Record<string, unknown>;
}


const AGENT_HIRE_TYPE_MAP: Record<string, string> = {
  'lead-generation': 'lead_generation',
  'content-studio': 'content_studio',
  outreach: 'outreach',
  'performance-marketing': 'performance_marketing',
  'icp-generation': 'icp_generation',
};

function ChatContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Thread adoption uses native replaceState. Pathname follows those updates,
  // while dynamic route params can still describe the original blank route.
  const rawThreadId = pathname?.match(/^\/dashboard\/conversations\/([^/]+)/)?.[1];
  const parsedId = rawThreadId && /^\d+$/.test(rawThreadId) ? Number(rawThreadId) : NaN;
  const threadIdFromUrl = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null;
  const { user } = useAuth();
  const { toast } = useToast();
  const { subscribe: wsSubscribe } = useWebSocket(); // Use global WebSocket
  const { loadWidgets, resetWidgets } = useWidgets();

  // Selected agent & view mode toggle: 'overview' = normal chat, 'campaign' = campaign dashboard
  const [chatViewMode, setChatViewMode] = useState<'overview' | 'campaign'>('overview');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  // Business profile selection for new chats
  const [selectedBusinessProfileId, setSelectedBusinessProfileId] = useState<string>("");
  const { data: allBusinessProfiles = [] } = useQuery<{ id: number; name: string; companyName: string; isDefault?: boolean }[]>({
    queryKey: ["business-profiles"],
    queryFn: () => api.get<{ id: number; name: string; companyName: string; isDefault?: boolean }[]>("/api/settings/business-profiles"),
  });

  const businessProfiles = allBusinessProfiles.filter(profile => profile.id === activeBusinessProfileId());

  // Business settings for the selected workspace.
  const [selectedBusinessId, setSelectedBusinessId] = useState<number | null>(null);
  const [_selectedBusinessName, setSelectedBusinessName] = useState<string | null>(null);
  const [_selectedBusinessDetails, setSelectedBusinessDetails] = useState<{
    id?: number;
    name?: string;
    companyName?: string;
    businessType?: string;
    profileType?: string;
    industry?: string;
    subIndustry?: string;
    website?: string;
    city?: string;
    state?: string;
    country?: string;
    description?: string;
  } | null>(null);

  // ICP Selector Modal states
  const [showICPSelector, setShowICPSelector] = useState(false);

  // Brand Toolkit Modal states
  const [showBrandToolkitSelector, setShowBrandToolkitSelector] = useState(false);
  const [showBrandToolkitCreate, setShowBrandToolkitCreate] = useState(false);

  const [examplePrompts, setExamplePrompts] = useState<string[]>([]);
  const [olderMessageCursor, setOlderMessageCursor] = useState<number | null>(null);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [icp, setIcp] = useState<ICPProfile | null>(null);
  const [icpId, setIcpId] = useState<number | null>(null);
  const [icpContextStatus, setIcpContextStatus] = useState<'loading' | 'ready' | 'error'>(threadIdFromUrl ? 'loading' : 'ready');
  const [fitScore, setFitScore] = useState(0);
  const [userIntent, setUserIntent] = useState<string | null>(null);

  const [leadGenConfig, setLeadGenConfig] = useState({
    keywords: [] as string[],
    platforms: [] as string[],
    leadCount: 100,
    locations: [] as string[],
  });
  const [leadInputsRevision, setLeadInputsRevision] = useState(0);

  const workflowRunSeenRef = useRef(false);
  const workflowRunStatusRef = useRef<string | null>(null);
  const beginChatTurn = useCallback(() => {
    // A preceding turn's durable run must not suppress completion of a new
    // read-only reply, which intentionally creates no workflow run events.
    workflowRunSeenRef.current = false;
    workflowRunStatusRef.current = null;
  }, []);

  // Hook 2: Chat states, message sending/loading
  const {
    messages,
    setMessages,
    isProcessing,
    setIsProcessing,
    isProcessingRef,
    isLoadingMessages,
    setIsLoadingMessages,
    chatName,
    setChatName,
    currentThreadId,
    setCurrentThreadId,
    currentThreadIdRef,
    pendingNewThreadRef,
    pendingNewThreadRequestIdRef,
    seenMessageIds,
    setSeenMessageIds,
    locallyCreatedThreadRef,
    lastSeenTsRef,
    clearProcessingTimeout,
    handleSendMessage,
  } = useChat(selectedBusinessProfileId, loadWidgets, beginChatTurn);

  // Hook 1: Inline widgets / tabs
  const {
    tabs,
    setTabs,
    activeTab,
    setActiveTab,
    tabsLoaded,
    setTabsLoaded,
    tabData,
    setTabData,
    addTab,
    switchTab,
    removeTab,
    handleAddTabFromButton,
    handleHeaderAgentClick,
    highlightedTabId,
    triggerTabHighlight,
    actionUpdates,
    setActionUpdates,
    liveSignals,
    setLiveSignals,
    addActionUpdate,
    addLiveSignal,
  } = useInlineWidgets(currentThreadId, setChatViewMode, setSelectedAgent, currentThreadIdRef);

  // Hook 3: Tool executions and approvals
  const {
    showApprovalModal,
    setShowApprovalModal,
    approvalData,
    setApprovalData,
    approvingTool,
    setApprovingTool,
    toolLogs,
    setToolLogs,
    handleApproveTool,
  } = useToolExecution(currentThreadId, clearProcessingTimeout, setIsProcessing);

  // Hook 4: Agent Routing
  const sendAgentRouterMessage = useCallback(async (content: string, bypassProcessingCheck?: boolean) => {
    await handleSendMessage(content, bypassProcessingCheck);
  }, [handleSendMessage]);
  const {
    activeAgent,
    setActiveAgent,
    showAgentSuggestions,
    setShowAgentSuggestions,
    recommendedAgents,
    setRecommendedAgents,
    recommendedAgentScores,
    setRecommendedAgentScores,
    agentDescriptions,
    setAgentDescriptions,
    handleAgentSelect,
  } = useAgentRouter(currentThreadId, sendAgentRouterMessage);

  // Ref to track last seen message timestamp for WebSocket reconnect message sync
  const lastSeenTsRefVar = lastSeenTsRef;
  const lastDurableCursorRef = useRef<{ createdAt: string; id: number } | null>(null);
  const streamAccumulatorsRef = useRef<Map<string, ConversationStreamAccumulator>>(new Map());
  const conversationEventLedgerRef = useRef(createConversationEventLedger());
  const threadLoadGenerationRef = useRef(0);
  const ensureCampaignThread = useCampaignThreadStart({
    currentThreadIdRef, pendingNewThreadRef, navigationVersionRef: threadLoadGenerationRef,
    businessProfileId: selectedBusinessProfileId,
    onCreated: (id) => {
      locallyCreatedThreadRef.current = id;
      resetWidgets(id);
      setCurrentThreadId(id);
      window.history.replaceState(null, '', `/dashboard/conversations/${id}`);
    },
  });
  const threadLoadThreadIdRef = useRef<number | null>(null);
  const threadLoadAbortRef = useRef<AbortController | null>(null);
  const [threadLoadError, setThreadLoadError] = useState<{ threadId: number; message: string } | null>(null);
  const olderMessagesAbortRef = useRef<AbortController | null>(null);

  // Stable empty object to avoid unnecessary re-renders when tabData[activeTab] is undefined
  const emptyTabData = useMemo(() => ({}), []);
  const [chatPanelOpen, setChatPanelOpen] = useState(true);
  const [resultPanelOpen, setResultPanelOpen] = useState(true);
  const [mobilePane, setMobilePane] = useState<'chat' | 'results'>('chat');
  const conversationWorkspaceRef = useRef<HTMLDivElement>(null);
  const resultPanelRestoreRef = useRef<HTMLButtonElement>(null);
  const resultPanelMinimizeRef = useRef<HTMLButtonElement>(null);
  const requestedAgentHandledRef = useRef(false);

  useEffect(() => {
    if (requestedAgentHandledRef.current || !tabsLoaded) return;
    if (searchParams.get('agent') === 'performance_marketing') {
      requestedAgentHandledRef.current = true;
      setSelectedAgent('performance-marketing');
      return;
    }
    if (searchParams.get('agent') !== 'content_studio') return;
    requestedAgentHandledRef.current = true;
    setSelectedAgent('content-studio');
    const existing = tabs.find((tab) => tab.type === 'content-studio' || tab.type === 'contentstudio');
    if (existing) {
      void switchTab(existing.id);
    } else {
      void addTab('content-studio', 'Content Studio', true, false);
    }
  }, [addTab, searchParams, switchTab, tabs, tabsLoaded]);

  const minimizeResultPanel = () => {
    setChatPanelOpen(true);
    setResultPanelOpen(false);
    setMobilePane('chat');
    requestAnimationFrame(() => resultPanelRestoreRef.current?.focus());
  };

  const restoreResultPanel = () => {
    setResultPanelOpen(true);
    setMobilePane('results');
    requestAnimationFrame(() => resultPanelMinimizeRef.current?.focus());
  };

  const acceptRealtimeThread = useCallback((rawThreadId: unknown, allowAdoption = false, requestId?: string): boolean => {
    if (rawThreadId === undefined || rawThreadId === null || rawThreadId === '') return true;
    const eventThreadId = Number(rawThreadId);
    if (!Number.isSafeInteger(eventThreadId) || eventThreadId <= 0) return false;

    const current = currentThreadIdRef.current;
    if (current !== null) return current === eventThreadId;
    if (!allowAdoption || !pendingNewThreadRef.current || !pendingNewThreadRequestIdRef.current
      || requestId !== pendingNewThreadRequestIdRef.current) return false;

    pendingNewThreadRef.current = false;
    currentThreadIdRef.current = eventThreadId;
    locallyCreatedThreadRef.current = eventThreadId;
    resetWidgets(eventThreadId);
    setCurrentThreadId(eventThreadId);
    window.history.replaceState(null, '', `/dashboard/conversations/${eventThreadId}`);
    return true;
  }, [currentThreadIdRef, locallyCreatedThreadRef, pendingNewThreadRef, pendingNewThreadRequestIdRef, resetWidgets, setCurrentThreadId]);

  // Use SSR-safe defaults, then derive the split from the actual workspace.
  const [compactWorkspace, setCompactWorkspace] = useState(true);
  const [panelWidths, setPanelWidths] = useState(() => ({
    defaultWidth: 480,
    minWidth: 300,
    maxWidth: 720,
  }));

  useEffect(() => {
    const workspace = conversationWorkspaceRef.current;
    if (!workspace) return;

    const updatePanelWidths = (width: number) => {
      const compact = width < 900;
      setCompactWorkspace(compact);
      if (compact) {
        setChatPanelOpen(true);
        return;
      }
      const availableForChat = Math.max(360, width - 400);
      setPanelWidths({
        defaultWidth: Math.min(availableForChat, Math.max(360, Math.floor(width * 0.55))),
        minWidth: Math.min(360, availableForChat),
        maxWidth: availableForChat,
      });
    };

    updatePanelWidths(workspace.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => updatePanelWidths(entry.contentRect.width));
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [chatViewMode, currentThreadId]);

  // Full agent definitions with metadata — from centralized agent-personas
  const allAgentDefinitions = useMemo(() => AGENT_DEFINITIONS, []);

  // Extract unique agents used in the current conversation
  const usedAgentsInChat = useMemo(() => {
    const usedAgentTypes = new Set<string>();
    const excludedAgentTypes = ['user', 'orchestrator', 'supervisor'];

    messages.forEach(msg => {
      const agentType = msg.agentType as string | undefined;
      if (agentType && !excludedAgentTypes.includes(agentType)) {
        usedAgentTypes.add(agentType);
      }
    });

    const agentsUsed = Array.from(usedAgentTypes)
      .map(type => allAgentDefinitions[type as keyof typeof allAgentDefinitions])
      .filter(Boolean);

    return agentsUsed;
  }, [messages, allAgentDefinitions]);

  const agents = useMemo(() =>
    Object.values(allAgentDefinitions),
    [allAgentDefinitions]);

  // Load the business selected for this browser tab.
  useEffect(() => {
    const loadBusinessProfile = async () => {
      try {
        const profiles = await api.get<Array<{ id: number; name: string; companyName?: string; industry?: string; description?: string; website?: string; city?: string; state?: string; country?: string; profileType?: string; subIndustry?: string; businessType?: string; isDefault?: boolean }>>('/api/settings/business-profiles');
        if (profiles && profiles.length > 0) {
          const profile = profiles.find((p) => p.id === activeBusinessProfileId());
          if (!profile) return;
          setSelectedBusinessId(profile.id);
          setSelectedBusinessName(profile.name || profile.companyName || '');
          setSelectedBusinessDetails(profile);
          setSelectedBusinessProfileId(String(profile.id));
        }
      } catch (error) {
        toast({
          title: "Business profile unavailable",
          description: error instanceof Error ? error.message : "Your selected business profile could not be loaded.",
          variant: "destructive",
        });
      }
    };
    loadBusinessProfile();
  }, [toast]);

  // Subscribe to the WebSocket thread channel for the current thread.
  useEffect(() => {
    webSocketService.subscribeToThread(currentThreadId ?? undefined);
    return () => {
      webSocketService.subscribeToThread(undefined);
    };
  }, [currentThreadId]);

  // Update document title dynamically with the chat thread name
  useEffect(() => {
    document.title = chatName ? `${chatName} | AskSales.AI` : "Conversations | AskSales.AI";
    return () => {
      document.title = "Conversations | AskSales.AI";
    };
  }, [chatName]);

  // Clear tool logs when a new processing cycle starts
  useEffect(() => {
    if (isProcessing) {
      setToolLogs([]);
    }
  }, [isProcessing, setToolLogs]);

  const fetchICPData = useCallback(async (icpId: number) => {
    const icpData = await api.get<ICPApiResponse>(`/api/icp/profile/${icpId}`);
    if (icpData) {
      const icpProfile: ICPProfile = {
        campaign_name: icpData.campaignName,
        campaign_objective: icpData.campaignObjective,
        target_audience: icpData.targetAudience,
        industry_vertical: icpData.industry,
        geography_locations: icpData.primaryRegions,
        target_roles_titles: icpData.primaryJobTitles,
        sources: icpData.primaryChannels,
        summary: icpData.summary,
        keywords: icpData.keywords,
        messaging_themes: icpData.messagingThemes,
      };
      setIcp(icpProfile);
      setFitScore(icpData.fitScore || 0);
      setUserIntent(icpData.userIntent ?? null);
    }
  }, []);

  const handleWebSocketEvent = useCallback((event: any) => {
    const envelope = event.data?.__envelope as Record<string, unknown> | undefined;
    const eventThreadId = conversationEventThreadId(event.data || {});
    const mayAdoptThread = event.type === 'thread_resolved' ||
      event.type === 'message_sent' ||
      (event.type === 'error' && event.data?.terminal === true && Boolean(event.data?.ackMessageId));
    if (!matchesConversationEventScope(event.type, event.data || {}, currentThreadIdRef.current, mayAdoptThread, pendingNewThreadRequestIdRef.current)) return;
    if (!acceptRealtimeThread(eventThreadId, mayAdoptThread, conversationEventRequestId(event.data || {}))) return;
    if (!ingestConversationEventEnvelope(conversationEventLedgerRef.current, {
      eventId: typeof envelope?.eventId === 'string' ? envelope.eventId : undefined,
      threadId: eventThreadId,
      turnId: typeof envelope?.turnId === 'string' ? envelope.turnId : event.data?.turn_id,
      updatedAt: event.data?.updated_at ?? event.data?.timestamp,
      runId: typeof envelope?.runId === 'string'
        ? envelope.runId
        : typeof event.data?.run_id === 'string'
          ? event.data.run_id
          : typeof event.data?.workflowId === 'string'
            ? event.data.workflowId
            : undefined,
      messageId: typeof envelope?.messageId === 'string' || typeof envelope?.messageId === 'number'
        ? envelope.messageId
        : undefined,
      kind: typeof envelope?.kind === 'string' ? envelope.kind : event.type,
      status: typeof event.data?.status === 'string' ? event.data.status : undefined,
    })) return;

    switch (event.type) {
      case 'workflow_run_status': {
        workflowRunSeenRef.current = true;
        const status = event.data.status;
        workflowRunStatusRef.current = status;
        if (status === 'running') {
          setIsProcessing(true);
        } else {
          clearProcessingTimeout();
          setIsProcessing(false);
          if (status !== 'queued') setActiveAgent(undefined);
        }
        if (status === 'failed' || status === 'timed_out' || status === 'gated') {
          addLiveSignal({
            type: status === 'gated' ? 'warning' : 'error',
            message: status === 'timed_out'
              ? 'Workflow timed out and needs attention.'
              : status === 'gated'
                ? 'Workflow is blocked by a readiness or provider gate.'
                : 'Workflow failed. Review the execution details before retrying.',
            source: 'Workflow',
          });
        }
        break;
      }
      case "workflow_started": {
        const eventThreadId = event.data.thread_id;
        if (eventThreadId && eventThreadId !== currentThreadIdRef.current) {
          break;
        }

        toast({
          title: "Workflow Started",
          description: `${event.data.platform || event.data.source || 'Lead'} generation has started`,
        });

        addActionUpdate({
          type: 'leads',
          action: 'in_progress',
          title: `${event.data.platform || event.data.source || 'Lead'} Generation Started`,
          data: { platform: event.data.platform, source: event.data.source },
        });

        if (!workflowRunSeenRef.current) setIsProcessing(true);
        setActiveAgent({
          agentType: 'lead_generation',
          status: 'processing',
          progress: 0,
          currentTask: `Searching ${event.data.platform || event.data.source || 'leads'}...`,
          workflowStage: 'executing',
        });

        addTab("leads", "Leads");
        break;
      }
      case "workflow_step": {
        const eventThreadId = event.data.thread_id;
        if (eventThreadId && eventThreadId !== currentThreadIdRef.current) {
          break;
        }

        const workflowStepName = (event.data.step || event.data.stepName || event.data.message) as string | undefined;

        setActiveAgent((prev) => prev ? {
          ...prev,
          progress: (event.data.progress as number) || prev.progress || 0,
          currentTask: workflowStepName || prev.currentTask,
        } : prev);

        if (workflowStepName) {
          addLiveSignal({
            type: 'info',
            message: `${workflowStepName}${event.data.progress ? ` (${event.data.progress}%)` : ''}`,
            source: 'Workflow',
          });
        }

        break;
      }
      case "workflow_completed": {
        const eventThreadId = event.data.thread_id;
        if (eventThreadId && eventThreadId !== currentThreadIdRef.current) {
          break;
        }

        addActionUpdate({
          type: 'leads',
          action: 'created',
          title: `${event.data.platform} Workflow Completed`,
          data: {
            platform: event.data.platform,
            leadsCount: event.data.results?.leads_count || event.data.count || 0
          },
        });

        addLiveSignal({
          type: 'success',
          message: `Generated ${event.data.results?.leads_count || event.data.count || 0} leads from ${event.data.platform}`,
          source: 'Lead Generation',
        });

        toast({
          title: "Workflow Completed",
          description: `${event.data.platform}: Generated ${event.data.results?.leads_count || event.data.count || 0} leads`,
        });
        break;
      }
      case "workflow_error": {
        const eventThreadId = event.data.thread_id;
        if (eventThreadId && eventThreadId !== currentThreadIdRef.current) {
          break;
        }

        addActionUpdate({
          type: 'leads',
          action: 'error',
          title: `Workflow Error`,
          data: { error: event.data.error || event.data.message },
        });

        addLiveSignal({ type: 'error', message: event.data.error || event.data.message || 'Workflow failed', source: event.data.platform || 'Lead Generation' });
        break;
      }
      case "lead_saved": {
        const leadThreadId = event.data.thread_id || event.data.threadId;
        if (leadThreadId && currentThreadIdRef.current && leadThreadId !== currentThreadIdRef.current) break;

        const lead = event.data.lead as { name?: string } | undefined;
        if (lead?.name) addLiveSignal({ type: 'success', message: `Saved ${lead.name}`, source: event.data.platform || 'Lead Generation' });
        break;
      }
      case "error": {
        // The server has already accepted this durable turn and is only
        // acknowledging a reconnect replay. Removing it from the local queue
        // is sufficient; showing an error bubble makes a successful recovery
        // look like a failed user message.
        if (event.data.code === 'REQUEST_IN_PROGRESS' && event.data.replayed === true) {
          break;
        }
        const errorContent = event.data.error || event.data.message || "An error occurred";
        const errorThreadId = event.data.threadId as number | undefined;

        if (errorThreadId && !currentThreadIdRef.current) {
          locallyCreatedThreadRef.current = errorThreadId;
          setCurrentThreadId(errorThreadId);
          window.history.replaceState(null, '', `/dashboard/conversations/${errorThreadId}`);
        }

        const genericErrorMsg: Message = {
          id: `error-${Date.now()}`,
          role: "system",
          content: errorContent,
          timestamp: Date.now(),
          metadata: { isError: true }
        };
        setMessages((prev) => [...prev, genericErrorMsg]);

        clearProcessingTimeout();
        setIsProcessing(false);
        setActiveAgent(undefined);
        break;
      }
      case "batch_progress": {
        if (activeAgent) {
          setActiveAgent({
            ...activeAgent,
            progress: event.data.progress || 0,
            currentTask: `Completed ${event.data.completed}/${event.data.total} platforms`,
          });
        }

        break;
      }
      case "agent_status": {
        const eventThreadId = event.data.thread_id;
        if (eventThreadId && currentThreadIdRef.current && eventThreadId !== currentThreadIdRef.current) {
          break;
        }

        const agentType = (event.data.agent_type || event.data.agentType || 'orchestrator') as NonNullable<Message['agentType']>;
        const status = event.data.status || event.data.state || 'thinking';

        const agentDisplayNames = AGENT_DISPLAY_NAMES;

        if (status === 'error') {
          if (!workflowRunSeenRef.current) {
            clearProcessingTimeout();
            setIsProcessing(false);
          }
          setActiveAgent(undefined);
        } else if (status === 'completed') {
          // Agent status is execution progress, not the authoritative end of a
          // conversation turn. The durable chat response (or terminal workflow
          // event) clears processing; doing it here caused the spinner to flash
          // off before the final message arrived.
          setActiveAgent(undefined);
        } else {
          const agentName = agentDisplayNames[agentType] || agentType;
          setActiveAgent({
            agentType: agentType,
            status: 'processing',
            progress: 0,
            currentTask: `${agentName} is ${status}...`,
            workflowStage: 'icp_building',
          });
        }
        break;
      }
      case "icp_update": {
        const icpThreadId = event.data.thread_id;
        if (icpThreadId && currentThreadIdRef.current && icpThreadId !== currentThreadIdRef.current) {
          break;
        }

        if (event.data.icp_id) {
          addActionUpdate({
            type: 'icp',
            action: 'saved',
            title: 'ICP Profile Updated',
            data: {
              icpId: event.data.icp_id,
              fitScore: event.data.fit_score,
            },
          });

          addLiveSignal({
            type: 'success',
            message: `ICP Profile saved with ${event.data.fit_score || 0}% fit score`,
            source: 'ICP Analysis',
          });

          setIcpId(event.data.icp_id);
          if (event.data.fit_score !== undefined) {
            setFitScore(event.data.fit_score);
          }

          if (typeof event.data.user_intent === 'string') {
            setUserIntent(event.data.user_intent);
          }

          if (event.data.full_profile) {
            setIcp(prevIcp => {
              const fp = event.data.full_profile as Record<string, unknown>;
              const mapped: Partial<ICPProfile> = {
                ...(fp as Partial<ICPProfile>),
                primary_regions: (fp.geography_locations as string[] | undefined) || prevIcp?.primary_regions || prevIcp?.geography_locations,
                primary_job_titles: (fp.target_roles_titles as string[] | undefined) || prevIcp?.primary_job_titles || prevIcp?.target_roles_titles,
                primary_channels: (fp.sources as string[] | undefined) || prevIcp?.primary_channels || prevIcp?.sources,
                geography_locations: (fp.geography_locations as string[] | undefined) || prevIcp?.geography_locations,
                target_roles_titles: (fp.target_roles_titles as string[] | undefined) || prevIcp?.target_roles_titles,
                sources: (fp.sources as string[] | undefined) || prevIcp?.sources,
                industry_vertical: (fp.industry as string | undefined) || prevIcp?.industry_vertical,
                business_type: (fp.target_business_model as string | undefined) || prevIcp?.business_type,
                company_size: (fp.target_company_size_range as string | undefined) || prevIcp?.company_size,
                revenue_range: (fp.target_revenue_range as string | undefined) || prevIcp?.revenue_range,
              };
              if (!prevIcp) return mapped as ICPProfile;
              return { ...prevIcp, ...mapped } as ICPProfile;
            });
          } else {
            fetchICPData(Number(event.data.icp_id)).catch(error => {
              toast({
                title: "ICP update unavailable",
                description: error instanceof Error ? error.message : "The latest ICP profile could not be loaded.",
                variant: "destructive",
              });
            });
          }

          const existingIcpTab = tabs.find(t => t.type === 'icp');
          if (existingIcpTab) {
            setTabData(prev => ({
              ...prev,
              [existingIcpTab.id]: {
                icpId: event.data.icp_id,
                fitScore: event.data.fit_score
              }
            }));
            void switchTab(existingIcpTab.id);
          } else {
            addTab('icp', 'ICP Profile', true, false, {
              icpId: event.data.icp_id,
              fitScore: event.data.fit_score
            });
          }

          if ((event.data.fit_score || 0) >= 50) {
            setShowAgentSuggestions(true);
          }
        }
        break;
      }
      case "chat_response_chunk": {
        const { responseId, role, agentType, chunk, sequence, done, timestamp, metadata, thread_id } = event.data;

        if (thread_id && currentThreadIdRef.current && thread_id !== currentThreadIdRef.current) {
          break;
        }

        if (!currentThreadIdRef.current && thread_id) {
          locallyCreatedThreadRef.current = thread_id as number;
          setCurrentThreadId(thread_id as number);
          window.history.replaceState(null, '', `/dashboard/conversations/${thread_id}`);
        }

        let accumulator = streamAccumulatorsRef.current.get(responseId);
        if (!accumulator) {
          accumulator = createConversationStreamAccumulator();
          streamAccumulatorsRef.current.set(responseId, accumulator);
          if (streamAccumulatorsRef.current.size > 500) {
            const oldestKey = streamAccumulatorsRef.current.keys().next().value;
            if (oldestKey) streamAccumulatorsRef.current.delete(oldestKey);
          }
        }
        const streamUpdate = ingestConversationStreamChunk(accumulator, {
          sequence,
          chunk,
          done,
          metadata,
        });
        if (!streamUpdate.accepted) break;
        if (!streamUpdate.appendedText && !streamUpdate.completed) break;

        if (streamUpdate.completed && streamUpdate.metadata.discard) {
          setMessages(prev => prev.filter(m => m.id !== `streaming-${responseId}`));
          break;
        }

        setMessages(prev => {
          // React may apply this queued chunk after the final-message update.
          // Do not create a second stream beside the already-durable response.
          if (prev.some(message => (message.metadata?.responseId === responseId || message.id === responseId)
            && (isDurableConversationMessage(message) || message.id !== `streaming-${responseId}`))) return prev;
          const streamingMsgIndex = prev.findIndex(m => m.id === `streaming-${responseId}`);
          if (streamingMsgIndex >= 0) {
            const updated = [...prev];
            updated[streamingMsgIndex] = {
              ...updated[streamingMsgIndex],
              content: updated[streamingMsgIndex].content + streamUpdate.appendedText,
              metadata: {
                ...updated[streamingMsgIndex].metadata,
                ...streamUpdate.metadata,
                sequence: streamUpdate.lastSequence,
                ...(streamUpdate.completed ? { streamingComplete: true } : {}),
              },
            };
            return updated;
          }
          if (!streamUpdate.appendedText) return prev;
          const streamingMsg: Message = {
            id: `streaming-${responseId}`,
            role: role as Message['role'],
            agentType: (agentType as Message['agentType']) || undefined,
            content: streamUpdate.appendedText,
            timestamp: timestamp || Date.now(),
            metadata: {
              responseId,
              sequence: streamUpdate.lastSequence,
              streaming: true,
              ...streamUpdate.metadata,
              ...(streamUpdate.completed ? { streamingComplete: true } : {}),
            },
          };
          return [...prev.filter(m => !m.id.startsWith('temp-')), streamingMsg];
        });

        // Streaming completion is visual only. Processing ends when the durable
        // assistant message or terminal workflow state arrives.
        if (streamUpdate.completed) {
          const streamingMsgId = `streaming-${responseId}`;
          setTimeout(() => {
            setMessages(prev => {
              const idx = prev.findIndex(m => m.id === streamingMsgId && m.metadata?.streamingComplete && !m.metadata?.persisted);
              if (idx === -1) return prev;
              const updated = [...prev];
              updated[idx] = { ...updated[idx], metadata: { ...updated[idx].metadata, persistencePending: true } };
              return updated;
            });
          }, 10000);
        }
        break;
      }
      case "chat_message": {
        const messageData = event.data.message || event.data;
        const messageThreadId = event.data.thread_id || messageData.threadId;

        if (messageThreadId && currentThreadIdRef.current && messageThreadId !== currentThreadIdRef.current) {
          break;
        }

        if (messageThreadId && !currentThreadIdRef.current) {
          locallyCreatedThreadRef.current = messageThreadId as number;
          setCurrentThreadId(messageThreadId as number);
          window.history.replaceState(null, '', `/dashboard/conversations/${messageThreadId}`);
        }

        if (!messageThreadId || messageThreadId === currentThreadIdRef.current) {
          if (messageData) {
            const durableTimestamp = messageData.createdAt
              ? new Date(messageData.createdAt as string).getTime()
              : Number(messageData.timestamp) || Date.now();
            const durableId = Number(messageData.id);
            lastSeenTsRefVar.current = durableTimestamp;
            if (Number.isSafeInteger(durableId) && durableId > 0) {
              lastDurableCursorRef.current = {
                createdAt: new Date(durableTimestamp).toISOString(),
                id: durableId,
              };
            }
            const newMessage: Message = {
              id: messageData.id?.toString() || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              role: messageData.role as Message['role'],
              agentType: (messageData.agentType as Message['agentType']) || undefined,
              content: messageData.content as string,
              timestamp: durableTimestamp,
              metadata: messageData.metadata as Record<string, unknown> | undefined,
            };

            const isToolResultMsg = newMessage.metadata?.isToolResult;
            sealConversationStream(streamAccumulatorsRef.current, newMessage.metadata?.responseId);
            if (isToolResultMsg) {
              if (!workflowRunSeenRef.current) {
                clearProcessingTimeout();
                setIsProcessing(false);
              }
              setActiveAgent(undefined);
            }

            setMessages((prev) => {
              const filtered = prev.filter(m => !m.id.startsWith('temp-'));

              if (newMessage.role === 'user') {
                const optimisticIndex = filtered.findIndex(
                  m => m.id.startsWith('optimistic-user-') && m.content === newMessage.content
                );
                if (optimisticIndex >= 0) {
                  filtered[optimisticIndex] = newMessage;
                  return filtered;
                }
                const exists = filtered.some(m => m.id === newMessage.id);
                if (exists) {
                  return filtered;
                }
                return [...filtered, newMessage];
              }

              return reconcileDurableConversationMessage(filtered, newMessage, streamAccumulatorsRef.current);
            });

            const isTransitionMessage = newMessage.metadata?.isTransition || newMessage.metadata?.isTransitionMessage;
            const cancelledApproval = newMessage.metadata?.cancelledApproval as { requestId?: string; toolName?: string } | undefined;
            if (cancelledApproval?.requestId && cancelledApproval?.toolName) {
              setApprovalData(previous => previous?.requestId === cancelledApproval.requestId && previous?.toolName === cancelledApproval.toolName ? null : previous);
              if (approvalData?.requestId === cancelledApproval.requestId && approvalData?.toolName === cancelledApproval.toolName) setShowApprovalModal(false);
            }
            const requiresApproval = newMessage.metadata?.requiresApproval;
            const pendingApproval = newMessage.metadata?.pendingApproval as {
              toolName?: string;
              args?: Record<string, unknown>;
              message?: string;
              executionId?: string;
              toolCallId?: string;
            } | undefined;
            if (requiresApproval && pendingApproval?.toolName && !toolHasWidget(pendingApproval.toolName)) {
              setApprovalData({
                toolName: pendingApproval.toolName,
                toolDescription: pendingApproval.message,
                parameters: pendingApproval.args,
                agentType: newMessage.agentType,
                requestId: pendingApproval.executionId || pendingApproval.toolCallId,
              });
              setShowApprovalModal(shouldAutoOpenApproval({ toolName: pendingApproval.toolName, parameters: pendingApproval.args }));
            }
            const isToolCallOrResult = newMessage.metadata?.isToolCall || newMessage.metadata?.isToolResult;
            if (newMessage.role === 'assistant' && (!isTransitionMessage || requiresApproval) && !isToolCallOrResult) {
              if (!workflowRunSeenRef.current) {
                clearProcessingTimeout();
                setIsProcessing(false);
              }
              setActiveAgent(undefined);
            }
          }
        }
        break;
      }
      case "chat_response": {
        const responseThreadId = event.data.thread_id;
        if (responseThreadId && currentThreadIdRef.current && responseThreadId !== currentThreadIdRef.current) {
          break;
        }

        if (event.data.response) {
          const responseId = event.data.response.metadata?.responseId as string | undefined;
          const responseMessage: Message = {
            id: responseId || `resp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            role: event.data.response.role as Message['role'],
            agentType: (event.data.response.agentType as Message['agentType']) || undefined,
            content: event.data.response.content as string,
            timestamp: (event.data.response.timestamp as number) || Date.now(),
            metadata: event.data.response.metadata,
          };

          const isToolResultMsg = responseMessage.metadata?.isToolResult;
          sealConversationStream(streamAccumulatorsRef.current, responseId);
          if (isToolResultMsg) {
            if (!workflowRunSeenRef.current) {
              clearProcessingTimeout();
              setIsProcessing(false);
            }
            setActiveAgent(undefined);
          }
          setMessages((prev) => {
            const filtered = prev.filter(m => !m.id.startsWith('temp-'));
            return reconcileConversationResponseMessage(filtered, responseMessage, streamAccumulatorsRef.current);
          });

          const responseMetadata = event.data.response.metadata as Record<string, unknown> | undefined;
          const icpIdFromResponse = (event.data.response.icpId || responseMetadata?.icpId) as number | undefined;
          if (icpIdFromResponse) {
            setIcpId(icpIdFromResponse);
          }
          const responseFitScore = (event.data.response.fitScore ?? responseMetadata?.fitScore) as number | undefined;
          if (responseFitScore !== undefined && typeof responseFitScore === 'number') {
            setFitScore(responseFitScore);
          }
          const responseRecommendedAgents = (event.data.response.recommendedAgents || responseMetadata?.recommendedAgents) as string[] | undefined;
          if (responseRecommendedAgents && Array.isArray(responseRecommendedAgents)) {
            setRecommendedAgents(responseRecommendedAgents);
            setShowAgentSuggestions(true);
          }

          const isTransitionMessage = responseMetadata?.isTransition || responseMetadata?.isTransitionMessage;
          const requiresApproval = responseMetadata?.requiresApproval;
          const pendingApproval = responseMetadata?.pendingApproval as {
            toolName?: string;
            args?: Record<string, unknown>;
            message?: string;
            executionId?: string;
            toolCallId?: string;
          } | undefined;
          if (requiresApproval && pendingApproval?.toolName && !toolHasWidget(pendingApproval.toolName)) {
            setApprovalData({
              toolName: pendingApproval.toolName,
              toolDescription: pendingApproval.message,
              parameters: pendingApproval.args,
              agentType: responseMessage.agentType,
              requestId: pendingApproval.executionId || pendingApproval.toolCallId,
            });
            setShowApprovalModal(shouldAutoOpenApproval({ toolName: pendingApproval.toolName, parameters: pendingApproval.args }));
          }
          const isToolCallOrResult = responseMetadata?.isToolCall || responseMetadata?.isToolResult;

          if ((!isTransitionMessage || requiresApproval) && !isToolCallOrResult) {
            if (!workflowRunSeenRef.current) {
              clearProcessingTimeout();
              setIsProcessing(false);
            }
            setActiveAgent(undefined);
          } else if (responseMetadata?.isToolCall) {
            if (!workflowRunSeenRef.current) setIsProcessing(true);
            const toolCallAgent = responseMetadata?.agentType as string | undefined;
            setActiveAgent((prev) => prev ?? {
              agentType: (toolCallAgent || 'orchestrator') as NonNullable<Message['agentType']>,
              status: 'processing',
              progress: 0,
              currentTask: `Running ${responseMetadata?.toolName as string || 'tool'}...`,
              workflowStage: 'executing',
            });
          } else if (isTransitionMessage && !requiresApproval) {
            const toAgent = responseMetadata?.toAgent as string | undefined;
            const toAgentName = responseMetadata?.toAgentName as string | undefined;
            if (toAgent) {
              setActiveAgent({
                agentType: (toAgent || 'orchestrator') as NonNullable<Message['agentType']>,
                status: 'processing',
                progress: 0,
                currentTask: `${toAgentName || toAgent} is working...`,
                workflowStage: 'icp_building',
              });
            }
          }
        }
        break;
      }
      case "orchestrator_progress": {
        const eventThreadId = event.data.thread_id;
        if (eventThreadId && eventThreadId !== currentThreadIdRef.current) {
          break;
        }

        const messageContent = event.data.message || "Processing...";
        const messageHash = `orchestrator-${messageContent.slice(0, 50)}`;

        if (seenMessageIds.has(messageHash)) {
          break;
        }

        const orchestratorMsg: Message = {
          id: `temp-${Date.now()}`,
          role: "assistant",
          agentType: "orchestrator",
          content: messageContent,
          timestamp: Date.now(),
          metadata: { ...event.data.details ? { details: event.data.details } : {}, temporary: true, hash: messageHash },
        };

        setMessages((prev) => {
          const filtered = prev.filter(m => !m.id.startsWith('temp-'));
          return [...filtered, orchestratorMsg];
        });

        setSeenMessageIds(prev => new Set(prev).add(messageHash));
        break;
      }
      case "message_sent": {
        const sentThreadId = event.data.threadId;
        if (sentThreadId && currentThreadIdRef.current && sentThreadId !== currentThreadIdRef.current) {
          break;
        }

        if (sentThreadId && !currentThreadIdRef.current) {
          locallyCreatedThreadRef.current = sentThreadId;
          setCurrentThreadId(sentThreadId);
          window.history.replaceState(null, '', `/dashboard/conversations/${sentThreadId}`);
        }
        const persistedUser = event.data.message as Record<string, unknown> | undefined;
        const persistedResponse = event.data.response as Record<string, unknown> | undefined;
        if (persistedUser || persistedResponse) {
          setMessages((current) => {
            const next = [...current];
            if (persistedUser?.id) {
              const userMessage: Message = {
                id: String(persistedUser.id),
                role: 'user',
                content: String(persistedUser.content || ''),
                timestamp: persistedUser.createdAt
                  ? new Date(String(persistedUser.createdAt)).getTime()
                  : Date.now(),
                metadata: persistedUser.metadata as Record<string, unknown> | undefined,
              };
              const optimisticIndex = next.findIndex(message =>
                message.id.startsWith('optimistic-user-') &&
                message.content === userMessage.content
              );
              const existingIndex = next.findIndex(message => message.id === userMessage.id);
              if (existingIndex >= 0) next[existingIndex] = userMessage;
              else if (optimisticIndex >= 0) next[optimisticIndex] = userMessage;
              else next.push(userMessage);
            }
            if (persistedResponse?.content && persistedResponse.messageId) {
              const responseMetadata = persistedResponse.metadata as Record<string, unknown> | undefined;
              const assistantMessage: Message = {
                id: String(persistedResponse.messageId),
                role: 'assistant',
                content: String(persistedResponse.content),
                agentType: persistedResponse.agentType as Message['agentType'],
                timestamp: persistedResponse.createdAt
                  ? new Date(String(persistedResponse.createdAt)).getTime()
                  : Date.now(),
                metadata: { ...responseMetadata, persisted: true },
              };
              return reconcileDurableConversationMessage(next, assistantMessage, streamAccumulatorsRef.current);
            }
            return next;
          });
        }
        break;
      }
      case "lead_inputs_generated": {
        const leadInputsThreadId = eventThreadId;
        if (leadInputsThreadId && currentThreadIdRef.current && leadInputsThreadId !== currentThreadIdRef.current) {
          break;
        }

        // The tab may already be mounted with an older durable batch. Bump its
        // resource revision so it reloads the just-persisted inputs instead of
        // continuing to render stale local component state.
        setLeadInputsRevision(revision => revision + 1);

        const existingLeadInputsTab = tabs.find(t => t.type === 'lead-inputs');
        if (existingLeadInputsTab) {
          void switchTab(existingLeadInputsTab.id);
        } else {
          addTab('lead-inputs', 'Lead Inputs', true, false);
        }

        toast({
          title: "Lead Inputs Ready",
          description: "Review and customize the inputs before starting lead generation.",
        });

        if (!workflowRunSeenRef.current) {
          clearProcessingTimeout();
          setIsProcessing(false);
        }
        break;
      }
      case "progress_step": {
        const eventThreadId = event.data.thread_id;
        if (eventThreadId && eventThreadId !== currentThreadIdRef.current) {
          break;
        }

        const message = event.data.message || 'Processing...';
        const agentType = (event.data.agent_type || 'orchestrator') as NonNullable<Message['agentType']>;

        if (isProcessing) {
          setActiveAgent((prev) => ({
            agentType: prev?.agentType || agentType,
            status: 'processing',
            progress: prev?.progress || 0,
            currentTask: message,
            workflowStage: prev?.workflowStage || 'icp_building',
          }));
        }
        break;
      }
      case "execution_summary": {
        const { status, successCount, totalLeads: savedCount } = normalizeLeadExecutionSummary(event.data);
        if (status === 'unknown') break;
        const totalLeads = savedCount ?? 0;
        const failed = status === 'failed';
        const cancelled = status === 'cancelled';
        const partial = status === 'partial_success';
        const empty = status === 'succeeded_empty';

        toast({
          title: failed
            ? "Lead Generation Failed"
            : cancelled
              ? "Lead Generation Cancelled"
              : partial
                ? "Lead Generation Partially Complete"
                : empty
                  ? "No Matching Leads Found"
                  : "Lead Generation Complete",
          description: failed
            ? "Every configured lead source failed. Review the source errors and retry."
            : cancelled
              ? `The run was cancelled after storing ${totalLeads} lead${totalLeads === 1 ? '' : 's'}.`
              : `${successCount} platforms succeeded. Generated ${totalLeads} total leads.`,
          ...(failed ? { variant: 'destructive' as const } : {}),
        });

        if (totalLeads > 0) {
          const existingLeadsTab = tabs.find(t => t.type === 'leads');
          if (existingLeadsTab) {
            void switchTab(existingLeadsTab.id);
          } else {
            addTab('leads', 'Leads', true, false, { totalLeads });
          }
        }
        if (!workflowRunSeenRef.current) {
          clearProcessingTimeout();
          setIsProcessing(false);
        }
        break;
      }
      case "tool_approval_required": {
        const eventThreadId = event.data.thread_id;
        if (eventThreadId && currentThreadIdRef.current && eventThreadId !== currentThreadIdRef.current) {
          break;
        }

        if (event.data.tool_name && toolHasWidget(event.data.tool_name)) {
          console.info(`[Page] Bypassing ToolApprovalDialog for widget-enabled tool: ${event.data.tool_name}`);
          break;
        }

        setApprovalData({
          toolName: event.data.tool_name || 'Unknown Tool',
          toolDescription: event.data.tool_description,
          parameters: event.data.parameters,
          agentType: event.data.agent_type,
          requestId: event.data.request_id,
        });
        setShowApprovalModal(shouldAutoOpenApproval({ toolName: event.data.tool_name || '', parameters: event.data.parameters }));
        if (!workflowRunSeenRef.current) {
          clearProcessingTimeout();
          setIsProcessing(false);
        }
        setActiveAgent(undefined);

        toast({
          title: "Approval Required",
          description: `The agent wants to execute: ${event.data.tool_name}`,
        });
        break;
      }
      case "tool_status": {
        const eventThreadId = event.data.thread_id;
        if (eventThreadId && eventThreadId !== currentThreadIdRef.current) {
          break;
        }

        if (event.data.status === 'completed') {
          toast({
            title: "Tool Completed",
            description: `${event.data.tool_name} executed successfully`,
          });
        } else if (event.data.status === 'error') {
          toast({
            title: "Tool Error",
            description: event.data.error || `${event.data.tool_name} failed`,
            variant: "destructive",
          });
        }
        break;
      }
      case "tool_execution": {
        const eventThreadId = event.data.thread_id;
        if (eventThreadId && eventThreadId !== currentThreadIdRef.current) {
          break;
        }

        const logEntry: ToolLogEntry = {
          id: String(event.data.toolCallId || `tool-${event.data.toolName}-${event.data.timestamp || Date.now()}`),
          toolCallId: event.data.toolCallId as string | undefined,
          toolName: (event.data.toolName as string) || 'unknown',
          status: (event.data.status as 'started' | 'completed' | 'failed' | 'gated') || 'started',
          agentType: (event.data.agentType as string) || (event.data.agent_type as string) || undefined,
          args: (event.data.args as Record<string, unknown>) || undefined,
          error: event.data.error as string | undefined,
          durationMs: event.data.durationMs as number | undefined,
          timestamp: (event.data.timestamp as number) || Date.now(),
        };

        setToolLogs(prev => {
          const previous = prev.find(log => log.id === logEntry.id);
          if (previous && previous.status !== "started" && logEntry.status === "started") return prev;
          return [...prev.filter(log => log.id !== logEntry.id), { ...previous, ...logEntry, args: logEntry.args || previous?.args }];
        });
        break;
      }
      case "content_generated": {
        const eventThreadId = event.data.thread_id;
        if (eventThreadId && eventThreadId !== currentThreadIdRef.current) {
          break;
        }

        addActionUpdate({
          type: 'content',
          action: 'created',
          title: `${event.data.content_type || 'Content'} Generated`,
          data: {
            contentType: event.data.content_type,
            contentId: event.data.content_id,
          },
        });

        addLiveSignal({
          type: 'success',
          message: `New ${event.data.content_type} content is ready`,
          source: 'Content Studio',
        });

        toast({
          title: "Content Generated",
          description: `New ${event.data.content_type} content is ready!`,
        });

        const contentType = event.data.content_type as string;
        const contentTypeToTabType: Record<string, string> = {
          'email_template': 'content-email',
          'email': 'content-email',
          'sms_template': 'content-sms',
          'sms': 'content-sms',
          'whatsapp': 'content-whatsapp',
          'whatsapp_template': 'content-whatsapp',
          'social_dm': 'content-social-message',
          'social_post': 'content-social',
          'social': 'content-social',
          'social_message': 'content-social-message',
          'ad_copy': 'content-adcopy',
          'image': 'content-image',
          'video': 'content-video',
          'blog_post': 'content-blog',
          'blog': 'content-blog',
        };
        const targetTabType = contentTypeToTabType[contentType] || 'content-studio';
        const existingContentTab = tabs.find(t => t.type === targetTabType);
        if (!existingContentTab) {
          addTab(targetTabType, getTabLabel(targetTabType), true, false);
        } else {
          setTabData(prev => ({ ...prev, [existingContentTab.id]: { ...prev[existingContentTab.id], refreshKey: Date.now() } }));
          void switchTab(existingContentTab.id);
        }
        break;
      }
      case "leads_batch_saved": {
        const leadThreadId = event.data.thread_id || event.data.threadId;
        if (leadThreadId && currentThreadIdRef.current && leadThreadId !== currentThreadIdRef.current) break;

        const batchLeads = (event.data.leads as Array<{ name?: string; company?: string; email?: string; phone?: string }>) || [];
        const platform = (event.data.platform || '') as string;
        const count = typeof event.data.count === 'number' ? event.data.count : batchLeads.length;

        if (count > 0) {
          const leadMsg: Message = {
            id: `leads-batch-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            role: 'agent',
            agentType: 'lead_generation',
            content: `Saved ${count} lead(s) from ${platform}`,
            timestamp: Date.now(),
            metadata: {
              isLeadSaved: true,
              lead: batchLeads[0],
              platform,
              count,
              isBatch: true,
            },
          };
          setMessages(prev => [...prev, leadMsg]);
        }
        break;
      }
      case "business_profile_created": {
        const eventThreadId = event.data.thread_id as number | undefined;
        const profileId = event.data.profile_id as number | undefined;
        const companyName = event.data.company_name as string | undefined;

        if (eventThreadId && currentThreadIdRef.current && eventThreadId !== currentThreadIdRef.current) {
          return;
        }

        if (profileId && companyName) {
          setSelectedBusinessId(profileId);
          setSelectedBusinessName(companyName);
        }
        break;
      }
      case "websocket_disconnected": {
        if (isProcessingRef.current && !workflowRunSeenRef.current) {
          clearProcessingTimeout();
          setIsProcessing(false);
          setActiveAgent(undefined);
        }
        break;
      }
      case "websocket_connected": {
        if (!currentThreadIdRef.current) return;
        const sinceTs = lastSeenTsRefVar.current;
        const durableCursor = lastDurableCursorRef.current;
        const reconnectThreadId = currentThreadIdRef.current;
        (async () => {
          try {
            const threadState = await api.get<{
              metadata?: { workflowRun?: { status?: string; updatedAt?: string | number }; workflowOutcome?: string; requiresApproval?: boolean; pendingApproval?: unknown };
            }>(`/api/chat/threads/${reconnectThreadId}`);
            if (currentThreadIdRef.current !== reconnectThreadId) return;
            const durableApproval = readDurableApproval(threadState.metadata);
            setApprovalData(durableApproval);
            if (!durableApproval) setShowApprovalModal(false);
            const durableStatus = threadState.metadata?.workflowRun?.status
              || threadState.metadata?.workflowOutcome;
            if (durableStatus) {
              workflowRunSeenRef.current = true;
              const processingIsFresh = shouldResumeConversationProcessing(threadState.metadata?.workflowRun);
              workflowRunStatusRef.current = durableStatus === 'running' && !processingIsFresh ? 'timed_out' : durableStatus;
              setIsProcessing(processingIsFresh);
              if (!processingIsFresh) {
                clearProcessingTimeout();
                isProcessingRef.current = false;
                setActiveAgent(undefined);
              }
            }
            type MissedMessagesResponse = { messages: Array<{
              id: number; role: string; content: string; agentType?: string;
              metadata?: Record<string, unknown>; createdAt: string;
            }>; missedCount: number; hasMore?: boolean; nextSince?: string | null; nextSinceId?: number | null };
            const missedMessages: MissedMessagesResponse['messages'] = [];
            let nextSince = durableCursor?.createdAt || new Date(sinceTs).toISOString();
            let nextSinceId: number | null = durableCursor?.id || null;
            let hasMore = true;
            let pageCount = 0;

            while (hasMore && pageCount < 100 && currentThreadIdRef.current === reconnectThreadId) {
              const cursor: string = nextSinceId ? `&sinceId=${nextSinceId}` : '';
              const page: MissedMessagesResponse = await api.get<MissedMessagesResponse>(
                `/api/chat/threads/${reconnectThreadId}/messages?since=${encodeURIComponent(nextSince)}${cursor}`,
              );
              missedMessages.push(...page.messages);
              hasMore = !!page.hasMore;
              nextSince = page.nextSince || nextSince;
              nextSinceId = page.nextSinceId || null;
              pageCount += 1;
              if (page.messages.length === 0) break;
            }

            if (missedMessages.length > 0 && currentThreadIdRef.current === reconnectThreadId) {
              setMessages(prev => {
                const newMessages: Message[] = missedMessages
                  .map(msg => ({
                    id: msg.id.toString(),
                    role: msg.role as Message['role'],
                    content: msg.content,
                    agentType: msg.agentType as Message['agentType'],
                    timestamp: new Date(msg.createdAt).getTime(),
                    metadata: msg.metadata,
                  }));
                if (newMessages.length === 0) return prev;
                return newMessages.reduce(
                  (reconciled, message) => reconcileDurableConversationMessage(reconciled, message, streamAccumulatorsRef.current),
                  prev,
                ).sort((a, b) => a.timestamp - b.timestamp);
              });
              webSocketService.subscribeToThread(reconnectThreadId);
              const lastDurable = missedMessages.at(-1);
              if (lastDurable) {
                lastDurableCursorRef.current = {
                  createdAt: lastDurable.createdAt,
                  id: lastDurable.id,
                };
                lastSeenTsRefVar.current = new Date(lastDurable.createdAt).getTime();
              }
            }
          } catch (error) {
            toast({
              title: "Message sync incomplete",
              description: error instanceof Error ? error.message : "Missed messages could not be synchronized.",
              variant: "destructive",
            });
          }
        })();
        break;
      }
    }
  }, [toast, setActiveAgent, setIsProcessing, setMessages, addActionUpdate, addLiveSignal, currentThreadIdRef, pendingNewThreadRequestIdRef, addTab, tabs, switchTab, setTabData, lastSeenTsRefVar, fetchICPData, locallyCreatedThreadRef, setCurrentThreadId, clearProcessingTimeout, isProcessingRef, acceptRealtimeThread]);

  useEffect(() => {
    if (user) {
      const unsubICP = wsSubscribe('icp_update', (e) => handleWebSocketEvent({ type: 'icp_update', data: e as any }));
      const unsubOrch = wsSubscribe('orchestrator_progress', (e) => handleWebSocketEvent({ type: 'orchestrator_progress', data: e as any }));
      const unsubStarted = wsSubscribe('workflow_started', (e) => handleWebSocketEvent({ type: 'workflow_started', data: e as any }));
      const unsubStep = wsSubscribe('workflow_step', (e) => handleWebSocketEvent({ type: 'workflow_step', data: e as any }));
      const unsubComp = wsSubscribe('workflow_completed', (e) => handleWebSocketEvent({ type: 'workflow_completed', data: e as any }));
      const unsubErr = wsSubscribe('workflow_error', (e) => handleWebSocketEvent({ type: 'workflow_error', data: e as any }));
      const unsubBatch = wsSubscribe('batch_progress', (e) => handleWebSocketEvent({ type: 'batch_progress', data: e as any }));
      const unsubExec = wsSubscribe('execution_summary', (e) => handleWebSocketEvent({ type: 'execution_summary', data: e as any }));
      const unsubStatus = wsSubscribe('agent_status', (e) => handleWebSocketEvent({ type: 'agent_status', data: e as any }));
      const unsubWorkflowRun = wsSubscribe('workflow_run_status', (e) => handleWebSocketEvent({ type: 'workflow_run_status', data: e as any }));
      const unsubChat = wsSubscribe('chat_response', (e) => handleWebSocketEvent({ type: 'chat_response', data: e as any }));
      const unsubChunk = wsSubscribe('chat_response_chunk', (e) => handleWebSocketEvent({ type: 'chat_response_chunk', data: e as any }));
      const unsubThreadResolved = wsSubscribe('thread_resolved', (e) => handleWebSocketEvent({ type: 'thread_resolved', data: e as any }));
      
      const unsubOpenTab = wsSubscribe('open_tab', (event: Record<string, unknown>) => {
        const rawEventThreadId = conversationEventThreadId(event);
        if (!matchesConversationEventScope('open_tab', event, currentThreadIdRef.current) || !acceptRealtimeThread(rawEventThreadId)) return;
        const tabType = event.tabType as string;
        const tabLabel = event.tabLabel as string || tabType;
        const tabEventData = event.data as Record<string, unknown> || {};

        if (!tabType) return;

        if (tabType === 'brandtoolkit') {
          if (tabEventData.mode === 'create') {
            handleCreateBrandToolkit();
          } else {
            handleOpenBrandToolkitSelector();
          }
          return;
        }

        if (tabType === 'agentchoose') {
          setChatViewMode('overview');
          setResultPanelOpen(true);
          setMobilePane('results');
          if (Array.isArray(tabEventData.recommendedAgents)) {
            setRecommendedAgents(tabEventData.recommendedAgents as string[]);
          }
          if (tabEventData.recommendedAgentScores) setRecommendedAgentScores(tabEventData.recommendedAgentScores as any);
          if (tabEventData.agentDescriptions) {
            setAgentDescriptions(tabEventData.agentDescriptions as any);
          }
        }
        addTab(tabType, tabLabel, true, false, tabEventData);
      });

      const unsubMsg = wsSubscribe('chat_message', (e) => handleWebSocketEvent({ type: 'chat_message', data: e as any }));
      const unsubSent = wsSubscribe('message_sent', (e) => handleWebSocketEvent({ type: 'message_sent', data: e as any }));
      const unsubProg = wsSubscribe('progress_step', (e) => handleWebSocketEvent({ type: 'progress_step', data: e as any }));
      const unsubAppr = wsSubscribe('tool_approval_required', (e) => handleWebSocketEvent({ type: 'tool_approval_required', data: e as any }));
      const unsubTStat = wsSubscribe('tool_status', (e) => handleWebSocketEvent({ type: 'tool_status', data: e as any }));
      const unsubTExec = wsSubscribe('tool_execution', (e) => handleWebSocketEvent({ type: 'tool_execution', data: e as any }));
      const unsubCont = wsSubscribe('content_generated', (e) => handleWebSocketEvent({ type: 'content_generated', data: e as any }));
      const unsubLInp = wsSubscribe('lead_inputs_generated', (e) => handleWebSocketEvent({ type: 'lead_inputs_generated', data: e as any }));
      const unsubLSave = wsSubscribe('lead_saved', (e) => handleWebSocketEvent({ type: 'lead_saved', data: e as any }));
      const unsubLBatch = wsSubscribe('leads_batch_saved', (e) => handleWebSocketEvent({ type: 'leads_batch_saved', data: e as any }));
      const unsubBiz = wsSubscribe('business_profile_created', (e) => handleWebSocketEvent({ type: 'business_profile_created', data: e as any }));

      const unsubWidgetCreated = wsSubscribe('widget_created', (event: Record<string, unknown>) => {
        // A new campaign can emit its first widget before thread_resolved.
        // Adopt only a widget correlated to this tab's first request. Another
        // open campaign can publish a widget while this campaign is starting.
        if (!acceptRealtimeThread(event.thread_id, true, conversationEventRequestId(event))) return;
        const eventThreadId = Number(event.thread_id);
        const widgetData = event.widget as any;
        if (widgetData) window.dispatchEvent(new CustomEvent('widget:created', {
          detail: { ...widgetData, threadId: eventThreadId },
        }));
      });

      const unsubWidgetUpdated = wsSubscribe('widget_update', (event: Record<string, unknown>) => {
        if (!acceptRealtimeThread(event.thread_id, true, conversationEventRequestId(event))) return;
        const eventThreadId = Number(event.thread_id);
        const widgetData = event.widget as any;
        if (widgetData) {
          const widgetStatus = String(widgetData.status || '');
          const linkedMessageId = widgetData.messageId;
          if (linkedMessageId != null) {
            setMessages(previous => previous.map(message => {
              const metadata = message.metadata || {};
              const isLinked = String(message.id) === String(linkedMessageId)
                || String(metadata.widgetMessageId || '') === String(linkedMessageId);
              if (!isLinked) return message;
              const toolOutput = metadata.toolOutput && typeof metadata.toolOutput === 'object'
                ? metadata.toolOutput as Record<string, unknown>
                : {};
              return {
                ...message,
                metadata: {
                  ...metadata,
                  widgetStatus,
                  success: widgetStatus === 'succeeded'
                    ? true
                    : widgetStatus === 'failed' ? false : metadata.success,
                  error: widgetData.executionError || metadata.error,
                  toolOutput: {
                    ...toolOutput,
                    awaitingSubmission: widgetStatus === 'active' || widgetStatus === 'draft',
                  },
                },
              };
            }));
          }
          window.dispatchEvent(new CustomEvent('widget:updated', {
            detail: { ...widgetData, threadId: eventThreadId },
          }));
        }
      });

      const unsubError = wsSubscribe('error', (e) => handleWebSocketEvent({ type: 'error', data: e as any }));
      const unsubDisc = wsSubscribe('websocket_disconnected', () => handleWebSocketEvent({ type: 'websocket_disconnected', data: {} }));
      const unsubConn = wsSubscribe('websocket_connected', () => handleWebSocketEvent({ type: 'websocket_connected', data: {} }));

      return () => {
        unsubICP();
        unsubOrch();
        unsubStarted();
        unsubStep();
        unsubComp();
        unsubErr();
        unsubBatch();
        unsubExec();
        unsubStatus();
        unsubWorkflowRun();
        unsubChat();
        unsubChunk();
        unsubThreadResolved();
        unsubOpenTab();
        unsubMsg();
        unsubSent();
        unsubProg();
        unsubAppr();
        unsubTStat();
        unsubTExec();
        unsubCont();
        unsubLInp();
        unsubLSave();
        unsubLBatch();
        unsubBiz();
        unsubWidgetCreated();
        unsubWidgetUpdated();
        unsubError();
        unsubDisc();
        unsubConn();
      };
    }
  }, [user, wsSubscribe, handleWebSocketEvent, addTab, currentThreadIdRef, setRecommendedAgentScores, setAgentDescriptions, acceptRealtimeThread]);

  // Fetch dynamic example prompts from backend
  useEffect(() => {
    const fetchExamplePrompts = async () => {
      try {
        const data = await api.get<{ suggestions?: string[]; allSuggestions?: string[] }>('/api/suggestions');
        const suggestions = data.allSuggestions || data.suggestions || [];
        if (suggestions.length > 0) {
          const shuffled = [...suggestions].sort(() => Math.random() - 0.5);
          setExamplePrompts(shuffled.slice(0, 3));
        } else {
          setExamplePrompts([
            "Find exactly 5 tech CEOs in San Francisco using LinkedIn",
            "Generate exactly 5 B2B SaaS leads targeting marketing directors in North America",
            "Create content for social media targeting millennials interested in fitness",
          ]);
        }
      } catch {
        setExamplePrompts([
          "Find exactly 5 tech CEOs in San Francisco using LinkedIn",
          "Generate exactly 5 B2B SaaS leads targeting marketing directors in North America",
          "Create content for social media targeting millennials interested in fitness",
        ]);
      }
    };
    fetchExamplePrompts();
  }, [user]);

  // Load thread from URL parameter or reset for new chat
  useEffect(() => {
    if (rawThreadId && !threadIdFromUrl) {
      router.replace('/dashboard/conversations');
      toast({
        title: "Invalid conversation",
        description: "That conversation link is not valid.",
        variant: "destructive",
      });
      return;
    }
    if (threadIdFromUrl) {
      if (locallyCreatedThreadRef.current === threadIdFromUrl) return;
      // The ref is updated synchronously at the start of handleThreadSelect.
      // Reading state here lets React Strict Mode's second effect invocation
      // start the same load again and abort the first request, which surfaces as
      // an unhandled AbortError and causes a visible error-overlay flicker.
      if (threadIdFromUrl !== currentThreadIdRef.current) {
        void handleThreadSelect(threadIdFromUrl);
      }
    } else if (!threadIdFromUrl && currentThreadIdRef.current !== null) {
      handleNewThread();
    }
  }, [threadIdFromUrl, rawThreadId]);

  // Load tab configurations when thread changes
  useEffect(() => {
    const controller = new AbortController();
    const requestedThreadId = currentThreadId;
    let tabLoadTimedOut = false;
    const tabLoadTimeout = requestedThreadId
      ? window.setTimeout(() => {
          tabLoadTimedOut = true;
          controller.abort();
        }, 10_000)
      : undefined;
    const loadTabConfigs = async () => {
      if (requestedThreadId) {
        setTabsLoaded(false);
        try {
          const response = await api.get(`/api/chat/threads/${requestedThreadId}/tabs`, {
            signal: controller.signal,
          });
          if (
            controller.signal.aborted ||
            currentThreadIdRef.current !== requestedThreadId
          ) return;
          if (response && Array.isArray(response)) {
            if (response.length > 0) {
              const orderedTabConfigs = [...response]
                .sort((a: TabConfig, b: TabConfig) => a.tabOrder - b.tabOrder)
                .map((config: TabConfig) => ({
                  ...config,
                  tabType: normalizeTabType(config.tabType),
                }));
              const tabConfigs = dedupeSingletonConversationTabs(orderedTabConfigs);
              const loadedTabs: Tab[] = tabConfigs
                .map((config: TabConfig) => {
                  const tabType = config.tabType;
                  return {
                    id: config.tabId,
                    type: tabType,
                    label: config.tabLabel,
                    closeable: tabType === 'overview' ? false : config.closeable !== false
                  };
                });
              setTabs(loadedTabs);
              setTabData(Object.fromEntries(
                tabConfigs.map((config: TabConfig) => [config.tabId, config.tabData || {}]),
              ));

              const activeTabConfig = tabConfigs.find((config: TabConfig) => config.isActive);
              const activeTabId = activeTabConfig?.tabId;
              const tabExists = loadedTabs.some(t => t.id === activeTabId);

              if (activeTabId && tabExists) {
                setActiveTab(activeTabId);
              } else if (loadedTabs.length > 0) {
                setActiveTab(loadedTabs[0].id);
              }

              if (tabConfigs.length < orderedTabConfigs.length) {
                try {
                  await api.put(`/api/chat/threads/${requestedThreadId}/tabs`, {
                    tabs: toConversationTabReplacement(tabConfigs),
                  });
                } catch (cleanupError) {
                  console.warn('[Chat] Duplicate result tabs were hidden but could not be cleaned up:', cleanupError);
                }
              }
            } else {
              const defaultOverviewTab: Tab = {
                id: `overview-${Date.now()}`,
                type: 'overview',
                label: 'Overview',
                closeable: false,
              };
              setTabs([defaultOverviewTab]);
              setTabData({});
              setActiveTab(defaultOverviewTab.id);

              try {
                if (currentThreadIdRef.current !== requestedThreadId) return;
                await api.post(`/api/chat/threads/${requestedThreadId}/tabs`, {
                  tabId: defaultOverviewTab.id,
                  tabType: 'overview',
                  tabLabel: 'Overview',
                  tabOrder: 0,
                  isActive: true
                });
              } catch (saveError) {
                toast({
                  title: "Tab layout was not saved",
                  description: saveError instanceof Error ? saveError.message : "The default Overview tab could not be persisted.",
                  variant: "destructive",
                });
              }
            }
          }
          if (!controller.signal.aborted && currentThreadIdRef.current === requestedThreadId) {
            setTabsLoaded(true);
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError' && !tabLoadTimedOut) return;
          if (currentThreadIdRef.current !== requestedThreadId) return;
          setTabs([]);
          setTabData({});
          setTabsLoaded(true);
          toast({
            title: "Saved tabs unavailable",
            description: tabLoadTimedOut
              ? "The saved workspace did not respond within 10 seconds. Reopen the workspace view to retry."
              : error instanceof Error ? error.message : "Your saved conversation tabs could not be loaded.",
            variant: "destructive",
          });
        } finally {
          if (tabLoadTimeout !== undefined) window.clearTimeout(tabLoadTimeout);
        }
      } else {
        setTabsLoaded(true);
      }
    };

    void loadTabConfigs();
    return () => {
      if (tabLoadTimeout !== undefined) window.clearTimeout(tabLoadTimeout);
      controller.abort();
    };
  }, [currentThreadId, currentThreadIdRef, setTabs, setActiveTab, setTabsLoaded, setTabData, toast]);

  // Fetch ICP data for a thread
  const fetchICPByThread = async (threadId: number, signal?: AbortSignal) => {
    try {
      const response = await api.get<any>(`/api/icp/thread/${threadId}`, { signal });
      if (signal?.aborted || currentThreadIdRef.current !== threadId) return;
      if (response) {
        const mappedICP = {
          campaign_name: response.campaignName || '',
          campaign_objective: response.campaignObjective || '',
          target_audience: response.targetAudience || '',
          industry_vertical: response.industry || '',
          sub_industry: response.subIndustry || '',
          business_type: response.targetBusinessModel || response.businessType || '',
          geography_locations: response.primaryRegions || [],
          target_roles_titles: response.primaryJobTitles || [],
          interests: [],
          sources: response.primaryChannels || [],
          company_size: response.targetCompanySizeRange || response.companySizeRange || '',
          revenue_range: response.targetRevenueRange || response.revenueRange || '',
          budget_range: response.budgetRange || '',
          technologies: response.techStack || [],
          pain_points: response.primaryPainPoint ? [response.primaryPainPoint] : (response.primaryPainPoints || []),
          buying_triggers: [],
          decision_makers: response.decisionMakers || [],
          summary: response.summary || '',
          keywords: [],
          messaging_themes: [],
          company_name: response.companyName || '',
          company_website: response.companyWebsite || '',
          company_address: response.companyAddress || '',
          primary_value_proposition: response.primaryValueProposition || '',
        };
        setIcp(mappedICP);
        setIcpId(response.id || null);
        setFitScore(response.fitScore || 0);
        setUserIntent(response.userIntent ?? null);
      } else {
        setIcp(null);
        setIcpId(null);
      }
      setIcpContextStatus('ready');
    } catch (_error: unknown) {
      if (signal?.aborted) return;
      if (_error instanceof Error && _error.name === 'AbortError') return;
      if (currentThreadIdRef.current !== threadId) return;
      setIcp(null);
      setIcpId(null);
      setFitScore(0);
      setUserIntent(null);
      setRecommendedAgentScores(undefined);
      setAgentDescriptions(undefined);
      setIcpContextStatus('error');
    }
  };



  async function handleThreadSelect(threadId: number) {
    if (
      threadLoadThreadIdRef.current === threadId &&
      threadLoadAbortRef.current &&
      !threadLoadAbortRef.current.signal.aborted
    ) {
      return;
    }
    const generation = ++threadLoadGenerationRef.current;
    threadLoadAbortRef.current?.abort();
    olderMessagesAbortRef.current?.abort();
    const controller = new AbortController();
    threadLoadThreadIdRef.current = threadId;
    threadLoadAbortRef.current = controller;
    const isCurrentLoad = () =>
      !controller.signal.aborted &&
      generation === threadLoadGenerationRef.current &&
      currentThreadIdRef.current === threadId;
    try {
      const switchingThread = currentThreadIdRef.current !== threadId;
      const messagesBeforeRead = switchingThread ? [] : messages;
      setThreadLoadError(null);
      setIcpContextStatus('loading');
      setCurrentThreadId(threadId);
      currentThreadIdRef.current = threadId;
      pendingNewThreadRef.current = false;
      if (switchingThread) resetWidgets(threadId);
      locallyCreatedThreadRef.current = null;
      setIsLoadingMessages(true);
      // A retry refreshes this same conversation. Keep its last known history
      // and reviews visible if the refresh also fails; never show another
      // conversation's data when switching to a different requested ID.
      if (switchingThread) {
        clearProcessingTimeout();
        conversationEventLedgerRef.current = createConversationEventLedger();
        workflowRunSeenRef.current = false;
        workflowRunStatusRef.current = null;
        setIsProcessing(false);
        setActiveAgent(undefined);
        setMessages([]);
        setSeenMessageIds(new Set());
        setToolLogs([]);
        setTabData({});
        setShowApprovalModal(false);
        setApprovalData(null);
        setApprovingTool(false);
      }

      // The URL effect (or the same-thread Retry button) owns this load.
      // Navigating to that URL again starts a redundant Next route request
      // while this conversation's messages and tabs are still being restored.

      const threadDetails = await api.get<{
        id: number;
        title: string;
        businessId?: number;
        metadata?: {
          workflowRun?: { status?: string; updatedAt?: string | number };
          workflowOutcome?: string;
          requiresApproval?: boolean;
          pendingApproval?: unknown;
        };
        createdAt: string;
        updatedAt: string;
      }>(`/api/chat/threads/${threadId}`, { signal: controller.signal });
      if (!isCurrentLoad()) return;

      setChatName(threadDetails.title);
      setApprovalData(readDurableApproval(threadDetails.metadata));
      const durableWorkflowStatus = threadDetails.metadata?.workflowRun?.status
        || threadDetails.metadata?.workflowOutcome;
      if (durableWorkflowStatus) {
        workflowRunSeenRef.current = true;
        const processingIsFresh = shouldResumeConversationProcessing(threadDetails.metadata?.workflowRun);
        workflowRunStatusRef.current = durableWorkflowStatus === 'running' && !processingIsFresh ? 'timed_out' : durableWorkflowStatus;
        setIsProcessing(processingIsFresh);
        if (!processingIsFresh) {
          clearProcessingTimeout();
          isProcessingRef.current = false;
          setActiveAgent(undefined);
        }
      }

      if (threadDetails.businessId) {
        setSelectedBusinessId(threadDetails.businessId);
        try {
          const businessDetails = await api.get<{
            id: number;
            name: string;
            companyName?: string;
            businessType?: string;
            profileType?: string;
            industry?: string;
            subIndustry?: string;
            website?: string;
            city?: string;
            state?: string;
            country?: string;
            description?: string;
          }>(`/api/settings/business-profiles/${threadDetails.businessId}`, {
            signal: controller.signal,
          });
          if (!isCurrentLoad()) return;
          setSelectedBusinessName(businessDetails.name || businessDetails.companyName || '');
          setSelectedBusinessDetails(businessDetails);
        } catch (error) {
          if (!isCurrentLoad()) return;
          setSelectedBusinessDetails(null);
          toast({
            title: "Business details unavailable",
            description: error instanceof Error ? error.message : "The business profile linked to this conversation could not be loaded.",
            variant: "destructive",
          });
        }
      } else {
        setSelectedBusinessId(null);
        setSelectedBusinessName("");
        setSelectedBusinessDetails(null);
      }

      const messagesResponse = await api.get<{
        messages: Array<{
          id: number;
          role: string;
          content: string;
          agentType?: string;
          metadata?: Record<string, unknown>;
          createdAt: string;
        }>;
        nextCursor?: number | null;
        hasMore?: boolean;
      }>(`/api/chat/threads/${threadId}/messages`, { signal: controller.signal });
      if (!isCurrentLoad()) return;
      
      const threadMessages = messagesResponse.messages || [];

      const formattedMessages: Message[] = threadMessages.map(msg => ({
        id: msg.id.toString(),
        role: msg.role as Message['role'],
        content: msg.content,
        agentType: msg.agentType as Message['agentType'],
        timestamp: new Date(msg.createdAt).getTime(),
        metadata: msg.metadata,
      }));

      const welcomeMessage: Message = {
        id: "welcome",
        role: "agent",
        agentType: "orchestrator",
        content: "**Welcome to AskSales.AI 👋**\n**Plan, run, and grow your marketing with AI agents.**\n\n\nWhat would you like to work on today?",
        timestamp: formattedMessages.length > 0
          ? formattedMessages[0].timestamp - 1000
          : Date.now(),
      };

      setMessages(current => {
        if (!isCurrentLoad()) return current;
        const restored = mergeConversationHistory(formattedMessages, current, messagesBeforeRead, streamAccumulatorsRef.current);
        return [{ ...welcomeMessage, timestamp: restored[0] ? restored[0].timestamp - 1000 : welcomeMessage.timestamp }, ...restored];
      });
      setOlderMessageCursor(messagesResponse.nextCursor ?? null);
      setHasOlderMessages(Boolean(messagesResponse.hasMore && messagesResponse.nextCursor));
      setIsLoadingMessages(false);

      if (formattedMessages.length > 0) {
        const newest = threadMessages.at(-1);
        lastSeenTsRef.current = Math.max(...formattedMessages.map(m => m.timestamp));
        if (newest) {
          lastDurableCursorRef.current = {
            createdAt: newest.createdAt,
            id: newest.id,
          };
        }
      } else {
        lastDurableCursorRef.current = null;
      }

      loadWidgets(threadId);

      const storedMessage = sessionStorage.getItem('chat_initial_message');
      if (storedMessage && storedMessage.trim()) {
        sessionStorage.removeItem('chat_initial_message');
        setTimeout(() => {
          handleSendMessage(storedMessage.trim());
        }, 300);
      }

      await fetchICPByThread(threadId, controller.signal);
      if (!isCurrentLoad()) return;
      setShowAgentSuggestions(false);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (!isCurrentLoad()) return;
      setIsLoadingMessages(false);
      // An unavailable API is not evidence that this conversation was deleted
      // or belongs to someone else. Preserve its URL/identity and offer retry.
      if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) {
        setIcpContextStatus('error');
        setThreadLoadError({
          threadId,
          message: error instanceof Error ? error.message : "The conversation could not be loaded. Please retry.",
        });
        return;
      }
      setThreadLoadError(null);
      clearProcessingTimeout();
      setIsProcessing(false);
      setActiveAgent(undefined);
      workflowRunSeenRef.current = false;
      workflowRunStatusRef.current = null;
      setMessages([]);
      setChatName("");
      setIcp(null);
      setIcpId(null);
      setIcpContextStatus('ready');
      setApprovalData(null);
      setShowApprovalModal(false);
      setTabData({});
      setTabs([]);
      setActiveTab("");
      setCurrentThreadId(null);
      currentThreadIdRef.current = null;
      pendingNewThreadRef.current = false;
      locallyCreatedThreadRef.current = null;
      resetWidgets(null);
      setOlderMessageCursor(null);
      setHasOlderMessages(false);
      router.replace('/dashboard/conversations');
      toast({
        title: "Conversation unavailable",
        description: error instanceof Error ? error.message : "Failed to load conversation",
        variant: "destructive",
      });
    } finally {
      // In-flight deduplication must not prevent a retry after settlement. A
      // stale request must not clear a newer conversation's controller.
      if (generation === threadLoadGenerationRef.current) {
        threadLoadAbortRef.current = null;
        threadLoadThreadIdRef.current = null;
      }
    }
  }

  async function handleLoadOlderMessages() {
    if (!currentThreadId || !olderMessageCursor || isLoadingOlderMessages) return;
    const requestedThreadId = currentThreadId;
    const requestedCursor = olderMessageCursor;
    olderMessagesAbortRef.current?.abort();
    const controller = new AbortController();
    olderMessagesAbortRef.current = controller;
    setIsLoadingOlderMessages(true);
    try {
      const response = await api.get<{
        messages: Array<{
          id: number;
          role: string;
          content: string;
          agentType?: string;
          metadata?: Record<string, unknown>;
          createdAt: string;
        }>;
        nextCursor: number | null;
        hasMore: boolean;
      }>(`/api/chat/threads/${requestedThreadId}/messages?limit=50&cursor=${requestedCursor}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || currentThreadIdRef.current !== requestedThreadId) return;
      const olderMessages: Message[] = response.messages.map((message) => ({
        id: message.id.toString(),
        role: message.role as Message['role'],
        content: message.content,
        agentType: message.agentType as Message['agentType'],
        timestamp: new Date(message.createdAt).getTime(),
        metadata: message.metadata,
      }));
      setMessages((current) => {
        const welcome = current.filter((message) => message.id === 'welcome');
        const existing = current.filter((message) => message.id !== 'welcome');
        const existingIds = new Set(existing.map((message) => message.id));
        return [...welcome, ...olderMessages.filter((message) => !existingIds.has(message.id)), ...existing];
      });
      setOlderMessageCursor(response.nextCursor);
      setHasOlderMessages(Boolean(response.hasMore && response.nextCursor));
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      toast({
        title: 'Older messages could not be loaded',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      // Clear the flag whenever this request is still the latest older-page
      // read, including when a thread switch aborted it. Otherwise the flag
      // stays set and older messages can never load in the next conversation.
      if (olderMessagesAbortRef.current === controller) {
        olderMessagesAbortRef.current = null;
        setIsLoadingOlderMessages(false);
      }
    }
  }

  function handleNewThread() {
    setThreadLoadError(null);
    threadLoadGenerationRef.current += 1;
    threadLoadAbortRef.current?.abort();
    threadLoadThreadIdRef.current = null;
    olderMessagesAbortRef.current?.abort();
    // The aborted thread load returns without settling its loading state (it
    // expects a newer load to own it); a new chat has nothing to load.
    setIsLoadingMessages(false);
    setIsLoadingOlderMessages(false);
    setCurrentThreadId(null);
    currentThreadIdRef.current = null;
    pendingNewThreadRef.current = false;
    isProcessingRef.current = false;
    resetWidgets(null);
    locallyCreatedThreadRef.current = null;
    router.push('/dashboard/conversations');
    clearProcessingTimeout();
    conversationEventLedgerRef.current = createConversationEventLedger();
    workflowRunSeenRef.current = false;
    workflowRunStatusRef.current = null;
    setIsProcessing(false);
    setSeenMessageIds(new Set());
    setToolLogs([]);
    setTabData({});
    setShowApprovalModal(false);
    setApprovalData(null);
    setApprovingTool(false);
    setMessages([
      {
        id: "welcome",
        role: "agent",
        agentType: "orchestrator",
        content: "**Welcome to AskSales.AI 👋**\n**Plan, run, and grow your marketing with AI agents.**\n\n\nWhat would you like to work on today?",
        timestamp: Date.now(),
      },
    ]);
    setOlderMessageCursor(null);
    setHasOlderMessages(false);
    lastSeenTsRef.current = Date.now();
    lastDurableCursorRef.current = null;
    setTabs([]);
    setActiveTab("");
    setIcp(null);
    setIcpId(null);
    setIcpContextStatus('ready');
    setFitScore(0);
    setUserIntent(null);
    setRecommendedAgentScores(undefined);
    setAgentDescriptions(undefined);
    setShowAgentSuggestions(false);
    setRecommendedAgents([]);
    setSelectedAgent(null);
    setActiveAgent(undefined);
    setChatName(`Chat ${new Date().toLocaleDateString()}`);
    setSelectedBusinessId(null);
    setSelectedBusinessName("");
    setSelectedBusinessDetails(null);
    setSelectedBusinessProfileId("");
  };

  const openAgentChooseTab = () => {
    setChatViewMode('overview');
    setResultPanelOpen(true);
    setMobilePane('results');
    const agentChooseTab = tabs.find(tab => tab.type === 'agentchoose');
    if (agentChooseTab) {
      if (activeTab === agentChooseTab.id) triggerTabHighlight(agentChooseTab.id);
      void switchTab(agentChooseTab.id);
    } else {
      addTab('agentchoose', 'Choose Agent', true);
    }
  };

  const openICPTab = () => {
    const icpTab = tabs.find(tab => tab.type === 'icp');
    if (icpTab) {
      if (activeTab === icpTab.id) triggerTabHighlight(icpTab.id);
      void switchTab(icpTab.id);
    } else {
      addTab('icp', 'ICP Profile', true);
    }
  };

  const openLeadInputsTab = () => {
    const leadInputsTab = tabs.find(tab => tab.type === 'lead-inputs');
    if (leadInputsTab) {
      if (activeTab === leadInputsTab.id) triggerTabHighlight(leadInputsTab.id);
      void switchTab(leadInputsTab.id);
    } else {
      addTab('lead-inputs', 'Lead Inputs', true);
    }
  };

  const openOutreachTab = () => {
    const outreachTab = tabs.find(tab => tab.type === 'outreach');
    if (outreachTab) {
      if (activeTab === outreachTab.id) triggerTabHighlight(outreachTab.id);
      void switchTab(outreachTab.id);
    } else {
      addTab('outreach', 'Outreach', true);
    }
  };

  const handleOpenBrandToolkitSelector = () => {
    setShowBrandToolkitSelector(true);
  };

  const handleCreateBrandToolkit = () => {
    setShowBrandToolkitCreate(true);
  };

  const handleBrandToolkitSelect = (toolkitId: number, toolkitName: string) => {
    handleSendMessage(`I want to use the brand toolkit "${toolkitName}" (ID: ${toolkitId}) for my campaigns.`);
    setShowBrandToolkitSelector(false);
  };

  const handleBrandToolkitCreated = () => {
    handleSendMessage('I just created a new brand toolkit. Please use my latest brand toolkit for campaigns.');
    setShowBrandToolkitCreate(false);
  };

  const handleOpenICPSelector = () => {
    setShowICPSelector(true);
  };

  const handleICPSelect = (icpId: number, icpName: string) => {
    handleSendMessage(`Load ICP "${icpName}" (ID: ${icpId}) for this session.`);
    setShowICPSelector(false);
  };

  const handleStartLeadGeneration = async (config = leadGenConfig) => {
    const normalizedConfig = {
      keywords: config.keywords.map(value => value.trim()).filter(Boolean),
      platforms: [...new Set(config.platforms)],
      leadCount: Math.min(Math.max(Math.round(config.leadCount), 1), 1000),
      locations: config.locations.map(value => value.trim()).filter(Boolean),
    };
    setLeadGenConfig(normalizedConfig);
    await handleSendMessage(
      `Run lead generation with this reviewed configuration:\n${JSON.stringify(normalizedConfig, null, 2)}`,
    );
  };

  // Initialize with welcome message on mount
  useEffect(() => {
    setMessages([
      {
        id: "welcome",
        role: "agent",
        agentType: "orchestrator",
        content: "**Welcome to AskSales.AI 👋**\n**Plan, run, and grow your marketing with AI agents.**\n\n\nWhat would you like to work on today?",
        timestamp: Date.now(),
      },
    ]);
  }, [setMessages]);

  const renderTabContent = () => {
    if (!tabsLoaded) {
      return <LoadingState className="h-full bg-background p-8" label="Loading saved workspace…" showLabel />;
    }

    if (tabs.length === 0) {
      return (
        <div className="flex h-full items-center justify-center bg-background p-8 text-center">
          <div>
            <h2 className="text-sm font-semibold">No workspace tabs are open</h2>
            <p className="mt-1 text-xs text-muted-foreground">Open a result or tool to use the visual workspace.</p>
            <button type="button" onClick={handleAddTabFromButton} className="mt-4 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground">
              Open tab picker
            </button>
          </div>
        </div>
      );
    }

    const currentTab = tabs.find(t => t.id === activeTab);
    if (!currentTab) {
      return (
        <div className="flex h-full items-center justify-center p-8 text-center" role="alert">
          <div>
            <h2 className="text-sm font-semibold">This tab is unavailable</h2>
            <p className="mt-1 text-xs text-muted-foreground">Choose another tab or reopen the workspace view.</p>
          </div>
        </div>
      );
    }

    switch (currentTab.type) {
      case "overview":
        return (
          <OverviewTab
            threadId={currentThreadId || undefined}
          />
        );

      case "icp":
        return (
          <ICPTab
            icp={icp}
            icpId={icpId || undefined}
            threadId={currentThreadId || undefined}
            businessId={selectedBusinessId || undefined}
            fitScore={fitScore}
            onFitScoreUpdate={setFitScore}
            onSendMessage={handleSendMessage}
          />
        );

      case "search":
        return <SearchTab onAddTab={addTab} />;

      case "agentchoose":
        return (
          <AgentChooseTab
            icpId={icpId || undefined}
            fitScore={fitScore}
            threadId={currentThreadId || undefined}
            recommendedAgents={recommendedAgents}
            recommendedAgentScores={recommendedAgentScores}
            agentDescriptions={agentDescriptions}
            userIntent={userIntent ?? undefined}
            onAgentSelect={(agentId) => {
              setSelectedAgent(agentId);
            }}
            onHireAgent={async (agentId, commandName) => {
              const agentThreadId = await ensureCampaignThread();
              const agent = agents.find(a => a.id === agentId);
              const agentType = AGENT_HIRE_TYPE_MAP[agentId] || agentId;

              await api.post('/api/chat/langgraph/action', {
                threadId: agentThreadId,
                action: 'HIRE_AGENT',
                data: { agentType },
              });

              const tabInfo = AGENT_HIRE_TAB_MAP[agentId] || { tabType: 'agentchoose' };

              if (tabInfo.tabType !== 'agentchoose') {
                await addTab(tabInfo.tabType, getTabLabel(tabInfo.tabType) || agent?.name || 'Agent', true, true);
              }

              toast({
                title: "Agent Hired",
                description: `${agent?.name || commandName} is now working on your campaign`,
              });
            }}
            onHireMultipleAgents={async (agentIds, agentNames) => {
              const agentThreadId = await ensureCampaignThread();
              await api.post('/api/chat/langgraph/action', {
                threadId: agentThreadId,
                action: 'HIRE_TEAM',
                data: { agentTypes: agentIds.map(id => AGENT_HIRE_TYPE_MAP[id] || id) },
              });

              toast({
                title: "Team Assembled",
                description: `${agentNames.join(' & ')} are now working on your campaign`,
              });
            }}
          />
        );

      case "leads":
        return <LeadsTab key={`leads-${currentThreadId}`} threadId={currentThreadId ?? undefined} onSendMessage={handleSendMessage} />;

      case "lead-inputs":
        return (
          <LeadsInputsTab
            key={`lead-inputs-${currentThreadId}-${leadInputsRevision}`}
            icpId={String(icpId || '')}
            platforms={icp?.sources || []}
            icpData={icp || {}}
            threadId={currentThreadId || undefined}
            onSendMessage={handleSendMessage}
            onApproval={handleApproveTool}
            approvalAvailable={approvalData?.toolName === 'execute_lead_workflow' && Boolean(approvalData.requestId)}
          />
        );

      case "outreach":
        return <OutreachTab icpId={icpId || undefined} threadId={currentThreadId || undefined} onSendMessage={handleSendMessage} />;

      case "analytics":
        return <StructuredAnalyticsTab data={tabData[activeTab]} />;

      case "campaigns":
        return <CampaignsTab threadId={currentThreadId || undefined} icpId={icpId || undefined} />;

      case "ads":
        return (
          <ContentStudioTab
            key={activeTab}
            icpId={icpId || undefined}
            businessProfileId={selectedBusinessProfileId ? Number(selectedBusinessProfileId) : undefined}
            threadId={currentThreadId || undefined}
            context="chat_sidebar"
            initialTab="ad_copy"
            hideTabBar
          />
        );

      case "leadconfig":
        return (
          <LeadConfigTab
            initialConfig={leadGenConfig}
            onStartGeneration={(config) => {
              void handleStartLeadGeneration(config);
            }}
            isProcessing={isProcessing}
          />
        );

      case "contentstudio":
      case "content-studio": {
        const contentStudioData = tabData[activeTab] || emptyTabData;
        const contentTabTypeToTabType: Record<string, string> = {
          image: 'content-image',
          video: 'content-video',
          email: 'content-email',
          sms: 'content-sms',
          whatsapp: 'content-whatsapp',
          social: 'content-social',
          social_message: 'content-social-message',
          ad_copy: 'content-adcopy',
          blog: 'content-blog',
        };
        return (
          <ContentStudioTab
            key={activeTab}
            icpId={icpId || undefined}
            businessProfileId={selectedBusinessProfileId ? Number(selectedBusinessProfileId) : undefined}
            threadId={currentThreadId || undefined}
            context="chat_sidebar"
            previewData={contentStudioData}
            initialTab="all"
            hideTabBar
            onOpenContentTab={(contentType) => {
              const tabType = contentTabTypeToTabType[contentType];
              if (tabType) {
                addTab(tabType, getTabLabel(tabType), true, false);
              }
            }}
            onSendMessage={handleSendMessage}
          />
        );
      }

      case "content-image":
      case "content-video":
      case "content-email":
      case "content-sms":
      case "content-whatsapp":
      case "content-social":
      case "content-social-message":
      case "content-adcopy":
      case "content-blog": {
        const currentTabObj = tabs.find(t => t.id === activeTab);
        const contentInitialTab = (CONTENT_TAB_INITIAL_MAP[currentTabObj?.type || ''] || 'all') as any;
        const perTypeData = tabData[activeTab] || emptyTabData;
        return (
          <ContentStudioTab
            key={activeTab}
            icpId={icpId || undefined}
            businessProfileId={selectedBusinessProfileId ? Number(selectedBusinessProfileId) : undefined}
            threadId={currentThreadId || undefined}
            context="chat_sidebar"
            previewData={perTypeData}
            initialTab={contentInitialTab}
            hideTabBar
            onSendMessage={handleSendMessage}
          />
        );
      }

      case "performancemarketing":
        return (
          <PerformanceMarketingTab
            icpId={icpId || undefined}
            icpStatus={icpContextStatus}
            onRetryIcp={() => { if (currentThreadId) void handleThreadSelect(currentThreadId); }}
            threadId={currentThreadId || undefined}
            onSendMessage={handleSendMessage}
          />
        );

      case "crm":
        return <CRMTab threadId={currentThreadId ? String(currentThreadId) : undefined} onSendMessage={handleSendMessage} />;

      case "support":
        return <SupportTab threadId={currentThreadId ? String(currentThreadId) : undefined} onSendMessage={handleSendMessage} />;

      case "proposals":
        return <ProposalsTab threadId={currentThreadId ? String(currentThreadId) : undefined} onSendMessage={handleSendMessage} />;

      default:
        return <SearchTab onAddTab={addTab} />;
    }
  };

  return (
    <div className="outreach-workspace campaign-coordinator relative flex h-full min-h-0 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <CampaignChatHeader
          campaignName={chatName || icp?.campaign_name || (currentThreadId ? "Campaign" : "New campaign")}
          lastMessageAt={messages.filter(m => m.id !== 'welcome').at(-1)?.timestamp}
          agents={usedAgentsInChat.map(a => ({
            id: a.id,
            agentType: Object.entries(allAgentDefinitions).find(([, def]) => def.id === a.id)?.[0] || '',
            name: a.name,
            initials: a.name.split(' ').map((n: string) => n[0]).join('').substring(0, 2),
            color: a.color || 'bg-purple-500',
            avatar: a.avatar || ''
          }))}
          onSearch={() => addTab('search')}
          threadId={currentThreadId}
          activeView={chatViewMode}
          onViewChange={(view) => {
            setChatViewMode(view);
          }}
          onAgentClick={handleHeaderAgentClick}
          onManageAgents={openAgentChooseTab}
        />

        {threadLoadError && threadLoadError.threadId === currentThreadId ? (
          <div role="alert" className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-muted px-4 py-3">
            <div className="min-w-0 text-sm">
              <p className="font-medium">Conversation could not be loaded</p>
              <p className="text-muted-foreground">{threadLoadError.message} Your conversation link has been kept.</p>
            </div>
            <Button variant="outline" disabled={isLoadingMessages} onClick={() => void handleThreadSelect(threadLoadError.threadId)}>
              Retry conversation
            </Button>
          </div>
        ) : null}

        {chatViewMode === 'campaign' && currentThreadId ? (
          <div className="flex-1 overflow-auto">
            <CampaignDashboardView threadId={currentThreadId} campaignName={chatName || icp?.campaign_name || "Campaign"} />
          </div>
        ) : (
          <>
            {tabs.length > 0 && resultPanelOpen && compactWorkspace ? (
              <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-3 py-2" role="tablist" aria-label="Conversation workspace pane">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mobilePane === 'chat'}
                  onClick={() => setMobilePane('chat')}
                  className={`inline-flex min-h-9 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors ${mobilePane === 'chat' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                >
                  <MessageSquareText className="h-4 w-4" aria-hidden="true" />
                  Chat
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mobilePane === 'results'}
                  onClick={() => setMobilePane('results')}
                  className={`relative inline-flex min-h-9 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors ${mobilePane === 'results' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                >
                  <PanelsTopLeft className="h-4 w-4" aria-hidden="true" />
                  Results
                  {highlightedTabId && mobilePane !== 'results' ? <span className="h-2 w-2 rounded-full bg-amber-400" aria-label="New result available" /> : null}
                </button>
              </div>
            ) : null}
            <div ref={conversationWorkspaceRef} className="coordinator-panels relative flex min-h-0 flex-1 overflow-hidden">
              <ChatActionProvider value={{
                onOpenAgentChooseTab: openAgentChooseTab,
                onOpenICPTab: openICPTab,
                onOpenLeadInputsTab: openLeadInputsTab,
                onOpenBrandToolkitTab: handleOpenBrandToolkitSelector,
                onCreateBrandToolkit: handleCreateBrandToolkit,
                onOpenICPSelector: handleOpenICPSelector,
                onOpenOutreachTab: openOutreachTab,
              }}>
              <ResizablePanel
                position="left"
                defaultWidth={panelWidths.defaultWidth}
                minWidth={panelWidths.minWidth}
                maxWidth={panelWidths.maxWidth}
                isOpen={chatPanelOpen}
                onOpenChange={setChatPanelOpen}
                stackOnMobile
                resizable={resultPanelOpen && !compactWorkspace}
                storageKey="asksales:conversation-chat-width:v3"
                className={`shrink-0 flex-col bg-card ${compactWorkspace ? "!h-full !min-h-0 !w-full" : ""} ${!compactWorkspace || mobilePane === "chat" || !resultPanelOpen ? "flex" : "hidden"} ${!resultPanelOpen ? "flex-1" : ""}`}
              >
                <ConversationTurnStatus basePath={currentThreadId ? `/api/chat/threads/${currentThreadId}` : undefined} active={isProcessing} idlePollMs={15_000} />
                <ChatInterface
                  campaignAssetId={searchParams.get('campaignAssetId')}
                  paidAdBrief={searchParams.get('agent') === 'performance_marketing' ? searchParams.get('paidAdBrief')?.slice(0, 2500) : null}
                  messages={messages}
                  onSendMessage={handleSendMessage}
                  onStop={() => { if (currentThreadId) void api.post(`/api/chat/threads/${currentThreadId}/stop`, {}).then(() => {
                    toast({ title: 'Stopping', description: 'The current response will stop before its next action.' });
                  }).catch(() => toast({ title: 'Could not stop', description: 'Check the action status before retrying.', variant: 'destructive' })); }}
                  onApproval={handleApproveTool}
                  isProcessing={isProcessing}
                  isLoadingMessages={isLoadingMessages}
                  hasOlderMessages={hasOlderMessages}
                  isLoadingOlderMessages={isLoadingOlderMessages}
                  onLoadOlderMessages={handleLoadOlderMessages}
                  toolLogs={toolLogs}
                  examplePrompts={examplePrompts}
                  chatName={currentThreadId ? chatName : undefined}
                  fitScore={fitScore}
                  currentThreadId={currentThreadId}
                  selectedAgent={selectedAgent}
                  activeAgent={activeAgent}
                  onOpenAgentChooseTab={openAgentChooseTab}
                  onOpenICPTab={openICPTab}
                  onOpenLeadInputsTab={openLeadInputsTab}
                  onOpenBrandToolkitTab={handleOpenBrandToolkitSelector}
                  onCreateBrandToolkit={handleCreateBrandToolkit}
                  onOpenICPSelector={handleOpenICPSelector}
                  onOpenOutreachTab={openOutreachTab}
                  businessProfiles={businessProfiles}
                  selectedBusinessProfileId={selectedBusinessProfileId}
                  onBusinessProfileChange={setSelectedBusinessProfileId}
                  currentIcpData={icp && icpId ? {
                    id: icpId,
                    campaignName: icp.campaign_name,
                    campaignObjective: icp.campaign_objective,
                    targetAudience: icp.target_audience,
                    industry: icp.industry_vertical,
                    targetBusinessModel: icp.business_type,
                    primaryRegions: icp.geography_locations,
                    targetCompanySizeRange: icp.company_size,
                    primaryJobTitles: icp.target_roles_titles,
                    primaryPainPoint: icp.pain_points?.[0],
                    primaryChannels: icp.sources,
                    fitScore: fitScore,
                  } : null}
                />
              </ResizablePanel>
              </ChatActionProvider>

              <div
                id="conversation-result-panel"
                aria-hidden={!resultPanelOpen}
                className={`min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l border-border bg-card ${resultPanelOpen && (!compactWorkspace || mobilePane === "results") ? "flex" : "hidden"}`}
              >
                <ChromeTabs
                  tabs={tabs}
                  activeTab={activeTab}
                  highlightedTabId={highlightedTabId}
                  onTabClick={switchTab}
                  onTabClose={removeTab}
                  onAddTab={handleAddTabFromButton}
                  onMinimize={minimizeResultPanel}
                  minimizeButtonRef={resultPanelMinimizeRef}
                />

                <div
                  id={`conversation-panel-${activeTab.replace(/[^a-zA-Z0-9_-]/g, "-")}`}
                  role="tabpanel"
                  aria-labelledby={`conversation-tab-${activeTab.replace(/[^a-zA-Z0-9_-]/g, "-")}`}
                  tabIndex={0}
                  className={`min-h-0 flex-1 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${tabs.find(t => t.id === activeTab)?.type === 'agentchoose' ? 'overflow-hidden flex flex-col' : 'overflow-auto'}`}
                >
                  {renderTabContent()}
                </div>
              </div>

              {!resultPanelOpen && (
                <Button
                  ref={resultPanelRestoreRef}
                  type="button"
                  variant="outline"
                  onClick={restoreResultPanel}
                  aria-label="Restore result panel"
                  aria-controls="conversation-result-panel"
                  aria-expanded="false"
                  title="Restore result panel"
                  size="icon"
                  className="!absolute right-4 top-4 z-30 h-10 w-10 shrink-0 rounded-lg border-border bg-card p-0 text-foreground shadow-md hover:bg-accent"
                >
                  <PanelRightOpen className="h-4 w-4 text-primary" />
                </Button>
              )}
            </div>
          </>
        )}

        <BrandToolkitSelectorModal
          isOpen={showBrandToolkitSelector}
          onClose={() => setShowBrandToolkitSelector(false)}
          onSelect={handleBrandToolkitSelect}
        />
        <BrandToolkitModal
          isOpen={showBrandToolkitCreate}
          onClose={() => setShowBrandToolkitCreate(false)}
          onSave={handleBrandToolkitCreated}
        />

        <ICPSelectorModal
          isOpen={showICPSelector}
          onClose={() => setShowICPSelector(false)}
          onSelect={handleICPSelect}
        />

        <ToolApprovalDialog
          open={showApprovalModal}
          onOpenChange={setShowApprovalModal}
          approvalData={approvalData}
          isApproving={approvingTool}
          onApproval={handleApproveTool}
        />
      </div>
    </div>
  );
}

export default function ConversationsPage() {
  return (
    <WidgetProvider>
      <ChatContent />
    </WidgetProvider>
  );
}
