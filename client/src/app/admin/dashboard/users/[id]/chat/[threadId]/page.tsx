"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import { ArrowLeft, Bot, User } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { formatShortTime as formatTime } from "@/lib/display-format";

interface ChatMessage {
  id: number;
  role: string;
  content: string;
  agentRole?: string;
  agent_role?: string;
  createdAt?: string;
  created_at?: string;
  timestamp?: string;
}

export default function ChatThreadViewPage() {
  const params = useParams();
  const userId = params.id as string;
  const threadId = params.threadId as string;
  const { toast } = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const fetchMessages = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<ChatMessage[] | { messages?: ChatMessage[]; data?: ChatMessage[] }>(`/api/admin/users/${userId}/chats/${threadId}/messages`);
      setMessages(
        Array.isArray(data)
          ? data
          : data.messages || data.data || []
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load messages";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [userId, threadId, toast]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const formatDateSeparator = (dateStr?: string) => {
    if (!dateStr) return "";
    return new Date(dateStr).toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  const getDateKey = (dateStr?: string) => {
    if (!dateStr) return "";
    return new Date(dateStr).toDateString();
  };

  if (loading) {
    return <LoadingState size="page" label="Loading messages…" />;
  }

  let lastDateKey = "";

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-4">
        <Link href={`/admin/dashboard/users/${userId}/chats`}>
          <Button variant="ghost" size="icon" aria-label="Back to chat threads">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-black tracking-tighter">Chat Thread</h1>
          <p className="text-muted-foreground mt-1">Thread #{threadId}</p>
        </div>
      </div>

      {loadError ? (
        <Alert variant="destructive">
          <Bot className="h-4 w-4" />
          <AlertTitle>Messages could not be loaded</AlertTitle>
          <AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void fetchMessages()}>Try again</Button>
          </AlertDescription>
        </Alert>
      ) : <Card>
        <CardContent className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {messages.length === 0 ? (
            <p className="text-center text-muted-foreground py-12">
              No messages in this thread
            </p>
          ) : (
            messages.map((msg) => {
              const dateStr =
                msg.createdAt || msg.created_at || msg.timestamp;
              const currentDateKey = getDateKey(dateStr);
              const showSeparator = currentDateKey !== lastDateKey;
              lastDateKey = currentDateKey;

              const isUser = msg.role === "user";
              const agentRole = msg.agentRole || msg.agent_role;

              return (
                <React.Fragment key={msg.id}>
                  {showSeparator && dateStr && (
                    <div className="flex items-center gap-3 py-2">
                      <div className="flex-1 h-px bg-border" />
                      <span className="text-xs text-muted-foreground font-medium">
                        {formatDateSeparator(dateStr)}
                      </span>
                      <div className="flex-1 h-px bg-border" />
                    </div>
                  )}

                  <div
                    className={`flex ${
                      isUser ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div
                      className={`max-w-[75%] rounded-lg px-4 py-3 ${
                        isUser
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        {isUser ? (
                          <User className="h-3.5 w-3.5" />
                        ) : (
                          <Bot className="h-3.5 w-3.5" />
                        )}
                        <span className="text-xs font-medium">
                          {isUser ? "User" : "AI"}
                        </span>
                        {agentRole && (
                          <Badge
                            variant="outline"
                            className={`text-[10px] px-1.5 py-0 ${
                              isUser
                                ? "border-white/30 text-white/80"
                                : "border-primary/30 text-primary"
                            }`}
                          >
                            {agentRole}
                          </Badge>
                        )}
                        <span
                          className={`text-[10px] ml-auto ${
                            isUser
                              ? "text-white/60"
                              : "text-muted-foreground"
                          }`}
                        >
                          {formatTime(dateStr)}
                        </span>
                      </div>
                      <p className="text-sm whitespace-pre-wrap">
                        {msg.content}
                      </p>
                    </div>
                  </div>
                </React.Fragment>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </CardContent>
      </Card>}
    </div>
  );
}
