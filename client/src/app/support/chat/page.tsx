"use client";
import { ConversationTurnStatus } from "@/components/conversation/ConversationTurnStatus";

import { conversationAttempt, finishConversationAttempt, readConversationAttempt } from '@/lib/conversation-attempt';

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Bot, Send, Plus, Archive, ArchiveRestore, Pencil, Check, X,
  MessageSquare, ArrowLeft, Sparkles, BookOpen, LogOut,
} from "lucide-react";
import { useSupportAuth } from "@/contexts/SupportAuthContext";
import { supportApi } from "@/lib/support-api";
import { useToast } from "@/hooks/use-toast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { ResponseProvenance } from "@/components/support/ResponseProvenance";
import { SessionHistoryControls, SessionPagination } from "@/components/support/SessionHistoryControls";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LoadingState } from "@/components/ui/loading-state";
import { ChatMessageViewport } from "@/components/conversation/ChatMessageViewport";

interface ChatSession {
  id: number;
  memberId: number;
  ticketId: number | null;
  title: string;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ChatMessage {
  metadata?: { provenance?: React.ComponentProps<typeof ResponseProvenance>["provenance"] };
  id: number;
  sessionId: number;
  role: "user" | "assistant";
  content: string;
  sources: { title: string; excerpt: string; similarity: number }[];
  confidence: number | null;
  createdAt: string;
}

interface SessionWithMessages extends ChatSession {
  messages: ChatMessage[];
}

export default function SupportChatPage() {
  const router = useRouter();
  const { member, isLoading: authLoading, logout } = useSupportAuth();
  const { toast } = useToast();

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [undoSessionId, setUndoSessionId] = useState<number | null>(null);
  const viewGeneration = useRef(0);
  const listGeneration = useRef(0);
  const sessionQuery = useRef({ page, search, archived });
  useEffect(() => { sessionQuery.current = { page, search, archived }; }, [page, search, archived]);

  const inputRef = useRef<HTMLTextAreaElement>(null);

  const parseSources = (sources: unknown): { title: string; excerpt: string; similarity: number; sourceUrl?: string }[] => {
    if (Array.isArray(sources)) return sources;
    if (typeof sources === "string") {
      try { const parsed = JSON.parse(sources); if (Array.isArray(parsed)) return parsed; } catch {}
    }
    return [];
  };

  const loadSessions = useCallback(async () => {
    // A completed send can hold an older callback; always refresh today's filter.
    const { page, search, archived } = sessionQuery.current;
    const generation = ++listGeneration.current;
    setLoadingSessions(true);
    setSessionsError(null);
    try {
      const data = await supportApi.get<ChatSession[] | { data?: ChatSession[]; sessions?: ChatSession[]; total?: number; hasMore?: boolean }>(`/api/support-portal/chat/sessions?limit=25&page=${page}&search=${encodeURIComponent(search)}&archived=${archived}`);
      if (generation !== listGeneration.current) return;
      // Server returns paginated { data, total, page, limit } which bypasses auto-unwrap
      const sessions = Array.isArray(data) ? data : (data?.data ?? data?.sessions ?? []);
      setSessions(sessions);
      setHasMore(!Array.isArray(data) && (data.hasMore ?? (data.total || 0) > page * 25));
    } catch (error) {
      if (generation !== listGeneration.current) return;
      setSessionsError(error instanceof Error ? error.message : "Chat history is unavailable.");
      toast({ title: "Error", description: "Failed to load chat sessions", variant: "destructive" });
    } finally {
      if (generation === listGeneration.current) setLoadingSessions(false);
    }
  }, [toast]);

  // Load sessions on mount
  useEffect(() => {
    if (!authLoading && !member) {
      router.push("/support/login");
      return;
    }
    if (member) loadSessions();
  }, [member, authLoading, loadSessions, router, page, search, archived]);

  const loadSession = useCallback(async (id: number) => {
    const generation = ++viewGeneration.current;
    setSending(false); setInput(""); setMessages([]); setMessagesError(null);
    setLoadingMessages(true);
    setActiveSessionId(id);
    setMobileSidebarOpen(false);
    try {
      const data = await supportApi.get<SessionWithMessages>(`/api/support-portal/chat/sessions/${id}`);
      if (generation !== viewGeneration.current) return;
      setMessages(data.messages);
    } catch (error) {
      if (generation !== viewGeneration.current) return;
      setMessagesError(error instanceof Error ? error.message : "Messages are unavailable.");
      toast({ title: "Error", description: "Failed to load messages", variant: "destructive" });
    } finally {
      if (generation === viewGeneration.current) setLoadingMessages(false);
    }
  }, [toast]);

  const createNewSession = useCallback(async () => {
    const generation = ++viewGeneration.current;
    setSending(false); setLoadingMessages(false); setMessagesError(null); setInput("");
    try {
      const initial = conversationAttempt("member:create", "New Chat");
      const session = await supportApi.post<ChatSession>("/api/support-portal/chat/sessions", { title: "New Chat", clientSessionKey: initial.clientSessionKey });
      finishConversationAttempt("member:create", initial.requestId);
      setSessions((prev) => [session, ...prev]);
      if (generation !== viewGeneration.current) return;
      setActiveSessionId(session.id);
      setMessages([]);
      setMobileSidebarOpen(false);
      inputRef.current?.focus({ preventScroll: true });
    } catch {
      toast({ title: "Error", description: "Failed to create session", variant: "destructive" });
    }
  }, [toast]);

  const deleteSession = useCallback(async (id: number) => {
    if (!archived && !window.confirm("Archive this conversation? You can restore it from Archived conversations.")) return;
    try {
      await supportApi.patch(`/api/support-portal/chat/sessions/${id}`, { archived: !archived });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSessionId === id) {
        viewGeneration.current++;
        setSending(false);
        setActiveSessionId(null);
        setMessages([]);
      }
      setUndoSessionId(archived ? null : id);
      toast({ title: archived ? "Conversation restored" : "Conversation archived" });
    } catch {
      toast({ title: "Error", description: "Failed to update conversation", variant: "destructive" });
    }
  }, [activeSessionId, toast, archived]);

