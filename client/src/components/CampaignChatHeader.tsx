import { useEffect, useState } from 'react';
import { Search, UsersRound } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ConversationHeader } from '@/components/conversation/ConversationHeader';
import { getPersona } from '@/lib/agent-personas';

interface Agent {
    id: string;
    name: string;
    avatar?: string;
    initials: string;
    color: string;
    agentType?: string;
}

interface CampaignChatHeaderProps {
    campaignName?: string;
    lastMessageAt?: number | string | Date;
    lastUpdated?: string | Date;
    duration?: string;
    isActive?: boolean;
    agents?: Agent[];
    activeView?: 'campaign' | 'overview';
    onViewChange?: (view: 'campaign' | 'overview') => void;
    onSearch?: () => void;
    threadId?: number | null;
    onAgentClick?: (agent: Agent) => void;
    onManageAgents?: () => void;
}

function getRelativeDuration(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} min${diffMins !== 1 ? 's' : ''}`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''}`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''}`;
    const diffWeeks = Math.floor(diffDays / 7);
    return `${diffWeeks} week${diffWeeks !== 1 ? 's' : ''}`;
}

export default function CampaignChatHeader({
    campaignName = 'New campaign',
    lastMessageAt,
    lastUpdated,
    duration,
    isActive = true,
    agents = [],
    activeView = 'overview',
    onViewChange,
    onSearch,
     
    threadId,
    onAgentClick,
    onManageAgents,
}: CampaignChatHeaderProps) {
    const [relativeTime, setRelativeTime] = useState<string>('');

    useEffect(() => {
        if (!lastMessageAt) return;
        const date = new Date(lastMessageAt);
        setRelativeTime(getRelativeDuration(date));
        const interval = setInterval(() => {
            setRelativeTime(getRelativeDuration(date));
        }, 60000);
        return () => clearInterval(interval);
    }, [lastMessageAt]);

    const handleViewChange = (newView: 'campaign' | 'overview') => {
        onViewChange?.(newView);
    };

    const getAgentRingColor = (agent: Agent) => {
        const key = (agent.agentType || agent.id || 'orchestrator').toLowerCase().replaceAll('-', '_');
        return getPersona(key).ringColor;
    };

    const subtitle = lastMessageAt
        ? `Last activity ${new Date(lastMessageAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${relativeTime ? ` · ${relativeTime === 'just now' ? relativeTime : `${relativeTime} ago`}` : ''}`
        : lastUpdated
            ? `Updated ${typeof lastUpdated === 'string' ? lastUpdated : lastUpdated.toLocaleDateString()}${duration ? ` · ${duration}` : ''}`
            : threadId ? 'No activity yet' : 'Not saved yet';

    return (
        <ConversationHeader
            className="campaign-workspace-heading"
            compactOnMobile
            title={campaignName}
            eyebrow="Campaign workspace"
            subtitle={subtitle}
            status={isActive && threadId ? <span className="inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success"><span className="h-1.5 w-1.5 rounded-full bg-success" />Active</span> : null}
            participants={agents.length > 0 ? (
                <div className="flex min-w-0 items-center gap-2" aria-label="Campaign agents">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Team</span>
                    <div className="flex -space-x-1.5">
                        {agents.slice(0, 5).map((agent) => (
                            <button
                                key={agent.id}
                                type="button"
                                className="group relative shrink-0 cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                                onClick={() => onAgentClick?.(agent)}
                                title={agent.name}
                                aria-label={`Open ${agent.name}`}
                            >
                                <div className="h-8 w-8 rounded-full p-[2px] transition-transform group-hover:-translate-y-0.5" style={{ backgroundColor: getAgentRingColor(agent) }}>
                                    <div className="h-full w-full rounded-full bg-background p-[1px]">
                                        <Avatar className="h-full w-full rounded-full">
                                            <AvatarImage src={agent.avatar} alt={agent.name} className="h-full w-full object-contain" />
                                            <AvatarFallback className="bg-muted text-[9px] font-semibold text-foreground">{agent.initials}</AvatarFallback>
                                        </Avatar>
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            ) : undefined}
            actions={(
                <>
                {onManageAgents && <button
                    type="button"
                    onClick={onManageAgents}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border/70 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-2.5"
                    aria-label="Manage agents"
                    title="Manage agents"
                >
                    <UsersRound className="h-4 w-4" aria-hidden="true" />
                    <span className="hidden sm:inline">Manage agents</span>
                </button>}
                <button
                    type="button"
                    onClick={onSearch}
                    className="flex h-9 w-9 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Search workspace views"
                    title="Search workspace views"
                >
                    <Search className="h-4 w-4" />
                </button>
                </>
            )}
            tabs={threadId ? [{ id: 'overview', label: 'Overview' }, { id: 'campaign', label: 'Campaign' }] : undefined}
            activeTab={activeView}
            onTabChange={(tab) => handleViewChange(tab as 'campaign' | 'overview')}
        />
    );
}
