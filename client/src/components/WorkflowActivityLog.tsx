import { useState, useRef, useEffect, useMemo } from "react";
import { 
  Loader2, 
  CheckCircle, 
  AlertCircle, 
  ChevronDown, 
  ChevronRight,
  Terminal,
  Play,
  RotateCcw,
  Clock,
  Database,
  Cpu,
  Activity,
  FileJson,
  ArrowRight,
  Square,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { cn } from "@/lib/utils";

export interface ActivityLogEntry {
  id: string;
  timestamp: Date;
  type: 'workflow_start' | 'step' | 'actor_start' | 'actor_progress' | 'actor_complete' | 'lead_saved' | 'error' | 'completed';
  platform?: string;
  actorId?: string;
  message: string;
  details?: Record<string, unknown>;
  status?: 'running' | 'completed' | 'error' | 'pending';
  leadsCount?: number;
  totalLeads?: number;
}

interface WorkflowActivityLogProps {
  logs: ActivityLogEntry[];
  isRunning: boolean;
  onRetry?: () => void;
  onStop?: () => void;
  currentPlatform?: string;
  totalLeads: number;
  platformStats: {
    platform: string;
    status: 'pending' | 'running' | 'completed' | 'error';
    leadsCount: number;
    maxResults: number;
  }[];
}

// Format timestamp for display
const formatTimestamp = (date: Date) => {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

// Get icon for log type
const getLogIcon = (type: ActivityLogEntry['type'], status?: string) => {
  switch (type) {
    case 'workflow_start':
      return <Play className="w-4 h-4 text-blue-500" />;
    case 'actor_start':
      return <Cpu className="w-4 h-4 text-orange-500" />;
    case 'actor_progress':
      return <Activity className="w-4 h-4 text-blue-400 animate-pulse" />;
    case 'actor_complete':
      return <CheckCircle className="w-4 h-4 text-green-500" />;
    case 'lead_saved':
      return <Database className="w-4 h-4 text-purple-500" />;
    case 'step':
      return status === 'running' 
        ? <Spinner label={null} className="text-blue-500" />
        : <ChevronRight className="w-4 h-4 text-muted-foreground" />;
    case 'error':
      return <AlertCircle className="w-4 h-4 text-red-500" />;
    case 'completed':
      return <CheckCircle className="w-4 h-4 text-green-500" />;
    default:
      return <Terminal className="w-4 h-4 text-muted-foreground" />;
  }
};

// Get background color for log type
const getLogBgColor = (type: ActivityLogEntry['type']) => {
  switch (type) {
    case 'workflow_start':
      return 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800';
    case 'actor_start':
      return 'bg-orange-50 dark:bg-orange-950/30 border-orange-200 dark:border-orange-800';
    case 'actor_complete':
      return 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800';
    case 'lead_saved':
      return 'bg-purple-50 dark:bg-purple-950/30 border-purple-200 dark:border-purple-800';
    case 'error':
      return 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800';
    case 'completed':
      return 'bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800';
    default:
      return 'bg-muted/30 border-border';
  }
};

export function WorkflowActivityLog({
  logs,
  isRunning,
  onRetry,
  onStop,
  currentPlatform,
  totalLeads,
  platformStats,
}: WorkflowActivityLogProps) {
  const [expanded, setExpanded] = useState(true);
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<'timeline' | 'platform'>('platform');
  const scrollRef = useRef<HTMLDivElement>(null);
  
  // Group logs by platform for accordion view
  const logsByPlatform = useMemo(() => {
    const grouped: Record<string, ActivityLogEntry[]> = {};
    const general: ActivityLogEntry[] = [];
    
    logs.forEach(log => {
      if (log.platform) {
        if (!grouped[log.platform]) {
          grouped[log.platform] = [];
        }
        grouped[log.platform].push(log);
      } else {
        general.push(log);
      }
    });
    
    return { platforms: grouped, general };
  }, [logs]);
  
  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (scrollRef.current && isRunning) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length, isRunning]);

  const toggleLogDetails = (logId: string) => {
    setExpandedLogs(prev => {
      const newSet = new Set(prev);
      if (newSet.has(logId)) {
        newSet.delete(logId);
      } else {
        newSet.add(logId);
      }
      return newSet;
    });
  };

  // Calculate overall progress
  const totalMaxResults = platformStats.reduce((sum, p) => sum + p.maxResults, 0);
  const overallProgress = totalMaxResults > 0 
    ? Math.min(100, (totalLeads / totalMaxResults) * 100)
    : 0;

  return (
    <Card className="overflow-hidden rounded-xl border border-border/40 bg-card/30 backdrop-blur-xl shadow-lg shadow-black/5">
      <CardHeader className="py-3 px-4 border-b border-border/40 bg-muted/10">
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="p-0 h-auto hover:bg-transparent"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronDown className="w-4 h-4 mr-2 text-muted-foreground/60" /> : <ChevronRight className="w-4 h-4 mr-2 text-muted-foreground/60" />}
            <CardTitle className="text-[10px] font-black uppercase tracking-widest flex items-center gap-2 text-muted-foreground/80">
              <Terminal className="w-3.5 h-3.5" />
              Workflow Activity Log
              {isRunning && (
                <Badge variant="outline" className="ml-2 h-4 text-[8px] px-1.5 uppercase font-black tracking-widest bg-primary/10 text-primary border-none">
                  <Loader2 className="w-2.5 h-2.5 mr-1 animate-spin" />
                  Running
                </Badge>
              )}
              {!isRunning && logs.some(l => l.type === 'completed') && (
                <Badge variant="outline" className="ml-2 h-4 text-[8px] px-1.5 uppercase font-black tracking-widest bg-green-500/10 text-green-500 border-none">
                  <CheckCircle className="w-2.5 h-2.5 mr-1" />
                  Completed
                </Badge>
              )}
            </CardTitle>
          </Button>
          
          <div className="flex items-center gap-2">
            {/* Stats summary */}
            <div className="hidden sm:flex items-center gap-4 text-sm text-muted-foreground">
              <span className="flex items-center gap-1">
                <Database className="w-4 h-4" />
                {totalLeads} leads
              </span>
              <span className="flex items-center gap-1">
                <Cpu className="w-4 h-4" />
                {platformStats.filter(p => p.status === 'completed').length}/{platformStats.length} platforms
              </span>
            </div>
            
            {/* Control buttons */}
            {isRunning && onStop && (
              <Button 
                variant="destructive" 
                size="sm"
                onClick={onStop}
                className="h-8"
              >
                <Square className="w-4 h-4 mr-1" />
                Stop
              </Button>
            )}
            {!isRunning && logs.some(l => l.type === 'error') && onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry} className="h-8">
                <RotateCcw className="w-4 h-4 mr-1" />
                Retry
              </Button>
            )}
          </div>
        </div>
        
        {/* Progress bar */}
        {expanded && (isRunning || logs.length > 0) && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-[9px] font-black uppercase tracking-widest text-muted-foreground/40 mb-1.5">
              <span>Overall Progress</span>
              <span>{Math.round(overallProgress)}%</span>
            </div>
            <div className="w-full h-1.5 bg-muted/20 rounded-full overflow-hidden">
              <div 
                className="h-full bg-primary transition-all duration-700 ease-out shadow-[0_0_8px_hsl(var(--primary)/0.4)]"
                style={{ width: `${overallProgress}%` }}
              />
            </div>
          </div>
        )}
      </CardHeader>
      
      {expanded && (
        <CardContent className="p-0">
          {/* Platform progress summary */}
          {platformStats.length > 0 && (
            <div className="px-4 py-3 border-b bg-muted/30">
              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(platformStats.length, 4)}, 1fr)` }}>
                {platformStats.map((platform) => (
                  <div 
                    key={platform.platform}
                    className={cn(
                      "px-3 py-2 rounded-lg border text-sm",
                      platform.status === 'running' && "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800",
                      platform.status === 'completed' && "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800",
                      platform.status === 'error' && "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800",
                      platform.status === 'pending' && "bg-muted/50 border-muted"
                    )}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium capitalize">{platform.platform}</span>
                      {platform.status === 'running' && <Spinner size="xs" label={null} className="text-blue-500" />}
                      {platform.status === 'completed' && <CheckCircle className="w-3 h-3 text-green-500" />}
                      {platform.status === 'error' && <AlertCircle className="w-3 h-3 text-red-500" />}
                      {platform.status === 'pending' && <Clock className="w-3 h-3 text-muted-foreground" />}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {platform.leadsCount}/{platform.maxResults} leads
                    </div>
                    <div className="mt-1 h-1 bg-muted rounded-full overflow-hidden">
                      <div 
                        className={cn(
                          "h-full transition-all duration-300",
                          platform.status === 'running' && "bg-blue-500",
                          platform.status === 'completed' && "bg-green-500",
                          platform.status === 'error' && "bg-red-500",
                          platform.status === 'pending' && "bg-muted-foreground/30"
                        )}
                        style={{ width: `${platform.maxResults > 0 ? (platform.leadsCount / platform.maxResults) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* View mode toggle */}
          <div className="px-4 py-2 border-b border-border/40 flex items-center gap-2 bg-background/20">
            <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/40">View:</span>
            <Button
              variant={viewMode === 'platform' ? 'secondary' : 'ghost'}
              size="sm"
              className={cn("h-6 text-[9px] font-black uppercase tracking-widest rounded-lg px-3 transition-all", viewMode === 'platform' && "bg-primary text-white hover:bg-primary/90")}
              onClick={() => setViewMode('platform')}
            >
              By Platform
            </Button>
            <Button
              variant={viewMode === 'timeline' ? 'secondary' : 'ghost'}
              size="sm"
              className={cn("h-6 text-[9px] font-black uppercase tracking-widest rounded-lg px-3 transition-all", viewMode === 'timeline' && "bg-primary text-white hover:bg-primary/90")}
              onClick={() => setViewMode('timeline')}
            >
              Timeline
            </Button>
          </div>

          {/* Activity log entries */}
          <ScrollArea className="h-[400px]" ref={scrollRef}>
            <div className="p-4 space-y-2">
              {logs.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Terminal className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">No activity yet</p>
                  <p className="text-xs">Logs will appear here when a workflow starts</p>
                </div>
              ) : viewMode === 'platform' ? (
                // Platform-grouped accordion view
                <Accordion type="multiple" defaultValue={Object.keys(logsByPlatform.platforms)} className="space-y-2">
                  {/* General logs (not platform-specific) */}
                  {logsByPlatform.general.length > 0 && (
                    <AccordionItem value="general" className="border rounded-lg overflow-hidden">
                      <AccordionTrigger className="px-4 py-3 hover:bg-muted/50 [&[data-state=open]>svg]:rotate-180">
                        <div className="flex items-center gap-3">
                          <Terminal className="w-5 h-5 text-muted-foreground" />
                          <div className="text-left">
                            <p className="font-medium">Workflow Events</p>
                            <p className="text-xs text-muted-foreground">{logsByPlatform.general.length} events</p>
                          </div>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="px-4 pb-4">
                        <div className="space-y-2">
                          {logsByPlatform.general.map((log) => renderLogEntry(log, expandedLogs, toggleLogDetails))}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  )}
                  
                  {/* Platform-specific logs */}
                  {Object.entries(logsByPlatform.platforms).map(([platform, platformLogs]) => {
                    const platformStat = platformStats.find(p => p.platform === platform);
                    const actorLogs = platformLogs.filter(l => l.type === 'actor_start' || l.type === 'actor_complete');
                    const leadLogs = platformLogs.filter(l => l.type === 'lead_saved');
                    const errorLogs = platformLogs.filter(l => l.type === 'error');
                    
                    return (
                      <AccordionItem key={platform} value={platform} className="border rounded-lg overflow-hidden">
                        <AccordionTrigger className={cn(
                          "px-4 py-3 hover:bg-muted/50 [&[data-state=open]>svg]:rotate-180",
                          platformStat?.status === 'running' && "bg-blue-50/50 dark:bg-blue-950/20",
                          platformStat?.status === 'completed' && "bg-green-50/50 dark:bg-green-950/20",
                          platformStat?.status === 'error' && "bg-red-50/50 dark:bg-red-950/20"
                        )}>
                          <div className="flex items-center gap-3">
                            {platformStat?.status === 'running' && <Spinner size="md" label={null} className="text-blue-500" />}
                            {platformStat?.status === 'completed' && <CheckCircle className="w-5 h-5 text-green-500" />}
                            {platformStat?.status === 'error' && <AlertCircle className="w-5 h-5 text-red-500" />}
                            {platformStat?.status === 'pending' && <Clock className="w-5 h-5 text-muted-foreground" />}
                            {!platformStat && <Cpu className="w-5 h-5 text-muted-foreground" />}
                            <div className="text-left">
                              <p className="font-medium capitalize">{platform}</p>
                              <p className="text-xs text-muted-foreground">
                                {actorLogs.length} actors • {leadLogs.reduce((sum, l) => sum + (l.leadsCount || 0), 0)} leads
                                {errorLogs.length > 0 && <span className="text-red-500"> • {errorLogs.length} errors</span>}
                              </p>
                            </div>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent className="px-4 pb-4">
                          {/* Actor execution summary */}
                          {actorLogs.length > 0 && (
                            <div className="mb-4">
                              <h4 className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
                                <Cpu className="w-3 h-3" /> Actor Executions
                              </h4>
                              <div className="space-y-2">
                                {actorLogs.map((log) => renderLogEntry(log, expandedLogs, toggleLogDetails))}
                              </div>
                            </div>
                          )}
                          
                          {/* Lead saves */}
                          {leadLogs.length > 0 && (
                            <div className="mb-4">
                              <h4 className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
                                <Database className="w-3 h-3" /> Leads Saved
                              </h4>
                              <div className="space-y-2">
                                {leadLogs.map((log) => renderLogEntry(log, expandedLogs, toggleLogDetails))}
                              </div>
                            </div>
                          )}
                          
                          {/* Errors */}
                          {errorLogs.length > 0 && (
                            <div className="mb-4">
                              <h4 className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
                                <AlertCircle className="w-3 h-3 text-red-500" /> Errors
                              </h4>
                              <div className="space-y-2">
                                {errorLogs.map((log) => renderLogEntry(log, expandedLogs, toggleLogDetails))}
                              </div>
                            </div>
                          )}
                          
                          {/* All other logs */}
                          {platformLogs.filter(l => !['actor_start', 'actor_complete', 'lead_saved', 'error'].includes(l.type)).length > 0 && (
                            <div>
                              <h4 className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
                                <Activity className="w-3 h-3" /> Other Activity
                              </h4>
                              <div className="space-y-2">
                                {platformLogs
                                  .filter(l => !['actor_start', 'actor_complete', 'lead_saved', 'error'].includes(l.type))
                                  .map((log) => renderLogEntry(log, expandedLogs, toggleLogDetails))}
                              </div>
                            </div>
                          )}
                        </AccordionContent>
                      </AccordionItem>
                    );
                  })}
                </Accordion>
              ) : (
                // Timeline view (original)
                logs.map((log) => renderLogEntry(log, expandedLogs, toggleLogDetails))
              )}
              
              {/* Current activity indicator */}
              {isRunning && currentPlatform && (
                <div className="rounded-lg border border-dashed border-blue-300 dark:border-blue-700 p-3 bg-blue-50/50 dark:bg-blue-950/20">
                  <div className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400">
                    <Spinner label={null} />
                    <span>Currently processing: <span className="font-medium capitalize">{currentPlatform}</span></span>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      )}
    </Card>
  );
}

