"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Brain,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Zap,
  FileText,
  Clock,
  Hash,
} from "lucide-react";
import api from "@/lib/api";
import { useWebSocket } from "@/contexts/WebSocketContext";
import { useToast } from "@/hooks/use-toast";

// ─── Client-side cache for context window data ─────────────────────────────────

interface CachedContextData {
  data: ContextWindowData;
  timestamp: number;
}

const CACHE_TTL_MS = 5000; // 5 seconds stale-while-revalidate

interface ContextBreakdown {
  systemInstructions: number;
  toolDefinitions: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  summary: number;
  hasActualUsage: boolean;
}

interface ContextWindowData {
  threadId: number;
  messageCount: number;
  tokenUsage: {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    estimatedCurrentContextTokens: number;
    maxContextTokens: number;
    modelName: string;
    usagePercent: number;
  };
  contextBreakdown?: ContextBreakdown;
  summary: {
    id: number;
    text: string;
    keyEntities: string[];
    timeline: string[];
    version: number;
    messageCount: number;
    createdAt: string;
  } | null;
  lastCompactedAt: string | null;
  canCompact: boolean;
}

interface ChatContextWindowProps {
  threadId: number | null;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

export function ChatContextWindow({ threadId }: ChatContextWindowProps) {
  return <ThreadContextWindow key={threadId ?? 'none'} threadId={threadId} />;
}

function ThreadContextWindow({ threadId }: ChatContextWindowProps) {
  // Keep cached conversation summaries within this mounted conversation only.
  const cachedContext = useRef<CachedContextData | null>(null);
  const requestVersion = useRef(0);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ContextWindowData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [showSummary, setShowSummary] = useState(true);
  const [showEntities, setShowEntities] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const { subscribe } = useWebSocket();
  const { toast } = useToast();

  const fetchData = useCallback(async (forceRefresh = false) => {
    if (!threadId) return;

    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = cachedContext.current;
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        setData(cached.data);
        return;
      }
    }

    const request = ++requestVersion.current;
    setLoading(true);
    setLoadError(false);
    try {
      const result = await api.get<ContextWindowData>(`/api/chat/threads/${threadId}/context-window`);
      if (request !== requestVersion.current) return;
      if (result.threadId !== threadId) throw new Error('Context response belongs to a different conversation');
      setData(result);
      cachedContext.current = { data: result, timestamp: Date.now() };
    } catch (err) {
      console.error("Failed to fetch context window data:", err);
      if (request === requestVersion.current) setLoadError(true);
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, [threadId]);

  // Fetch once on mount / when threadId changes
  useEffect(() => {
    if (threadId) {
      fetchData();
    } else {
      setData(null);
      setLoadError(false);
    }
    return () => { requestVersion.current += 1; };
  }, [threadId, fetchData]);

  // Re-fetch when popover opens
  useEffect(() => {
    if (open && threadId) {
      fetchData();
    }
  }, [open, threadId, fetchData]);

  // Listen for real-time context_update events via WebSocket
  useEffect(() => {
    const unsubscribe = subscribe('context_update', (event: Record<string, unknown>) => {
      const eventThreadId = event.thread_id as number;
      if (eventThreadId && threadId && eventThreadId === threadId) {
        const wsData: ContextWindowData = {
          threadId: eventThreadId,
          messageCount: event.messageCount as number,
          tokenUsage: event.tokenUsage as ContextWindowData['tokenUsage'],
          contextBreakdown: event.contextBreakdown as ContextBreakdown | undefined,
          summary: event.summary as ContextWindowData['summary'],
          lastCompactedAt: event.lastCompactedAt as string | null,
          canCompact: event.canCompact as boolean,
        };
        // This event supersedes any HTTP snapshot requested before it arrived.
        requestVersion.current += 1;
        setLoading(false);
        setLoadError(false);
        cachedContext.current = { data: wsData, timestamp: Date.now() };
        setData(wsData);
      }
    });
    return () => unsubscribe();
  }, [threadId, subscribe]);

  // The server owns automatic compaction. A full meter may remain full after
  // summarisation; using it as a client retry trigger creates a paid-call loop.
  // Keep only the explicit manual control here.

  const handleCompact = async () => {
    if (!threadId || compacting) return;
    setCompacting(true);
    try {
      await api.post(`/api/chat/threads/${threadId}/compact`, {});
      // Invalidate cache and force refresh
      cachedContext.current = null;
      await fetchData(true);
      toast({ title: "Conversation compacted", description: "Older messages were summarized for this conversation." });
    } catch (err) {
      console.error("Failed to compact conversation:", err);
      toast({ title: "Compaction failed", description: "The conversation history is unchanged. Try again in a moment.", variant: "destructive" });
    } finally {
      setCompacting(false);
    }
  };

  const usagePercent = data?.tokenUsage?.usagePercent ?? 0;
  // Keep the control visible while a conversation's context is loading.
  if (!threadId) {
    return null;
  }

  const usageColor =
    usagePercent >= 80 ? "text-red-500" :
    usagePercent >= 50 ? "text-orange-500" :
    "text-yellow-500";

  const progressColor =
    usagePercent >= 80 ? "[&>div]:bg-red-500" :
    usagePercent >= 50 ? "[&>div]:bg-orange-500" :
    "[&>div]:bg-yellow-500";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background px-2.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={data ? `Context usage: ${Math.round(usagePercent)}%` : loadError ? 'Context unavailable' : 'Context loading'}
          aria-expanded={open}
        >
          <Brain className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          <span>Context</span>
          {data ? <span className={`rounded-md bg-muted px-1 py-0.5 text-[10px] tabular-nums leading-none ${usageColor}`}>{Math.round(usagePercent)}%</span>
            : loading ? <Spinner size="xs" label={null} className="text-muted-foreground" />
            : <span className="text-muted-foreground">—</span>}
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[min(24rem,calc(100vw-2rem))] p-0 max-h-[80vh] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-gradient-to-r from-primary/5 to-transparent">
          <div className="flex items-center gap-2">
            <Brain className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold">Chat Memory</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => fetchData(true)}
            disabled={loading}
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        <ScrollArea className="max-h-[calc(80vh-52px)]">
          <div className="p-4 space-y-4">
            {loading && !data ? (
              <LoadingState className="py-8" label="Loading context usage…" />
            ) : data ? (
              <>
                {/* Token Usage Meter */}
                <div className="space-y-2">
                  <span className="text-xs font-medium text-muted-foreground">Memory Usage</span>
                  <div className="rounded-lg border bg-background p-3 space-y-2">
                    <div className="flex items-baseline justify-between">
                      <span className={`text-2xl font-bold tabular-nums ${usageColor}`}>
                        {formatTokenCount(data.tokenUsage.estimatedCurrentContextTokens)}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        / {formatTokenCount(data.tokenUsage.maxContextTokens)} capacity
                      </span>
                    </div>

                    <Progress value={usagePercent} className={`h-2 ${progressColor}`} />

                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span className={usageColor}>{usagePercent}% memory used</span>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {data.tokenUsage.modelName}
                      </Badge>
                    </div>
                  </div>
                </div>

                {/* Stats Row */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border bg-background p-2 text-center">
                    <div className="flex items-center justify-center gap-1 mb-1">
                      <Hash className="w-3 h-3 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">Messages</span>
                    </div>
                    <span className="text-lg font-semibold">{data.messageCount}</span>
                  </div>
                  <div className="rounded-lg border bg-background p-2 text-center">
                    <div className="flex items-center justify-center gap-1 mb-1">
                      <Zap className="w-3 h-3 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">History Size</span>
                    </div>
                    <span className="text-lg font-semibold">{formatTokenCount(data.tokenUsage.totalTokens)}</span>
                  </div>
                </div>

                <Separator />

                {/* Compaction Controls */}
                <div className="space-y-2">
                <span className="text-xs font-medium text-muted-foreground">History Compaction</span>

                  {data.summary ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="w-3 h-3" />
                        <span>
                          v{data.summary.version} · {data.summary.messageCount} messages compacted
                        </span>
                      </div>

                      {/* Summary */}
                      <button
                        className="w-full text-left"
                        onClick={() => setShowSummary(!showSummary)}
                      >
                        <div className="flex items-center justify-between text-xs font-medium">
                          <div className="flex items-center gap-1">
                            <FileText className="w-3 h-3" />
                            Summary
                          </div>
                          {showSummary ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        </div>
                      </button>
                      {showSummary && (
                        <div className="rounded-lg border bg-background p-2.5 text-xs text-muted-foreground leading-relaxed max-h-40 overflow-y-auto">
                          {data.summary.text}
                        </div>
                      )}

                      {/* Key Entities */}
                      {data.summary.keyEntities && data.summary.keyEntities.length > 0 && (
                        <>
                          <button
                            className="w-full text-left"
                            onClick={() => setShowEntities(!showEntities)}
                          >
                            <div className="flex items-center justify-between text-xs font-medium">
                              <span>Key Entities ({data.summary.keyEntities.length})</span>
                              {showEntities ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            </div>
                          </button>
                          {showEntities && (
                            <div className="flex flex-wrap gap-1">
                              {data.summary.keyEntities.map((entity, i) => (
                                <Badge key={i} variant="secondary" className="text-[10px] px-1.5 py-0">
                                  {entity}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </>
                      )}

                      {/* Timeline */}
                      {data.summary.timeline && data.summary.timeline.length > 0 && (
                        <>
                          <button
                            className="w-full text-left"
                            onClick={() => setShowTimeline(!showTimeline)}
                          >
                            <div className="flex items-center justify-between text-xs font-medium">
                              <span>Timeline ({data.summary.timeline.length})</span>
                              {showTimeline ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            </div>
                          </button>
                          {showTimeline && (
                            <div className="space-y-1.5 pl-2 border-l-2 border-primary/20">
                              {data.summary.timeline.map((item, i) => (
                                <p key={i} className="text-[11px] text-muted-foreground leading-tight">
                                  {item}
                                </p>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No compaction yet. Compact to save context space.
                    </p>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-xs"
                    onClick={handleCompact}
                    loading={compacting}
                    loadingText="Compacting..."
                    disabled={!data.canCompact}
                  >
                    <RefreshCw className="w-3 h-3 mr-1.5" />
                    {data.summary ? "Re-compact Conversation" : "Compact Conversation"}
                  </Button>

                  {!data.canCompact && (
                    <p className="text-[10px] text-muted-foreground text-center">
                      Need more messages to compact
                    </p>
                  )}
                </div>

                {/* Token Breakdown by Category */}
                <Separator />
                <div className="space-y-2">
                  <span className="text-xs font-medium text-muted-foreground">Context Breakdown</span>

                  {data.contextBreakdown ? (
                    <div className="space-y-1.5">
                      {/* System section */}
                      <div className="space-y-1">
                        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">System</span>
                        <BreakdownRow label="System instructions" tokens={data.contextBreakdown.systemInstructions} total={data.tokenUsage.estimatedCurrentContextTokens} />
                        <BreakdownRow label="Tool definitions" tokens={data.contextBreakdown.toolDefinitions} total={data.tokenUsage.estimatedCurrentContextTokens} />
                      </div>

                      {/* User / Assistant section */}
                      <div className="space-y-1 pt-1">
                        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Conversation</span>
                        <BreakdownRow label="User messages" tokens={data.contextBreakdown.userMessages} total={data.tokenUsage.estimatedCurrentContextTokens} />
                        <BreakdownRow label="Assistant messages" tokens={data.contextBreakdown.assistantMessages} total={data.tokenUsage.estimatedCurrentContextTokens} />
                        {(data.contextBreakdown.toolCalls > 0 || data.contextBreakdown.toolResults > 0) && (
                          <>
                            <BreakdownRow label="Tool calls" tokens={data.contextBreakdown.toolCalls} total={data.tokenUsage.estimatedCurrentContextTokens} />
                            <BreakdownRow label="Tool results" tokens={data.contextBreakdown.toolResults} total={data.tokenUsage.estimatedCurrentContextTokens} />
                          </>
                        )}
                        {data.contextBreakdown.summary > 0 && (
                          <BreakdownRow label="Summary (compacted)" tokens={data.contextBreakdown.summary} total={data.tokenUsage.estimatedCurrentContextTokens} />
                        )}
                      </div>

                      {!data.contextBreakdown.hasActualUsage && (
                        <p className="text-[10px] text-muted-foreground/70 italic">
                          Estimated — will refine after first AI response
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      <span className="text-muted-foreground">Input history</span>
                      <span className="text-right font-medium">{formatTokenCount(data.tokenUsage.promptTokens)}</span>
                      <span className="text-muted-foreground">Response history</span>
                      <span className="text-right font-medium">{formatTokenCount(data.tokenUsage.completionTokens)}</span>
                      <span className="text-muted-foreground">Active memory</span>
                      <span className="text-right font-medium">{formatTokenCount(data.tokenUsage.estimatedCurrentContextTokens)}</span>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="space-y-3 py-6 text-center">
                <p className="text-xs text-muted-foreground">Context could not be loaded.</p>
                <Button size="sm" variant="outline" onClick={() => fetchData(true)}>Try again</Button>
              </div>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

/** Single row in the context breakdown showing a mini bar + token count */
function BreakdownRow({ label, tokens, total }: { label: string; tokens: number; total: number }) {
  const percent = total > 0 ? Math.min(100, Math.round((tokens / total) * 100)) : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground min-w-[120px] truncate">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-muted-foreground/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-primary/60 transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-right font-medium tabular-nums min-w-[40px]">{formatTokenCount(tokens)}</span>
    </div>
  );
}
