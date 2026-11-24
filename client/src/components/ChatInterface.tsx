import { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import type { AgentStatus } from "../models/agentStatus";
import type { SelectedAgent } from "../contexts/AgentContext";
import { Button } from "@/components/ui/button";
import { CreativeBriefHandoff } from "@/components/content-studio/CreativeBriefHandoff";
import { AdCampaignHandoff } from "@/components/content-studio/AdCampaignHandoff";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChatInputArea } from "@/components/chat/ChatInputArea";
import { AttachmentTray } from "@/components/conversation/AttachmentTray";
import { ChatThinkingBubble, type ToolLogEntry } from "@/components/chat/ChatThinkingBubble";
import { ChatContextWindow } from "@/components/chat/ChatContextWindow";
import { type Message } from "../models/message";
import MessageBubble from "./MessageBubble";
import {
  resolveDisplayedConversationAction,
  resolveConversationAction,
  type ConversationActionResolution,
} from "@/lib/conversation-action-resolution";
import { ToolExecutionCard } from "./chat/ToolExecutionCard";
import { WorkflowStepCard } from "./chat/WorkflowStepCard";
import LeadSelectionModal from "./LeadSelectionModal";
import type { InboxChannel } from '../../../shared/outreachInbox';
import { InlineWidgetCard, useWidgets } from "@/components/widgets";
import { WidgetHistoryNotice } from "@/components/widgets/WidgetHistoryNotice";




import { useAgent } from "@/contexts/AgentContext";
import { useChatActions } from "@/contexts/ChatActionContext";
import { useToast } from "@/hooks/use-toast";

import api from "@/lib/api";
import {
  CONVERSATION_ATTACHMENT_ACCEPT,
  MAX_CONVERSATION_ATTACHMENTS,
  MAX_CONVERSATION_ATTACHMENT_BYTES,
  MAX_CONVERSATION_ATTACHMENT_TOTAL_BYTES,
  type ConversationAttachment,
  type PendingConversationAttachment,
} from "@/lib/conversation-attachments";
import { collapseToolExecutionMessages } from "@/lib/tool-message-pairing";
import { campaignReplyOverrides } from "@/lib/campaign-reply-presentation";

// Interface for SpeechRecognition API (Web Speech API)
interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onresult: (event: any) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: (event: any) => void;
  onend: () => void;
  onstart: () => void;
  start: () => void;
  stop: () => void;
  abort?: () => void;
}

interface ChatInterfaceProps {
  paidAdBrief?: string | null;
  campaignAssetId?: string | null;
  messages: Message[];
  onSendMessage: (
    content: string,
    bypassProcessingCheck?: boolean,
    attachments?: ConversationAttachment[],
  ) => void | { delivery: 'unconfirmed' } | Promise<void | { delivery: 'unconfirmed' }>;
  onStrategySelect?: (_strategyId: string) => void;
  onApproval?: (approved: boolean) => void | Promise<void>;
  isProcessing?: boolean;
  onStop?: () => void;
  isLoadingMessages?: boolean;
  hasOlderMessages?: boolean;
  isLoadingOlderMessages?: boolean;
  onLoadOlderMessages?: () => Promise<void>;
  examplePrompts?: string[];
  chatName?: string;
  fitScore?: number;
  currentThreadId?: number | null;
  selectedAgent?: SelectedAgent | string | null;
  onOpenAgentChooseTab?: () => void;
  onOpenICPTab?: () => void;
  onOpenLeadInputsTab?: () => void;
  onOpenBrandToolkitTab?: () => void;
  onCreateBrandToolkit?: () => void;
  onOpenOutreachTab?: () => void;
  onOpenICPSelector?: () => void;
  activeAgent?: AgentStatus | null;
  toolLogs?: ToolLogEntry[];
  // Business profile selection for new chats
  businessProfiles?: { id: number; name: string; companyName: string; isDefault?: boolean }[];
  selectedBusinessProfileId?: string;
  onBusinessProfileChange?: (profileId: string) => void;
  // ICP and business data for fallback display in message bubbles
  currentIcpData?: {
    id?: number;
    campaignName?: string;
    campaignObjective?: string;
    targetAudience?: string;
    industry?: string;
    targetBusinessModel?: string;
    primaryRegions?: string[];
    targetCompanySizeRange?: string;
    primaryJobTitles?: string[];
    primaryPainPoint?: string;
    primaryChannels?: string[];
    fitScore?: number;
  } | null;
}

interface SelectedLead {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  location?: string;
  status?: string;
}

