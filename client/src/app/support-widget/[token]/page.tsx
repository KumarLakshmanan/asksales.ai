"use client";

import {
  conversationAttempt,
  finishConversationAttempt,
  readConversationAttempt,
} from "@/lib/conversation-attempt";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
import {
  AlertCircle,
  Bot,
  Send,
  BookOpen,
  ArrowDown,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";
import { startWidgetHistoryPoll, type WidgetHistoryPoll } from "@/lib/widget-history-poll";
import { requestSupportWidgetClose } from "@/lib/support-widget-embed";
import {
  DEFAULT_WIDGET_SETTINGS,
  normalizeWidgetSettings,
  widgetColorForeground,
  type SupportWidgetSettings,
} from "@/lib/support-widget-settings";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import {
  WidgetDocumentCard,
  parseWidgetDocuments,
  type WidgetDocument,
} from "./WidgetDocumentCard";
import { Spinner } from "@/components/ui/spinner";
import { fetchWithReadRetry } from "@/lib/api-client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

async function widgetFetch(
  url: string,
  options?: RequestInit,
  timeoutMs = 12000,
) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Reads retry a dropped connection or 502/503/504 within the same deadline.
    return await fetchWithReadRetry(url, { ...options, credentials: "omit", signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

// Embedded browsers can block persistent storage; the active chat still works.
const widgetStorage = {
  getItem(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Keep in-memory credentials. */
    }
  },
  removeItem(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* Storage may be blocked. */
    }
  },
};

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  sources: { title: string; excerpt: string; similarity: number }[] | null;
  confidence: number | null;
  createdAt: string;
  processingStatus?: string;
  metadata?: {
    media?: WidgetMedia[];
    choices?: WidgetChoice[];
    documents?: WidgetDocument[];
  } | null;
}

interface WidgetMedia {
  assetId: number;
  name: string;
  caption?: string;
  altText: string;
  order: number;
}
interface WidgetChoice {
  id: string;
  label: string;
  shortLabel: string;
}

function parseMedia(metadata: unknown): WidgetMedia[] {
  if (!metadata || typeof metadata !== "object") return [];
  const media = (metadata as { media?: unknown }).media;
  return Array.isArray(media)
    ? media
        .filter(
          (item): item is WidgetMedia =>
            Boolean(item) &&
            typeof item === "object" &&
            Number.isSafeInteger(Number((item as WidgetMedia).assetId)),
        )
        .slice(0, 5)
    : [];
}

function parseChoices(metadata: unknown): WidgetChoice[] {
  if (!metadata || typeof metadata !== "object") return [];
  const choices = (metadata as { choices?: unknown }).choices;
  return Array.isArray(choices)
    ? choices
        .filter(
          (item): item is WidgetChoice =>
            Boolean(item) &&
            typeof item === "object" &&
            typeof (item as WidgetChoice).id === "string" &&
            typeof (item as WidgetChoice).label === "string",
        )
        .slice(0, 20)
    : [];
}

function parseSources(
  sources: unknown,
): { title: string; excerpt: string; similarity: number }[] {
  if (Array.isArray(sources)) return sources;
  if (typeof sources === "string") {
    try {
      const parsed = JSON.parse(sources);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* ignore */
    }
  }
  return [];
}

