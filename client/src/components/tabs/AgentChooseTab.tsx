import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Check, CheckCircle2, Loader2, Sparkles, Target, Users, Megaphone, Play, AlertCircle, Clock, ArrowRight, Zap, Plus } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useWebSocket } from '@/contexts/WebSocketContext';
import { useAgent } from '@/contexts/AgentContext';
import { AGENT_PIPELINE_INFO } from '@/lib/agent-personas';
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";

// Recommended agent scores type
interface RecommendedAgentScores {
  lead_generation?: number;
  content_studio?: number;
  performance_marketing?: number;
  outreach?: number;
}

interface Agent {
  id: string;
  name: string;
  role: string;
  icon: React.ReactNode;
  description: string;
  deliverables: string;
  // Optional legacy metadata; hiring dispatches through onHireAgent.
  endpoint?: string;
  color: string;
  specialty: string;
  avatar: string;
  benefits: string[];
  matchRate?: number;
  estimatedTime: string;
}

// Get local avatar path
const getAvatarUrl = (filename: string) => {
  return `/agent-avatars/${filename}`;
};

// Avatar image with graceful fallback to initials on 404
function AgentAvatarImg({ src, alt, initials, className }: { src: string; alt: string; initials: string; className?: string }) {
  const [imgError, setImgError] = useState(false);
  if (imgError || !src) {
    return (
      <div className={cn("flex items-center justify-center text-white text-xs font-bold", className)}>
        {initials}
      </div>
    );
  }
  return <img src={src} alt={alt} className={className} onError={() => setImgError(true)} />;
}

const agents: Agent[] = [
  {
    id: 'lead-generation',
    name: 'Marcus Johnson',
    role: 'Lead Generation Specialist',
    icon: <Users className="h-6 w-6" />,
    description: 'B2B Lead Finder & Database Builder',
    deliverables: '8 deliverables',
    endpoint: '/api/agents/lead-generation/run',
    color: 'from-green-500 to-emerald-500',
    specialty: 'lead generation',
    avatar: getAvatarUrl('leadagent.png'),
    benefits: [
      'Find high-intent business leads',
      'Verify contact information',
      'Build targeted lead databases',
      'Score leads by fit and intent',
    ],
    estimatedTime: '10-20 mins',
  },
  {
    id: 'content-studio',
    name: 'Alex Chen',
    role: 'Content Creator',
    icon: <Sparkles className="h-6 w-6" />,
    description: 'Viral Content Creation & Design',
    deliverables: '8 deliverables',
    color: 'from-purple-500 to-pink-500',
    specialty: 'content creation',
    avatar: getAvatarUrl('content-studio.png'),
    benefits: [
      'Analyze trending topics in your niche',
      'Create 10 viral-ready content pieces',
      'Optimize for each platform algorithm',
      'Schedule & automate posting',
    ],
    estimatedTime: '5-10 mins',
  },
  {
    id: 'outreach',
    name: 'Emily Rodriguez',
    role: 'Outreach Specialist',
    icon: <Megaphone className="h-6 w-6" />,
    description: 'Email & Multi-Channel Campaigns',
    deliverables: '6 deliverables',
    endpoint: '/api/outreach/campaigns',
    color: 'from-orange-500 to-amber-500',
    specialty: 'outreach',
    avatar: getAvatarUrl('outreach.png'),
    benefits: [
      'Design personalized email sequences',
      'Multi-channel outreach campaigns',
      'Track engagement and responses',
      'Automate follow-up workflows',
    ],
    estimatedTime: '2-5 mins',
  },
  {
    id: 'performance-marketing',
    name: 'Sarah Martinez',
    role: 'Performance Manager',
    icon: <Target className="h-6 w-6" />,
    description: 'Paid Ads & Campaign Optimization',
    deliverables: '8 deliverables',
    endpoint: '/api/campaigns/performance/generate',
    color: 'from-blue-500 to-cyan-500',
    specialty: 'performance marketing',
    avatar: getAvatarUrl('performance.png'),
    benefits: [
      'Create high-converting ad campaigns',
      'Optimize budget allocation',
      'A/B test ad variations',
      'Track ROI and performance metrics',
    ],
    estimatedTime: '15-30 mins',
  },
];