export default function ChatInterface({
  messages,
  onSendMessage,
  onStrategySelect: _onStrategySelect,
  onApproval: _onApproval,
  isProcessing = false,
  onStop,
  isLoadingMessages = false,
  hasOlderMessages = false,
  isLoadingOlderMessages = false,
  onLoadOlderMessages,
  examplePrompts = [],
  campaignAssetId,
  paidAdBrief,
  // eslint-disable-next-line unused-imports/no-unused-vars
  chatName,
  // eslint-disable-next-line unused-imports/no-unused-vars
  fitScore = 0,
  currentThreadId,
  selectedAgent,
  onOpenAgentChooseTab: _onOpenAgentChooseTabProp,
  onOpenICPTab: onOpenICPTabProp,
  onOpenLeadInputsTab: onOpenLeadInputsTabProp,
  onOpenBrandToolkitTab: onOpenBrandToolkitTabProp,
  onCreateBrandToolkit: onCreateBrandToolkitProp,
  onOpenOutreachTab: onOpenOutreachTabProp,
  onOpenICPSelector: onOpenICPSelectorProp,
  activeAgent = null,
  toolLogs = [],
  businessProfiles = [],
  selectedBusinessProfileId,
  onBusinessProfileChange,
  // eslint-disable-next-line unused-imports/no-unused-vars
  currentIcpData,
}: ChatInterfaceProps) {
  const router = useRouter();
  const { selectedAgent: contextSelectedAgent, setSelectedAgent: _setSelectedAgent } = useAgent();
  // Merge prop callbacks with context callbacks (props take precedence)
  const chatActions = useChatActions();
  const onOpenICPTab = onOpenICPTabProp ?? chatActions.onOpenICPTab;
  const onOpenLeadInputsTab = onOpenLeadInputsTabProp ?? chatActions.onOpenLeadInputsTab;
  const onOpenBrandToolkitTab = onOpenBrandToolkitTabProp ?? chatActions.onOpenBrandToolkitTab;
  const onCreateBrandToolkit = onCreateBrandToolkitProp ?? chatActions.onCreateBrandToolkit;
  const onOpenOutreachTab = onOpenOutreachTabProp ?? chatActions.onOpenOutreachTab;
  const onOpenICPSelector = onOpenICPSelectorProp ?? chatActions.onOpenICPSelector;
  const { getWidgetByMessageId } = useWidgets();
  const composerRevisionRef = useRef(0);
  const composerThreadRef = useRef(currentThreadId);
  composerThreadRef.current = currentThreadId;
  const [input, setInputState] = useState("");
  const setInput = useCallback((value: SetStateAction<string>) => {
    composerRevisionRef.current += 1;
    setInputState(value);
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const messageCountRef = useRef(0); // Track message count to detect new messages
  const loadingOlderRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isListening, setIsListening] = useState(false);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [pendingAttachments, setPendingAttachmentsState] = useState<PendingConversationAttachment[]>([]);
  const setPendingAttachments = useCallback((value: SetStateAction<PendingConversationAttachment[]>) => {
    composerRevisionRef.current += 1;
    setPendingAttachmentsState(value);
  }, []);
  const [isMagicPromptLoading, setIsMagicPromptLoading] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    // Initialize with correct dark mode state on mount
    if (typeof document !== 'undefined') {
      return document.documentElement.classList.contains('dark');
    }
    return false;
  });
  const [hasNewMessages, setHasNewMessages] = useState(false); // Shows "scroll to bottom" button
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const voiceActiveRef = useRef(false);
  const voicePrefixRef = useRef<string>('');
  const finalTranscriptRef = useRef<string>('');
  const { toast } = useToast();

  // Template generation state
  const [_isGeneratingTemplate, setIsGeneratingTemplate] = useState(false);

  // Lead selection for outreach
  const [showLeadSelectionModal, setShowLeadSelectionModal] = useState(false);
  const [actionResolutionOverrides, setActionResolutionOverrides] = useState<Record<string, ConversationActionResolution>>({});
  const actionInFlightRef = useRef(new Set<string>());

  // Use context selected agent or prop, prioritize context
  const displaySelectedAgent = contextSelectedAgent || (typeof selectedAgent === 'string' ? selectedAgent : selectedAgent);

  const isAgentObject = (a: SelectedAgent | string | null | undefined): a is SelectedAgent => {
    return (
      !!a &&
      typeof a === 'object' &&
      'name' in (a as unknown as Record<string, unknown>) &&
      typeof (a as unknown as Record<string, unknown>).name === 'string'
    );
  };

  const displaySelectedAgentName = isAgentObject(displaySelectedAgent) ? displaySelectedAgent.name : (displaySelectedAgent as string | null);

  // Helper to get the actual scrollable viewport inside the ScrollArea
  const getViewport = useCallback(() => {
    return scrollRef.current?.querySelector<HTMLDivElement>('[data-radix-scroll-area-viewport]') ?? null;
  }, []);

  const pinMessagesToBottom = useCallback(() => {
    const viewport = getViewport();
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [getViewport]);

  // Detect user manual scroll — if scrolled up more than 100px from bottom, mark as "scrolled up"
  useEffect(() => {
    const viewport = getViewport();
    if (!viewport) return;

    const handleScroll = () => {
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      userScrolledUpRef.current = distanceFromBottom > 100;
      // Clear new messages indicator when user scrolls back to bottom
      if (!userScrolledUpRef.current) {
        setHasNewMessages(false);
      }
    };

    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, [getViewport]);

  // Auto-scroll to bottom when new messages arrive (only if user hasn't scrolled up)
  useLayoutEffect(() => {
    if (loadingOlderRef.current) {
      messageCountRef.current = messages.length;
      return;
    }

    // Sending a message is an explicit return to the live edge, even when the
    // user had previously browsed older history.
    if (messages.at(-1)?.role === 'user') {
      userScrolledUpRef.current = false;
    }

    if (userScrolledUpRef.current) {
      // Show "new messages" indicator if messages increased
      if (messages.length > messageCountRef.current) {
        setHasNewMessages(true);
      }
      messageCountRef.current = messages.length;
      return;
    }
    // Auto-scroll when at bottom
    const frame = requestAnimationFrame(pinMessagesToBottom);
    messageCountRef.current = messages.length;
    setHasNewMessages(false);
    return () => cancelAnimationFrame(frame);
  }, [isProcessing, messages, pinMessagesToBottom, toolLogs]);

  // Streaming text, activity cards, and inline widgets can grow without
  // changing the message count. Keep following those layout changes until the
  // user deliberately scrolls away from the live edge.
  useEffect(() => {
    const list = messageListRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!userScrolledUpRef.current && !loadingOlderRef.current) {
        requestAnimationFrame(pinMessagesToBottom);
      }
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [pinMessagesToBottom]);

  // Always scroll to bottom on thread change (loading new thread)
  useEffect(() => {
    userScrolledUpRef.current = false;
    messageCountRef.current = messages.length;
    setHasNewMessages(false);
    requestAnimationFrame(pinMessagesToBottom);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentThreadId]);

  // Detect dark mode changes
  useEffect(() => {
    const checkDarkMode = () => {
      const isDark = document.documentElement.classList.contains('dark');
      setIsDarkMode(isDark);
    };

    // Check on mount (can be called after slight delay to ensure DOM is ready)
    setTimeout(checkDarkMode, 0);

    // Watch for changes to the dark class
    const observer = new MutationObserver(() => {
      checkDarkMode();
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  // Release the microphone when this conversation closes or changes.
  useEffect(() => {
    return () => {
      voiceActiveRef.current = false;
      setIsListening(false);
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      if (recognition) try { recognition.abort ? recognition.abort() : recognition.stop(); } catch (_) {}
    };
  }, [currentThreadId]);

  // Show agent selector always - no fit score filtering
  const _showAgentSelector = true;

  // Switch agent using the API endpoint
  const _switchToAgent = async (targetAgent: string) => {
    if (!currentThreadId) {
      toast({
        title: "Error",
        description: "No active thread. Please start a conversation first.",
        variant: "destructive",
      });
      return;
    }

    try {
      const response = await api.post<{ success: boolean; response?: unknown; currentAgent?: string }>('/api/chat/langgraph/switch-agent', {
        threadId: currentThreadId,
        targetAgent,
      });

      if (response.success) {
        toast({
          title: "Agent Switched",
          description: `Now working with ${targetAgent.replace(/_/g, ' ')}`,
        });
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to switch agent';
      toast({
        title: "Cannot Switch Agent",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  // Handle action button clicks
  // ALL routing logic lives on the backend — frontend just sends structured actions
  const handleActionClick = async (
    action: string,
    data?: Record<string, unknown>,
    context?: { sourceMessageId: string; buttonId: string; oneShot: boolean },
  ) => {
    const actionKey = context?.oneShot ? `${context.sourceMessageId}:${context.buttonId}` : null;
    if (actionKey && actionInFlightRef.current.has(actionKey)) return;
    if (actionKey) actionInFlightRef.current.add(actionKey);

    const durableSourceMessageId = context && /^\d+$/.test(context.sourceMessageId)
      ? Number(context.sourceMessageId)
      : undefined;
    const outcome = action === 'reject_tool'
      ? 'rejected' as const
      : action === 'approve_tool' || action === 'LEAD_AGENT_APPROVE' || action === 'APPROVE_ICP'
        ? 'approved' as const
        : 'selected' as const;
    const setActionOverride = (resolution: ConversationActionResolution) => {
      if (!context?.oneShot) return;
      setActionResolutionOverrides((current) => ({ ...current, [context.sourceMessageId]: resolution }));
    };

    if (context?.oneShot) {
      setActionOverride({ status: 'processing', selectedButtonId: context.buttonId, action, outcome });
    }

    // UI-only actions (no backend routing needed)
    const UI_ACTIONS: Record<string, () => void> = {
      VIEW_SEARCH_PARAMS: () => onOpenLeadInputsTab?.(),
      EDIT_LEAD_INPUTS: () => onOpenLeadInputsTab?.(),
      SELECT_LEADS_FOR_OUTREACH: () => setShowLeadSelectionModal(true),
      OPEN_LEADS_TAB: () => setShowLeadSelectionModal(true),
      OPEN_LEAD_SELECTOR: () => setShowLeadSelectionModal(true),
      OPEN_CSV_UPLOAD: () => router.push('/dashboard/leads'),
      OPEN_ADD_LEAD: () => router.push('/dashboard/leads'),
      SELECT_ICP: () => onOpenICPSelector?.(),
      CREATE_BRAND_TOOLKIT: () => onCreateBrandToolkit?.(),
      OPEN_OUTREACH_TAB: () => onOpenOutreachTab?.(),
      SELECT_BUSINESS: () => {},
      SELECT_EXISTING_BUSINESS: () => {},
    };

    if (UI_ACTIONS[action]) {
      UI_ACTIONS[action]();
      return;
    }

    // Tab-opening actions (check local handlers first)
    if (action === 'OPEN_TAB') {
      const tabType = data?.tabType as string;
      const tabHandlers: Record<string, (() => void) | undefined> = {
        leadInputs: onOpenLeadInputsTab, leadinputs: onOpenLeadInputsTab, 'lead-inputs': onOpenLeadInputsTab,
        icp: onOpenICPTab, agents: _onOpenAgentChooseTabProp, agentchoose: _onOpenAgentChooseTabProp,
        brandtoolkit: onOpenBrandToolkitTab,
      };
      const handler = tabHandlers[tabType || ''];
      if (handler) { handler(); return; }
    }

    // SELECT_BRAND_TOOLKIT with select action → open tab
    if (action === 'SELECT_BRAND_TOOLKIT') {
      if (data?.action === 'select' && data?.toolkit_id) {
        // Fall through to backend to process the selection
      } else {
        onOpenBrandToolkitTab?.();
        return;
      }
    }

    // Content generation that opens modals before routing
    if (action === 'OPEN_EMAIL_MODAL' || action === 'OPEN_INSTAGRAM_DM_MODAL' || action === 'OPEN_SMS_MODAL') {
      const channel = action === 'OPEN_EMAIL_MODAL' ? 'email' : action === 'OPEN_INSTAGRAM_DM_MODAL' ? 'instagram' : 'sms';
      setIsGeneratingTemplate(true);
      toast({ title: `Preparing ${channel === 'email' ? 'Email' : channel === 'instagram' ? 'Instagram' : 'SMS'} Outreach`, description: 'Checking for templates...' });
      try {
        const typeMap: Record<string, string> = { email: 'email_template', instagram: 'social_dm', sms: 'sms_template' };
        const templateUrl = currentThreadId
          ? `/api/content/assets?type=${typeMap[channel]}&threadId=${currentThreadId}`
          : `/api/content/assets?type=${typeMap[channel]}`;
        const existing = await api.get<Array<{ id: number }>>(templateUrl);
        if (!existing || existing.length === 0) {
          toast({ title: 'Generating Template', description: `Creating ${channel} template for outreach...` });
          const promptMap: Record<string, string> = {
            email: 'Create a professional introduction email for marketing outreach',
            instagram: 'Create a friendly Instagram DM for marketing outreach',
            sms: 'Create a professional SMS template for marketing outreach',
          };
          const endpointMap: Record<string, string> = {
            email: '/api/content/studio/email',
            instagram: '/api/content/studio/social-message',
            sms: '/api/content/studio/sms',
          };
          const generationPayload = channel === 'instagram'
            ? { prompt: promptMap[channel], platform: channel, threadId: currentThreadId }
            : { prompt: promptMap[channel], threadId: currentThreadId };
          const resp = await api.post<{ assetId?: number }>(endpointMap[channel], generationPayload);
          if (resp?.assetId) {
            sessionStorage.setItem('outreach_generated_template_id', resp.assetId.toString());
            sessionStorage.setItem('outreach_template_type', channel);
          }
        }
      } catch (_error) { /* continue even if check/generation fails */ } finally { setIsGeneratingTemplate(false); }
      if (currentThreadId) sessionStorage.setItem('outreach_thread_id', currentThreadId.toString());
      const pathMap: Record<string, string> = { email: '/dashboard/outreach/email/create', instagram: '/dashboard/outreach/instagram/create', sms: '/dashboard/outreach/sms/create' };
      router.push(`${pathMap[channel]}${currentThreadId ? `?threadId=${currentThreadId}` : ''}`);
      return;
    }

    // Export ad (opens external URL)
    if (action === 'export_ad') {
      const exportPlatform = (data?.platform as string || '').toLowerCase();
      const exportRoutes: Record<string, string> = { google: 'https://ads.google.com', google_ads: 'https://ads.google.com', linkedin: 'https://linkedin.com/ad/accounts' };
      const uploadUrl = exportRoutes[exportPlatform];
      if (uploadUrl) toast({ title: 'Export Ad Creatives', description: `Your ad creatives are saved in Content Studio. Download them and upload at ${uploadUrl}` });
      router.push('/dashboard/saved-templates/ads');
      return;
    }
    // All other actions: send structured action to backend (no natural language construction)
    try {
      const response = await api.post<{ message?: string; response?: unknown; error?: string; success?: boolean; processing?: boolean; stage?: string }>('/api/chat/langgraph/action', {
        threadId: currentThreadId,
        action,
        value: data?.value as string,
        data,
        ...(durableSourceMessageId && context ? {
          sourceMessageId: durableSourceMessageId,
          buttonId: context.buttonId,
        } : {}),
      });
      if (response.error) {
        throw new Error(response.error);
      }
      // HTTP acknowledgement is a fallback when the open_tab socket event is missed.
      // Do not interrupt a specialist continuation or a replayed completed workflow.
      if (action === 'APPROVE_ICP' && response.success && response.stage === 'agent_selection') {
        _onOpenAgentChooseTabProp?.();
      }
      if (context?.oneShot && !response.processing) {
        setActionOverride({ status: 'selected', selectedButtonId: context.buttonId, action, outcome });
      }
    } catch (err: unknown) {
      const failure = err instanceof Error ? err.message : 'Failed to perform action';
      if (context?.oneShot) {
        setActionOverride({ status: 'failed_retryable', selectedButtonId: context.buttonId, action, outcome, failure });
      }
      toast({ title: 'Error', description: failure, variant: 'destructive' });
    } finally {
      if (actionKey) actionInFlightRef.current.delete(actionKey);
    }
  };

  // Handle leads selected from modal for outreach
  const handleLeadsSelected = (leads: SelectedLead[], channel: InboxChannel) => {
    if (leads.length > 0) {
      // Send structured action to backend — no natural language construction
      handleActionClick('CREATE_OUTREACH_MESSAGE', {
        leadIds: leads.map(l => l.id),
        leadNames: leads.map(l => l.name),
        leadCount: leads.length,
        channel,
      });

      toast({
        title: 'Leads Selected',
        description: `${leads.length} lead${leads.length !== 1 ? 's' : ''} selected for outreach`,
      });
    }
  };

  const handleSend = async () => {
    if ((input.trim() || pendingAttachments.length > 0) && (!isProcessing || Boolean(currentThreadId)) && !isUploadingAttachments) {
      const messageToSend = input.trim() || "Please review the attached file(s) and use them as context.";
      const draftText = input;
      const draftAttachments = pendingAttachments;
      const submittedThreadId = currentThreadId;
      const attachmentsToSend = pendingAttachments.map(({ localId: _localId, ...attachment }) => attachment);
      setInput("");
      setPendingAttachments([]);
      const clearedRevision = composerRevisionRef.current;
      let deliveryUnconfirmed = false;
      try {
        const result = await onSendMessage(messageToSend, false, attachmentsToSend);
        deliveryUnconfirmed = result?.delivery === 'unconfirmed';
      } catch {
        deliveryUnconfirmed = true;
      }
      if (deliveryUnconfirmed) {
        // Never overwrite text/attachments edited after submission, or insert
        // an old draft into a different conversation. Recovery is not resend.
        if (composerRevisionRef.current === clearedRevision && composerThreadRef.current === submittedThreadId) {
          setInput(draftText);
          setPendingAttachments(draftAttachments);
        }
        toast({ title: 'Delivery not confirmed', description: 'Your attempted message is retained. Check the conversation after reconnecting before retrying.', variant: 'destructive' });
      }
    }
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files || []);
    e.currentTarget.value = '';
    if (files.length === 0 || isUploadingAttachments) return;

    const availableSlots = MAX_CONVERSATION_ATTACHMENTS - pendingAttachments.length;
    if (availableSlots <= 0 || files.length > availableSlots) {
      toast({
        title: 'Too many attachments',
        description: `You can attach up to ${MAX_CONVERSATION_ATTACHMENTS} files to one message.`,
        variant: 'destructive',
      });
      return;
    }

    const existingBytes = pendingAttachments.reduce((total, attachment) => total + attachment.size, 0);
    const selectedBytes = files.reduce((total, file) => total + file.size, 0);
    if (files.some((file) => file.size <= 0 || file.size > MAX_CONVERSATION_ATTACHMENT_BYTES)) {
      toast({
        title: 'Attachment is too large',
        description: 'Each attachment must be non-empty and no larger than 10 MB.',
        variant: 'destructive',
      });
      return;
    }
    if (existingBytes + selectedBytes > MAX_CONVERSATION_ATTACHMENT_TOTAL_BYTES) {
      toast({
        title: 'Attachments are too large',
        description: 'Attachments may not exceed 20 MB in total.',
        variant: 'destructive',
      });
      return;
    }

    setIsUploadingAttachments(true);
    const uploaded: PendingConversationAttachment[] = [];
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        const stored = await api.upload<{
          id: number;
          originalName?: string | null;
          fileName: string;
          mimeType?: string | null;
          fileSizeBytes: number;
          url?: string | null;
        }>('/api/settings/storage/files', formData);
        if (!stored?.id) throw new Error(`The upload for ${file.name} did not return a file reference.`);
        uploaded.push({
          localId: `${stored.id}-${Date.now()}-${uploaded.length}`,
          fileId: stored.id,
          name: stored.originalName || file.name || stored.fileName,
          mimeType: stored.mimeType || file.type || 'application/octet-stream',
          size: Number(stored.fileSizeBytes || file.size),
          downloadUrl: stored.url || `/api/settings/storage/files/${stored.id}/download`,
        });
      }
      setPendingAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      await Promise.allSettled(
        uploaded.map((attachment) => api.delete(`/api/settings/storage/files/${attachment.fileId}`)),
      );
      toast({
        title: 'Attachment upload failed',
        description: error instanceof Error ? error.message : 'Unable to upload the selected file.',
        variant: 'destructive',
      });
    } finally {
      setIsUploadingAttachments(false);
    }
  };

  const handleRemoveAttachment = async (attachment: PendingConversationAttachment) => {
    try {
      await api.delete(`/api/settings/storage/files/${attachment.fileId}`);
      setPendingAttachments((current) => current.filter((item) => item.localId !== attachment.localId));
    } catch (error) {
      toast({
        title: 'Unable to remove attachment',
        description: error instanceof Error ? error.message : 'The uploaded file could not be removed.',
        variant: 'destructive',
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleVoiceInput = () => {
    if (voiceActiveRef.current) {
      voiceActiveRef.current = false;
      try { recognitionRef.current?.stop(); } catch (_) {
        try { recognitionRef.current?.abort?.(); } catch (_) {}
        recognitionRef.current = null;
      }
      setIsListening(false);
      return;
    }

    // Construct on the user gesture so the browser can request microphone access.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const RecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!RecognitionAPI) {
      toast({ title: 'Dictation unavailable', description: 'This browser does not support speech recognition. Try Chrome or Edge, or type your message.', variant: 'destructive' });
      return;
    }

    voicePrefixRef.current = input;
    finalTranscriptRef.current = '';
    try {
      const recognition: SpeechRecognitionInstance = new RecognitionAPI();
      let transcriptRevision = composerRevisionRef.current;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';
      recognition.onstart = () => {
        if (recognitionRef.current === recognition && voiceActiveRef.current) setIsListening(true);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onresult = (event: any) => {
        if (recognitionRef.current !== recognition
          || (!voiceActiveRef.current && composerRevisionRef.current !== transcriptRevision)) return;
        const finalParts: string[] = [];
        const interimParts: string[] = [];
        for (let i = 0; i < event.results.length; i++) {
          const text = String(event.results[i]?.[0]?.transcript ?? '').trim();
          if (!text) continue;
          (event.results[i].isFinal ? finalParts : interimParts).push(text);
        }
        finalTranscriptRef.current = finalParts.join(' ');
        setInput([voicePrefixRef.current.trimEnd(), finalTranscriptRef.current, interimParts.join(' ')].filter(Boolean).join(' '));
        transcriptRevision = composerRevisionRef.current;
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recognition.onerror = (event: any) => {
        if (recognitionRef.current !== recognition) return;
        recognitionRef.current = null;
        voiceActiveRef.current = false;
        setIsListening(false);
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          toast({ title: 'Microphone access denied', description: 'Allow microphone and speech recognition access in your browser, then try again.', variant: 'destructive' });
        } else if (event.error === 'audio-capture') {
          toast({ title: 'No microphone found', description: 'Connect a microphone and try dictation again.', variant: 'destructive' });
        } else if (event.error === 'no-speech') {
          toast({ title: 'No speech detected', description: 'Speak into the microphone and try again.' });
        } else if (event.error !== 'aborted') {
          toast({ title: 'Dictation stopped', description: event.error === 'network' ? 'Speech recognition could not connect. Check your connection and try again.' : 'Speech recognition failed. Please try again.', variant: 'destructive' });
        }
      };
      recognition.onend = () => {
        if (recognitionRef.current !== recognition) return;
        recognitionRef.current = null;
        voiceActiveRef.current = false;
        setIsListening(false);
      };
      recognitionRef.current = recognition;
      voiceActiveRef.current = true;
      setIsListening(true);
      recognition.start();
    } catch {
      voiceActiveRef.current = false;
      recognitionRef.current = null;
      setIsListening(false);
      toast({ title: 'Dictation could not start', description: 'Check microphone permissions and try again.', variant: 'destructive' });
    }
  };

  // Magic Pen: Enhance prompt based on the selected agent and context
  const _handleMagicPrompt = async () => {
    if (isMagicPromptLoading) return;

    setIsMagicPromptLoading(true);
    try {
      // Determine content type based on selected agent
      let contentType = 'general';
      const agentName = displaySelectedAgentName || '';
      if (agentName.toLowerCase().includes('alex') || agentName.toLowerCase().includes('content')) {
        contentType = 'social'; // Default to social for content agent
      } else if (agentName.toLowerCase().includes('emily') || agentName.toLowerCase().includes('outreach')) {
        contentType = 'email';
      } else if (agentName.toLowerCase().includes('sarah') || agentName.toLowerCase().includes('performance')) {
        contentType = 'ad_copy';
      } else if (agentName.toLowerCase().includes('marcus') || agentName.toLowerCase().includes('lead')) {
        contentType = 'lead_generation';
      }

      const response = await api.post<{
        success: boolean;
        enhancedPrompt: string;
        tips?: string;
        suggestions?: string[];
      }>('/api/content/studio/magic-prompt', {
        currentPrompt: input,
        contentType,
        chatContext: messages.slice(-3).map(m => m.content).join(' '),
      });

      if (response.success && response.enhancedPrompt) {
        setInput(response.enhancedPrompt);
        toast({
          title: 'Magic Prompt Generated!',
          description: response.tips || 'Your prompt has been enhanced with AI',
        });
      }
    } catch (_error) {
      toast({
        title: 'Error',
        description: 'Failed to generate magic prompt',
        variant: 'destructive',
      });
    } finally {
      setIsMagicPromptLoading(false);
    }
  };

  // Scroll to bottom and clear new messages indicator
  const scrollToBottom = () => {
    userScrolledUpRef.current = false;
    setHasNewMessages(false);
    requestAnimationFrame(pinMessagesToBottom);
  };

  const loadOlderMessages = async () => {
    if (!onLoadOlderMessages || loadingOlderRef.current) return;
    const viewport = getViewport();
    const previousHeight = viewport?.scrollHeight ?? 0;
    const previousTop = viewport?.scrollTop ?? 0;
    loadingOlderRef.current = true;
    try {
      await onLoadOlderMessages();
      requestAnimationFrame(() => {
        if (viewport) viewport.scrollTop = previousTop + viewport.scrollHeight - previousHeight;
        loadingOlderRef.current = false;
      });
    } catch {
      loadingOlderRef.current = false;
    }
  };

  const displayMessages = useMemo(() => collapseToolExecutionMessages(messages), [messages]);
  const replyOverrides = useMemo(() => campaignReplyOverrides(displayMessages), [displayMessages]);

  return (
    <div className="@container/chat flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 min-w-0 max-w-full flex-1 overflow-hidden">
        {/* Main Chat Area */}
        <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden">
      <WidgetHistoryNotice />

      {/* Messages */}
      <ScrollArea
        ref={scrollRef}
        // Only the viewport may scroll. An overflow-hidden root can itself be
        // scrolled by focus/anchoring during live updates, clipping the chat.
        // Pin the viewport to the flex slot, independent of message height.
        className="min-h-0 min-w-0 max-w-full flex-1 overflow-clip bg-background"
        viewportClassName="absolute inset-0 box-border max-w-full touch-pan-y overscroll-contain overflow-x-hidden px-6 py-5 [&>div]:!block [&>div]:min-w-0 [&>div]:max-w-full"
      >
        <div
          ref={messageListRef}
          className="mx-auto w-full min-w-0 max-w-3xl space-y-6"
          role="log"
          aria-live="polite"
          aria-label="Chat messages"
        >
          {/* Skeleton loading state when switching threads */}
          {isLoadingMessages ? (
            <div className="space-y-6">
              {/* Agent message skeleton */}
              <div className="flex gap-3 items-start ml-2">
                <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-16 w-full max-w-md rounded-xl" />
                </div>
              </div>
              {/* User message skeleton */}
              <div className="flex justify-end mr-2">
                <Skeleton className="h-10 w-48 rounded-xl" />
              </div>
              {/* Agent message skeleton */}
              <div className="flex gap-3 items-start ml-2">
                <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-24 w-full max-w-lg rounded-xl" />
                </div>
              </div>
              {/* User message skeleton */}
              <div className="flex justify-end mr-2">
                <Skeleton className="h-10 w-64 rounded-xl" />
              </div>
              {/* Agent message skeleton */}
              <div className="flex gap-3 items-start ml-2">
                <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-20 w-full max-w-sm rounded-xl" />
                </div>
              </div>
            </div>
          ) : (
            <>
          {hasOlderMessages && onLoadOlderMessages && (
            <div className="flex justify-center pb-2">
              <Button
                variant="outline"
                size="sm"
                loading={isLoadingOlderMessages}
                onClick={() => void loadOlderMessages()}
              >
                Load earlier messages
              </Button>
            </div>
          )}
          {displayMessages.map((message, index) => {
            const meta = message.metadata;
            if (meta?.isToolCall || meta?.isToolResult) {
              const linkedMessageId = Number(meta.widgetMessageId);
              const linkedWidget = Number.isSafeInteger(linkedMessageId) && linkedMessageId > 0
                ? getWidgetByMessageId(linkedMessageId)
                : undefined;
              return (
                <ToolExecutionCard
                  key={message.id}
                  message={message}
                  widgetStatus={linkedWidget?.status}
                  widgetError={linkedWidget?.executionError}
                  reviewSurface={linkedWidget && !["running", "queued", "provider_succeeded"].includes(linkedWidget.status) ? (
                    <div className="@md/chat:ml-10">
                      <InlineWidgetCard widget={linkedWidget} />
                    </div>
                  ) : undefined}
                />
              );
            }
            if (meta?.isWorkflowStart || meta?.isWorkflowStep || meta?.isWorkflowComplete || meta?.isWorkflowError || meta?.isLeadSaved) {
              return <WorkflowStepCard key={message.id} message={message} />;
            }
            const persistedActionResolution = resolveConversationAction(
              message,
              displayMessages.slice(index + 1),
            );
            const actionResolution = resolveDisplayedConversationAction(
              persistedActionResolution,
              actionResolutionOverrides[message.id],
            );
            return (
              <MessageBubble
                key={message.id}
                message={message}
                displayContent={replyOverrides.get(message.id)}
                onActionClick={handleActionClick}
                isLastMessage={index === displayMessages.length - 1}
                actionResolution={actionResolution}
              />
            );
          })}

          {/* Example Prompts */}
          {messages.length === 1 && examplePrompts.length > 0 && !isProcessing && (
            <div className="mt-6 space-y-3 @md/chat:ml-10" data-testid="example-prompts">
              <div className="flex flex-wrap gap-2">
                {examplePrompts.map((prompt, index) => (
                  <button
                    key={index}
                    onClick={() => onSendMessage(prompt)}
                    className="px-4 py-2 bg-secondary border border-border hover:bg-secondary/80 hover:border-primary/50 rounded-full text-sm text-foreground font-medium transition-all shadow-sm"
                    data-testid={`button-example-${index}`}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {isProcessing && (
            <ChatThinkingBubble
              messages={displayMessages.map(message => {
                const widget = getWidgetByMessageId(Number(message.metadata?.widgetMessageId));
                return widget ? { ...message, metadata: { ...message.metadata, widgetStatus: widget.status } } : message;
              })}
              activeAgent={activeAgent}
              displaySelectedAgentName={displaySelectedAgentName}
              isDarkMode={isDarkMode}
              toolLogs={toolLogs}
            />
          )}

            </>
          )}
        </div>
      </ScrollArea>

      {/* Scroll to bottom button — shows when user is scrolled up and new messages arrive */}
      {hasNewMessages && (
        <div className="relative">
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10">
            <button
              onClick={scrollToBottom}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-full shadow-lg hover:bg-blue-700 transition-all duration-200 hover:scale-105 active:scale-95"
            >
              ↓ New messages
            </button>
          </div>
        </div>
      )}

      {/* Business Profile Selector for new chats */}
      {!currentThreadId && businessProfiles.length > 1 && !selectedBusinessProfileId && onBusinessProfileChange && (
        <div className="px-4 pb-2">
          <div className="max-w-4xl mx-auto w-full">
            <div className="flex items-center gap-3 px-3 py-2 rounded-2xl bg-secondary/50 border border-border/50">
              <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">Business Profile:</span>
              <Select onValueChange={onBusinessProfileChange}>
                <SelectTrigger className="h-8 rounded-xl border-border/60 bg-background/80 text-sm flex-1">
                  <SelectValue placeholder="Select a business profile" />
                </SelectTrigger>
                <SelectContent className="rounded-xl">
                  {businessProfiles.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name || p.companyName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )}

      {/* Selected profile indicator */}
      {!currentThreadId && selectedBusinessProfileId && businessProfiles.length > 1 && (
        <div className="px-4 pb-2">
          <div className="max-w-4xl mx-auto w-full">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-primary/5 border border-primary/10 w-fit">
              <span className="text-xs text-muted-foreground">Profile:</span>
              <span className="text-xs font-medium text-foreground">{businessProfiles.find(p => String(p.id) === selectedBusinessProfileId)?.name || businessProfiles.find(p => String(p.id) === selectedBusinessProfileId)?.companyName}</span>
              {businessProfiles.length > 1 && (
                <button onClick={() => onBusinessProfileChange?.('')} className="text-xs text-muted-foreground hover:text-foreground ml-1">✕</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Input Area - Floating Pill Design */}
      {!currentThreadId && paidAdBrief && <div className="m-3 space-y-3 rounded-xl border bg-muted/30 p-4"><p className="text-sm font-semibold">Paid campaign brief · Performance Marketing</p><p className="whitespace-pre-wrap text-sm text-muted-foreground">{paidAdBrief}</p><Button disabled={isProcessing} variant="outline" size="sm" onClick={() => setInput(paidAdBrief)}>Use this campaign brief</Button><p className="text-xs text-muted-foreground">Review the message before sending. Publishing requires your approval.</p></div>}
      {<CreativeBriefHandoff disabled={isProcessing} />}
      {!currentThreadId && campaignAssetId && <AdCampaignHandoff assetId={campaignAssetId} disabled={isProcessing} onInsert={text => setInput(current => current.trim() ? `${current}\n\n${text}` : text)} />}
      <ChatInputArea
        input={input}
        setInput={setInput}
        isProcessing={isProcessing}
        allowQueue={Boolean(currentThreadId)}
        onStop={onStop}
        isListening={isListening}
        onSend={handleSend}
        onKeyDown={handleKeyDown}
        onToggleVoice={toggleVoiceInput}
        onFileImport={handleFileImport}
        attachmentAccept={CONVERSATION_ATTACHMENT_ACCEPT}
        hasAttachments={pendingAttachments.length > 0}
        isUploadingAttachments={isUploadingAttachments}
        textareaRef={textareaRef}
        contextIndicator={<ChatContextWindow threadId={currentThreadId ?? null} />}
        attachmentIndicator={
          pendingAttachments.length > 0 || isUploadingAttachments ? (
            <div className="px-1" aria-live="polite">
              <AttachmentTray
                attachments={[
                  ...pendingAttachments.map((attachment) => ({
                    id: attachment.localId,
                    name: attachment.name,
                    size: attachment.size,
                    mimeType: attachment.mimeType,
                    status: "ready" as const,
                  })),
                  ...(isUploadingAttachments ? [{ id: "uploading", name: "Uploading attachment…", status: "uploading" as const }] : []),
                ]}
                onRemove={(id) => {
                  const attachment = pendingAttachments.find((item) => item.localId === id);
                  if (attachment) void handleRemoveAttachment(attachment);
                }}
              />
            </div>
          ) : null
        }
      />

        </div>{/* End Main Chat Area */}
      </div>{/* End flex row */}

      {/* Lead Selection Modal */}
      <LeadSelectionModal
        isOpen={showLeadSelectionModal}
        onClose={() => setShowLeadSelectionModal(false)}
        onSelectLeads={handleLeadsSelected}
        threadId={currentThreadId || undefined}
      />

      {/* Business Profile Modal removed - business profiles managed separately in settings */}

      {/* ICP Profile Modal removed - ICP is auto-saved by the backend ICP agent */}

    </div>
  );
}