export default function SupportWidgetPage() {
  const params = useParams();
  const token = params?.token as string;
  return <SupportWidgetConversation key={token} token={token} />;
}
function SupportWidgetConversation({ token }: { token: string }) {

  // localStorage key scoped to this widget token
  const storageKey = token ? `sw_session_${token}` : "";

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [teamName, setTeamName] = useState("Support");
  const [businessProfileName, setBusinessProfileName] = useState("Support");
  const [settings, setSettings] = useState<SupportWidgetSettings>(
    DEFAULT_WIDGET_SETTINGS,
  );
  const [connectionState, setConnectionState] = useState<
    "online" | "offline" | "expired"
  >("online");
  const [handoff, setHandoff] = useState(false);
  const [feedback, setFeedback] = useState<"helpful" | "not_helpful" | null>(
    null,
  );
  const [feedbackComment, setFeedbackComment] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackError, setFeedbackError] = useState("");
  const [showLatest, setShowLatest] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [configLoading, setConfigLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyPollRef = useRef<WidgetHistoryPoll | null>(null);

  useEffect(() => {
    window.addEventListener("keydown", requestSupportWidgetClose);
    return () => window.removeEventListener("keydown", requestSupportWidgetClose);
  }, []);

  // Load widget config + resume previous session
  useEffect(() => {
    if (!token) return;
    setConfigLoading(true);

    const loadConfig = widgetFetch(
      `${API_BASE}/api/support-widget/config?token=${encodeURIComponent(token)}`,
    )
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          setTeamName(data.data.teamName || "Support");
          setSettings(normalizeWidgetSettings(data.data));
          setBusinessProfileName(
            data.data.displayName ||
              data.data.businessProfileName ||
              data.data.teamName ||
              "Support",
          );
        } else {
          setError("Invalid widget configuration");
        }
      })
      .catch(() => setError("Failed to load widget"));

    // Try to resume previous session from localStorage
    const savedSessionId = storageKey
      ? widgetStorage.getItem(storageKey)
      : null;
    const savedSessionToken = storageKey
      ? widgetStorage.getItem(`${storageKey}_token`)
      : null;
    if (savedSessionId && savedSessionToken) {
      setResuming(true);
      const sid = parseInt(savedSessionId);
      if (!isNaN(sid)) {
        // Keep the credential during transient failures so polling can recover.
        setSessionId(sid);
        setSessionToken(savedSessionToken);
        widgetFetch(
          `${API_BASE}/api/support-widget/session/${sid}/messages?token=${encodeURIComponent(token)}&sessionToken=${encodeURIComponent(savedSessionToken)}`,
        )
          .then(async (response) => {
            const data = await response.json();
            if (data.success && Array.isArray(data.data)) {
              setMessages(data.data);
              setHandoff(data.session?.handoff === "requested");
              setFeedback(data.session?.customerFeedback?.rating || null);
            } else if ([401, 403, 404, 440].includes(response.status)) {
              setConnectionState("expired");
              setSessionId(null);
              setSessionToken(null);
              widgetStorage.removeItem(storageKey);
              widgetStorage.removeItem(`${storageKey}_token`);
            }
          })
          .catch(() => {
            // Preserve this session; the regular history poll retries shortly.
          })
          .finally(() => setResuming(false));
      } else {
        widgetStorage.removeItem(storageKey);
        widgetStorage.removeItem(`${storageKey}_token`);
        setResuming(false);
      }
    }

    loadConfig.finally(() => setConfigLoading(false));
  }, [token, storageKey]);

  useEffect(() => {
    if (atBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({
        behavior: "auto",
        block: "end",
      });
      setShowLatest(false);
    } else setShowLatest(true);
  }, [messages]);

  useEffect(() => {
    if (!sessionId || !sessionToken || !token) return;
    let active = true;
    let lastSignature = "";
    const stop = startWidgetHistoryPoll({
      // An idle chat slows to one read every 30 seconds; a pending reply,
      // a human handoff, any new message or wake() returns it to 5 seconds.
      idleInterval: 30000,
      read: async (signal) => {
        try {
          const response = await fetch(
            `${API_BASE}/api/support-widget/session/${sessionId}/messages?token=${encodeURIComponent(token)}&sessionToken=${encodeURIComponent(sessionToken)}`,
            { signal, credentials: "omit" },
          );
          const data = await response.json();
          if (!active || signal.aborted) return false;
          if ([401, 403, 404, 440].includes(response.status)) {
            setConnectionState("expired");
            setSessionId(null);
            setSessionToken(null);
            widgetStorage.removeItem(storageKey);
            widgetStorage.removeItem(`${storageKey}_token`);
            return true;
          }
          if (!response.ok || !data.success) {
            setConnectionState("offline");
            return false;
          }
          setConnectionState("online");
          setHandoff(data.session?.handoff === "requested");
          setFeedback(data.session?.customerFeedback?.rating || null);
          const serverMessages: ChatMessage[] = Array.isArray(data.data) ? data.data : [];
          const signature = serverMessages
            .map((message) => `${message.id}:${message.processingStatus || ""}:${message.content?.length || 0}`)
            .join("|");
          const changed = signature !== lastSignature;
          lastSignature = signature;
          const last = serverMessages.at(-1);
          const replyPending = last?.role === "user"
            && ["queued", "processing", "committing"].includes(last.processingStatus || "");
          const pollActive = changed || replyPending || data.session?.handoff === "requested";
          if (Array.isArray(data.data))
            setMessages((current) => {
              return current.length === data.data.length &&
                current.every(
                  (message, index) =>
                    message.id === data.data[index]?.id &&
                    message.content === data.data[index]?.content &&
                    message.processingStatus ===
                      data.data[index]?.processingStatus,
                )
                ? current
                : [
                    ...new Map(
                      [...current, ...data.data].map((message) => [
                        message.id,
                        message,
                      ]),
                    ).values(),
                  ].sort((a, b) =>
                    a.id < 0 ? 1 : b.id < 0 ? -1 : a.id - b.id,
                  );
            });
          return { success: true, active: pollActive };
        } catch {
          if (active && !signal.aborted) setConnectionState("offline");
          return false;
        }
      },
    });
    historyPollRef.current = stop;
    return () => {
      active = false;
      if (historyPollRef.current === stop) historyPollRef.current = null;
      stop();
    };
  }, [sessionId, sessionToken, storageKey, token]);

  useEffect(() => {
    const saved = readConversationAttempt(
      `widget:${token}:${sessionId || "new"}`,
    );
    if (saved) setInput((current) => current || saved.text);
  }, [token, sessionId]);

  const sendMessage = useCallback(
    async (overrideText?: string) => {
      const selectedText =
        typeof overrideText === "string" ? overrideText : input;
      if (
        !selectedText.trim() ||
        sending ||
        !token ||
        connectionState === "expired"
      )
        return;

      const userText = selectedText.trim();
      const attemptScope = `widget:${token}:${sessionId || "new"}`;
      const attempt = conversationAttempt(attemptScope, userText, null);
      setInput("");
      setSendError(null);
      setSending(true);
      atBottomRef.current = true;

      const tempUserMsg: ChatMessage = {
        id: -Date.now(),
        role: "user",
        content: userText,
        sources: null,
        metadata: null,
        confidence: null,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, tempUserMsg]);

      try {
        const res = await widgetFetch(
          `${API_BASE}/api/support-widget/chat`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token,
              message: userText,
              sessionId,
              sessionToken,
              requestId: attempt.requestId,
              clientSessionKey: attempt.clientSessionKey,
            }),
          },
          120000,
        );
        const data = await res.json();

        if ([401, 403, 404, 440].includes(res.status)) {
          setConnectionState("expired");
          setSessionId(null);
          setSessionToken(null);
          widgetStorage.removeItem(storageKey);
          widgetStorage.removeItem(`${storageKey}_token`);
        }
        if (!data.success) {
          throw new Error(data.error || "Failed to send message");
        }

        const result = data.data;
        finishConversationAttempt(attemptScope, attempt.requestId);
        setConnectionState("online");
        setSessionId(result.sessionId);
        setSessionToken(result.sessionToken);

        // Persist session to localStorage for future visits
        if (storageKey && result.sessionId) {
          widgetStorage.setItem(storageKey, String(result.sessionId));
          widgetStorage.setItem(`${storageKey}_token`, result.sessionToken);
        }

        const normalizedAssistantMessage: ChatMessage | null =
          result.assistantMessage
            ? {
                ...result.assistantMessage,
                sources:
                  result.assistantMessage.sources &&
                  parseSources(result.assistantMessage.sources).length > 0
                    ? result.assistantMessage.sources
                    : parseSources(result.response?.sources),
              }
            : null;

        setMessages((prev) =>
          [
            ...prev.filter(
              (m) =>
                m.id !== tempUserMsg.id &&
                m.id !== result.userMessage.id &&
                m.id !== normalizedAssistantMessage?.id,
            ),
            result.userMessage,
            ...(normalizedAssistantMessage ? [normalizedAssistantMessage] : []),
          ].sort((a, b) => (a.id < 0 ? 1 : b.id < 0 ? -1 : a.id - b.id)),
        );
      } catch {
        setMessages((prev) => prev.filter((m) => m.id !== tempUserMsg.id));
        setInput(userText);
        setSendError(
          "We couldn't confirm your message. Please try again.",
        );
      } finally {
        setSending(false);
        // The reply is generated asynchronously; check for it promptly even
        // if the history poll had slowed down while the chat was idle.
        historyPollRef.current?.wake();
        inputRef.current?.focus();
      }
    },
    [
      input,
      sending,
      token,
      sessionId,
      sessionToken,
      storageKey,
      connectionState,
    ],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  };

  const resetChat = () => {
    const attemptScope = `widget:${token}:${sessionId || "new"}`;
    const pending = readConversationAttempt(attemptScope);
    if (pending) finishConversationAttempt(attemptScope, pending.requestId);
    setInput("");
    setSessionId(null);
    setSessionToken(null);
    setMessages([]);
    setFeedback(null);
    setFeedbackComment("");
    setFeedbackError("");
    setHandoff(false);
    setConnectionState("online");
    setSendError(null);
    atBottomRef.current = true;
    if (storageKey) {
      widgetStorage.removeItem(storageKey);
      widgetStorage.removeItem(`${storageKey}_token`);
    }
  };
  async function rateConversation(rating: "helpful" | "not_helpful") {
    if (!sessionId || !sessionToken || feedbackBusy) return;
    setFeedbackBusy(true);
    setFeedbackError("");
    try {
      const response = await widgetFetch(
        `${API_BASE}/api/support-widget/session/${sessionId}/feedback`,
        {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token,
            sessionToken,
            rating,
            ...(feedbackComment.trim()
              ? { comment: feedbackComment.trim() }
              : {}),
          }),
        },
      );
      const data = await response.json();
      if (!response.ok || !data.success)
        throw new Error(data.error || "Could not save feedback.");
      setFeedback(rating);
    } catch (err) {
      setFeedbackError(
        err instanceof Error
          ? err.message
          : "Could not save feedback. Try again.",
      );
    } finally {
      setFeedbackBusy(false);
    }
  }
  const brandStyle = {
    backgroundColor: settings.primaryColor,
    color: widgetColorForeground(settings.primaryColor),
  };
  if (configLoading || resuming) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background">
        <Spinner size="lg" label="Loading support chat" className="text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background p-4">
        <div className="w-full max-w-sm border border-destructive/20 bg-card p-6 text-center sm:p-8">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-md bg-destructive/10 text-destructive">
            <AlertCircle className="h-6 w-6" />
          </div>
          <h1 className="mb-2 text-lg font-bold text-foreground">
            Support unavailable
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {error}
          </p>
          <button
            type="button"
            className="mt-4 min-h-11 rounded-md border px-4 text-sm"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-dvh min-h-0 flex-col bg-background text-foreground"
      style={{ fontFamily: "var(--font-sans)" }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-3 sm:gap-3 sm:px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background">
          {settings.logoUrl ? (
            <img
              src={settings.logoUrl}
              alt=""
              className="h-7 w-7 object-contain"
            />
          ) : (
            <Bot className="h-4 w-4" style={{ color: settings.primaryColor }} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">
            {businessProfileName}
          </h1>
          <p className="text-[11px] text-muted-foreground">
            {teamName} support
          </p>
        </div>
        {(sessionId || connectionState === "expired") && (
          <button
            onClick={resetChat}
            disabled={sending}
            className="min-h-11 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            New chat
          </button>
        )}
      </div>

      <>
        {connectionState !== "online" && (
          <div role="status" className="border-b bg-muted/50 px-3 py-2 text-xs">
            {connectionState === "expired"
              ? "This conversation has expired. Start a new chat to continue."
              : "Connection interrupted. Your conversation is saved; reconnecting…"}
          </div>
        )}
        {handoff && (
          <p role="status" className="border-b bg-muted/50 px-3 py-2 text-xs">
            Your conversation is with the support team. You can continue to
            leave messages here.
          </p>
        )}
        {/* Messages */}
        <div
          ref={viewportRef}
          role="log"
          aria-label="Conversation messages"
          aria-live="polite"
          aria-relevant="additions"
          className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 sm:p-4"
          onScroll={(event) => {
            const view = event.currentTarget;
            atBottomRef.current =
              view.scrollHeight - view.scrollTop - view.clientHeight < 80;
            if (atBottomRef.current) setShowLatest(false);
          }}
        >
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-md border border-border bg-muted/50">
                <Bot className="w-7 h-7 text-primary" />
              </div>
              <h3 className="text-sm font-semibold text-foreground mb-1">
                {settings.greeting}
              </h3>
              <p className="text-xs text-muted-foreground">
                Ask us anything and we&apos;ll find the best answer from our
                knowledge base. If needed, we will ask for your name, email, and
                phone in the chat.
              </p>
            </div>
          ) : (
            messages.map((msg) => {
              const sources = parseSources(msg.sources);
              const media = parseMedia(msg.metadata);
              const choices = parseChoices(msg.metadata);
              const documents = parseWidgetDocuments(msg.metadata);
              return (
                <div
                  key={msg.id}
                  className={cn(
                    "flex gap-2.5",
                    msg.role === "user" ? "justify-end" : "justify-start",
                  )}
                >
                  {msg.role === "assistant" && (
                    <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Bot className="w-4 h-4 text-primary" />
                    </div>
                  )}
                  <div
                    style={msg.role === "user" ? brandStyle : undefined}
                    className={cn(
                      "min-w-0 max-w-[88%] break-words rounded-2xl px-3.5 py-2.5 text-sm sm:max-w-[85%]",
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground",
                    )}
                  >
                    {msg.role === "assistant" ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none text-sm prose-p:my-2 prose-headings:my-2 prose-ul:my-2 prose-ol:my-2 text-foreground [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_a]:break-all">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm, remarkBreaks]}
                        >
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap leading-relaxed">
                        {msg.content}
                      </p>
                    )}

                    {msg.role === "assistant" && sources.length > 0 && (
                      <div className="mt-1.5 pt-1.5 border-t border-border/60">
                        <p className="text-xs font-medium text-muted-foreground flex items-center gap-1 mb-1">
                          <BookOpen className="w-3 h-3" /> Sources
                        </p>
                        {sources.map((src, i) => (
                          <div
                            key={i}
                            className="text-xs text-muted-foreground bg-background rounded px-2 py-1 mb-0.5"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium">
                                {src.title || `Source ${i + 1}`}
                              </span>
                              <span className="opacity-60">
                                {Math.round((src.similarity || 0) * 100)}%
                              </span>
                            </div>
                            {src.excerpt && (
                              <p className="mt-0.5 line-clamp-2">
                                {src.excerpt}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {msg.role === "assistant" &&
                      media.length > 0 &&
                      sessionId &&
                      sessionToken && (
                        <div
                          className="mt-2 grid grid-cols-2 gap-1.5"
                          role="group"
                          aria-label="Related images"
                        >
                          {media
                            .sort((a, b) => a.order - b.order)
                            .map((item, index) => (
                              <a
                                key={item.assetId}
                                href={`${API_BASE}/api/support-widget/session/${sessionId}/media/${item.assetId}?token=${encodeURIComponent(token)}&sessionToken=${encodeURIComponent(sessionToken)}`}
                                target="_blank"
                                rel="noreferrer"
                                className={cn(
                                  "overflow-hidden rounded-lg border bg-background",
                                  media.length === 1 && "col-span-2",
                                )}
                              >
                                <img
                                  src={`${API_BASE}/api/support-widget/session/${sessionId}/media/${item.assetId}?token=${encodeURIComponent(token)}&sessionToken=${encodeURIComponent(sessionToken)}`}
                                  alt={item.altText || item.name}
                                  loading="lazy"
                                  className="aspect-[4/3] w-full object-cover"
                                />
                                {(item.caption || item.name) && (
                                  <p className="px-2 py-1 text-xs text-muted-foreground">
                                    {item.caption ||
                                      item.name ||
                                      `Image ${index + 1}`}
                                  </p>
                                )}
                              </a>
                            ))}
                        </div>
                      )}
                    {msg.role === "assistant" &&
                      sessionId &&
                      sessionToken &&
                      documents.map((document) => (
                        <WidgetDocumentCard
                          key={document.id}
                          document={document}
                          apiBase={API_BASE}
                          token={token}
                          sessionId={sessionId}
                          sessionToken={sessionToken}
                          messageId={msg.id}
                        />
                      ))}
                    {msg.role === "assistant" && choices.length > 0 && (
                      <div
                        className="mt-2 flex flex-wrap gap-1.5"
                        role="group"
                        aria-label="Reply options"
                      >
                        {choices.map((choice) => (
                          <button
                            key={choice.id}
                            type="button"
                            disabled={sending}
                            onClick={() => void sendMessage(choice.label)}
                            className="rounded-lg border bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                          >
                            {choice.shortLabel || choice.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {(sending ||
            (messages.at(-1)?.role === "user" &&
              ["queued", "processing", "committing"].includes(
                messages.at(-1)?.processingStatus || "",
              ))) && (
            <div className="flex gap-2.5">
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Bot className="w-4 h-4 text-primary" />
              </div>
              <div className="bg-muted rounded-2xl px-3.5 py-2.5">
                <div className="flex items-center gap-2">
                  <Spinner size="xs" label={null} className="text-primary" />
                  <span className="text-xs text-muted-foreground">
                    Preparing a response…
                  </span>
                </div>
              </div>
            </div>
          )}
          {!sending && !handoff && messages.at(-1)?.role === "user" &&
            messages.at(-1)?.processingStatus === "completed" && (
              <p role="status" className="px-3 text-xs text-muted-foreground">
                Your message was saved, but an automated reply is not available.
              </p>
            )}
          {messages.at(-1)?.role === "user" &&
            messages.at(-1)?.processingStatus === "reconciliation_required" && (
              <p role="status" className="px-3 text-xs text-muted-foreground">
                This response needs a support review before it can be completed.
                Your message is saved.
              </p>
            )}
          {messages.at(-1)?.role === "user" &&
            messages.at(-1)?.processingStatus === "cancelled" && (
              <p role="status" className="px-3 text-xs text-muted-foreground">
                This response was stopped. You can send a new message to
                continue.
              </p>
            )}
          <div ref={messagesEndRef} />
        </div>

        {showLatest && (
          <button
            type="button"
            className="mx-auto mb-2 flex min-h-10 items-center gap-2 rounded-full border bg-card px-4 text-xs shadow-sm"
            onClick={() => {
              atBottomRef.current = true;
              messagesEndRef.current?.scrollIntoView({
                block: "end",
                behavior: "smooth",
              });
              setShowLatest(false);
            }}
          >
            <ArrowDown className="h-3 w-3" />
            Jump to latest
          </button>
        )}
        {sessionId &&
          messages.some((message) => message.role === "assistant") && (
            <div className="border-t px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">
                  Was this conversation helpful?
                </span>
                <button
                  type="button"
                  aria-label="Helpful"
                  aria-pressed={feedback === "helpful"}
                  disabled={feedbackBusy}
                  onClick={() => void rateConversation("helpful")}
                  className={cn(
                    "flex h-10 items-center gap-1 rounded-md border px-2",
                    feedback === "helpful" && "bg-muted",
                  )}
                >
                  <ThumbsUp className="h-3.5 w-3.5" />
                  Yes
                </button>
                <button
                  type="button"
                  aria-label="Not helpful"
                  aria-pressed={feedback === "not_helpful"}
                  disabled={feedbackBusy}
                  onClick={() => void rateConversation("not_helpful")}
                  className={cn(
                    "flex h-10 items-center gap-1 rounded-md border px-2",
                    feedback === "not_helpful" && "bg-muted",
                  )}
                >
                  <ThumbsDown className="h-3.5 w-3.5" />
                  No
                </button>
                {feedback && (
                  <span role="status" className="text-muted-foreground">
                    Thank you for your feedback.
                  </span>
                )}
              </div>
              {feedback === "not_helpful" && (
                <div className="mt-2 flex gap-2">
                  <input
                    aria-label="What could we improve?"
                    placeholder="What could we improve? (optional)"
                    maxLength={1000}
                    value={feedbackComment}
                    onChange={(event) => setFeedbackComment(event.target.value)}
                    className="min-w-0 flex-1 rounded-md border bg-background px-2 py-2"
                  />
                  <button
                    type="button"
                    disabled={feedbackBusy || !feedbackComment.trim()}
                    onClick={() => void rateConversation("not_helpful")}
                    className="min-h-10 rounded-md border px-2"
                  >
                    Save note
                  </button>
                </div>
              )}
              {feedbackError && (
                <p role="alert" className="mt-2 text-destructive">
                  {feedbackError}
                </p>
              )}
            </div>
          )}
        {/* Input */}
        <div className="border-t border-border p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
          {sendError && (
            <p className="mb-2 text-xs text-destructive" role="alert">
              {sendError}
            </p>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // Auto-resize textarea
                e.target.style.height = "auto";
                e.target.style.height =
                  Math.min(e.target.scrollHeight, 120) + "px";
              }}
              onKeyDown={handleKeyDown}
              aria-label="Message to support"
              maxLength={10000}
              placeholder="Type your message…"
              className="flex-1 resize-none overflow-y-auto rounded-md border border-input bg-background px-3 py-2.5 text-base sm:text-sm text-foreground focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
              rows={1}
              style={{ minHeight: "44px", maxHeight: "120px" }}
              disabled={sending || connectionState === "expired"}
              autoComplete="off"
            />
            <button
              onClick={() => void sendMessage()}
              disabled={
                !input.trim() || sending || connectionState === "expired"
              }
              style={brandStyle}
              className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Send message"
            >
              {sending ? (
                <Spinner size="sm" label={null} />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>
          <p className="text-xs text-muted-foreground text-center mt-2">
            Automated responses can be inaccurate. Verify important details.
          </p>
        </div>
      </>
    </div>
  );
}
