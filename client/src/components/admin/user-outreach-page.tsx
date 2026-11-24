"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  Clock3,
  Instagram,
  Mail,
  MessageCircle,
  Phone,
  UserRound,
} from "lucide-react";

import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";

type OutreachChannel = "email" | "instagram" | "sms" | "whatsapp";

interface OutreachConversation {
  id: number;
  channel: string;
  leadName: string | null;
  leadEmail: string | null;
  leadInstagram?: string | null;
  leadAvatar: string | null;
  leadCompany: string | null;
  status: string;
  subject?: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  totalMessages: number | null;
  unreadCount: number | null;
}

interface OutreachMessage {
  id: number;
  direction: "inbound" | "outbound" | string;
  subject: string | null;
  content: string;
  status: string;
  sentAt: string | null;
  createdAt: string;
}

const CHANNELS = {
  email: { title: "Email outreach", noun: "email", icon: Mail },
  instagram: { title: "Instagram outreach", noun: "Instagram DM", icon: Instagram },
  sms: { title: "SMS outreach", noun: "SMS", icon: Phone },
  whatsapp: { title: "WhatsApp outreach", noun: "WhatsApp", icon: MessageCircle },
} as const;

function initials(value: string | null) {
  if (!value) return "?";
  return value
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "No activity yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

const CONVERSATION_STATUS_TONES: Record<string, StatusTone> = {
  unsubscribed: "danger",
  replied: "success",
  read: "success",
};

export function UserOutreachPage({ channel }: { channel: OutreachChannel }) {
  const params = useParams<{ id: string }>();
  const userId = params.id;
  const config = CHANNELS[channel];
  const ChannelIcon = config.icon;
  const { toast } = useToast();
  const messageEndRef = useRef<HTMLDivElement>(null);

  const [conversations, setConversations] = useState<OutreachConversation[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<OutreachMessage[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const loadConversations = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<{ conversations?: OutreachConversation[] }>(
        `/api/admin/users/${userId}/outreach/${channel}`,
      );
      const next = response.conversations ?? [];
      setConversations(next);
      setSelectedId((current) =>
        current && next.some((conversation) => conversation.id === current)
          ? current
          : next[0]?.id ?? null,
      );
    } catch (error) {
      toast({
        title: `Unable to load ${config.noun} outreach`,
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [channel, config.noun, toast, userId]);

  const loadMessages = useCallback(async (conversationId: number) => {
    setLoadingMessages(true);
    setMessages([]);
    try {
      const response = await api.get<{ messages?: OutreachMessage[] }>(
        `/api/admin/outreach-conversations/${conversationId}/messages`,
      );
      setMessages(response.messages ?? []);
    } catch (error) {
      toast({
        title: "Unable to load conversation",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoadingMessages(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (selectedId) void loadMessages(selectedId);
    else setMessages([]);
  }, [loadMessages, selectedId]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return conversations;
    return conversations.filter((conversation) =>
      [
        conversation.leadName,
        conversation.leadEmail,
        conversation.leadCompany,
        conversation.lastMessagePreview,
      ].some((value) => value?.toLowerCase().includes(normalized)),
    );
  }, [conversations, query]);

  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? null;
  const unreadTotal = conversations.reduce((total, conversation) => total + (conversation.unreadCount ?? 0), 0);

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header className="flex items-start gap-3">
        <Button asChild variant="ghost" size="icon" className="shrink-0" aria-label="Back to user details">
          <Link href={`/admin/dashboard/users/${userId}/view`}>
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{config.title}</h1>
            <Badge variant="secondary">{conversations.length} conversations</Badge>
            {unreadTotal > 0 && <Badge>{unreadTotal} unread</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Review this user&apos;s real {config.noun} conversations and delivery history.
          </p>
        </div>
      </header>

      <Card className="min-h-[34rem] overflow-hidden">
        <div className="grid min-h-[34rem] lg:grid-cols-[22rem_minmax(0,1fr)]">
          <section className="flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r" aria-label="Conversations">
            <div className="space-y-3 border-b border-border p-4">
              <div className="flex items-center gap-2">
                <span className="rounded-lg bg-primary/10 p-2 text-primary">
                  <ChannelIcon className="h-4 w-4" />
                </span>
                <span className="font-semibold">Conversations</span>
              </div>
              <SearchInput
                value={query}
                onValueChange={setQuery}
                placeholder="Search lead or company"
                aria-label="Search conversations"
              />
            </div>

            <ScrollArea className="h-80 lg:h-[calc(100vh-20rem)] lg:min-h-[27rem]">
              {loading ? (
                <div className="space-y-3 p-4" aria-label="Loading conversations">
                  {[0, 1, 2].map((item) => <Skeleton key={item} className="h-20 w-full" />)}
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex min-h-64 flex-col items-center justify-center p-8 text-center">
                  <ChannelIcon className="mb-3 h-10 w-10 text-muted-foreground/50" />
                  <p className="font-medium">No conversations found</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {query ? "Try a different search." : `No ${config.noun} outreach has been recorded for this user.`}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {filtered.map((conversation) => (
                    <button
                      key={conversation.id}
                      type="button"
                      onClick={() => setSelectedId(conversation.id)}
                      className={`w-full p-4 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                        conversation.id === selectedId ? "bg-primary/10" : ""
                      }`}
                      aria-pressed={conversation.id === selectedId}
                    >
                      <div className="flex gap-3">
                        <Avatar className="h-10 w-10 shrink-0">
                          {conversation.leadAvatar && <AvatarImage src={conversation.leadAvatar} alt="" />}
                          <AvatarFallback>{initials(conversation.leadName)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-sm font-semibold">{conversation.leadName || "Unknown lead"}</p>
                            {(conversation.unreadCount ?? 0) > 0 && (
                              <span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
                                {conversation.unreadCount}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 truncate text-sm text-muted-foreground">
                            {conversation.lastMessagePreview || conversation.subject || "No message preview"}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">{formatDate(conversation.lastMessageAt)}</p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </section>

          <section className="flex min-h-[28rem] min-w-0 flex-col bg-muted/20" aria-label="Conversation messages">
            {!selected ? (
              <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
                <MessageCircle className="mb-3 h-10 w-10 text-muted-foreground/50" />
                <p className="font-medium">Select a conversation</p>
                <p className="mt-1 text-sm text-muted-foreground">Message history will appear here.</p>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-start gap-3 border-b border-border bg-card p-4">
                  <Avatar className="h-10 w-10">
                    {selected.leadAvatar && <AvatarImage src={selected.leadAvatar} alt="" />}
                    <AvatarFallback>{initials(selected.leadName)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{selected.leadName || "Unknown lead"}</p>
                      <StatusBadge status={selected.status} toneOverrides={CONVERSATION_STATUS_TONES} />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {selected.leadEmail && <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{selected.leadEmail}</span>}
                      {selected.leadCompany && <span className="flex items-center gap-1"><Building2 className="h-3 w-3" />{selected.leadCompany}</span>}
                      <span>{selected.totalMessages ?? messages.length} messages</span>
                    </div>
                  </div>
                </div>

                <ScrollArea className="h-[32rem] flex-1 lg:h-[calc(100vh-20rem)] lg:min-h-[27rem]">
                  {loadingMessages ? (
                    <div className="space-y-4 p-5" aria-label="Loading messages">
                      <Skeleton className="h-20 w-4/5" />
                      <Skeleton className="ml-auto h-20 w-4/5" />
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="flex min-h-64 flex-col items-center justify-center p-8 text-center">
                      <Clock3 className="mb-3 h-9 w-9 text-muted-foreground/50" />
                      <p className="font-medium">No message history</p>
                      <p className="mt-1 text-sm text-muted-foreground">This conversation has no stored messages.</p>
                    </div>
                  ) : (
                    <div className="space-y-4 p-4 sm:p-5">
                      {messages.map((message) => {
                        const inbound = message.direction === "inbound";
                        return (
                          <article key={message.id} className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
                            <div className={`max-w-[90%] rounded-2xl px-4 py-3 sm:max-w-[75%] ${
                              inbound ? "rounded-bl-sm border border-border bg-card" : "rounded-br-sm bg-primary text-primary-foreground"
                            }`}>
                              <div className="mb-2 flex items-center gap-2 text-xs opacity-75">
                                {inbound ? <UserRound className="h-3.5 w-3.5" /> : <ChannelIcon className="h-3.5 w-3.5" />}
                                <span>{inbound ? "Lead" : "User"}</span>
                                <span className="ml-auto flex items-center gap-1 capitalize">
                                  <CheckCircle2 className="h-3.5 w-3.5" />{message.status}
                                </span>
                              </div>
                              {message.subject && <p className="mb-1 text-sm font-semibold">{message.subject}</p>}
                              <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
                              <p className="mt-2 text-right text-[11px] opacity-70">{formatDate(message.sentAt || message.createdAt)}</p>
                            </div>
                          </article>
                        );
                      })}
                      <div ref={messageEndRef} />
                    </div>
                  )}
                </ScrollArea>
              </>
            )}
          </section>
        </div>
      </Card>
    </div>
  );
}
