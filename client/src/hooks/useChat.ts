import { useState, useEffect, useRef, useCallback } from "react";
import { type Message } from "@/models/message";
import { useToast } from "@/hooks/use-toast";
import webSocketService from "@/services/WebSocketService";
import type { ConversationAttachment } from "@/lib/conversation-attachments";
import { api } from "@/lib/api";
import { reconcileConversationResponseMessage } from "@/lib/conversation-stream-reducer";
import { bindConversationAttempt, conversationAttempt, finishConversationAttempt, readConversationAttempt } from '@/lib/conversation-attempt';

const ACTIVE_TURN_POLL_MS = 3_000;
const IDLE_TURN_POLL_MS = 15_000;

export function useChat(
  selectedBusinessProfileId: string,
  _loadWidgets: (threadId: number) => void,
  onTurnStart?: () => void,
) {
  const { toast } = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const isProcessingRef = useRef(isProcessing);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [chatName, setChatName] = useState<string>("");
  const [currentThreadId, setCurrentThreadId] = useState<number | null>(null);
  const currentThreadIdRef = useRef<number | null>(null);
  const pendingNewThreadRef = useRef(false);
  const [seenMessageIds, setSeenMessageIds] = useState<Set<string>>(new Set());

  // Track threads created in this session to skip skeleton on navigation
  const locallyCreatedThreadRef = useRef<number | null>(null);

  // Track last seen message timestamp for WebSocket reconnect message sync
  const lastSeenTsRef = useRef<number>(Date.now());

  // Safety timeout: clear processing state if no response arrives within 150s.
  const processingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentKeyRef = useRef<{ key: string; ts: number } | null>(null);
  const activeTurnRef = useRef<{ threadId: number | null; requestId?: string } | null>(null);
  const lastRequestIdRef = useRef<string | null>(null);
  const attemptScopes = useRef(new Map<string, string>());
  useEffect(() => webSocketService.subscribe('thread_resolved', event => {
    const threadId = Number(event.threadId);
    if (!Number.isSafeInteger(threadId) || threadId <= 0 || typeof event.requestMessageId !== 'string') return;
    bindConversationAttempt('campaign:new', `campaign:${threadId}`, event.requestMessageId);
    if (attemptScopes.current.has(event.requestMessageId)) attemptScopes.current.set(event.requestMessageId, `campaign:${threadId}`);
    if (activeTurnRef.current?.requestId === event.requestMessageId) activeTurnRef.current.threadId = threadId;
  }), []);
  useEffect(() => webSocketService.subscribe('message_sent', event => {
    if (typeof event.ackMessageId !== 'string' || event.success !== true) return;
    const scopes = [attemptScopes.current.get(event.ackMessageId), `campaign:${event.threadId}`, 'campaign:new'];
    for (const scope of scopes) if (scope) finishConversationAttempt(scope, event.ackMessageId);
    attemptScopes.current.delete(event.ackMessageId);
  }), []);

  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  useEffect(() => {
    currentThreadIdRef.current = currentThreadId;
  }, [currentThreadId]);

  const clearProcessingTimeout = useCallback(() => {
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
      processingTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    const turn = activeTurnRef.current;
    if (!turn || turn.threadId === currentThreadId) return;
    activeTurnRef.current = null;
    clearProcessingTimeout();
  }, [currentThreadId, clearProcessingTimeout]);

  useEffect(() => () => {
    activeTurnRef.current = null;
    clearProcessingTimeout();
  }, [clearProcessingTimeout]);

  useEffect(() => {
    if (!currentThreadId) return;
    let active = true;
    let refreshing = false;
    let observedServerBusy = false;
    let lastReadAt = 0;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      lastReadAt = Date.now();
      const requestAtStart = lastRequestIdRef.current;
      try {
        const turns = await api.get<Array<{ request_id: string; status: string }>>(`/api/chat/threads/${currentThreadId}/turns`);
        if (!active || currentThreadIdRef.current !== currentThreadId || !Array.isArray(turns)) return;
        for (const scope of [`campaign:${currentThreadId}`, 'campaign:new']) {
          const attempt = readConversationAttempt(scope);
          if (attempt && turns.some(turn => turn.request_id === attempt.requestId && ['completed','cancelled','reconciled'].includes(turn.status))) {
            finishConversationAttempt(scope, attempt.requestId);
          }
        }
        if (requestAtStart !== lastRequestIdRef.current) return;
        const busy = turns.some(turn => ['queued', 'running'].includes(turn.status));
        if (busy) {
          observedServerBusy = true;
          isProcessingRef.current = true; setIsProcessing(true);
        }
        // Reloaded turns have no local request ID. Once the server-owned work
        // settles, release their spinner even when the terminal WS event was
        // missed. A read begun before a new send cannot settle that new turn.
        else if (
          turns.some(turn => turn.request_id === lastRequestIdRef.current)
          || (observedServerBusy && !(activeTurnRef.current?.threadId === currentThreadId
            && activeTurnRef.current.requestId
            && !turns.some(turn => turn.request_id === activeTurnRef.current?.requestId)))
        ) {
          observedServerBusy = false;
          isProcessingRef.current = false; setIsProcessing(false); clearProcessingTimeout();
        }
      } catch { /* Existing WS/REST state continues to own offline recovery. */ }
      finally { refreshing = false; }
    };
    void refresh();
    // A hidden tab skips polls; the next tick after it is shown catches up.
    // While a turn is in flight, read every few seconds so a missed socket
    // event cannot strand the spinner. An idle conversation only needs a slow
    // safety read: live updates arrive over the socket.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      const turnInFlight = isProcessingRef.current || observedServerBusy;
      if (!turnInFlight && Date.now() - lastReadAt < IDLE_TURN_POLL_MS) return;
      void refresh();
    }, ACTIVE_TURN_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [currentThreadId, clearProcessingTimeout]);
  const handleSendMessage = useCallback(async (
    content: string,
    bypassProcessingCheck = false,
    attachments: ConversationAttachment[] = [],
    // Short label shown in the chat for a button-sent instruction.
    displayContent?: string,
  ) => {
    if (!content.trim()) return;
    const label = displayContent?.trim() || undefined;

    if (isProcessing && !bypassProcessingCheck && !currentThreadIdRef.current) {
      toast({
        title: "Still processing",
        description: "Please wait for the current response to finish.",
        variant: "default",
      });
      return;
    }

    // Read the thread from the ref at send time. A newly-created thread is set
    // while the conversation page is still loading; callbacks scheduled by the
    // previous render otherwise retain `currentThreadId === null` and ask the
    // server to create a second thread for the first message.
    const sendThreadId = currentThreadIdRef.current;
    const attachmentKey = attachments.map(({ fileId }) => fileId).sort((a, b) => a - b).join(',');
    const key = `${sendThreadId || "new"}:${content.trim()}:${attachmentKey}`;
    const now = Date.now();

    if (lastSentKeyRef.current && lastSentKeyRef.current.key === key && now - lastSentKeyRef.current.ts < 3000) {
      return;
    }
    lastSentKeyRef.current = { key, ts: now };

    const turn: { threadId: number | null; requestId?: string } = { threadId: sendThreadId };
    activeTurnRef.current = turn;
    const ownsCurrentConversation = () => (
      currentThreadIdRef.current === turn.threadId
      && (turn.threadId !== null || activeTurnRef.current === turn)
    );
    const ownsCurrentTurn = () => activeTurnRef.current === turn && ownsCurrentConversation();

    onTurnStart?.();
    setIsProcessing(true);
    isProcessingRef.current = true;
    pendingNewThreadRef.current = sendThreadId === null;
    clearProcessingTimeout();

    processingTimeoutRef.current = setTimeout(() => {
      if (!ownsCurrentTurn()) return;
      processingTimeoutRef.current = null;
      isProcessingRef.current = false;
      setIsProcessing(false);
    }, 150000);

    const optimisticUserMessage: Message = {
      // Concurrent queued turns can share a millisecond. Their optimistic rows
      // must remain distinct so one receipt cannot replace another turn's text.
      id: `optimistic-user-${crypto.randomUUID()}`,
      role: "user",
      content: content.trim(),
      timestamp: now,
      metadata: {
        optimistic: true,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(label ? { displayContent: label } : {}),
      },
    };
    setMessages((prev) => [...prev, optimisticUserMessage]);

    try {
      const attemptScope = `campaign:${sendThreadId || 'new'}`;
      const prior = readConversationAttempt(attemptScope);
      const priorContext = prior?.context as { attachmentKey?: string; businessProfileId?: string | null } | undefined;
      const businessProfileId = sendThreadId && prior?.text === content && priorContext?.attachmentKey === attachmentKey
        ? priorContext.businessProfileId ?? null : !sendThreadId ? selectedBusinessProfileId : null;
      const attempt = conversationAttempt(attemptScope, content, { attachmentKey, businessProfileId });
      const deliveryId = attempt.requestId;
      turn.requestId = deliveryId;
      attemptScopes.current.set(deliveryId, attemptScope);
      lastRequestIdRef.current = deliveryId;
      const requestData = {
        content,
        ...(sendThreadId ? { threadId: sendThreadId } : {}),
        ...(attachments.length > 0
          ? { attachments: attachments.map(({ fileId }) => ({ fileId })) }
          : {}),
        ...(businessProfileId ? { businessProfileId: Number(businessProfileId) } : {}),
        ...(label ? { displayContent: label } : {}),
      };
      const sendResult = webSocketService.send({
        type: "send_chat_message",
        messageId: deliveryId,
        data: requestData,
      });

      if (sendResult === 'queued') {
        setMessages((prev) => prev.map(m =>
          m.id === optimisticUserMessage.id
            ? { ...m, metadata: { ...m.metadata, pendingDelivery: true } }
            : m
        ));

        // A queued-only WebSocket turn can remain optimistic forever during a
        // gateway outage even while the authenticated API is healthy. Transfer
        // ownership to HTTP synchronously; removing it from the WS queue first
        // prevents a reconnect replay from racing the same turn.
        webSocketService.releaseQueuedMessage(deliveryId);
        const fallback = await api.post<{
          threadId?: number;
          message?: { id?: string | number; content?: string; timestamp?: number; createdAt?: string };
          response?: {
            messageId?: string | number;
            role?: Message['role'];
            content?: string;
            agentType?: Message['agentType'];
            metadata?: Record<string, unknown>;
          };
        }>("/api/chat/langgraph/message", {
          ...requestData,
          idempotencyKey: deliveryId,
        });
        finishConversationAttempt(attemptScope, deliveryId);
        const boundScope = attemptScopes.current.get(deliveryId);
        if (boundScope) finishConversationAttempt(boundScope, deliveryId);
        attemptScopes.current.delete(deliveryId);

        const fallbackThreadId = Number(fallback.threadId);
        // Resolve from this request's receipt. A shared "locally created"
        // marker may already identify a different, newer campaign.
        if (turn.threadId === null && Number.isSafeInteger(fallbackThreadId) && fallbackThreadId > 0
          && currentThreadIdRef.current === fallbackThreadId) turn.threadId = fallbackThreadId;
        // Earlier queued replies still belong in their original conversation.
        if (!ownsCurrentConversation()) return;

        // HTTP fallback owns delivery after the queued WebSocket message is
        // released. Adopt the server-created thread from that response just as
        // we do for thread_resolved/message_sent events; otherwise the browser
        // remains on the new-campaign route and filters every thread-scoped
        // widget/event that follows.
        if (
          sendThreadId === null
          && Number.isSafeInteger(fallbackThreadId)
          && fallbackThreadId > 0
          && (currentThreadIdRef.current === null || currentThreadIdRef.current === fallbackThreadId)
        ) {
          turn.threadId = fallbackThreadId;
          currentThreadIdRef.current = fallbackThreadId;
          locallyCreatedThreadRef.current = fallbackThreadId;
          setCurrentThreadId(fallbackThreadId);
          window.history.replaceState(null, '', `/dashboard/conversations/${fallbackThreadId}`);
          void _loadWidgets(fallbackThreadId);
        }

        const durableUserId = fallback.message?.id != null
          ? String(fallback.message.id)
          : optimisticUserMessage.id;
        const assistantId = fallback.response?.messageId != null
          ? String(fallback.response.messageId)
          : typeof fallback.response?.metadata?.responseId === 'string'
            ? fallback.response.metadata.responseId
            : `http-response-${deliveryId}`;
        setMessages((prev) => {
          if (!ownsCurrentConversation()) return prev;
          const withoutOptimistic = [...prev];
          const durableUser: Message = {
            ...optimisticUserMessage,
            id: durableUserId,
            content: fallback.message?.content || optimisticUserMessage.content,
            timestamp: fallback.message?.timestamp
              || (fallback.message?.createdAt ? new Date(fallback.message.createdAt).getTime() : now),
            metadata: {
              ...optimisticUserMessage.metadata,
              optimistic: false,
              pendingDelivery: false,
            },
          };
          const assistant: Message | null = fallback.response?.content
            ? {
                id: assistantId,
                role: fallback.response.role || 'assistant',
                content: fallback.response.content,
                agentType: fallback.response.agentType,
                timestamp: Date.now(),
                metadata: fallback.response.metadata,
              }
            : null;
          const existingUserIndex = withoutOptimistic.findIndex(message => message.id === durableUser.id);
          const optimisticIndex = withoutOptimistic.findIndex(message => message.id === optimisticUserMessage.id);
          const reconciled = [...withoutOptimistic];
          if (existingUserIndex >= 0) {
            reconciled[existingUserIndex] = durableUser;
            if (optimisticIndex >= 0 && optimisticIndex !== existingUserIndex) reconciled.splice(optimisticIndex, 1);
          } else if (optimisticIndex >= 0) reconciled[optimisticIndex] = durableUser;
          else reconciled.push(durableUser);
          return assistant ? reconcileConversationResponseMessage(reconciled, assistant) : reconciled;
        });
        if (ownsCurrentTurn()) {
          pendingNewThreadRef.current = false;
          clearProcessingTimeout();
          isProcessingRef.current = false;
          setIsProcessing(false);
        }
      }
    } catch (error: unknown) {
      // Do not restore an old draft, append an error, or stop a newer turn.
      if (!ownsCurrentTurn()) return;
      pendingNewThreadRef.current = false;
      console.error("Error sending message:", error);
      // A lost acknowledgement is not proof that the server rejected the
      // message. Keep its text/attachments visible without automatically
      // sending again; the composer can restore this draft if still untouched.
      setMessages((prev) => !ownsCurrentTurn() ? prev : prev.map(message => message.id === optimisticUserMessage.id
        ? { ...message, metadata: { ...message.metadata, pendingDelivery: false, deliveryUnconfirmed: true } }
        : message));

      const errorMessage: Message = {
        id: Date.now().toString(),
        role: "system",
        content: `${(error as Error)?.message || "The message could not be confirmed."} Delivery is not confirmed. Your attempted message is kept above. Check the conversation after reconnecting before retrying to avoid sending it twice.`,
        timestamp: Date.now(),
        metadata: { isError: true },
      };
      setMessages((prev) => ownsCurrentTurn() ? [...prev, errorMessage] : prev);
      clearProcessingTimeout();
      isProcessingRef.current = false;
      setIsProcessing(false);
      return { delivery: 'unconfirmed' as const };
    }
  }, [selectedBusinessProfileId, isProcessing, clearProcessingTimeout, toast, _loadWidgets, onTurnStart]);

  return {
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
    pendingNewThreadRequestIdRef: lastRequestIdRef,
    seenMessageIds,
    setSeenMessageIds,
    locallyCreatedThreadRef,
    lastSeenTsRef,
    clearProcessingTimeout,
    handleSendMessage,
  };
}
