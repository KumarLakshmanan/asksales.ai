/**
 * useOutreachPage - Shared hook for outreach page logic
 * Encapsulates conversations loading, message loading, sending, syncing, and deletion
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import api, { ApiError } from "@/lib/api";
import type { OutreachConversation, OutreachMessage, OutreachChannel } from "./types";
import type { EmailAttachment } from "./EmailComposeBuilder";
import { conversationFilterQuery, DEFAULT_CONVERSATION_FILTERS, type ConversationFilters } from './conversation-filters';

interface UseOutreachPageOptions {
  channel: OutreachChannel;
  /** API channel name for endpoints (defaults to channel) */
  apiChannel?: string;
  /** Custom sync endpoint (POST) */
  syncEndpoint?: string;
  /** Custom unread count field name in response */
  unreadField?: string;
  /** Whether to auto-load on mount (default: true) */
  autoLoad?: boolean;
}

interface UseOutreachPageReturn {
  // State
  conversations: OutreachConversation[];
  selectedConversation: OutreachConversation | null;
  messages: OutreachMessage[];
  newMessage: string;
  subject: string;
  searchQuery: string;
  conversationFilters: ConversationFilters;
  loading: boolean;
  loadingMore: boolean;
  hasMoreConversations: boolean;
  loadMoreError: string | null;
  loadMoreConversations: () => Promise<void>;
  loadingMessages: boolean;
  conversationsError: string | null;
  messagesError: string | null;
  sending: boolean;
  syncing: boolean;
  unreadCount: number;
  deleteDialogOpen: boolean;
  conversationToDelete: OutreachConversation | null;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  generatingDraft: boolean;
  attachments: EmailAttachment[];
  uploadingAttachments: boolean;

  // Setters
  setNewMessage: (msg: string) => void;
  setSubject: (subj: string) => void;
  setSearchQuery: (query: string) => void;
  setConversationFilters: (filters: ConversationFilters) => void;
  setSelectedConversation: (conv: OutreachConversation | null) => void;
  setDeleteDialogOpen: (open: boolean) => void;
  setConversationToDelete: (conv: OutreachConversation | null) => void;

  // Actions
  loadConversations: () => Promise<void>;
  handleSelectConversation: (conversation: OutreachConversation) => void;
  handleSendMessage: (extra?: Record<string, unknown>) => Promise<boolean>;
  handleSync: () => Promise<void>;
  openDeleteDialog: (conv: OutreachConversation, e?: React.MouseEvent) => void;
  handleDeleteConversation: () => Promise<void>;
  scrollToBottom: () => void;
  handleGenerateDraft: () => Promise<void>;
  handleGenerateComposerReply: () => Promise<string | null>;
  handleEditDraft: (message: OutreachMessage) => void;
  handleSendDraft: (message: OutreachMessage) => Promise<void>;
  handleDiscardDraft: (message: OutreachMessage) => Promise<void>;
  handleFilesSelected: (files: FileList) => Promise<void>;
  handleRemoveAttachment: (id: number | string) => void;
  refetch?: () => Promise<void>;

  // Filtered data
  filteredConversations: OutreachConversation[];
}

// Helper to parse potentially JSON-encoded content
export function parseMessageContent(content: string | null): string {
  if (!content) return "";
  const trimmed = content.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && (trimmed.endsWith("}") || trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        const body = parsed.body || parsed.content || parsed.message || parsed.text;
        if (body) return body;
        if (parsed.subject) return `Subject: ${parsed.subject}`;
        return JSON.stringify(parsed, null, 2);
      }
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not valid JSON, return original
    }
  }
  return content;
}

// Helper to get initials from a name
export function getInitials(name: string | null): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Scroll the closest overflowing message viewport without moving the
 * dashboard shell that contains the outreach workspace.
 *
 * `scrollIntoView` walks all scrollable ancestors, which can move the fixed
 * dashboard main element when a message is loaded. Looking up the nearest
 * vertical scroll container keeps the page header and conversation toolbar in
 * place while still taking the message list to its latest item.
 */