  const renameSession = useCallback(async (id: number, title: string) => {
    if (!title.trim()) return;
    try {
      const updated = await supportApi.put<ChatSession>(`/api/support-portal/chat/sessions/${id}`, { title: title.trim() });
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: updated.title ?? title.trim() } : s)));
      setEditingSessionId(null);
    } catch {
      toast({ title: "Error", description: "Failed to rename session", variant: "destructive" });
    }
  }, [toast]);

  useEffect(() => {
    const saved = readConversationAttempt(`member:${activeSessionId}`);
    if (saved) setInput(current => current || saved.text);
  }, [activeSessionId]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || sending || loadingMessages) return;
    const generation = viewGeneration.current;
    // Lock before the session-creation request, which is also asynchronous.
    setSending(true);

    let sessionId = activeSessionId;

    // Auto-create session if none active
    if (!sessionId) {
      try {
        const initial = conversationAttempt('member:new', input.trim());
        const session = await supportApi.post<ChatSession>("/api/support-portal/chat/sessions", { title: "New Chat", clientSessionKey: initial.clientSessionKey });
        finishConversationAttempt("member:new", initial.requestId);
        setSessions((prev) => [session, ...prev]);
        if (generation !== viewGeneration.current) return;
        sessionId = session.id;
        setActiveSessionId(session.id);
      } catch {
        if (generation !== viewGeneration.current) return;
        toast({ title: "Error", description: "Failed to create session", variant: "destructive" });
        setSending(false);
        return;
      }
    }

    const userText = input.trim();
    const attemptScope = `member:${sessionId}`;
    const attempt = conversationAttempt(attemptScope, userText, null);
    setInput("");
    setSending(true);

    // Optimistic user message
    const tempUserMsg: ChatMessage = {
      id: Date.now(),
      sessionId: sessionId!,
      role: "user",
      content: userText,
      sources: [],
      confidence: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const result = await supportApi.post<{
        userMessage: ChatMessage;
        assistantMessage: ChatMessage;
        response: { answer: string; confidence: number; sources: Array<{ title: string; excerpt: string; similarity: number }> };
      }>(`/api/support-portal/chat/sessions/${sessionId}/messages`, { message: userText, requestId: attempt.requestId });
      finishConversationAttempt(attemptScope, attempt.requestId);
      if (generation !== viewGeneration.current) { void loadSessions(); return; }

      // Replace optimistic msg + add assistant msg
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== tempUserMsg.id),
        result.userMessage,
        result.assistantMessage,
      ]);

      // Update session title in sidebar if auto-titled
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId ? { ...s, title: !s.title || s.title === "New Chat" ? (userText.length > 60 ? userText.substring(0, 57) + "..." : userText) : s.title, updatedAt: new Date().toISOString() } : s
        )
      );
    } catch (error) {
      if (generation !== viewGeneration.current) return;
      toast({ title: "Error", description: error instanceof Error ? error.message : "Failed to send message", variant: "destructive" });
      setMessages((prev) => prev.filter((m) => m.id !== tempUserMsg.id));
      setInput((current) => current || userText);
    } finally {
      if (generation === viewGeneration.current) { setSending(false); inputRef.current?.focus({ preventScroll: true }); }
    }
  }, [input, sending, loadingMessages, activeSessionId, toast, loadSessions]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  };

  if (authLoading) {
    return (
      <LoadingState size="page" className="h-screen bg-background" label="Loading support chat…" />
    );
  }

  if (!member) return null;

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const toggleSessionSidebar = () => {
    if (window.matchMedia("(min-width: 1024px)").matches) {
      setDesktopSidebarOpen((open) => !open);
      return;
    }

    setMobileSidebarOpen((open) => !open);
  };

  return (
    <div className="relative flex h-full min-w-0 overflow-clip bg-background">
      {mobileSidebarOpen && (
        <button
          type="button"
          className="absolute inset-0 z-10 cursor-default border-0 bg-foreground/40 p-0 lg:hidden"
          onClick={() => setMobileSidebarOpen(false)}
          aria-label="Dismiss chat history"
        />
      )}

      {/* Sidebar */}
      <div
        className={`absolute inset-y-0 left-0 z-20 w-[min(20rem,85vw)] flex-shrink-0 overflow-hidden border-r bg-background shadow-2xl transition-[transform,width] duration-300 lg:relative lg:z-auto lg:max-w-none lg:bg-muted/30 lg:shadow-none ${
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"
        } ${desktopSidebarOpen ? "lg:w-80 lg:translate-x-0" : "lg:w-0 lg:-translate-x-full"}`}
      >
        <div className="flex h-full w-80 max-w-[85vw] flex-col lg:max-w-none">
          {/* Sidebar Header */}
          <div className="p-4 border-b">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted/40">
                  <Bot className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold">Support Assistant</h2>
                  <p className="text-xs text-muted-foreground">RAG-powered</p>
                </div>
              </div>
              <button
                type="button"
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
                onClick={() => setMobileSidebarOpen(false)}
                aria-label="Close chat history"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <button
              onClick={createNewSession}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Plus className="h-4 w-4" />
              New Chat
            </button>
          </div>

          <SessionHistoryControls search={search} onSearch={(value) => { setSearch(value); setPage(1); }} archived={archived} onArchived={(value) => { setArchived(value); setPage(1); }} />
          {undoSessionId && <div role="status" className="flex items-center justify-between p-3 text-xs">Conversation archived<Button size="sm" variant="ghost" onClick={async () => { try { await supportApi.patch(`/api/support-portal/chat/sessions/${undoSessionId}`, { archived: false }); setUndoSessionId(null); await loadSessions(); } catch { toast({ title: "Could not restore conversation", variant: "destructive" }); } }}>Undo</Button></div>}
          {/* Session List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {sessionsError ? <div role="alert" className="space-y-2 p-3 text-sm text-destructive"><p>{sessionsError}</p><Button variant="outline" size="sm" onClick={() => void loadSessions()}>Retry history</Button></div> : loadingSessions ? (
              <LoadingState className="py-8" label="Loading conversations…" />
            ) : sessions.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>{search ? "No matching conversations" : archived ? "No archived conversations" : "No chats yet"}</p>
                <p className="text-xs mt-1">{search ? "Try a different search" : "Start a new conversation"}</p>
              </div>
            ) : (
              sessions.map((session) => (
                <div
                  key={session.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open chat ${session.title || "Untitled"}`}
                  className={`group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                    activeSessionId === session.id
                      ? "bg-primary/10 text-primary"
                      : "hover:bg-muted"
                  }`}
                  onClick={() => loadSession(session.id)}
                  onKeyDown={(event) => {
                    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      loadSession(session.id);
                    }
                  }}
                >
                  <MessageSquare className="h-4 w-4 flex-shrink-0 opacity-60" />
                  {editingSessionId === session.id ? (
                    <div className="flex-1 flex items-center gap-1">
                      <input
                        aria-label={`Rename ${session.title || "chat"}`}
                        className="flex-1 text-sm bg-transparent border-b border-primary outline-none"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") renameSession(session.id, editTitle);
                          if (e.key === "Escape") setEditingSessionId(null);
                        }}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                      <button aria-label={`Save name for ${session.title || "chat"}`} onClick={(e) => { e.stopPropagation(); renameSession(session.id, editTitle); }}>
                        <Check className="h-3.5 w-3.5 text-success" />
                      </button>
                      <button aria-label={`Cancel renaming ${session.title || "chat"}`} onClick={(e) => { e.stopPropagation(); setEditingSessionId(null); }}>
                        <X className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="flex-1 text-sm truncate">{session.title || "Untitled"}</span>
                      <div className="flex items-center gap-0.5">
                        <button
                          aria-label={`Rename ${session.title || "chat"}`}
                          className="p-1 rounded hover:bg-muted-foreground/10"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingSessionId(session.id);
                            setEditTitle(session.title || "");
                          }}
                        >
                          <Pencil className="h-3 w-3 text-muted-foreground" />
                        </button>
                        <button
                          aria-label={`${archived ? "Restore" : "Archive"} ${session.title || "chat"}`}
                          className="p-1 rounded hover:bg-destructive/10"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteSession(session.id);
                          }}
                        >
                          {archived ? <ArchiveRestore className="h-3 w-3 text-muted-foreground" /> : <Archive className="h-3 w-3 text-muted-foreground" />}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
          <SessionPagination page={page} hasMore={hasMore} loading={loadingSessions} onPage={setPage} />
          {/* Sidebar Footer */}
          <div className="p-3 border-t">
            <div className="flex items-center justify-between">
              <button
                onClick={() => router.push("/support/tickets")}
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Tickets
              </button>
              <button
                onClick={logout}
                aria-label="Log out"
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-destructive transition-colors"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip">
        {/* Chat Header */}
        <div className="flex min-w-0 items-center justify-between gap-2 border-b bg-background/80 px-3 py-2 backdrop-blur-sm sm:px-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={toggleSessionSidebar}
              className="shrink-0 rounded-lg p-1.5 transition-colors hover:bg-muted"
              aria-label="Toggle chat history"
            >
              <MessageSquare className="h-5 w-5 text-muted-foreground" />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">
                {activeSession ? activeSession.title : "Support Assistant"}
              </h1>
              <p className="hidden truncate text-xs text-muted-foreground sm:block">
                Ask questions about your knowledge base
              </p>
            </div>
          </div>
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            <div className="flex items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-2.5 py-1">
              <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
              <span className="text-xs font-medium text-success">Online</span>
            </div>
          </div>
        </div>

        {/* Messages */}
        <ConversationTurnStatus basePath={activeSessionId ? `/api/support-portal/chat/sessions/${activeSessionId}` : undefined} member />
        <ChatMessageViewport sessionKey={activeSessionId} messages={messages} busy={sending || loadingMessages} className="px-4 py-2 lg:px-4 lg:py-2 [&>div]:space-y-4">
          {messagesError ? <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm"><p>{messagesError}</p><Button variant="outline" size="sm" className="mt-2" onClick={() => activeSessionId && void loadSession(activeSessionId)}>Retry messages</Button></div> : !activeSessionId && messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-md border border-border bg-muted/40">
                <Sparkles className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-base font-semibold mb-2">Support Assistant</h2>
              <p className="text-muted-foreground max-w-md mb-6">
                I can help you answer customer questions using the knowledge base. Ask me anything about products, policies, or common issues.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg">
                {[
                  { icon: BookOpen, text: "What are the common FAQs?" },
                  { icon: MessageSquare, text: "Help me draft a reply" },
                  { icon: Sparkles, text: "Summarize our return policy" },
                  { icon: Bot, text: "How to handle escalations?" },
                ].map((suggestion, i) => (
                  <button
                    key={i}
                    className="flex items-center gap-2 px-4 py-3 border rounded-xl text-sm text-left hover:bg-muted transition-colors"
                    onClick={() => {
                      setInput(suggestion.text);
                      inputRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    <suggestion.icon className="h-4 w-4 text-primary flex-shrink-0" />
                    <span>{suggestion.text}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : loadingMessages ? (
            <LoadingState label="Loading messages…" />
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`min-w-0 max-w-[92%] break-words sm:max-w-[80%] ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground rounded-2xl rounded-br-md px-4 py-3"
                      : "bg-muted rounded-2xl rounded-bl-md px-4 py-3"
                  }`}
                >
                  {msg.role === "assistant" && (
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Bot className="h-3.5 w-3.5 text-primary" />
                      <span className="text-xs font-medium text-primary">Assistant</span>
                      {parseSources(msg.sources).length > 0 && msg.confidence !== null && Number.isFinite(msg.confidence) && msg.confidence > 0 && msg.confidence <= 1 && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                          msg.confidence >= 0.7
                            ? "bg-success/10 text-success"
                            : msg.confidence >= 0.4
                            ? "bg-warning/10 text-warning"
                            : "bg-destructive/10 text-destructive"
                        }`}>
                          {Math.round(msg.confidence * 100)}% confident
                        </span>
                      )}
                    </div>
                  )}
                  {msg.role === "assistant" ? (
                    <div className="prose prose-sm dark:prose-invert max-w-none text-sm prose-p:my-2 prose-headings:my-2 prose-ul:my-2 prose-ol:my-2">
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <div className="text-sm whitespace-pre-wrap">{msg.content}</div>
                  )}
                  {msg.role === "assistant" && (() => {
                    const sources = parseSources(msg.sources);
                    return sources.length > 0 ? (
                      <div className="mt-2 pt-2 border-t border-border/50">
                        <p className="text-xs text-muted-foreground font-medium mb-1">Sources:</p>
                        {sources.map((src, i) => (
                          <div key={i} className="text-xs text-muted-foreground flex items-start gap-1 mb-0.5">
                            <BookOpen className="h-3 w-3 mt-0.5 flex-shrink-0" />
                            {src.sourceUrl && /^https?:\/\//i.test(src.sourceUrl) ? <a className="font-medium text-primary underline underline-offset-2" href={src.sourceUrl} target="_blank" rel="noreferrer">{src.title}</a> : <span className="font-medium">{src.title}</span>}
                            {src.similarity > 0 && (
                              <span className="opacity-60">({Math.round(src.similarity * 100)}%)</span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : null;
                  })()}
                  {msg.role === "assistant" && <ResponseProvenance provenance={msg.metadata?.provenance} />}
                  <div className="text-xs mt-1 opacity-60">
                    {new Date(msg.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}
                  </div>
                </div>
              </div>
            ))
          )}

          {sending && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-2xl rounded-bl-md px-4 py-3">
                <div className="flex items-center gap-1.5 mb-1">
                  <Bot className="h-3.5 w-3.5 text-primary" />
                  <span className="text-xs font-medium text-primary">Assistant</span>
                </div>
                <div className="flex items-center gap-1">
                  <div className="h-2 w-2 animate-bounce rounded-full bg-primary [animation-delay:0ms]" />
                  <div className="h-2 w-2 animate-bounce rounded-full bg-primary [animation-delay:150ms]" />
                  <div className="h-2 w-2 animate-bounce rounded-full bg-primary [animation-delay:300ms]" />
                </div>
              </div>
            </div>
          )}
        </ChatMessageViewport>

        {/* Input Area */}
        <div className="shrink-0 border-t px-4 py-3 bg-background">
          <div className="flex items-end gap-2">
            <div className="flex-1 relative">
              <textarea
                aria-label="Message"
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask the support assistant..."
                rows={1}
                className="w-full resize-none rounded-xl border bg-muted/50 px-4 py-3 pr-12 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all min-h-[44px] max-h-[120px]"
                style={{ height: "auto", overflowY: "auto" }}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = Math.min(el.scrollHeight, 120) + "px";
                }}
                disabled={sending || loadingMessages}
              />
            </div>
            <button
              onClick={sendMessage}
              aria-label="Send message"
              disabled={!input.trim() || sending || loadingMessages}
              className="flex items-center justify-center h-[44px] w-[44px] rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {sending ? <Spinner size="sm" label={null} /> : <Send className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-center text-xs text-muted-foreground mt-2">
            Responses are generated from the knowledge base. Always verify critical information.
          </p>
        </div>
      </div>
    </div>
  );
}
