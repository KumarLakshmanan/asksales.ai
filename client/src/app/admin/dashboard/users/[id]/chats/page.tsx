"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface ChatThread {
  id: number;
  threadId?: string;
  title?: string;
  lastMessage?: string;
  last_message?: string;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  messageCount?: number;
}

export default function UserChatsPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchChats = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<ChatThread[] | { threads?: ChatThread[]; chats?: ChatThread[]; data?: ChatThread[] }>(`/api/admin/users/${id}/chats`);
      setThreads(
        Array.isArray(data) ? data : data.threads || data.chats || data.data || []
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load chats";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    fetchChats();
  }, [fetchChats]);

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const filteredThreads = threads.filter((t) => {
    const q = searchQuery.toLowerCase();
    return (
      (t.title || "").toLowerCase().includes(q) ||
      (t.lastMessage || t.last_message || "").toLowerCase().includes(q)
    );
  });

  if (loading) {
    return <LoadingState size="page" label="Loading chats…" />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-start gap-2 sm:gap-4">
        <Button asChild variant="ghost" size="icon" className="shrink-0">
          <Link href={`/admin/dashboard/users/${id}/view`} aria-label="Back to user details">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="text-xl font-black tracking-tighter sm:text-2xl">User Chats</h1>
          <p className="text-muted-foreground mt-1">
            Chat threads for this user
          </p>
        </div>
      </div>

      <SearchInput
        aria-label="Search chats"
        placeholder="Search chats..."
        value={searchQuery}
        onValueChange={setSearchQuery}
        wrapperClassName="sm:max-w-md"
      />

      {loadError ? (
        <Alert variant="destructive">
          <MessageSquare className="h-4 w-4" />
          <AlertTitle>Chat history could not be loaded</AlertTitle>
          <AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void fetchChats()}>Try again</Button>
          </AlertDescription>
        </Alert>
      ) : filteredThreads.length === 0 ? (
        <div className="text-center py-12">
          <MessageSquare className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground">No chat threads found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredThreads.map((thread) => {
            const threadId = thread.threadId || thread.id;
            return (
              <Link
                key={thread.id}
                href={`/admin/dashboard/users/${id}/chat/${threadId}`}
              >
                <Card className="hover:border-purple-300 hover:shadow-md transition-all cursor-pointer">
                  <CardHeader className="pb-2">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <CardTitle className="flex min-w-0 items-center gap-2 text-base">
                        <MessageSquare className="h-4 w-4 text-purple-500" />
                        {thread.title || `Chat #${thread.id}`}
                      </CardTitle>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(
                          thread.updatedAt ||
                            thread.updated_at ||
                            thread.createdAt ||
                            thread.created_at
                        )}
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {thread.lastMessage || thread.last_message || "No messages yet"}
                    </p>
                    {thread.messageCount != null && (
                      <p className="text-xs text-muted-foreground mt-2">
                        {thread.messageCount} message{thread.messageCount !== 1 ? "s" : ""}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      <div className="text-sm text-muted-foreground">
        Showing {filteredThreads.length} of {threads.length} threads
      </div>
    </div>
  );
}