export function scrollElementToNearestBottom(
  element: HTMLElement | null,
  behavior: ScrollBehavior = "smooth",
): void {
  if (!element || typeof window === "undefined") return;

  let container = element.parentElement;
  while (container) {
    const styles = window.getComputedStyle(container);
    const canScrollVertically =
      /(auto|scroll)/.test(styles.overflowY) &&
      container.scrollHeight > container.clientHeight;

    if (canScrollVertically) {
      container.scrollTo({ top: container.scrollHeight, behavior });
      return;
    }

    container = container.parentElement;
  }
}

export function useOutreachPage({
  channel,
  apiChannel,
  syncEndpoint,
  unreadField,
  autoLoad = true,
}: UseOutreachPageOptions): UseOutreachPageReturn {
  const { toast } = useToast();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sendInFlightRef = useRef<string | null>(null);
  const effectiveChannel = apiChannel || channel;
  const effectiveUnreadField = unreadField || channel;

  // State
  const [conversations, setConversations] = useState<OutreachConversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<OutreachConversation | null>(null);
  const [messages, setMessages] = useState<OutreachMessage[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [subject, setSubject] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [conversationFilters, setConversationFiltersState] = useState<ConversationFilters>(DEFAULT_CONVERSATION_FILTERS);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const conversationGeneration = useRef(0);
  const nextConversationOffset = useRef(0);
  const moreInFlight = useRef(false);
  const listInFlight = useRef(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [conversationToDelete, setConversationToDelete] = useState<OutreachConversation | null>(null);
  const [generatingDraft, setGeneratingDraft] = useState(false);
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);

  const scrollToBottom = useCallback(() => {
    scrollElementToNearestBottom(messagesEndRef.current);
  }, []);

  const loadConversations = useCallback(async (filterOverride?: ConversationFilters) => {
    const generation = ++conversationGeneration.current;
    listInFlight.current = true;
    moreInFlight.current = false;
    setLoadingMore(false);
    setLoadMoreError(null);
    setHasMoreConversations(false);
    nextConversationOffset.current = 0;
    try {
      setLoading(true);
      setConversationsError(null);
      const filters = conversationFilterQuery(filterOverride || conversationFilters);
      const response = await api.get<{ conversations: OutreachConversation[]; unreadCount: number; pagination?: { hasMore?: boolean } }>(
        `/api/outreach-conversations/${effectiveChannel}?limit=50&offset=0${filters ? `&${filters}` : ''}`
      );
      if (generation !== conversationGeneration.current) return;
      setConversations(response.conversations || []);
      nextConversationOffset.current = response.conversations?.length || 0;
      setHasMoreConversations(response.pagination?.hasMore ?? response.conversations?.length === 50);
      setUnreadCount(response.unreadCount || 0);
    } catch (error) {
      if (generation !== conversationGeneration.current) return;
      const status = (error as { status?: number })?.status;
      if (status === 401) {
        setConversations([]);
      }
      const message = error instanceof Error
        ? error.message
        : `Couldn't load ${channel} conversations.`;
      setConversationsError(message);
      toast({ variant: "destructive", description: message });
    } finally {
      if (generation === conversationGeneration.current) {
        listInFlight.current = false;
        setLoading(false);
      }
    }
  }, [effectiveChannel, channel, toast, conversationFilters]);

  const setConversationFilters = useCallback((filters: ConversationFilters) => {
    setConversationFiltersState(filters);
    void loadConversations(filters);
  }, [loadConversations]);

  const loadMoreConversations = useCallback(async () => {
    if (listInFlight.current || moreInFlight.current || !hasMoreConversations) return;
    moreInFlight.current = true;
    const generation = conversationGeneration.current;
    const offset = nextConversationOffset.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const filters = conversationFilterQuery(conversationFilters);
      const response = await api.get<{ conversations: OutreachConversation[]; pagination?: { hasMore?: boolean } }>(
        `/api/outreach-conversations/${effectiveChannel}?limit=50&offset=${offset}${filters ? `&${filters}` : ''}`
      );
      if (generation !== conversationGeneration.current) return;
      const page = response.conversations || [];
      // Live activity may move a row across a page boundary. Append only new IDs;
      // advance by the server's raw page length, not the deduplicated count.
      setConversations(current => {
        const seen = new Set(current.map(row => row.id));
        return [...current, ...page.filter(row => !seen.has(row.id) && Boolean(seen.add(row.id)))];
      });
      nextConversationOffset.current = offset + page.length;
      setHasMoreConversations(page.length > 0 && (response.pagination?.hasMore ?? page.length === 50));
    } catch (error) {
      if (generation === conversationGeneration.current) setLoadMoreError(error instanceof Error ? error.message : 'Could not load older conversations.');
    } finally {
      if (generation === conversationGeneration.current) {
        moreInFlight.current = false;
        setLoadingMore(false);
      }
    }
  }, [effectiveChannel, hasMoreConversations, conversationFilters]);

  useEffect(() => () => { conversationGeneration.current += 1; }, [effectiveChannel]);

  const refreshAndResolveConversation = useCallback(async (staleConversation: OutreachConversation) => {
    const generation = ++conversationGeneration.current;
    listInFlight.current = true;
    moreInFlight.current = false;
    setLoadingMore(false);
    setLoadMoreError(null);
    setHasMoreConversations(false);
    nextConversationOffset.current = 0;
    let response;
    try {
      response = await api.get<{ conversations: OutreachConversation[]; unreadCount: number; pagination?: { hasMore?: boolean } }>(
        `/api/outreach-conversations/${effectiveChannel}?limit=50&offset=0&${conversationFilterQuery(conversationFilters)}`
      );
    } finally {
      if (generation === conversationGeneration.current) {
        listInFlight.current = false;
        setLoading(false);
      }
    }
    if (generation !== conversationGeneration.current) return null;
    const refreshedConversations = response.conversations || [];
    setConversations(refreshedConversations);
    nextConversationOffset.current = refreshedConversations.length;
    setHasMoreConversations(response.pagination?.hasMore ?? refreshedConversations.length === 50);
    setUnreadCount(response.unreadCount || 0);

    const replacement =
      refreshedConversations.find((conversation) => conversation.id === staleConversation.id) ||
      refreshedConversations.find((conversation) => conversation.leadId === staleConversation.leadId);

    if (replacement) {
      setSelectedConversation(replacement);
      return replacement;
    }

    setSelectedConversation(null);
    setMessages([]);
    return null;
  }, [effectiveChannel, conversationFilters]);

  const loadUnreadCount = useCallback(async () => {
    try {
      const response = await api.get<Record<string, number>>("/api/outreach-conversations/unread");
      setUnreadCount(response[effectiveUnreadField] || 0);
    } catch {
      // The conversation list remains usable; the badge will refresh next time.
    }
  }, [effectiveUnreadField]);

  const loadMessages = useCallback(async (conversationId: number) => {
    try {
      setLoadingMessages(true);
      setMessagesError(null);
      const response = await api.get<{ conversation: OutreachConversation; messages: OutreachMessage[] }>(
        `/api/outreach-conversations/${effectiveChannel}/${conversationId}/messages`
      );
      setMessages(response.messages || []);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId ? { ...c, unreadCount: 0 } : c
        )
      );
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 404 && selectedConversation && selectedConversation.id === conversationId) {
        try {
          const replacement = await refreshAndResolveConversation(selectedConversation);
          if (replacement && replacement.id !== conversationId) {
            await loadMessages(replacement.id);
            return;
          }
        } catch {
          // Fall through to the visible error below.
        }
      }

      const message = error instanceof Error ? error.message : "Failed to load messages";
      setMessagesError(message);
      toast({
        title: "Messages unavailable",
        description: message,
        variant: "destructive",
      });
    } finally {
      setLoadingMessages(false);
    }
  }, [effectiveChannel, toast, selectedConversation, refreshAndResolveConversation]);

  const handleSelectConversation = useCallback((conversation: OutreachConversation) => {
    setSelectedConversation(conversation);
    setMessages([]);
    setMessagesError(null);
    void loadMessages(conversation.id);
  }, [loadMessages]);

  const handleSendMessage = useCallback(async (extra?: Record<string, unknown>) => {
    const extraAttachments = Array.isArray(extra?.attachments) ? extra.attachments : [];
    if (!selectedConversation || (!newMessage.trim() && attachments.length === 0 && extraAttachments.length === 0) || sendInFlightRef.current) return false;
    const idempotencyKey = crypto.randomUUID();
    sendInFlightRef.current = idempotencyKey;

    try {
      setSending(true);
      const sendConfirmation = {
        confirmed: true,
        conversationId: selectedConversation.id,
        recipientConfirmed: true,
        accountConfirmed: true,
        messageConfirmed: true,
      };
      const sendResult = await api.post<{
        success: boolean;
        manualReviewRequired?: boolean;
        error?: string;
      }>(`/api/outreach-conversations/${effectiveChannel}/${selectedConversation.id}/messages`, {
        content: newMessage,
        ...(subject ? { subject } : {}),
        ...(extra || {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        idempotencyKey,
        confirmation: sendConfirmation,
      });
      if (!sendResult.success) {
        await loadMessages(selectedConversation.id);
        toast({
          title: sendResult.manualReviewRequired ? "Delivery needs review" : "Message not sent",
          description: sendResult.error || "The provider did not confirm delivery.",
          variant: "destructive",
        });
        return false;
      }

      await loadMessages(selectedConversation.id);
      await loadConversations();
      setNewMessage("");
      setSubject("");
      setAttachments([]);

      toast({
        title: "Message sent",
        description: `Your ${channel} message has been sent successfully`,
      });
      return true;
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 404 && selectedConversation) {
        try {
          const replacement = await refreshAndResolveConversation(selectedConversation);
          if (replacement) {
            const retryResult = await api.post<{
              success: boolean;
              manualReviewRequired?: boolean;
              error?: string;
            }>(`/api/outreach-conversations/${effectiveChannel}/${replacement.id}/messages`, {
              content: newMessage,
              ...(subject ? { subject } : {}),
              ...(extra || {}),
              ...(attachments.length > 0 ? { attachments } : {}),
              idempotencyKey,
              confirmation: {
                confirmed: true,
                conversationId: replacement.id,
                recipientConfirmed: true,
                accountConfirmed: true,
                messageConfirmed: true,
              },
            });
            if (!retryResult.success) {
              await loadMessages(replacement.id);
              toast({
                title: retryResult.manualReviewRequired ? "Delivery needs review" : "Message not sent",
                description: retryResult.error || "The provider did not confirm delivery.",
                variant: "destructive",
              });
              return false;
            }
            await loadMessages(replacement.id);
            await loadConversations();
            setNewMessage("");
            setSubject("");
            setAttachments([]);
            toast({
              title: "Message sent",
              description: `Your ${channel} message has been sent successfully`,
            });
            return true;
          }
        } catch {
          // Fall through to the visible error below.
        }
      }

      const apiErrorCode = error instanceof ApiError && error.data && typeof error.data === 'object'
        ? (error.data as { code?: string }).code
        : undefined;
      const unavailableBoundAccount = apiErrorCode === 'CONVERSATION_ACCOUNT_UNAVAILABLE';
      const unavailableWhatsAppAccount = effectiveChannel === 'whatsapp' && apiErrorCode === 'OUTREACH_PROVIDER_NOT_READY';
      const reconnectRequired = unavailableBoundAccount || unavailableWhatsAppAccount;
      const reconnectPlatform = effectiveChannel === 'instagram'
        ? 'Instagram'
        : effectiveChannel === 'whatsapp' ? 'WhatsApp' : 'Facebook';
      toast({
        title: reconnectRequired ? `Reconnect ${reconnectPlatform}` : "Message not sent",
        description: unavailableWhatsAppAccount
          ? 'The WhatsApp account bound to this conversation is not ready. Open Integrations → WhatsApp, reconnect that same phone-number account and resolve any readiness prompts, then retry.'
          : unavailableBoundAccount
            ? `This conversation is tied to a ${reconnectPlatform} account that is no longer connected. Open Integrations → ${reconnectPlatform}, reconnect that same account, then retry.`
          : error instanceof Error ? error.message : "Failed to send message",
        variant: "destructive",
      });
      return false;
    } finally {
      sendInFlightRef.current = null;
      setSending(false);
    }
  }, [
    selectedConversation,
    newMessage,
    subject,
    effectiveChannel,
    channel,
    loadMessages,
    toast,
    refreshAndResolveConversation,
    loadConversations,
    attachments,
  ]);

  const handleFilesSelected = useCallback(async (files: FileList) => {
    if (!files.length) return;
    const remainingSlots = Math.max(0, 5 - attachments.length);
    if (remainingSlots === 0) {
      toast({ title: "Attachment limit reached", description: "A message can include up to 5 attachments.", variant: "destructive" });
      return;
    }
    const selectedFiles = Array.from(files).slice(0, remainingSlots);
    if (files.length > remainingSlots) {
      toast({ title: "Some files were not added", description: "A message can include up to 5 attachments." });
    }
    try {
      setUploadingAttachments(true);
      const formData = new FormData();
      selectedFiles.forEach((file) => formData.append("files", file));
      const data = await api.postForm<{ attachments: EmailAttachment[] }>("/api/outreach/attachments", formData);
      setAttachments((current) => [...current, ...data.attachments]);
    } catch (error) {
      toast({
        title: "Upload failed",
        description: error instanceof Error ? error.message : "The attachment could not be uploaded.",
        variant: "destructive",
      });
    } finally {
      setUploadingAttachments(false);
    }
  }, [attachments.length, toast]);

  const handleRemoveAttachment = useCallback((id: number | string) => {
    setAttachments((current) => current.filter((attachment) =>
      attachment.id !== id && attachment.fileId !== id && attachment.fileName !== id
    ));
  }, []);

  const handleSync = useCallback(async () => {
    if (syncEndpoint) {
      try {
        setSyncing(true);
        const response = await api.post<{ syncedCount?: number; processed?: number; matched?: number; message?: string }>(
          syncEndpoint
        );
        toast({
          title: "Sync complete",
          description: response.message || `Synced successfully`,
        });
        await loadConversations();
        if (selectedConversation) {
          await loadMessages(selectedConversation.id);
        }
      } catch (error: unknown) {
        toast({
          title: "Sync failed",
          description: error instanceof Error ? error.message : "Failed to sync",
          variant: "destructive",
        });
      } finally {
        setSyncing(false);
      }
    } else {
      // Simple refresh
      setSyncing(true);
      await loadConversations();
      setSyncing(false);
    }
  }, [syncEndpoint, loadConversations, selectedConversation, loadMessages, toast]);

  const openDeleteDialog = useCallback((conv: OutreachConversation, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setConversationToDelete(conv);
    setDeleteDialogOpen(true);
  }, []);

  const handleDeleteConversation = useCallback(async () => {
    if (!conversationToDelete) return;

    try {
      let deletedConversationId = conversationToDelete.id;
      try {
        await api.delete(`/api/outreach-conversations/${conversationToDelete.id}`);
      } catch (deleteError: unknown) {
        if (!(deleteError instanceof ApiError) || deleteError.status !== 404) throw deleteError;

        const replacement = await refreshAndResolveConversation(conversationToDelete);
        if (!replacement) {
          throw deleteError;
        }
        deletedConversationId = replacement.id;
        await api.delete(`/api/outreach-conversations/${replacement.id}`);
      }

      setConversations(prev => prev.filter(c => c.id !== deletedConversationId));

      if (selectedConversation?.id === deletedConversationId || selectedConversation?.leadId === conversationToDelete.leadId) {
        setSelectedConversation(null);
        setMessages([]);
      }

      await loadConversations();

      toast({
        title: "Conversation deleted",
        description: "The conversation has been permanently deleted",
      });
    } catch (error: unknown) {
      toast({
        title: "Conversation not deleted",
        description: error instanceof Error ? error.message : "Failed to delete conversation",
        variant: "destructive",
      });
    } finally {
      setDeleteDialogOpen(false);
      setConversationToDelete(null);
    }
  }, [conversationToDelete, selectedConversation, toast, refreshAndResolveConversation, loadConversations]);

  // Reload when the channel changes; old page responses are invalidated above.
  useEffect(() => {
    if (autoLoad) {
      loadConversations();
      loadUnreadCount();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveChannel, autoLoad]);

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Filtered conversations
  const filteredConversations = conversations.filter(
    (c) =>
      !searchQuery ||
      c.leadName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.leadEmail?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.leadInstagram?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.leadPhone?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.leadCompany?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // === Draft reply actions ===

  const composerContext = useRef({ conversationId: selectedConversation?.id, channel: effectiveChannel, text: newMessage, revision: 0 });
  if (composerContext.current.conversationId !== selectedConversation?.id
    || composerContext.current.channel !== effectiveChannel || composerContext.current.text !== newMessage) {
    composerContext.current = { conversationId: selectedConversation?.id, channel: effectiveChannel, text: newMessage,
      revision: composerContext.current.revision + 1 };
  }
  const composerRequest = useRef(false);
  const handleGenerateComposerReply = useCallback(async () => {
    if (!selectedConversation || composerRequest.current) return null;
    const started = composerContext.current;
    composerRequest.current = true;
    setGeneratingDraft(true);
    try {
      const response = await api.post<{ content: string }>(
        `/api/outreach-conversations/${effectiveChannel}/${selectedConversation.id}/draft-reply`,
        { composerOnly: true },
      );
      const current = composerContext.current;
      if (current.revision !== started.revision) {
        toast({ description: 'The conversation or your message changed. Your current text has been kept; generate again if needed.' });
        return null;
      }
      if (!response.content?.trim()) throw new Error('Support AI did not return a usable reply.');
      setNewMessage(response.content);
      toast({ title: 'Reply drafted', description: 'Based on this conversation and Support AI knowledge. Review before sending.' });
      return response.content;
    } catch (error) {
      toast({ title: 'Could not draft reply', description: error instanceof Error ? error.message : 'Please try again.', variant: 'destructive' });
      return null;
    } finally {
      composerRequest.current = false;
      setGeneratingDraft(false);
    }
  }, [selectedConversation, effectiveChannel, toast]);

  const handleGenerateDraft = useCallback(async () => {
    if (!selectedConversation) return;
    try {
      setGeneratingDraft(true);
      await api.post(`/api/outreach-conversations/${effectiveChannel}/${selectedConversation.id}/draft-reply`);
      await loadMessages(selectedConversation.id);
      toast({
        title: "Draft generated",
        description: "AI has drafted a reply based on your knowledge base. Review it before sending.",
      });
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 404 && selectedConversation) {
        try {
          const replacement = await refreshAndResolveConversation(selectedConversation);
          if (replacement) {
            await api.post(`/api/outreach-conversations/${effectiveChannel}/${replacement.id}/draft-reply`);
            await loadMessages(replacement.id);
            toast({
              title: "Draft generated",
              description: "AI has drafted a reply based on your knowledge base. Review it before sending.",
            });
            return;
          }
        } catch {
          // Fall through to the visible error below.
        }
      }

      const errorMsg = error instanceof Error ? error.message : "Failed to generate draft reply";
      toast({
        title: "Error",
        description: errorMsg,
        variant: "destructive",
      });
    } finally {
      setGeneratingDraft(false);
    }
  }, [selectedConversation, effectiveChannel, loadMessages, toast, refreshAndResolveConversation]);

  const handleEditDraft = useCallback((message: OutreachMessage) => {
    // Load the draft content into the compose area for editing
    setNewMessage(message.content);
    if (message.subject) {
      setSubject(message.subject);
    }
  }, []);

  const handleSendDraft = useCallback(async (message: OutreachMessage) => {
    if (!selectedConversation || sendInFlightRef.current) return;
    const idempotencyKey = `outreach-draft-${selectedConversation.id}-${message.id}`;
    sendInFlightRef.current = idempotencyKey;
    try {
      setSending(true);
      const sendResult = await api.post<{
        success: boolean;
        manualReviewRequired?: boolean;
        error?: string;
      }>(`/api/outreach-conversations/${effectiveChannel}/${selectedConversation.id}/send-draft`, {
        messageId: message.id,
        content: message.content,
        idempotencyKey,
        confirmation: { confirmed: true, conversationId: selectedConversation.id },
      });
      if (!sendResult.success) {
        await loadMessages(selectedConversation.id);
        toast({
          title: sendResult.manualReviewRequired ? "Delivery needs review" : "Draft not sent",
          description: sendResult.error || "The provider did not confirm delivery.",
          variant: "destructive",
        });
        return;
      }
      await loadMessages(selectedConversation.id);
      await loadConversations();
      toast({
        title: "Message sent",
        description: "Your draft reply has been sent successfully",
      });
    } catch (error: unknown) {
      toast({
        title: "Draft not sent",
        description: error instanceof Error ? error.message : "Failed to send draft message",
        variant: "destructive",
      });
    } finally {
      sendInFlightRef.current = null;
      setSending(false);
    }
  }, [selectedConversation, effectiveChannel, loadMessages, loadConversations, toast]);

  const handleDiscardDraft = useCallback(async (message: OutreachMessage) => {
    if (!selectedConversation) return;
    try {
      // Delete the draft message by sending a request to remove it
      await api.post(`/api/outreach-conversations/${effectiveChannel}/${selectedConversation.id}/discard-draft`, {
        messageId: message.id,
      });
      await loadMessages(selectedConversation.id);
      toast({
        title: "Draft discarded",
        description: "The draft reply has been removed",
      });
    } catch {
      // If the endpoint doesn't exist, just reload messages
      await loadMessages(selectedConversation.id);
    }
  }, [selectedConversation, effectiveChannel, loadMessages, toast]);

  return {
    conversations,
    selectedConversation,
    messages,
    newMessage,
    subject,
    searchQuery,
    conversationFilters,
    loading,
    loadingMore,
    hasMoreConversations,
    loadMoreError,
    loadMoreConversations,
    loadingMessages,
    conversationsError,
    messagesError,
    sending,
    syncing,
    unreadCount,
    deleteDialogOpen,
    conversationToDelete,
    messagesEndRef,
    generatingDraft,
    attachments,
    uploadingAttachments,

    setNewMessage,
    setSubject,
    setSearchQuery,
    setConversationFilters,
    setSelectedConversation,
    setDeleteDialogOpen,
    setConversationToDelete,

    loadConversations,
    refetch: loadConversations,
    handleSelectConversation,
    handleSendMessage,
    handleSync,
    openDeleteDialog,
    handleDeleteConversation,
    scrollToBottom,
    handleGenerateDraft,
    handleGenerateComposerReply,
    handleEditDraft,
    handleSendDraft,
    handleDiscardDraft,
    handleFilesSelected,
    handleRemoveAttachment,

    filteredConversations,
  };
}