// Helper function to render a single log entry
function renderLogEntry(
  log: ActivityLogEntry,
  expandedLogs: Set<string>,
  toggleLogDetails: (id: string) => void
) {
  return (
    <div 
      key={log.id}
      className={cn(
        "rounded-lg border p-3 text-sm transition-colors",
        getLogBgColor(log.type)
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          {getLogIcon(log.type, log.status)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">{log.message}</span>
              {log.actorId && (
                <Badge variant="outline" className="text-xs font-mono">
                  {log.actorId.split('/').pop()}
                </Badge>
              )}
              {log.leadsCount !== undefined && (
                <Badge variant="secondary" className="text-xs">
                  {log.leadsCount} leads
                </Badge>
              )}
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {formatTimestamp(log.timestamp)}
            </span>
          </div>
          
          {/* Expandable details with Input/Output sections */}
          {log.details && Object.keys(log.details).length > 0 && (
            <div className="mt-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => toggleLogDetails(log.id)}
              >
                {expandedLogs.has(log.id) ? (
                  <>
                    <ChevronDown className="w-3 h-3 mr-1" />
                    Hide Details
                  </>
                ) : (
                  <>
                    <FileJson className="w-3 h-3 mr-1" />
                    Show Input/Output
                  </>
                )}
              </Button>
              
              {expandedLogs.has(log.id) && (
                <div className="mt-2 space-y-3">
                  {/* Actor Input */}
                  {'actorInput' in log.details && log.details.actorInput ? (
                    <div className="rounded bg-blue-50/50 dark:bg-blue-950/30 p-2 border border-blue-200 dark:border-blue-800">
                      <h5 className="text-xs font-semibold text-blue-600 dark:text-blue-400 mb-1 flex items-center gap-1">
                        <ArrowRight className="w-3 h-3" /> Input Parameters
                      </h5>
                      <pre className="font-mono text-xs whitespace-pre-wrap break-all text-blue-800 dark:text-blue-200">
                        {JSON.stringify(log.details.actorInput, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                  
                  {/* Sample Output */}
                  {'sampleOutput' in log.details && log.details.sampleOutput ? (
                    <div className="rounded bg-green-50/50 dark:bg-green-950/30 p-2 border border-green-200 dark:border-green-800">
                      <h5 className="text-xs font-semibold text-green-600 dark:text-green-400 mb-1 flex items-center gap-1">
                        <ArrowRight className="w-3 h-3 rotate-180" /> Sample Output ({String(log.details.resultCount ?? 0)} total)
                      </h5>
                      <pre className="font-mono text-xs whitespace-pre-wrap break-all text-green-800 dark:text-green-200">
                        {JSON.stringify(log.details.sampleOutput, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                  
                  {/* Sample Leads */}
                  {'sampleLeads' in log.details && log.details.sampleLeads ? (
                    <div className="rounded bg-purple-50/50 dark:bg-purple-950/30 p-2 border border-purple-200 dark:border-purple-800">
                      <h5 className="text-xs font-semibold text-purple-600 dark:text-purple-400 mb-1 flex items-center gap-1">
                        <Database className="w-3 h-3" /> Saved Leads (Sample)
                      </h5>
                      <pre className="font-mono text-xs whitespace-pre-wrap break-all text-purple-800 dark:text-purple-200">
                        {JSON.stringify(log.details.sampleLeads, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                  
                  {/* Other details */}
                  {Object.keys(log.details).filter(k => !['actorInput', 'sampleOutput', 'sampleLeads'].includes(k)).length > 0 ? (
                    <div className="rounded bg-muted/50 p-2 border">
                      <h5 className="text-xs font-semibold text-muted-foreground mb-1">Other Details</h5>
                      <pre className="font-mono text-xs whitespace-pre-wrap break-all">
                        {JSON.stringify(
                          Object.fromEntries(
                            Object.entries(log.details).filter(([k]) => !['actorInput', 'sampleOutput', 'sampleLeads'].includes(k))
                          ),
                          null,
                          2
                        )}
                      </pre>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