interface AgentChooseTabProps {
  icpId?: number;
  fitScore?: number;
  threadId?: number;
  recommendedAgents?: string[];
  recommendedAgentScores?: RecommendedAgentScores;
  agentDescriptions?: Record<string, string>;
  userIntent?: string;
  onAgentSelect?: (agentId: string | null) => void;
  onHireAgent?: (agentId: string, commandName: string) => void | Promise<void>;
  onHireMultipleAgents?: (agentIds: string[], agentNames: string[]) => void | Promise<void>;
  /** Agent types that have already worked in this campaign, e.g. "lead_generation". */
  activeAgents?: string[];
}

interface AgentExecution {
  agentId: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  progress: number;
  currentTask: string;
  startTime?: number;
  endTime?: number;
  error?: string;
  results?: Record<string, unknown>;
}

 
export default function AgentChooseTab({
  icpId: _icpId,
  fitScore: _fitScore = 0,
  threadId: _threadId,
  recommendedAgents = [],
  recommendedAgentScores,
  agentDescriptions,
  userIntent,
  onAgentSelect,
  onHireAgent,
  onHireMultipleAgents,
  activeAgents = [],
}: AgentChooseTabProps) {
  const activeAgentIds = new Set(activeAgents.map(type => type.replace(/_/g, '-')));
  const [loadingAgent, setLoadingAgent] = useState<string | null>(null);
  const [_startedAgents, setStartedAgents] = useState<Set<string>>(new Set());
  const hiringRef = useRef<Set<string>>(new Set());
  const hiringTeamRef = useRef(false);
  const [isHiringTeam, setIsHiringTeam] = useState(false);
  const [executions, setExecutions] = useState<Map<string, AgentExecution>>(new Map());
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const { subscribe: wsSubscribe } = useWebSocket(); // Use global WebSocket
  const { toast } = useToast();
  const { selectedAgent, setSelectedAgent } = useAgent();

  // Map agent IDs to score keys
  const agentIdToScoreKey = useMemo<Record<string, keyof RecommendedAgentScores>>(() => ({
    'lead-generation': 'lead_generation',
    'content-studio': 'content_studio',
    'performance-marketing': 'performance_marketing',
    'outreach': 'outreach',
  }), []);

  // Sort agents by recommended scores

  const sortedAgents = useMemo(() => {
    if (recommendedAgents.length > 0) {
      const rank = (id: string) => {
        const index = recommendedAgents.findIndex(agent => agent === id || agent === agentIdToScoreKey[id]);
        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
      };
      return [...agents].sort((a, b) => rank(a.id) - rank(b.id));
    }
    if (!recommendedAgentScores || Object.keys(recommendedAgentScores).length === 0) {
      return agents;
    }

    return [...agents].sort((a, b) => {
      const scoreKeyA = agentIdToScoreKey[a.id];
      const scoreKeyB = agentIdToScoreKey[b.id];
      const scoreA = scoreKeyA ? (recommendedAgentScores[scoreKeyA] || 0) : 0;
      const scoreB = scoreKeyB ? (recommendedAgentScores[scoreKeyB] || 0) : 0;
      return scoreB - scoreA; // Descending order (highest score first)
    });
  }, [recommendedAgents, recommendedAgentScores, agentIdToScoreKey]);

  // Pre-select recommended agents on mount (only once to avoid overriding user manual selections)
  const hasPreSelectedRef = useRef(false);
  useEffect(() => {
    if (!recommendedAgentScores || hasPreSelectedRef.current) return;
    const scoreKeyToAgentId: Record<string, string> = {
      'lead_generation': 'lead-generation',
      'content_studio': 'content-studio',
      'performance_marketing': 'performance-marketing',
      'outreach': 'outreach',
    };
    const preSelected = new Set<string>();
    Object.entries(recommendedAgentScores).forEach(([key, score]) => {
      if ((score || 0) > 0 && scoreKeyToAgentId[key]) {
        preSelected.add(scoreKeyToAgentId[key]);
      }
    });
    if (preSelected.size > 0) {
      setSelectedAgentIds(preSelected);
      hasPreSelectedRef.current = true;
    }
  }, [recommendedAgentScores]);

  // Get recommendation score for an agent
  const getAgentScore = (agentId: string): number | undefined => {
    if (!recommendedAgentScores) return undefined;
    const scoreKey = agentIdToScoreKey[agentId];
    return scoreKey ? recommendedAgentScores[scoreKey] : undefined;
  };

  // Check if agent is the top recommended
  const isTopRecommended = (agentId: string): boolean => {
    if (recommendedAgents.length > 0) {
      return recommendedAgents[0] === agentId || recommendedAgents[0] === agentIdToScoreKey[agentId];
    }
    if (!recommendedAgentScores || Object.keys(recommendedAgentScores).length === 0) return false;
    const scoreKey = agentIdToScoreKey[agentId];
    if (!scoreKey) return false;

    const agentScore = recommendedAgentScores[scoreKey] || 0;
    const maxScore = Math.max(...Object.values(recommendedAgentScores));
    return agentScore === maxScore && agentScore > 0;
  };

  // Handle WebSocket events for execution monitoring
  const handleWebSocketEvent = useCallback((event: { type: string; data: Record<string, unknown> }) => {
    if (event.type === 'agent_progress') {
      const { agent_type, progress, current_task, status } = event.data;
      setExecutions(prev => {
        const newExecutions = new Map(prev);
        const execution = newExecutions.get(agent_type as string) || {
          agentId: agent_type as string,
          status: 'running',
          progress: 0,
          currentTask: '',
        };

        newExecutions.set(agent_type as string, {
          ...execution,
          progress: (progress as number) || execution.progress,
          currentTask: (current_task as string) || execution.currentTask,
          status: status === 'completed' ? 'completed' : 'running',
        });

        return newExecutions;
      });
    } else if (event.type === 'workflow_completed') {
      const { platform } = event.data;
      setExecutions(prev => {
        const newExecutions = new Map(prev);
        const execution = newExecutions.get(platform as string);
        if (execution) {
          newExecutions.set(platform as string, {
            ...execution,
            status: 'completed',
            progress: 100,
            endTime: Date.now(),
          });
        }
        return newExecutions;
      });

      toast({
        title: `${platform as string} Completed`,
        description: `Agent execution finished successfully`,
      });
    } else if (event.type === 'workflow_error') {
      const { platform, error } = event.data;
      setExecutions(prev => {
        const newExecutions = new Map(prev);
        const execution = newExecutions.get(platform as string);
        if (execution) {
          newExecutions.set(platform as string, {
            ...execution,
            status: 'error',
            error: error as string,
            endTime: Date.now(),
          });
        }
        return newExecutions;
      });

      toast({
        title: `${platform as string} Error`,
        description: error as string,
        variant: 'destructive',
      });
    }
  }, [toast]);

  // Subscribe to execution monitoring events

  useEffect(() => {
    // Subscribe to agent progress
    const unsubProgress = wsSubscribe('agent_progress', (data: Record<string, unknown>) => {
      handleWebSocketEvent({ type: 'agent_progress', data });
    });

    // Subscribe to workflow completion
    const unsubCompleted = wsSubscribe('workflow_completed', (data: Record<string, unknown>) => {
      handleWebSocketEvent({ type: 'workflow_completed', data });
    });

    // Subscribe to workflow errors
    const unsubError = wsSubscribe('workflow_error', (data: Record<string, unknown>) => {
      handleWebSocketEvent({ type: 'workflow_error', data });
    });

    // Subscribe to batch progress
    const unsubBatch = wsSubscribe('batch_progress', (data: Record<string, unknown>) => {
      handleWebSocketEvent({ type: 'batch_progress', data });
    });

    return () => {
      unsubProgress();
      unsubCompleted();
      unsubError();
      unsubBatch();
    };
  }, [wsSubscribe, handleWebSocketEvent]);

  const getAgentCommandName = (agentId: string): string => {
    const commandNames: Record<string, string> = {
      'lead-generation': 'LeadAgent',
      'content-studio': 'ContentStudioAgent',
      'performance-marketing': 'PerformanceMarketingAgent',
      'outreach': 'OutreachAgent',
    };
    return commandNames[agentId] || agentId;
  };

  const handleSelectAgent = (agent: Agent) => {
    if (hiringTeamRef.current) return;
    // Toggle multi-select
    setSelectedAgentIds(prev => {
      const next = new Set(prev);
      if (next.has(agent.id)) {
        next.delete(agent.id);
      } else {
        next.add(agent.id);
      }
      return next;
    });

    // Also update the single-select context for backward compat
    setSelectedAgent({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      specialty: agent.specialty,
      avatar: agent.avatar,
    });

    // Notify parent component
    if (onAgentSelect) {
      onAgentSelect(agent.id);
    }
  };

  const handleDeselectAgent = (agent: Agent, e?: React.MouseEvent) => {
    // Prevent event propagation
    if (e) {
      e.stopPropagation();
    }
    if (hiringTeamRef.current) return;

    setSelectedAgentIds(prev => {
      const next = new Set(prev);
      next.delete(agent.id);
      return next;
    });

    if (selectedAgent?.id === agent.id) {
      setSelectedAgent(null);
      if (onAgentSelect) {
        onAgentSelect(null);
      }
    }
  };

  const handleHireSelected = async () => {
    if (selectedAgentIds.size < 2 || hiringTeamRef.current || !onHireMultipleAgents) return;
    // The ref closes the same-render double-click window; state drives the UI.
    hiringTeamRef.current = true;
    setIsHiringTeam(true);
    const selectedList = agents.filter(a => selectedAgentIds.has(a.id));
    const agentIds = selectedList.map(a => a.id);
    const agentNames = selectedList.map(a => a.name);
    try {
      await onHireMultipleAgents(agentIds, agentNames);
      setSelectedAgentIds(new Set());
    } catch (error) {
      toast({
        title: 'Failed to Assemble Team',
        description: error instanceof Error ? error.message : 'The team could not be hired.',
        variant: 'destructive',
      });
    } finally {
      hiringTeamRef.current = false;
      setIsHiringTeam(false);
    }
  };

  const handleHireClick = async (agentOverride?: Agent) => {
    const agent = agentOverride || selectedAgent;
    if (!agent || !agent.id || hiringTeamRef.current) return;

    const agentId = agent.id;

    // Synchronous guard to prevent double-clicking
    if (hiringRef.current.has(agentId)) return;
    hiringRef.current.add(agentId);

    if (!agent) return;

    setLoadingAgent(agentId);

    try {
      // Notify parent component to start the agent
      if (onHireAgent) {
        await onHireAgent(agentId, getAgentCommandName(agentId));
      }
      setStartedAgents((prev) => new Set(prev).add(agentId));
    } catch (error: unknown) {
      console.error('Error hiring agent:', error);

      toast({
        title: 'Failed to Hire Agent',
        description: (error as Error)?.message || 'An error occurred',
        variant: 'destructive',
      });
    } finally {
      setLoadingAgent(null);
      hiringRef.current.delete(agentId);
    }
  };

  const getRingColor = (agentId: string) => {
    switch (agentId) {
      case 'content-studio':
        return 'ring-orange-400';
      case 'performance-marketing':
        return 'ring-pink-400';
      case 'outreach':
        return 'ring-purple-400';
      case 'lead-generation':
      default:
        return 'ring-emerald-400';
    }
  };

  // Hex ring colors for inline style usage (badges, score indicators)
  const agentRingColors: Record<string, string> = {
    'lead-generation': '#6ee7b7',
    'content-studio': '#fdba74',
    'outreach': '#c084fc',
    'performance-marketing': '#f9a8d4',
  };

  const getAvatarBgColor = (agentId: string) => {
    switch (agentId) {
      case 'content-studio':
        return 'rgba(251,146,60,0.5)';
      case 'performance-marketing':
        return 'rgba(244,114,182,0.5)';
      case 'outreach':
        return 'rgba(192,132,252,0.5)';
      case 'lead-generation':
      default:
        return 'rgba(52,211,153,0.5)';
    }
  };

  // Per-agent name color (Figma palette)
  const getNameColor = (agentId: string) => {
    switch (agentId) {
      case 'content-studio':
        return 'text-orange-600 dark:text-orange-400';
      case 'performance-marketing':
        return 'text-pink-600 dark:text-pink-400';
      case 'outreach':
        return 'text-purple-600 dark:text-purple-400';
      case 'lead-generation':
      default:
        return 'text-emerald-600 dark:text-emerald-400';
    }
  };

  // Unified impact bar gradient (#B48CF2 → #F6A6C1)
  const getImpactGradient = (_agentId: string) => {
    return 'from-[#B48CF2] to-[#F6A6C1]';
  };

  const getImpactLabel = (score?: number) => {
    if (score === undefined) return 'High';
    if (score >= 85) return 'Very High';
    if (score >= 70) return 'High';
    if (score >= 55) return 'Medium';
    return 'Low';
  };

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b bg-card flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Users className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold">Hire agents</p>
            <p className="text-xs text-muted-foreground">Select specialized agents</p>
          </div>
        </div>
        <Badge className="bg-primary/10 text-primary border-primary/20 rounded-lg text-xs">{agents.length} agents</Badge>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Recommended Agent Order */}
        {recommendedAgentScores && Object.keys(recommendedAgentScores).length > 0 && (() => {
          const pipelineAgents = Object.entries(recommendedAgentScores)
            .filter(([, score]) => (score || 0) > 0)
            .sort((a, b) => (b[1] || 0) - (a[1] || 0));
          if (pipelineAgents.length <= 1) return null;

          const agentPipelineInfo = AGENT_PIPELINE_INFO;

          // Sort by typical pipeline order: lead → content → outreach → performance
          const pipelineOrder: Record<string, number> = {
            'lead_generation': 1,
            'content_studio': 2,
            'outreach': 3,
            'performance_marketing': 4,
          };
          const orderedAgents = pipelineAgents
            .map(([key]) => key)
            .sort((a, b) => (pipelineOrder[a] || 99) - (pipelineOrder[b] || 99));

          const getAgentReason = (agentKey: string): string => {
            if (agentDescriptions && agentDescriptions[agentKey]) {
              return agentDescriptions[agentKey];
            }
            const reasons: Record<string, string> = {
              'lead_generation': 'Finds & qualifies leads matching your ICP criteria and target segments',
              'content_studio': 'Creates targeted content aligned to your identified channels and audience',
              'outreach': 'Automates personalized multi-channel outreach to your prospect list',
              'performance_marketing': 'Runs paid campaigns optimized for your audience goals and budget',
            };
            return reasons[agentKey] || 'Optimized for your ICP and campaign objectives';
          };

          return (
            <div className="mb-5 rounded-xl overflow-hidden border border-border/40 bg-card shadow-sm transition-all hover:border-primary/20 group/pipeline">
              {/* Header */}
              <div className="bg-primary/[0.03] px-4 py-2.5 border-b border-border/40 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="p-3.5 bg-background/20 rounded-lg border border-border/40">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-1 h-1 rounded-full bg-primary" />
                    <p className="text-xs text-foreground leading-tight">Recommended Workflow</p>
                  </div>
  <p className="text-xs text-muted-foreground/60 mt-1">{userIntent || 'Optimized Sequence'}</p>
                  </div>
                </div>
                <Badge className="text-xs bg-primary/10 text-primary border border-primary/20 rounded px-2">
                  {pipelineAgents.length} Agents
                </Badge>
              </div>
              {/* Pipeline Cards */}
              <div className="p-3 bg-muted/5 overflow-x-auto custom-scrollbar">
                <div className="flex items-stretch gap-0 min-w-max">
                  {orderedAgents.map((agentKey, idx) => {
                    const info = agentPipelineInfo[agentKey];
                    const score = recommendedAgentScores[agentKey as keyof typeof recommendedAgentScores] || 0;
                    if (!info) return null;
                    const reason = getAgentReason(agentKey);
                    return (
                      <div key={agentKey} className="flex items-center">
                        {/* Stage Card */}
                        <div className="w-36 rounded-xl bg-card border border-border/40 p-3 group/stage hover:border-primary/30 transition-all shadow-sm">
                          <div className="flex flex-col items-center gap-2 text-center">
                            <span className="text-[10px] text-muted-foreground">Stage {idx + 1}</span>
                            {/* Avatar + Score */}
                            <div className="relative group/avatar">
                              <div
                                className="w-10 h-10 rounded-full overflow-hidden shadow-md border-2 transition-transform group-hover/avatar:scale-110 duration-500"
                                style={{ borderColor: info.ringColor, backgroundColor: `${info.ringColor}20` }}
                              >
                                <AgentAvatarImg src={info.avatar} alt={info.name} initials={info.name.charAt(0)} className="w-full h-full object-contain" />
                              </div>
                              <div
                                className="absolute -bottom-0.5 -right-0.5 rounded-full px-1 py-0.5 text-[6px] font-semibold border shadow-lg bg-background"
                                style={{ borderColor: info.ringColor, color: info.ringColor }}
                              >
                                {score}%
                              </div>
                            </div>
                            <div>
                              <p className="text-xs font-semibold text-foreground leading-tight">{info.label}</p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">{info.name}</p>
                            </div>
                            <p className="text-[10px] text-muted-foreground leading-relaxed mt-1 line-clamp-2">&quot;{reason}&quot;</p>
                          </div>
                        </div>
                        {/* Connector Arrow */}
                        {idx < orderedAgents.length - 1 && (
                          <div className="flex items-center justify-center w-8 shrink-0">
                            <ArrowRight className="w-3.5 h-3.5 text-border/30" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })()}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {sortedAgents.map((agent) => {
            const isLoading = loadingAgent === agent.id;
            const execution = executions.get(agent.id);
            const score = getAgentScore(agent.id);
            const _isTop = isTopRecommended(agent.id);
            const impactScore = score ?? 0;

            return (
              <div
                key={agent.id}
                onClick={() => handleSelectAgent(agent)}
                className={cn(
                  "rounded-xl flex flex-col h-auto transition-all duration-500 cursor-pointer group relative select-none overflow-hidden border border-border/40 shadow-sm",
                  selectedAgentIds.has(agent.id) ? "bg-card border-primary/50 ring-1 ring-primary/30 shadow-sm shadow-primary/5" : "bg-card hover:bg-card hover:border-primary/20 hover:shadow hover:shadow-primary/5"
                )}
              >
                {/* Explicit keyboard-accessible team selection */}
                <button
                  type="button"
                  aria-label={`${selectedAgentIds.has(agent.id) ? 'Remove' : 'Select'} ${agent.name} ${selectedAgentIds.has(agent.id) ? 'from' : 'for'} team`}
                  aria-pressed={selectedAgentIds.has(agent.id)}
                  onClick={(event) => { event.stopPropagation(); handleSelectAgent(agent); }}
                  className={cn(
                    "absolute right-4 top-4 z-10 flex h-7 w-7 items-center justify-center rounded-lg border shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selectedAgentIds.has(agent.id) ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-primary",
                  )}
                >
                  {selectedAgentIds.has(agent.id) ? <Check className="h-4 w-4" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
                </button>

                {/* Card Content */}
                <div className="p-3.5 space-y-3 flex-1">
                  <div className="flex items-start gap-3">
                    <div className={cn(
                      "w-12 h-12 rounded-lg overflow-hidden ring-1 shadow-sm flex-shrink-0 transition-all duration-700  relative",
                      getRingColor(agent.id)
                    )} style={{ backgroundColor: getAvatarBgColor(agent.id) }}>
                      <div className="absolute inset-0 bg-gradient-to-tr from-black/20 to-transparent opacity-40" />
                      <AgentAvatarImg
                        src={agent.avatar}
                        alt={agent.name}
                        initials={agent.name.split(' ').map(n => n[0]).join('')}
                        className="w-full h-full object-contain p-1.5 relative z-10"
                      />
                    </div>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h3 className={cn("text-sm font-semibold leading-none", getNameColor(agent.id))}>{agent.name}</h3>
                        {activeAgentIds.has(agent.id) && (
                          <Badge variant="outline" className="h-4 rounded px-1 text-[10px] font-medium text-emerald-700 border-emerald-500/30 bg-emerald-500/5 dark:text-emerald-400">
                            On this campaign
                          </Badge>
                        )}
                        {score !== undefined && score > 0 && (
                          <Badge
                            className="text-[10px] font-medium px-1 py-0.5 rounded border"
                            style={{
                              backgroundColor: `${agentRingColors[agent.id] || '#b48cf2'}15`,
                              borderColor: `${agentRingColors[agent.id] || '#b48cf2'}40`,
                              color: agentRingColors[agent.id] || '#b48cf2',
                            }}
                          >
                            {score}%
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{agent.role}</p>
                      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2 mt-1">{agentDescriptions?.[agentIdToScoreKey[agent.id]] || agent.description}</p>
                    </div>
                  </div>

                  {/* Stats Grid */}
                  <div className="grid grid-cols-1 gap-1.5">
                    <div className="flex items-center gap-1.5 p-1.5 rounded-lg bg-card border border-border/40 group-hover:bg-card/60 transition-colors">
                      <div className="w-5 h-5 rounded-md bg-primary/10 flex items-center justify-center border border-primary/10">
                        <Clock className="w-2.5 h-2.5 text-primary" />
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground mb-0.5">Typical time per task</p>
                        <p className="text-xs font-semibold">{agent.estimatedTime}</p>
                      </div>
                    </div>
                  </div>

                  {/* Impact Score Bar */}
                  {impactScore > 0 && (
                    <div className="space-y-2 pt-1">
                      <div className="flex items-center justify-between px-1">
                        <span className="text-[10px] text-muted-foreground">Impact Score</span>
                        <span className="text-[10px] font-semibold text-primary">{getImpactLabel(impactScore)}</span>
                      </div>
                      <div className="w-full h-1 bg-muted/40 rounded-full overflow-hidden relative border border-border/10">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${impactScore}%` }}
                          transition={{ duration: 1.5, ease: "easeOut" }}
                          className={cn("h-full rounded-full bg-gradient-to-r shadow-[0_0_10px_hsl(var(--primary)/0.3)]", getImpactGradient(agent.id))}
                        />
                      </div>
                    </div>
                  )}

                  {/* Benefits */}
                  {agent.benefits && agent.benefits.length > 0 && (
                    <div className="pt-0.5 space-y-1.5">
                      <div className="flex items-center gap-2 ml-1">
                        <Zap className="w-2 h-2 text-primary/40" />
                        <p className="text-[10px] text-muted-foreground">Agent Benefits</p>
                      </div>
                      <div className="grid grid-cols-1 gap-1">
                        {agent.benefits.slice(0, 3).map((benefit, index) => (
                          <div key={index} className="flex items-center gap-1.5 p-1 rounded-md bg-primary/[0.02] border border-primary/5 hover:border-primary/20 transition-all group/benefit">
                            <div className="w-2.5 h-2.5 rounded-sm bg-primary/10 flex items-center justify-center group-hover/benefit:bg-primary group-hover/benefit:text-primary transition-all">
                              <Check className="w-1 h-1" strokeWidth={5} />
                            </div>
                            <span className="text-xs text-foreground/70">{benefit}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Hire Button */}
                <div className="px-3.5 pb-3.5 pt-0.5 mt-auto">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleHireClick(agent);
                    }}
                    disabled={isLoading || execution?.status === 'running'}
                    className={cn(
                      "w-full h-8 font-medium text-xs rounded-lg transition-all flex items-center justify-center gap-1.5",
                      execution?.status === 'completed' ? "bg-emerald-500 text-white cursor-default" :
                        selectedAgentIds.has(agent.id) ? "bg-primary text-primary-foreground shadow-primary/30 hover:shadow-primary/40" :
                          !isLoading ? "bg-card border border-primary/20 text-foreground hover:bg-primary/10 hover:border-primary/40" :
                            "bg-muted text-muted-foreground cursor-not-allowed opacity-60"
                    )}
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover/btn:animate-shimmer" />
                    {isLoading && <Loader2 className="h-2 w-2 animate-spin" />}
                    {execution?.status === 'running' && <Play className="h-2 w-2 animate-pulse" />}
                    {execution?.status === 'completed' && <CheckCircle2 className="h-2 w-2" />}
                    {execution?.status === 'error' && <AlertCircle className="h-2 w-2" />}

                    <span className="relative z-10">
                      {execution?.status === 'running' ? 'Syncing...' :
                        selectedAgent?.id === agent.id && execution?.status === 'completed' ? 'Synced' :
                          execution?.status === 'error' ? 'Retry' :
                            activeAgentIds.has(agent.id) ? `Continue with ${agent.name.split(' ')[0]}` :
                            `Start ${agent.name.split(' ')[0]}`}
                    </span>
                    {!isLoading && execution?.status !== 'running' && execution?.status !== 'completed' && (
                      <ArrowRight className="w-2 h-2 relative z-10 group-hover/btn:translate-x-1 transition-transform" />
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Fixed Footer */}
      {selectedAgentIds.size >= 2 ? (
        <div className="p-3 sm:p-4 border-t border-border/50 bg-background/80 flex-none animate-in slide-in-from-bottom duration-500">
          <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 sm:gap-8">
            <div className="flex-1">
              <p className="text-xs font-medium text-muted-foreground mb-3">Hire multiple agents</p>
              <div className="flex flex-wrap gap-2">
                {agents.filter(a => selectedAgentIds.has(a.id)).map(a => (
                  <Badge key={a.id} variant="secondary" className="gap-2 px-3 py-1.5 rounded-xl bg-primary/10 text-primary border-primary/20 hover:bg-primary/20 text-xs font-bold transition-all shadow-sm">
                    {a.name}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeselectAgent(a); }}
                      disabled={isHiringTeam}
                      className="ml-1 hover:text-destructive transition-colors"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    </button>
                  </Badge>
                ))}
              </div>
            </div>
            <Button
              onClick={handleHireSelected}
              loading={isHiringTeam}
              loadingText="Assembling Team…"
              disabled={!onHireMultipleAgents}
              size="lg"
              className="w-full sm:w-auto h-8 px-4 rounded-lg bg-primary text-primary-foreground text-xs gap-1.5 group"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:animate-shimmer" />
              <div className="flex items-center justify-center gap-3 relative z-10">
                <Users className="h-4 w-4 group-hover:scale-110 transition-transform" />
                Hire Team & Start Workflow
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </div>
            </Button>
          </div>
        </div>
      ) : selectedAgentIds.size === 1 ? (
        <div className="p-4 border-t bg-background/95 supports-[backdrop-filter]:bg-background/60 flex-none">
          <div className="max-w-2xl mx-auto">
            {(() => {
              const agentId = [...selectedAgentIds][0];
              const agent = agents.find(a => a.id === agentId);
              if (!agent) return null;
              return (
                <Button
                  onClick={() => handleHireClick(agent)}
                  loading={loadingAgent === agent.id}
                  loadingText="Starting..."
                  className="w-full h-8 rounded-lg bg-primary text-primary-foreground text-xs gap-1.5 group"
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:animate-shimmer" />
                  <div className="flex items-center justify-center gap-3 relative z-10">
                    <span>Book {agent.name}</span>
                    <Play className="h-4 w-4 fill-current transition-transform group-hover:translate-x-1" />
                  </div>
                </Button>
              );
            })()}
          </div>
        </div>
      ) : null}
    </div>
  );
}
