"use client";
import { ConversationTurnStatus } from "@/components/conversation/ConversationTurnStatus";

import {
  conversationAttempt,
  finishConversationAttempt,
  readConversationAttempt,
} from "@/lib/conversation-attempt";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Plus,
  Archive,
  ArchiveRestore,
  MessageSquare,
  ArrowLeft,
  ArrowRight,
  MoreHorizontal,
  Pencil,
  Download,
  Copy,
  PanelLeft,
  Bot,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/lib/api";
import Link from "next/link";
import { BUSINESS_PROFILE_HEADER } from "@/lib/business-profile";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Callout } from "@/components/ui/callout";
import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/lib/utils";
import { ConversationComposer } from "@/components/conversation/ConversationComposer";
import { ConversationActivityGroup } from "@/components/conversation/ConversationActivityGroup";
import { AttachmentTray } from "@/components/conversation/AttachmentTray";
import { SupportConversationTranscript, parseSupportSources, type SupportTranscriptMessage } from "@/components/support/SupportConversationTranscript";
import { SupportAIPageShell } from "@/components/support/SupportAIPageShell";
import { copySupportTranscript, exportSupportTranscript } from "@/lib/support-transcript";
import { supportSessionSummaryPreview } from "@/lib/support-session-summary";
import { replaceSupportQueryHistory } from "@/lib/support-report";
import { validateSupportChatFiles, SUPPORT_CHAT_FILE_ACCEPT } from "@/lib/support-chat-uploads";
import { queryClient } from "@/lib/queryClient";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { SessionPagination } from "@/components/support/SessionHistoryControls";
import { AttachmentExtractionNotices } from "@/components/support/AttachmentExtractionNotices";
import { ChatMessageViewport } from "@/components/conversation/ChatMessageViewport";
import { useAssistantList, useAssistantWorkspace } from "@/hooks/use-outreach-assistants";

interface ChatSession {
  id: number;
  memberId: number;
  leadId: number | null;
  title: string;
  summary: string | null;
  memberName: string;
  metadata: {
    channel?: string;
    mode?: "advisory" | "preview";
    source?: string;
    visitorName?: string;
    visitorEmail?: string;
    visitorPhone?: string;
    assistantId?: string;
    assistantRevision?: "draft" | "published";
  } | null;
  createdAt: string;
  updatedAt: string;
}

interface ChatMessage extends SupportTranscriptMessage { sessionId: number; role: "user" | "assistant"; }
interface SessionWithMessages extends ChatSession { messages: ChatMessage[]; }

function readChatView(profileId?: number) {
  if (typeof window === "undefined") return { search: "", archived: false, page: 1, session: null as number | null };
  const params = new URLSearchParams(window.location.search);
  if (params.get("chatBusiness") !== String(profileId)) return { search: "", archived: false, page: 1, session: null as number | null };
  const session = Number(params.get("session"));
  return { search: params.get("search")?.slice(0, 200) || "", archived: params.get("archived") === "true", page: Math.max(1, Math.min(Number(params.get("page")) || 1, 100000)), session: Number.isSafeInteger(session) && session > 0 ? session : null };
}

export default function SupportAIChatPage() {
  const assistantWorkspace = useAssistantWorkspace();
  const assistantList = useAssistantList(assistantWorkspace);
  return <SupportAIChatWorkspace key={`${assistantWorkspace.scopeKey[1]}:${assistantWorkspace.profileId ?? 'pending'}`} assistantWorkspace={assistantWorkspace} assistantList={assistantList} />;
}

