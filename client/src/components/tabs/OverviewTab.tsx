import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Callout } from "@/components/ui/callout";
import { StatCard } from "@/components/ui/stat-card";
import styles from "./campaign-results.module.css";
import { useWebSocket } from "@/contexts/WebSocketContext";
import api from '@/lib/api';
import {
  Activity,
  ArrowRight,
  Bot,
  Users,
  FileText,
  Target,
  Clock,
  Search,
  Send,
  BarChart3,
  ShieldCheck,
  Workflow,
  RefreshCw,
} from 'lucide-react';
import { cn } from "@/lib/utils";

interface TimelineEvent {
  id: string;
  type: string;
  title: string;
  description: string;
  status?: string;
  agentType?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface ActiveAgent {
  agentType: string;
  lastAction: string;
  lastAt: string;
  status: string;
}

interface WorkflowExecution {
  id: number;
  workflow_name: string;
  platforms: string[] | string;
  status: string;
  total_leads_expected: number;
  total_leads_generated: number;
  platforms_completed: number;
  platforms_total: number;
  is_paused: boolean;
  started_at: string;
  completed_at: string | null;
}

interface OverviewData {
  thread: {
    id: number;
    title: string;
    createdAt: string;
    updatedAt: string;
  };
  stats: {
    messageCount: number;
    leadsCount: number;
    contentAssetsCount: number;
    agentExecutionsCount: number;
    outreachCount: number;
    scrapingCount: number;
  };
  icp: {
    id: number;
    campaign_name: string;
    target_audience: string;
    industry: string;
    fit_score: number;
    status: string;
    approved: boolean;
    created_at: string;
    primary_regions: string[];
    primary_channels: string[];
  } | null;
  activeAgents: ActiveAgent[];
  workflowExecutions: WorkflowExecution[];
  timeline: TimelineEvent[];
}

interface OverviewTabProps {
  threadId?: number;
}

export default function OverviewTab({ threadId }: OverviewTabProps) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const requestVersion = useRef(0);
  const { subscribe } = useWebSocket();
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchOverview = useCallback(async () => {
    const version = ++requestVersion.current;
    if (!threadId) {
      setLoading(false);
      return;
    }
    try {
      const result = await api.get<OverviewData>(`/api/chat/threads/${threadId}/overview`);
      if (version !== requestVersion.current) return;
      if (result.thread.id !== threadId) throw new Error('Overview thread mismatch');
      setData(result);
      setLoadError(false);
    } catch (err) {
      if (version !== requestVersion.current) return;
      setLoadError(true);
      console.error('Error loading overview:', err);
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [threadId]);

  // Debounced refresh to avoid flooding the API when multiple events fire
  const debouncedRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => fetchOverview(), 1000);
  }, [fetchOverview]);

  useEffect(() => {
    setData(null);
    setLoadError(false);
    setLoading(!!threadId);
    fetchOverview();
    return () => { ++requestVersion.current; };
  }, [fetchOverview]);

  // Auto-refresh on key events (debounced)
  useEffect(() => {
    if (!threadId) return;
    const refreshCurrentThread = (event: Record<string, unknown>) => {
      const envelope = event.__envelope;
      const scope = envelope && typeof envelope === 'object'
        ? (envelope as Record<string, unknown>).threadId
        : event.threadId ?? event.thread_id;
      // Unscoped legacy events cannot establish conversation identity.
      if ((typeof scope === 'number' || typeof scope === 'string') && Number(scope) === threadId) {
        debouncedRefresh();
      }
    };
    const unsubs = [
      'icp_update', 'agent_status', 'workflow_started', 'workflow_completed',
      'workflow_step', 'workflow_error', 'content_generated', 'lead_inputs_generated',
      'tool_approval_required', 'tool_status', 'tool_execution', 'message_sent',
      'batch_progress', 'execution_summary', 'progress_step',
    ].map(event => subscribe(event, refreshCurrentThread));
    // Reload durable state: events missed while disconnected may not be replayed.
    unsubs.push(subscribe('websocket_connected', debouncedRefresh));
    return () => {
      unsubs.forEach(fn => fn?.());
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [threadId, subscribe, debouncedRefresh]);

  if (loading || (data !== null && data.thread.id !== threadId)) {
    return <OverviewSkeleton />;
  }

  if (!threadId) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-background p-8 text-muted-foreground">
        <div className="text-center space-y-2">
          <Activity className="h-10 w-10 mx-auto opacity-40" />
          <p className="text-sm">Start a conversation to see the overview</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-background p-8 text-muted-foreground">
        <div role="alert" className="space-y-3 text-center">
          <p className="text-sm">Unable to load this campaign’s overview.</p>
          <button onClick={fetchOverview} className="rounded-md border border-border px-3 py-2 text-sm text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">Retry loading overview</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.panel} h-full overflow-y-auto bg-background`}>
      <div className="min-h-full min-w-0 bg-background p-4 space-y-4">
        {loadError && (
          <Callout
            tone="danger"
            actions={<button onClick={fetchOverview} className="underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">Retry loading overview</button>}
          >
            Could not refresh this campaign. Showing the last loaded overview.
          </Callout>
        )}
        {/* Stats Cards */}
        <div className={styles.stats}>
          <StatCard icon={<Target className="text-primary" />} label="Leads" value={data.stats.leadsCount} />
          <StatCard icon={<Send className="text-primary" />} label="Outreach" value={data.stats.outreachCount} />
          <StatCard icon={<Search className="text-primary" />} label="Scraping" value={data.stats.scrapingCount} />
        </div>

        <div className={styles.overviewGrid}>
          <div className="min-w-0 space-y-4">
            {/* ICP Summary */}
            {data.icp && (
              <Card className="relative min-w-0 overflow-hidden group border border-border/40 bg-card shadow-sm rounded-xl">
                <CardHeader className="p-4 border-b border-border/40 bg-muted/10">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-xs flex items-center gap-2.5 text-muted-foreground/60">
                      <div className="w-8 h-8 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20">
                        <Target className="h-3.5 w-3.5 text-primary" />
                      </div>
                      Ideal Customer Profile
                    </CardTitle>
                    <Badge variant={data.icp.approved ? 'default' : 'secondary'} className={cn(
                      "rounded-lg px-3 py-1 text-xs border shadow-sm",
                      data.icp.approved ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : "bg-muted/40 border-border/40"
                    )}>
                      {data.icp.approved ? 'Active' : data.icp.status || 'Drafting'}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  {data.icp.campaign_name && (
                    <h3 className="text-sm font-semibold break-words">{data.icp.campaign_name}</h3>
                  )}
                  {data.icp.target_audience && (
                    <div className="relative p-4 rounded-xl bg-background/40 border border-border/40">
                      <p className="text-xs text-muted-foreground leading-relaxed font-medium opacity-80 line-clamp-3">{data.icp.target_audience}</p>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {data.icp.industry && (
                      <Badge variant="outline" className="text-xs border-border/40 h-5 px-2 rounded-md">
                        {data.icp.industry}
                      </Badge>
                    )}
                    {data.icp.fit_score > 0 && (
                      <Badge variant="outline" className="text-xs bg-primary/5 text-primary border-primary/20 h-5 px-2 rounded-md">
                        Completeness: {data.icp.fit_score}%
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="min-w-0 space-y-4">
            {/* Active Agents */}
            {data.activeAgents.length > 0 && (
              <Card className="border border-border/40 bg-card shadow-sm overflow-hidden rounded-xl">
                <CardHeader className="p-4 border-b border-border/40 bg-muted/10">
                  <CardTitle className="text-xs flex items-center gap-2.5 text-muted-foreground/60">
                    <div className="w-8 h-8 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20">
                      <Bot className="h-3.5 w-3.5 text-primary" />
                    </div>
                    Active Agents
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0 divide-y divide-border/40">
                  {data.activeAgents.map((agent) => (
                    <div key={agent.agentType} className="flex items-center justify-between p-4 hover:bg-muted/5 transition-all group">
                      <div className="flex items-center gap-4 min-w-0">
                        <div className="relative shrink-0">
                          <div className={cn(
                            "w-2.5 h-2.5 rounded-full shadow-md border border-background",
                            agent.status === 'running' || agent.status === 'completed' ? 'bg-emerald-500' :
                            agent.status === 'error' ? 'bg-rose-500' : 'bg-amber-500'
                          )} />
                          {(agent.status === 'running') && (
                            <div className="absolute inset-0 w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping opacity-40" />
                          )}
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-foreground leading-none">{formatAgentDisplay(agent.agentType)}</p>
                          <p className="text-xs text-muted-foreground/40 mt-1.5">{agent.lastAction}</p>
                        </div>
                      </div>
                      <Badge variant="outline" className="h-5 px-2 text-xs bg-muted/40 border-border/40 rounded-md">
                        {agent.status}
                      </Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Workflow Executions */}
            {data.workflowExecutions.length > 0 && (
              <Card className="border border-border/40 bg-card shadow-sm overflow-hidden rounded-xl">
                <CardHeader className="p-4 border-b border-border/40 bg-muted/10">
                  <CardTitle className="text-xs flex items-center gap-2.5 text-muted-foreground/60">
                    <div className="w-8 h-8 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20">
                      <Workflow className="h-3.5 w-3.5 text-primary" />
                    </div>
                    Workflow Executions
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0 divide-y divide-border/40">
                  {data.workflowExecutions.map((wf) => (
                    <div key={wf.id} className="p-5 space-y-3 hover:bg-muted/5 transition-all">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-foreground">{wf.workflow_name || 'Workflow'}</span>
                        <Badge variant={
                          wf.status === 'completed' ? 'default' :
                          wf.status === 'running' ? 'secondary' :
                          wf.status === 'error' ? 'destructive' : 'outline'
                        } className="h-5 px-2 text-xs rounded-md border-none shadow-md">
                          {wf.is_paused ? 'Paused' : wf.status}
                        </Badge>
                      </div>
                      {(wf.total_leads_generated > 0 || wf.total_leads_expected > 0) && (
                        <div className="space-y-2">
                          <div className="w-full h-1.5 rounded-full bg-background border border-border/20 overflow-hidden p-0.5">
                            <div 
                              className="h-full bg-primary rounded-full transition-all duration-1000 shadow-[0_0_10px_hsl(var(--primary)/0.3)]"
                              style={{ width: `${wf.total_leads_expected > 0 ? (wf.total_leads_generated / wf.total_leads_expected) * 100 : 0}%` }}
                            />
                          </div>
                          <div className="flex justify-between items-center px-0.5">
                            <p className="text-[8px] font-semibold text-muted-foreground/40 uppercase tracking-[0.15em]">Progress</p>
                            <span className="text-[8px] font-semibold text-foreground uppercase tabular-nums tracking-[0.1em]">
                              {wf.total_leads_generated} / {wf.total_leads_expected || '?'} Leads
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* Timeline / Activity Feed - Full Width */}
        {data.timeline.length > 0 && (
          <Card className="border border-border/40 bg-card shadow-sm overflow-hidden rounded-xl">
            <CardHeader className="p-4 lg:p-5 border-b border-border/40 bg-muted/10">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-xs flex items-center gap-2.5 text-muted-foreground/60">
                  <div className="w-8 h-8 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center border border-primary/20">
                    <Activity className="h-3.5 w-3.5 text-primary" />
                  </div>
                  Activity Feed
                </CardTitle>
                <button
                  onClick={fetchOverview}
                  className="h-8 px-3 flex items-center justify-center gap-2 rounded-lg hover:bg-primary/10 text-muted-foreground hover:text-primary transition-all border border-border/40 font-semibold uppercase tracking-[0.15em] text-[8px]"
                >
                  <RefreshCw className="h-2.5 w-2.5" />
                  Refresh
                </button>
              </div>
            </CardHeader>
            <CardContent className="p-4 lg:p-5">
              <div className="relative">
                {/* Timeline line */}
                <div className="absolute left-[17px] top-4 bottom-4 w-px bg-border/40" />
                <div className="space-y-2">
                  {data.timeline.map((event, idx) => (
                    <TimelineItem key={event.id} event={event} isLast={idx === data.timeline.length - 1} />
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function TimelineItem({ event, isLast: _isLast }: { event: TimelineEvent; isLast: boolean }) {
  const icon = getEventIcon(event.type, event.agentType);
  const statusColor = getStatusColor(event.status);
  const changes = (event.metadata?.changes || []) as Array<{ field: string; from: string | null; to: string | null }>;
  const showChanges = event.type === 'icp_updated' && changes.length > 0;
  const showLeadInputs = event.type === 'lead_inputs_generated' && !!event.metadata?.inputs;
  const leadInputs = (event.metadata?.inputs || {}) as Record<string, unknown>;

  return (
    <div className="relative flex gap-4 pb-5 last:pb-0">
      {/* Dot with Icon */}
      <div className={cn(
        "relative z-10 flex items-center justify-center w-7 h-7 rounded-lg shrink-0 mt-0.5 shadow-sm border border-border/40",
        statusColor.bg
      )}>
        {icon}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold text-foreground leading-tight truncate">{event.title}</p>
            <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed opacity-70">{event.description}</p>
          </div>
          {event.status && (
            <Badge variant="outline" className={cn(
              "text-xs shrink-0 px-1.5 py-0 border-border/40 bg-background/40 h-4",
              statusColor.badge
            )}>
              {event.status}
            </Badge>
          )}
        </div>
        
        {showChanges && (
          <div className="mt-3 space-y-2 bg-secondary/40 rounded-xl p-3 border border-border/30">
            <p className="text-xs font-semibold text-primary mb-2">Changes</p>
            {changes.map((change, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span className="font-bold text-foreground/70 shrink-0 min-w-[80px]">{change.field}:</span>
                <span className="text-muted-foreground/60 line-through truncate max-w-[100px]">{change.from || '—'}</span>
                <ArrowRight className="h-3 w-3 shrink-0 text-primary opacity-50" />
                <span className="text-foreground font-bold truncate bg-primary/5 px-2 py-0.5 rounded-md">{change.to || '—'}</span>
              </div>
            ))}
          </div>
        )}

        {showLeadInputs && (
          <div className="mt-3 space-y-2 bg-secondary/40 rounded-xl p-3 border border-border/30 text-[11px]">
            <p className="text-xs font-semibold text-primary mb-2">Parameters</p>
            {!!(leadInputs.searchQuery || leadInputs.query || leadInputs.search) && (
              <div className="flex gap-2">
                <span className="font-bold text-foreground/70 shrink-0">Query:</span>
                <span className="text-foreground font-bold">{String(leadInputs.searchQuery || leadInputs.query || leadInputs.search)}</span>
              </div>
            )}
            {Array.isArray(leadInputs.searchStringsArray) && (
              <div className="flex gap-2">
                <span className="font-bold text-foreground/70 shrink-0">Keywords:</span>
                <span className="text-foreground">{(leadInputs.searchStringsArray as string[]).map(s => <Badge key={s} variant="outline" className="text-[9px] mr-1 mb-1">{s}</Badge>)}</span>
              </div>
            )}
            {!!(leadInputs.locationQuery || leadInputs.location) && (
              <div className="flex gap-2">
                <span className="font-bold text-foreground/70 shrink-0">Location:</span>
                <span className="text-foreground">{String(leadInputs.locationQuery || leadInputs.location)}</span>
              </div>
            )}
            {!!(leadInputs.maxItems || leadInputs.maxResults || leadInputs.maxCrawledPlacesPerSearch || leadInputs.resultsLimit || leadInputs.maxTweets) && (
              <div className="flex gap-2">
                <span className="font-bold text-foreground/70 shrink-0">Limit:</span>
                <span className="text-foreground font-bold tabular-nums">{String(leadInputs.maxItems || leadInputs.maxResults || leadInputs.maxCrawledPlacesPerSearch || leadInputs.resultsLimit || leadInputs.maxTweets)} Leads</span>
              </div>
            )}
          </div>
        )}
        
        <div className="flex items-center gap-2 mt-2">
          <Clock className="h-2.5 w-2.5 text-muted-foreground/40" />
          <p className="text-[10px] text-muted-foreground/50 tabular-nums">{formatTimeAgo(event.timestamp)}</p>
        </div>
      </div>
    </div>
  );
}

function getEventIcon(type: string, agentType?: string): React.ReactNode {
  const className = "h-3 w-3";
  switch (type) {
    case 'agent_execution':
      switch (agentType) {
        case 'lead_generation': return <Search className={className} />;
        case 'content_studio': return <FileText className={className} />;
        case 'outreach': return <Send className={className} />;
        case 'performance_marketing': return <BarChart3 className={className} />;
        case 'icp_generation': return <Target className={className} />;
        default: return <Bot className={className} />;
      }
    case 'icp_generated': return <Target className={className} />;
    case 'icp_updated': return <Target className={className} />;
    case 'leads_generated': return <Users className={className} />;
    case 'content_created': return <FileText className={className} />;
    case 'workflow_event': return <Workflow className={className} />;
    case 'tool_approval': return <ShieldCheck className={className} />;
    case 'outreach_sent': return <Send className={className} />;
    case 'scraping_event': return <Search className={className} />;
    case 'lead_inputs_generated': return <Search className={className} />;
    default: return <Activity className={className} />;
  }
}

function getStatusColor(status?: string): { bg: string; badge: string } {
  switch (status) {
    case 'completed':
    case 'approved':
    case 'generated':
    case 'updated':
      return { bg: 'bg-green-100 dark:bg-green-950 text-green-600 dark:text-green-400', badge: 'border-green-300 text-green-700 dark:text-green-400' };
    case 'running':
    case 'pending':
      return { bg: 'bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400', badge: 'border-blue-300 text-blue-700 dark:text-blue-400' };
    case 'error':
    case 'rejected':
      return { bg: 'bg-red-100 dark:bg-red-950 text-red-600 dark:text-red-400', badge: 'border-red-300 text-red-700 dark:text-red-400' };
    default:
      return { bg: 'bg-muted text-muted-foreground', badge: '' };
  }
}

function formatAgentDisplay(agentType: string): string {
  const getModuleLabel = (moduleId: string) => {
    const labels: Record<string, string> = {
      icp_generation: 'ICP Hub',
      lead_generation: 'Lead Generation',
      outreach: 'Outreach',
      content_studio: 'Content Studio',
      performance_marketing: 'Marketing',
      analytics: 'Analytics',
    };
    return labels[moduleId] || moduleId;
  };
  return getModuleLabel(agentType) || agentType?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Unknown';
}

function formatTimeAgo(timestamp: string): string {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now.getTime() - then.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function OverviewSkeleton() {
  return (
    <div className="h-full min-h-full bg-background p-4 space-y-4">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-3">
        {[...Array(3)].map((_, i) => (
          <Card key={i}>
            <CardContent className="p-3">
              <Skeleton className="h-10 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="p-4 space-y-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4 space-y-3">
          <Skeleton className="h-4 w-40" />
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex flex-wrap items-center gap-3">
              <Skeleton className="h-5 w-5 rounded-full" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-2 w-1/2" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