function SupportAIChatWorkspace({ assistantWorkspace, assistantList }: {
  assistantWorkspace: ReturnType<typeof useAssistantWorkspace>;
  assistantList: ReturnType<typeof useAssistantList>;
}) {
  const { toast } = useToast();
  const requestOptions = useMemo(() => ({ headers: { [BUSINESS_PROFILE_HEADER]: String(assistantWorkspace.profileId) } }), [assistantWorkspace.profileId]);
  const initialView = useRef(readChatView(assistantWorkspace.profileId)).current;
  const [showConfiguration, setShowConfiguration] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [sendError, setSendError] = useState("");
  const [uploadPercent, setUploadPercent] = useState(0);
  const [pendingUploadNames, setPendingUploadNames] = useState<string[]>([]);
  const [uploadError, setUploadError] = useState("");
  const uploadRequest = useRef<AbortController | null>(null);
  const listRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; const view = viewGeneration; const list = sessionListGeneration; return () => { alive.current = false; view.current++; list.current++; uploadRequest.current?.abort(); listRequest.current?.abort(); detailRequest.current?.abort(); }; }, []);
  const [assistantId, setAssistantId] = useState("");
  const [assistantRevision, setAssistantRevision] = useState<"draft" | "published">("draft");
  const availableAssistants = assistantList.data?.assistants || [];
  const selectedAssistant = availableAssistants.find(assistant => assistant.id === assistantId);
  const runtimeEnabled = assistantWorkspace.profileId && !assistantWorkspace.profiles.isLoading && !assistantList.isError
    ? assistantList.data?.runtimeEnabled : undefined;
  const assistantSelectionValid = !!selectedAssistant && (assistantRevision === 'draft' || !!selectedAssistant.publishedRevision && !!selectedAssistant.published);
  const assistantRoutingBlocked = runtimeEnabled !== true || !assistantSelectionValid;
  const assistantContextKey = runtimeEnabled === true
    ? `${assistantId}:${assistantRevision}:${assistantRevision === 'draft' ? selectedAssistant?.draftVersion : selectedAssistant?.publishedRevision}`
    : 'legacy';
  const assistantScope = useCallback((sessionId: number | null, mode: string) => `owner:${sessionId || 'new'}:${mode}${runtimeEnabled === true ? `:assistant:${assistantContextKey}` : ''}`, [runtimeEnabled, assistantContextKey]);

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [activeSessionTitle, setActiveSessionTitle] =
    useState("New conversation");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [showSessionList, setShowSessionList] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [channel, setChannel] = useState<
    "web" | "whatsapp" | "instagram" | "facebook" | "email"
  >("web");

  const [attachments, setAttachments] = useState<any[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [search, setSearch] = useState(initialView.search);
  const [debouncedSearch, setDebouncedSearch] = useState(initialView.search);
  useEffect(() => { const timer = setTimeout(() => setDebouncedSearch(search), 300); return () => clearTimeout(timer); }, [search]);
  const [archived, setArchived] = useState(initialView.archived);
  const [page, setPage] = useState(initialView.page);
  const [hasMore, setHasMore] = useState(false);
  const [undoSessionId, setUndoSessionId] = useState<number | null>(null);
  const [mode, setMode] = useState<"advisory" | "preview">("advisory");
  const viewGeneration = useRef(0);
  const sessionListGeneration = useRef(0);
  const sessionQuery = useRef({ page, search: debouncedSearch, archived });
  useEffect(() => {
    sessionQuery.current = { page, search: debouncedSearch, archived };
  }, [page, debouncedSearch, archived]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("chatBusiness", String(assistantWorkspace.profileId));
    for (const [key, value] of Object.entries({ search, archived: archived ? "true" : "", page: page > 1 ? String(page) : "", session: activeSessionId ? String(activeSessionId) : "" })) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    replaceSupportQueryHistory(url.pathname + url.search);
  }, [search, archived, page, activeSessionId, assistantWorkspace.profileId]);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyHeadingRef = useRef<HTMLHeadingElement>(null);
  const conversationHeadingRef = useRef<HTMLHeadingElement>(null);
  const historyToggleRef = useRef<HTMLButtonElement>(null);
  const selectedPreviewContext = useRef<{ assistantId: string; revision: 'draft' | 'published'; version: number | null } | null>(null);
  useEffect(() => {
    if (runtimeEnabled !== true || !selectedAssistant) { selectedPreviewContext.current = null; return; }
    const next = { assistantId: selectedAssistant.id, revision: assistantRevision, version: assistantRevision === 'draft' ? selectedAssistant.draftVersion : selectedAssistant.publishedRevision };
    const previous = selectedPreviewContext.current;
    selectedPreviewContext.current = next;
    if (previous && previous.assistantId === next.assistantId && previous.revision === next.revision && previous.version !== next.version) {
      viewGeneration.current++;
      setSending(false); setLoadingMessages(false); setMessagesError(null);
      setActiveSessionId(null); setActiveSessionTitle('New conversation'); setMessages([]); setAttachments([]);
      toast({ title: 'Assistant configuration changed', description: 'A fresh test conversation is ready. Previous chat history is retained.' });
    }
  }, [runtimeEnabled, selectedAssistant, assistantRevision, toast]);

  const loadSessions = useCallback(async () => {
    // A completed send can hold an older callback; always refresh today's filter.
    const { page, search, archived } = sessionQuery.current;
    const generation = ++sessionListGeneration.current;
    setLoadingSessions(true);
    setSessionsError(null);
    listRequest.current?.abort();
    const controller = new AbortController(); listRequest.current = controller;
    try {
      const res = await api.get<{
        success: boolean;
        data: ChatSession[];
        sessions?: ChatSession[];
        total: number;
        hasMore?: boolean;
      }>(
        `/api/support/ai/sessions?limit=25&page=${page}&search=${encodeURIComponent(search)}&archived=${archived}&source=internal`,
        { ...requestOptions, signal: controller.signal },
      );
      if (generation !== sessionListGeneration.current) return;
      const allSessions: ChatSession[] = Array.isArray(res)
        ? res
        : res.data || res.sessions || [];
      setSessions(allSessions.filter((s) => s.metadata?.source !== "widget"));
      setHasMore(res.hasMore ?? res.total > page * 25);
    } catch (error: unknown) {
      if (controller.signal.aborted || generation !== sessionListGeneration.current) return;
      setSessionsError(
        error instanceof Error ? error.message : "Failed to load chat sessions",
      );
    } finally {
      if (generation === sessionListGeneration.current)
        setLoadingSessions(false);
    }
  }, [requestOptions]);

  useEffect(() => {
    if (assistantWorkspace.profileId && !assistantWorkspace.profiles.isLoading) void loadSessions();
  }, [loadSessions, page, debouncedSearch, archived, assistantWorkspace.profileId, assistantWorkspace.profiles.isLoading]);

  const loadSession = useCallback(async (id: number) => {
    const generation = ++viewGeneration.current;
    uploadRequest.current?.abort(); setUploadingAttachments(false); setUploadError(""); setSendError("");
    detailRequest.current?.abort();
    const controller = new AbortController(); detailRequest.current = controller;
    setInput("");
    setAttachments([]);
    setSending(false);
    setLoadingMessages(true);
    setActiveSessionId(id);
    setActiveSessionTitle("Loading conversation…");
    setMessages([]);
    setMessagesError(null);
    setShowSessionList(false);
    if (window.matchMedia?.("(max-width: 1023px)")?.matches) {
      requestAnimationFrame(() =>
        conversationHeadingRef.current?.focus({ preventScroll: true }),
      );
    }
    try {
      const sessionData = await api.get<SessionWithMessages>(
        `/api/support/ai/sessions/${id}`,
        { ...requestOptions, signal: controller.signal },
      );
      if (generation !== viewGeneration.current) return;
      setMessages(sessionData?.messages || []);
      setActiveSessionTitle(sessionData.title || "Untitled conversation");
      const savedChannel =
        sessionData.metadata?.channel ||
        sessionData.messages?.at(-1)?.metadata?.channel;
      setChannel(
        ["web", "whatsapp", "instagram", "facebook", "email"].includes(
          savedChannel || "",
        )
          ? (savedChannel as typeof channel)
          : "web",
      );
      setMode(
        sessionData.metadata?.mode === "preview" ? "preview" : "advisory",
      );
      const savedAssistant = sessionData.messages?.filter(message => message.role === 'assistant').at(-1)?.metadata?.provenance?.assistant;
      setAssistantId(sessionData.metadata?.assistantId || savedAssistant?.assistantId || "");
      setAssistantRevision(sessionData.metadata?.assistantRevision || (savedAssistant && savedAssistant.revision !== 0 ? 'published' : 'draft'));
    } catch (error: unknown) {
      if (controller.signal.aborted || generation !== viewGeneration.current) return;
      setMessagesError(
        error instanceof Error ? error.message : "Failed to load messages",
      );
      setActiveSessionTitle("Conversation unavailable");
    } finally {
      if (generation === viewGeneration.current) setLoadingMessages(false);
    }
  }, [requestOptions]);

  useEffect(() => { if (initialView.session) void loadSession(initialView.session); }, [initialView, loadSession]);

  const deleteSession = useCallback(
    async (id: number) => {
      if (
        !archived &&
        !window.confirm(
          "Archive this conversation? You can restore it from Archived conversations.",
        )
      )
        return;
      try {
        await api.patch(`/api/support/ai/sessions/${id}`, {
          archived: !archived,
        });
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (activeSessionId === id) {
          viewGeneration.current++;
          setSending(false);
          setLoadingMessages(false);
          setMessagesError(null);
          setChannel("web");
          setActiveSessionId(null);
          setActiveSessionTitle("New conversation");
          setMode("advisory");
          setMessages([]);
        }
        setUndoSessionId(archived ? null : id);
        toast({
          title: archived ? "Conversation restored" : "Conversation archived",
        });
      } catch {
        toast({
          title: "Error",
          description: "Failed to update conversation",
          variant: "destructive",
        });
      }
    },
    [activeSessionId, toast, archived],
  );

  useEffect(() => {
    const saved = readConversationAttempt(
      assistantScope(activeSessionId, mode),
    );
    if (saved) setInput((current) => current || saved.text);
  }, [activeSessionId, mode, assistantScope]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || sending || loadingMessages || uploadingAttachments || !!messagesError || assistantRoutingBlocked) return;
    setSendError("");

    const userText = input.trim();
    const attemptScope = assistantScope(activeSessionId, mode);
    const attempt = conversationAttempt(attemptScope, userText, {
      channel,
      mode,
      attachments: attachments.map((file) => file.id),
      ...(runtimeEnabled === true ? { assistantId, assistantRevision } : {}),
    });
    const generation = viewGeneration.current;
    setInput("");
    setSending(true);

    const tempUserMsg: ChatMessage = {
      id: Date.now(),
      sessionId: activeSessionId || 0,
      role: "user",
      content: userText,
      sources: null,
      confidence: null,
      createdAt: new Date().toISOString(),
      metadata: {
        channel,
        attachments: attachments.length > 0 ? attachments : null,
      },
    } as any;
    setMessages((prev) => [...prev, tempUserMsg]);

    const activeAttachments = [...attachments];
    setAttachments([]);

    try {
      type ChatResponse = {
        sessionId: number;
        userMessage: ChatMessage;
        assistantMessage: ChatMessage;
        assistantMessages?: ChatMessage[];
        response: { answer: string; confidence: number; sources: unknown[] };
        resolvedAssistant?: NonNullable<NonNullable<SupportTranscriptMessage["metadata"]>["provenance"]>["assistant"];
      };
      const body = {
        message: userText,
        requestId: attempt.requestId,
        clientSessionKey: attempt.clientSessionKey,
        sessionId: activeSessionId,
        channel,
        mode,
        ...(runtimeEnabled === true ? { assistantId, assistantRevision } : {}),
        attachments:
          activeAttachments.length > 0 ? activeAttachments : undefined,
      };
      const result = await api.post<ChatResponse>("/api/support/ai/chat", body, requestOptions);

      finishConversationAttempt(attemptScope, attempt.requestId);
      const assistantMsgs = result.assistantMessages || [
        result.assistantMessage,
      ];
      if (generation !== viewGeneration.current) {
        void loadSessions();
        return;
      }
      const normalizedAssistantMessages = assistantMsgs.map((msg) => ({
        ...msg,
        ...(result.resolvedAssistant && !msg.metadata?.provenance?.assistant ? { metadata: { ...msg.metadata, provenance: { ...msg.metadata?.provenance, assistant: result.resolvedAssistant } } } : {}),
        sources:
          msg.sources && parseSupportSources(msg.sources).length > 0
            ? msg.sources
            : parseSupportSources(result.response?.sources),
      }));

      setMessages((prev) => [
        ...prev.filter((m) => m.id !== tempUserMsg.id),
        result.userMessage,
        ...normalizedAssistantMessages,
      ]);

      if (!activeSessionId) {
        setActiveSessionId(result.sessionId);
        loadSessions();
      } else {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === result.sessionId
              ? { ...s, updatedAt: new Date().toISOString() }
              : s,
          ),
        );
      }
    } catch (error) {
      if (generation !== viewGeneration.current) return;
      setSendError(error instanceof Error ? error.message : "The message could not be sent. Retry to retrieve its saved result.");
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to send message",
        variant: "destructive",
      });
      setMessages((prev) => prev.filter((m) => m.id !== tempUserMsg.id));
      setInput((current) => current || userText);
      setAttachments(activeAttachments);
    } finally {
      if (generation === viewGeneration.current) {
        setSending(false);
        inputRef.current?.focus({ preventScroll: true });
      }
    }
  }, [
    input,
    activeSessionId,
    channel,
    mode,
    sending,
    loadingMessages,
    uploadingAttachments,
    messagesError,
    assistantScope,
    toast,
    loadSessions,
    attachments,
    assistantId,
    assistantRevision,
    assistantRoutingBlocked,
    runtimeEnabled,
    requestOptions,
  ]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFilesSelected = async (files: FileList) => {
    if (uploadingAttachments || sending) return;
    const selected = Array.from(files);
    const validation = validateSupportChatFiles(selected, attachments);
    if (validation) { setUploadError(validation); return; }
    const generation = viewGeneration.current;
    const controller = new AbortController(); uploadRequest.current = controller;
    setUploadError(""); setUploadingAttachments(true); setUploadPercent(0); setPendingUploadNames(selected.map((file) => file.name));
    try {
      const formData = new FormData(); selected.forEach((file) => formData.append("files", file));
      const data = await api.postForm<{ attachments: any[] }>("/api/outreach/attachments", formData, {
        ...requestOptions, signal: controller.signal,
        onUploadProgress: (percent) => { if (alive.current && generation === viewGeneration.current) setUploadPercent(percent); },
      });
      if (alive.current && generation === viewGeneration.current) setAttachments((prev) => [...prev, ...data.attachments]);
    } catch (error) {
      if (!controller.signal.aborted && alive.current && generation === viewGeneration.current) {
        const description = error instanceof Error ? error.message : "Files could not be uploaded. Choose the files again to retry.";
        setUploadError(description); toast({ title: "Upload failed", description, variant: "destructive" });
      }
    } finally {
      if (alive.current && generation === viewGeneration.current) { setUploadingAttachments(false); setPendingUploadNames([]); }
    }
  };

  const handleRemoveAttachment = (fileIdOrName: number | string) => {
    setAttachments((prev) =>
      prev.filter((a) => (a.fileId || a.fileName) !== fileIdOrName),
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  };

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    return d.toLocaleDateString();
  };

  const conversationTitle =
    sessions.find((session) => session.id === activeSessionId)?.title ||
    activeSessionTitle;

  const startConversation = () => {
    viewGeneration.current++;
    detailRequest.current?.abort(); uploadRequest.current?.abort();
    setUploadingAttachments(false); setPendingUploadNames([]); setUploadError(""); setSendError("");
    setSending(false);
    setLoadingMessages(false);
    setMessagesError(null);
    setChannel("web");
    setActiveSessionId(null);
    setActiveSessionTitle("New conversation");
    setMode("advisory");
    setMessages([]);
    setInput("");
    setAttachments([]);
    setShowSessionList(false);
    requestAnimationFrame(() =>
      inputRef.current?.focus({ preventScroll: true }),
    );
  };

  return (
    <SupportAIPageShell variant="chat" padding="none" className="overflow-clip rounded-2xl border border-border bg-background shadow-sm">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-5 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary sm:flex"><Bot className="h-6 w-6" aria-hidden="true" /></div>
          <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            Support assistant
          </h1>
          <p className="mt-1 hidden text-sm text-muted-foreground sm:block">
            Find answers in your knowledge base and draft customer replies.
          </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            onClick={startConversation}
            className="h-11 gap-2 px-3 sm:px-4"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New chat
          </Button>
        </div>
      </header>

      <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-4 sm:px-6">
        <div className="space-y-2">
          {runtimeEnabled !== false && <><div className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-0 basis-full flex-col gap-2 text-xs font-medium sm:basis-auto sm:flex-1 sm:flex-row sm:items-center sm:gap-3"><span className="text-muted-foreground">Assistant</span>
              <select id="support-chat-assistant" aria-label="Assistant for this chat" value={assistantId} disabled={runtimeEnabled !== true || sending || loadingMessages} className="h-11 w-full min-w-0 flex-1 rounded-xl border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onChange={event => { startConversation(); setAssistantId(event.target.value); setAssistantRevision('draft'); }}>
                <option value="">Choose an assistant</option>
                {assistantId && !selectedAssistant && <option value={assistantId}>Selected assistant unavailable</option>}
                {availableAssistants.map(assistant => <option key={assistant.id} value={assistant.id}>{assistant.draft.name}</option>)}
              </select>
            </label>
            {assistantList.hasNextPage && <Button variant="outline" className="h-11 text-xs" disabled={assistantList.isFetchingNextPage} onClick={() => { void assistantList.fetchNextPage(); }}>{assistantList.isFetchingNextPage ? 'Loading…' : 'Load more assistants'}</Button>}
            <Button variant="outline" className="h-11 gap-2 rounded-xl bg-background px-3 text-xs" aria-expanded={showConfiguration} aria-controls="support-chat-configuration" onClick={() => setShowConfiguration(value => !value)}><Settings2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{selectedAssistant ? `${assistantRevision === "draft" ? "Saved changes" : "Live version"} · Settings` : "Chat settings"}</Button>
          </div>
          {showConfiguration && <div id="support-chat-configuration" className="space-y-3 rounded-xl border border-border bg-background p-4">
            <fieldset disabled={!selectedAssistant || runtimeEnabled !== true || sending || loadingMessages}>
              <legend className="mb-3 text-sm font-medium">Chat version</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex min-h-16 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
                  <input type="radio" name="support-chat-version" aria-label="Saved changes" value="draft" checked={assistantRevision === 'draft'} className="mt-1 accent-primary" onChange={() => { if (assistantRevision !== 'draft') { startConversation(); setAssistantRevision('draft'); } }} />
                  <span><span className="block text-sm font-medium">Saved changes</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">Try your latest saved edits before publishing.</span></span>
                </label>
                <label className="flex min-h-16 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
                  <input type="radio" name="support-chat-version" aria-label="Live version" value="published" checked={assistantRevision === 'published'} disabled={!selectedAssistant?.publishedRevision || !selectedAssistant.published} className="mt-1 accent-primary" onChange={() => { if (assistantRevision !== 'published') { startConversation(); setAssistantRevision('published'); } }} />
                  <span><span className="block text-sm font-medium">Live version</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{selectedAssistant?.publishedRevision && selectedAssistant.published ? 'Use the version currently serving your customers.' : 'Available after you publish this assistant.'}</span></span>
                </label>
              </div>
            </fieldset>
            <p className="text-xs leading-5 text-muted-foreground">Replies stay in this workspace. Choosing a different version starts a new chat.</p>
          </div>}</>}
          {assistantRoutingBlocked && <div role={runtimeEnabled === undefined ? 'alert' : 'status'} className="flex flex-wrap items-center justify-between gap-2 text-xs leading-5 text-muted-foreground">
            <p>{runtimeEnabled === undefined ? assistantList.isFetching || assistantWorkspace.profiles.isLoading ? 'Loading assistants…' : 'Assistants could not be loaded. Retry before sending a message.' : runtimeEnabled === false ? 'AI replies are disabled. Review assistant setup.' : !availableAssistants.length ? 'No assistants are available. Create one to start chatting.' : assistantId && !selectedAssistant ? 'This assistant is unavailable. Choose another to start a new chat.' : assistantRevision === 'published' && selectedAssistant ? 'This assistant has no published configuration. Open Settings to use its saved draft.' : 'Choose an assistant before sending a message.'}</p>
            {runtimeEnabled === undefined && !assistantList.isFetching && <Button variant="outline" className="h-11" onClick={() => { void assistantList.refetch(); void assistantWorkspace.profiles.refetch(); }}>Retry</Button>}
            <Link href="/dashboard/settings/outreach" className="inline-flex min-h-11 items-center text-primary hover:underline">Manage assistants</Link>
          </div>}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-clip">
        <aside
          aria-label="Support conversation history"
          className={cn(
            "h-full min-h-0 w-full min-w-0 shrink-0 flex-col border-r border-border bg-muted/10 lg:flex lg:w-72",
            showSessionList ? "flex" : "hidden lg:flex",
          )}
        >
          <div className="flex min-h-[68px] shrink-0 items-center justify-between gap-2 px-4 py-3">
            <div>
              <h2
                ref={historyHeadingRef}
                tabIndex={-1}
                className="text-sm font-semibold text-foreground outline-none"
              >
                Conversations
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Your saved support chats
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 shrink-0 lg:hidden"
              aria-label="Back to support chat"
              onClick={() => {
                setShowSessionList(false);
                requestAnimationFrame(() =>
                  historyToggleRef.current?.focus({ preventScroll: true }),
                );
              }}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <div className="shrink-0 space-y-2 border-b border-border px-4 pb-4">
            <SearchInput
              aria-label="Search conversations"
              placeholder="Search conversations…"
              value={search}
              onValueChange={(value) => {
                setSearch(value);
                setPage(1);
              }}
              className="h-11 bg-background text-sm"
            />
            <select
              aria-label="Conversation filter"
              value={archived ? "archived" : "active"}
              onChange={(event) => {
                const nextArchived = event.target.value === "archived";
                if (nextArchived === archived) return;
                sessionListGeneration.current++;
                listRequest.current?.abort();
                sessionQuery.current = { ...sessionQuery.current, archived: nextArchived, page: 1 };
                setSessions([]);
                setSessionsError(null);
                setLoadingSessions(true);
                setArchived(nextArchived);
                setPage(1);
              }}
              className="h-11 w-full rounded-xl border border-input bg-background px-3 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="active">Active conversations</option>
              <option value="archived">Archived conversations</option>
            </select>
          </div>
          {undoSessionId && (
            <div
              role="status"
              className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs"
            >
              <span>Conversation archived</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-11"
                onClick={async () => {
                  try {
                    await api.patch(
                      `/api/support/ai/sessions/${undoSessionId}`,
                      { archived: false },
                    );
                    setUndoSessionId(null);
                    await loadSessions();
                  } catch {
                    toast({
                      title: "Could not restore conversation",
                      variant: "destructive",
                    });
                  }
                }}
              >
                Undo
              </Button>
            </div>
          )}
          <ScrollArea
            className="min-h-0 min-w-0 flex-1"
            viewportClassName="[&>div]:!block"
          >
            {sessionsError ? (
              <div className="p-4">
                <Alert variant="destructive">
                  <AlertTitle>Chats could not be loaded</AlertTitle>
                  <AlertDescription className="mt-2 space-y-3">
                    <p className="[overflow-wrap:anywhere]">{sessionsError}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-11"
                      onClick={() => void loadSessions()}
                    >
                      Try again
                    </Button>
                  </AlertDescription>
                </Alert>
              </div>
            ) : loadingSessions && !sessions.length ? (
              <div
                role="status"
                aria-label="Loading conversations"
                className="divide-y divide-border px-4"
              >
                <span className="sr-only">Loading conversations…</span>
                {Array.from({ length: 5 }, (_, index) => (
                  <div
                    key={index}
                    className="space-y-3 py-4"
                    aria-hidden="true"
                  >
                    <div className="h-4 w-4/5 rounded bg-muted" />
                    <div className="h-3 w-20 rounded bg-muted" />
                  </div>
                ))}
              </div>
            ) : sessions.length === 0 ? (
              <div className="px-4 py-8">
                <MessageSquare
                  className="mb-3 h-5 w-5 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="text-sm font-medium text-foreground">
                  {search
                    ? "No matching conversations"
                    : archived
                      ? "No archived conversations"
                      : "No conversations yet"}
                </p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {search
                    ? "Try a different phrase or clear your search."
                    : archived
                      ? "Chats you archive will appear here."
                      : "Start a chat to keep your questions and replies together."}
                </p>
                {search ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4 h-11"
                    onClick={() => {
                      setSearch("");
                      setPage(1);
                    }}
                  >
                    Clear search
                  </Button>
                ) : (
                  !archived && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-4 h-11"
                      onClick={startConversation}
                    >
                      Start a chat
                    </Button>
                  )
                )}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {sessions.map((session) => {
                  const isActive = activeSessionId === session.id;
                  const summaryPreview = supportSessionSummaryPreview(session.summary);
                  return (
                    <div
                      key={session.id}
                      className={cn(
                        "group flex min-w-0 items-start border-l-2",
                        isActive
                          ? "border-l-primary bg-primary/10"
                          : "border-l-transparent hover:bg-muted/60",
                      )}
                    >
                      <button
                        type="button"
                        id={`support-chat-${session.id}`}
                        aria-label={`Open chat ${session.title || "New Chat"}`}
                        aria-current={isActive ? "true" : undefined}
                        onClick={() => void loadSession(session.id)}
                        className="min-h-[76px] min-w-0 flex-1 px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <p
                          className={cn(
                            "line-clamp-2 text-sm leading-5",
                            isActive
                              ? "font-semibold text-foreground"
                              : "font-medium text-foreground",
                          )}
                        >
                          {session.title || "Untitled conversation"}
                        </p>
                        {summaryPreview && (
                          <p className="mt-1 line-clamp-1 text-xs leading-5 text-muted-foreground">
                            {summaryPreview}
                          </p>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <time
                            dateTime={session.updatedAt}
                            className="font-mono tabular-nums"
                          >
                            {formatTime(session.updatedAt)}
                          </time>
                          {session.metadata?.mode === "preview" && (
                            <span className="border-l border-border pl-2">
                              Preview
                            </span>
                          )}
                        </div>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="mr-1 mt-1.5 h-11 w-11 shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => void deleteSession(session.id)}
                        aria-label={`${archived ? "Restore" : "Archive"} ${session.title || "chat"}`}
                        title={
                          archived
                            ? "Restore conversation"
                            : "Archive conversation"
                        }
                      >
                        {archived ? (
                          <ArchiveRestore
                            className="h-4 w-4"
                            aria-hidden="true"
                          />
                        ) : (
                          <Archive className="h-4 w-4" aria-hidden="true" />
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
          <div className="shrink-0 [&_button]:h-11">
            <SessionPagination
              page={page}
              hasMore={hasMore}
              loading={loadingSessions}
              onPage={setPage}
            />
          </div>
        </aside>

        <div
          className={cn(
            "relative min-h-0 min-w-0 flex-1 flex-col overflow-clip bg-background lg:flex",
            showSessionList ? "hidden lg:flex" : "flex",
          )}
        >
          <div className="shrink-0 border-b border-border px-4 py-3 sm:px-6">
            <div className="mx-auto flex min-h-11 w-full min-w-0 max-w-3xl items-center gap-3">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 w-11 shrink-0 lg:hidden"
                ref={historyToggleRef}
                onClick={() => {
                  setShowSessionList(true);
                  requestAnimationFrame(() =>
                    historyHeadingRef.current?.focus({ preventScroll: true }),
                  );
                }}
                aria-label="Show support conversations"
              >
                <PanelLeft className="h-4 w-4" aria-hidden="true" />
              </Button>
              <div className="min-w-0">
                <h2
                  ref={conversationHeadingRef}
                  tabIndex={-1}
                  className="truncate text-sm font-semibold text-foreground outline-none"
                  title={conversationTitle}
                >
                  {conversationTitle}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {mode === "preview"
                    ? "Saved customer journey preview"
                    : "Internal support chat"}
                </p>
              </div>
              <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="ml-auto h-11 w-11 shrink-0" aria-label="Conversation actions" disabled={!activeSessionId || loadingMessages || !!messagesError}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => { setRenameTitle(conversationTitle); setRenameError(""); setRenameOpen(true); }} disabled={sending}><Pencil className="mr-2 h-4 w-4" />Rename conversation</DropdownMenuItem>
                <DropdownMenuItem disabled={!messages.length} onSelect={() => { void copySupportTranscript(messages, conversationTitle).then(() => toast({ title: "Transcript copied" })).catch(() => toast({ title: "Could not copy transcript", variant: "destructive" })); }}><Copy className="mr-2 h-4 w-4" />Copy transcript</DropdownMenuItem>
                <DropdownMenuItem disabled={!messages.length} onSelect={() => exportSupportTranscript(messages, conversationTitle)}><Download className="mr-2 h-4 w-4" />Download transcript</DropdownMenuItem>
              </DropdownMenuContent></DropdownMenu>
            </div>
          </div>

          <ConversationTurnStatus
            basePath={
              activeSessionId
                ? `/api/support/ai/sessions/${activeSessionId}`
                : undefined
            }
          />
          <ChatMessageViewport
            sessionKey={activeSessionId}
            messages={messages}
            busy={sending || loadingMessages}
            className="px-4 py-6 sm:px-6 [scrollbar-width:thin]"
          >
            {messagesError ? (
              <div className="mx-auto max-w-3xl">
                <Alert variant="destructive">
                  <AlertTitle>Messages could not be loaded</AlertTitle>
                  <AlertDescription className="mt-2 space-y-3">
                    <p className="[overflow-wrap:anywhere]">{messagesError}</p>
                    {activeSessionId && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-11"
                        onClick={() => void loadSession(activeSessionId)}
                      >
                        Try again
                      </Button>
                    )}
                  </AlertDescription>
                </Alert>
              </div>
            ) : loadingMessages ? (
              <div
                role="status"
                aria-label="Loading messages"
                className="mx-auto max-w-3xl space-y-8"
                aria-busy="true"
              >
                <span className="sr-only">Loading messages…</span>
                <div
                  className="ml-auto h-20 w-2/3 rounded-xl bg-muted"
                  aria-hidden="true"
                />
                <div className="space-y-3" aria-hidden="true">
                  <div className="h-3 w-28 rounded bg-muted" />
                  <div className="h-4 w-full rounded bg-muted" />
                  <div className="h-4 w-5/6 rounded bg-muted" />
                  <div className="h-4 w-3/5 rounded bg-muted" />
                </div>
              </div>
            ) : messages.length === 0 ? (
              <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col items-center py-1 text-center sm:py-2">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-primary/15 bg-primary/5 text-primary"><MessageSquare className="h-5 w-5" aria-hidden="true" /></div>
                <h3 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                  {assistantRoutingBlocked ? runtimeEnabled === true && availableAssistants.length > 0 && !assistantId ? 'Choose your assistant to begin' : 'Assistant setup required' : 'How can we help your customers?'}
                </h3>
                <p className="mt-3 max-w-[55ch] text-sm leading-6 text-muted-foreground">
                  {assistantRoutingBlocked ? runtimeEnabled === true && availableAssistants.length > 0 && !assistantId ? 'Select an assistant above to find trusted answers and prepare your next customer reply.' : 'Review assistant setup before sending a message.' : 'Find an answer, explain a policy, or turn a customer message into a thoughtful reply.'}
                </p>
                {runtimeEnabled === true && availableAssistants.length > 0 && !assistantId && <Button variant="outline" className="mt-5 gap-2 rounded-xl" onClick={() => document.getElementById('support-chat-assistant')?.focus()}>Choose an assistant <ArrowRight className="h-4 w-4" aria-hidden="true" /></Button>}
                <div className="mt-8 grid w-full gap-3 sm:grid-cols-3">
                  {[
                    {
                      label: "Draft a customer reply",
                      description: "Start with the message you received",
                      prompt:
                        "Help me draft a reply to this customer message:\n\n",
                    },
                    {
                      label: "Find a product answer",
                      description: "Look up information in your knowledge base",
                      prompt: "What products are available?",
                    },
                    {
                      label: "Explain a return policy",
                      description: "Get guidance for a customer request",
                      prompt: "How to handle returns?",
                    },
                  ].map(({ label, description, prompt }) => (
                    <button
                      key={label}
                      type="button"
                      disabled={assistantRoutingBlocked}
                      onClick={() => {
                        setInput(prompt);
                        inputRef.current?.focus({ preventScroll: true });
                      }}
                      className="group flex min-h-28 w-full min-w-0 items-start justify-between gap-3 rounded-xl border border-border bg-background p-4 text-left shadow-sm outline-none transition-colors hover:border-primary/30 hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-2">
                        <span className="block text-sm font-medium text-foreground">
                          {label}
                        </span>
                        <span className="text-xs leading-5 text-muted-foreground">
                          {description}
                        </span>
                      </span>
                      <ArrowRight
                        className="mr-1 h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground"
                        aria-hidden="true"
                      />
                    </button>
                  ))}
                </div>
                <p className="mt-5 flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />Internal workspace · Replies stay here for your review</p>
              </div>
            ) : (
              <div>
                <SupportConversationTranscript messages={messages} onFeedbackSaved={() => { void queryClient.invalidateQueries({ queryKey: ["support-ai-report"] }); void queryClient.invalidateQueries({ queryKey: ["support-ai-quality"] }); }} />
                {sending && (
                  <ConversationActivityGroup
                    agentName="Support assistant"
                    agentRole="Knowledge specialist"
                    label="Preparing your response"
                    status="running"
                    steps={[
                      {
                        id: "response",
                        label: "Processing your request",
                        status: "running",
                      },
                    ]}
                  />
                )}
              </div>
            )}
          </ChatMessageViewport>

          <div className="shrink-0 border-t border-border bg-background px-4 pb-4 pt-3 sm:px-6">
            <div className="mx-auto w-full min-w-0 max-w-3xl">
              {mode === "preview" && (
                <p className="mb-3 text-xs leading-5 text-muted-foreground">
                  This saved conversation is a customer journey preview. No
                  customer messages or booking changes are sent.
                </p>
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                accept={SUPPORT_CHAT_FILE_ACCEPT}
                onChange={(event) => {
                  if (event.target.files && event.target.files.length > 0)
                    handleFilesSelected(event.target.files);
                  event.target.value = "";
                }}
              />
              {sendError && <Callout tone="danger" size="sm" className="mb-3" actions={<Button variant="outline" className="h-11" disabled={sending || !input.trim() || uploadingAttachments || assistantRoutingBlocked} onClick={() => void sendMessage()}>Retry message</Button>}><span className="[overflow-wrap:anywhere]">{sendError}</span></Callout>}
              {uploadError && <p role="alert" className="mb-3 text-xs leading-5 text-destructive">{uploadError}</p>}
              <ConversationComposer
                value={input}
                onValueChange={setInput}
                onSend={sendMessage}
                onKeyDown={handleKeyDown}
                placeholder="Ask a question or paste a customer message…"
                shape="panel"
                controlsLayout="toolbar"
                maxHeight={160}
                className="min-w-0 [&>div]:shadow-none [&_button]:h-11 [&_button]:min-w-11 [&_textarea:focus-visible]:ring-offset-0"
                sendButtonClassName="h-11 w-11"
                busy={sending}
                disabled={sending || loadingMessages || !!messagesError || assistantRoutingBlocked}
                sendDisabled={!input.trim() || uploadingAttachments}
                maxLength={10000}
                textareaRef={inputRef}
                onAttach={() => fileInputRef.current?.click()}
                attachmentDisabled={uploadingAttachments}
                footer={
                  attachments.length > 0 || uploadingAttachments ? (
                    <div className="space-y-1 text-[11px] leading-5 text-muted-foreground">{uploadingAttachments && <div role="status"><p>{uploadPercent < 100 ? `Uploading files · ${uploadPercent}%` : "Upload complete · processing files…"}</p><progress aria-label="File upload progress" value={uploadPercent} max={100} className="w-full" /></div>}<p>Up to 5 files · 10 MB each · 20 MB total. Files are retained for 30 days.</p></div>
                  ) : undefined
                }
                attachments={
                  attachments.length > 0 || uploadingAttachments ? (
                    <>
                      <AttachmentTray
                        attachments={[
                          ...attachments.map((attachment) => ({
                            id: attachment.fileId || attachment.fileName,
                            name:
                              attachment.originalName ||
                              attachment.fileName ||
                              "Attachment",
                            size: attachment.size,
                            mimeType:
                              attachment.mimeType || attachment.contentType,
                            status: "ready" as const,
                          })),
                          ...(uploadingAttachments ? pendingUploadNames.map((name, index) => ({ id: `uploading-${index}`, name, status: "uploading" as const })) : []),
                        ]}
                        onRemove={handleRemoveAttachment}
                      />
                      <AttachmentExtractionNotices attachments={attachments} />
                    </>
                  ) : undefined
                }
                context={
                  <label className="flex min-w-0 items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      Reply format
                    </span>
                    <select
                      value={channel}
                      onChange={(event) =>
                        setChannel(event.target.value as typeof channel)
                      }
                      className="h-11 w-32 min-w-0 rounded-lg border border-input bg-background px-3 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label="Response channel"
                      disabled={sending || loadingMessages || !!messagesError}
                    >
                      <option value="web">Web chat</option>
                      <option value="whatsapp">WhatsApp</option>
                      <option value="instagram">Instagram</option>
                      <option value="facebook">Facebook</option>
                      <option value="email">Email</option>
                    </select>
                  </label>
                }
              />
              <p className="mt-2 hidden text-[11px] leading-5 text-muted-foreground sm:block">
                Enter to send · Shift + Enter for a new line
              </p>
            </div>
          </div>
        </div>
      </div>
      <Dialog open={renameOpen} onOpenChange={(next) => { if (!renaming) setRenameOpen(next); }}><DialogContent><DialogHeader><DialogTitle>Rename conversation</DialogTitle><DialogDescription>Use a name that helps your team find this chat later.</DialogDescription></DialogHeader><Input aria-label="Conversation name" value={renameTitle} maxLength={255} disabled={renaming} onChange={(event) => setRenameTitle(event.target.value)} />{renameError && <p role="alert" className="text-sm text-destructive">{renameError}</p>}<DialogFooter><Button variant="outline" disabled={renaming} onClick={() => setRenameOpen(false)}>Cancel</Button><Button disabled={renaming || !renameTitle.trim()} onClick={async () => {
        const id = activeSessionId; const generation = viewGeneration.current;
        if (!id) return;
        setRenaming(true); setRenameError("");
        try { await api.patch(`/api/support/ai/sessions/${id}`, { title: renameTitle.trim() }, requestOptions); if (alive.current && generation === viewGeneration.current) { setActiveSessionTitle(renameTitle.trim()); setSessions(prev => prev.map(session => session.id === id ? { ...session, title: renameTitle.trim() } : session)); setRenameOpen(false); toast({ title: "Conversation renamed" }); } }
        catch (error) { if (alive.current) setRenameError(error instanceof Error ? error.message : "Conversation could not be renamed. Try again."); }
        finally { if (alive.current) setRenaming(false); }
      }}>{renaming ? "Saving…" : "Save name"}</Button></DialogFooter></DialogContent></Dialog>
    </SupportAIPageShell>
  );
}
