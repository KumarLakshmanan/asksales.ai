import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  CheckCircle2,
  Building2,
  Users,
  Target,
  MessageSquare,
  Mail,
  Phone,
  Linkedin,
  TrendingUp,
  FileText,
  Sparkles
} from "lucide-react";

// Types for action-based updates
export interface ActionUpdate {
  id: string;
  type: 'business_profile' | 'icp' | 'leads' | 'outreach' | 'content' | 'analytics';
  action: 'saving' | 'saved' | 'creating' | 'created' | 'updating' | 'updated' | 'error' | 'in_progress';
  title: string;
  description?: string;
  data?: Record<string, unknown>;
  timestamp: Date;
}

export interface OutreachProgress {
  channelsActivated: string[];
  messagingStatus: 'pending' | 'in_progress' | 'finalized' | 'deployed';
  messagesQueued: number;
  firstResponsesExpected: string;
  engagementTracking: 'pending' | 'active';
}

export interface LiveSignal {
  id?: string;
  type: 'open' | 'click' | 'reply' | 'bounce' | 'info' | 'success' | 'warning' | 'error';
  platform?: string;
  message?: string;
  source?: string;
  prospect?: string;
  timestamp: Date;
}

interface ActionSnapshotPanelProps {
  actionUpdates?: ActionUpdate[];
  actions?: ActionUpdate[];
  outreachProgress?: OutreachProgress | null;
  liveSignals?: LiveSignal[];
  businessProfile?: {
    id?: number;
    name?: string;
    companyName?: string;
    industry?: string;
    location?: string;
    targetMarket?: string;
    description?: string;
    status?: string;
  } | null;
  businessProfileData?: {
    name?: string;
    industry?: string;
    status?: string;
  } | null;
  icpProfile?: {
    id?: number;
    campaignName?: string;
    targetAudience?: string;
    industry?: string;
    fitScore?: number;
  } | null;
  icpProfileData?: {
    name?: string;
    targetAudience?: string;
    status?: string;
  } | null;
  isVisible?: boolean;
  onClearActions?: () => void;
  onClearSignals?: () => void;
}

export default function ActionSnapshotPanel({
  actionUpdates,
  actions,
  outreachProgress,
  liveSignals = [],
  businessProfile,
  businessProfileData,
  icpProfile,
  icpProfileData,
  isVisible = true,
  onClearActions: _onClearActions,
  onClearSignals: _onClearSignals,
}: ActionSnapshotPanelProps) {
  const [_showPanel, setShowPanel] = useState(isVisible);

  // Merge actionUpdates and actions (support both prop names)
  const allActions = actionUpdates || actions || [];

  // Merge business profile data (support both prop patterns)
  const effectiveBusinessProfile = businessProfile || (businessProfileData ? {
    name: businessProfileData.name,
    industry: businessProfileData.industry,
  } : null);

  // Merge ICP profile data (support both prop patterns)
  const effectiveIcpProfile = icpProfile || (icpProfileData ? {
    campaignName: icpProfileData.name,
    targetAudience: icpProfileData.targetAudience,
  } : null);

  useEffect(() => {
    setShowPanel(isVisible);
  }, [isVisible]);

  // Don't render if nothing to show - show default state instead of hiding
  const hasContent = allActions.length > 0 || outreachProgress || effectiveBusinessProfile || effectiveIcpProfile || liveSignals.length > 0;

  // Get the most recent action by type
  const latestActions = allActions.reduce((acc, action) => {
    if (!acc[action.type] || action.timestamp > acc[action.type].timestamp) {
      acc[action.type] = action;
    }
    return acc;
  }, {} as Record<string, ActionUpdate>);

  const getActionIcon = (type: string) => {
    switch (type) {
      case 'business_profile': return <Building2 className="h-4 w-4" />;
      case 'icp': return <Target className="h-4 w-4" />;
      case 'leads': return <Users className="h-4 w-4" />;
      case 'outreach': return <MessageSquare className="h-4 w-4" />;
      case 'content': return <FileText className="h-4 w-4" />;
      case 'analytics': return <TrendingUp className="h-4 w-4" />;
      default: return <Sparkles className="h-4 w-4" />;
    }
  };

  const getStatusBadge = (action: string) => {
    switch (action) {
      case 'saving':
      case 'creating':
      case 'updating':
      case 'in_progress':
        return <StatusBadge tone="progress" label="In Progress" />;
      case 'saved':
      case 'created':
      case 'updated':
        return <StatusBadge tone="success" label="Complete" />;
      case 'error':
        return <StatusBadge tone="danger" label="Error" />;
      default:
        return null;
    }
  };

  return (
    <div className="h-full flex flex-col bg-background p-5 overflow-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3 px-1">
        <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center text-primary border border-primary/20">
          <Sparkles className="h-4.5 w-4.5" />
        </div>
        <div className="space-y-0.5">
          <h2 className="text-sm font-black text-foreground uppercase tracking-widest leading-none">
            Activity Feed
          </h2>
          <p className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60">
            Real-time action monitoring
          </p>
        </div>
      </div>

      {/* Empty State */}
      {!hasContent && (
        <div className="flex-1 flex flex-col items-center justify-center py-12 px-4">
          <div className="text-center space-y-4 max-w-sm">
            <div className="flex justify-center">
              <div className="text-6xl opacity-40">
                🚴
              </div>
            </div>
            <p className="text-sm text-muted-foreground font-medium leading-relaxed">
              Updates will appear here as the campaign progresses.
            </p>
          </div>
        </div>
      )}

      {/* Business Profile Card */}
      {effectiveBusinessProfile && (
        <Card className="rounded-xl border border-border/40 bg-card/30 backdrop-blur-xl shadow-sm">
          <CardHeader className="p-4 border-b border-border/40">
            <CardTitle className="text-[10px] font-black uppercase tracking-widest flex items-center gap-2 text-muted-foreground/60">
              <Building2 className="h-3.5 w-3.5 text-primary" />
              Lead Profile
              <div className="ml-auto">
                {latestActions['business_profile'] && getStatusBadge(latestActions['business_profile'].action)}
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/50">Company</span>
                <p className="text-xs font-bold text-foreground leading-none">{effectiveBusinessProfile.companyName || effectiveBusinessProfile.name || 'N/A'}</p>
              </div>
              <div className="space-y-1">
                <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/50">Industry</span>
                <p className="text-xs font-bold text-foreground leading-none">{effectiveBusinessProfile.industry || 'N/A'}</p>
              </div>
              <div className="space-y-1">
                <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/50">Geography</span>
                <p className="text-xs font-bold text-foreground leading-none">{effectiveBusinessProfile.location || 'N/A'}</p>
              </div>
              <div className="space-y-1">
                <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/50">Market focus</span>
                <p className="text-xs font-bold text-foreground leading-none">{effectiveBusinessProfile.targetMarket || 'N/A'}</p>
              </div>
            </div>
            {effectiveBusinessProfile.description && (
              <div className="pt-2 space-y-1">
                <span className="text-muted-foreground text-xs font-medium">Description</span>
                <p className="text-muted-foreground text-xs leading-relaxed">{effectiveBusinessProfile.description}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ICP Profile Card */}
      {effectiveIcpProfile && (
        <Card className="rounded-xl border border-border/40 bg-card/30 backdrop-blur-xl shadow-sm">
          <CardHeader className="p-4 border-b border-border/40">
            <CardTitle className="text-[10px] font-black uppercase tracking-widest flex items-center gap-2 text-muted-foreground/60">
              <Target className="h-3.5 w-3.5 text-primary" />
              Targeting Parameters
              <div className="ml-auto">
                {latestActions['icp'] && getStatusBadge(latestActions['icp'].action)}
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/50">Campaign</span>
                <p className="text-xs font-bold text-foreground leading-none">{effectiveIcpProfile.campaignName || 'N/A'}</p>
              </div>
              <div className="space-y-1">
                <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/50">Industry</span>
                <p className="text-xs font-bold text-foreground leading-none">{effectiveIcpProfile.industry || 'N/A'}</p>
              </div>
              <div className="space-y-1">
                <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/50">Ideal Prospect</span>
                <p className="text-xs font-bold text-foreground leading-none">{effectiveIcpProfile.targetAudience || 'N/A'}</p>
              </div>
              {effectiveIcpProfile.fitScore !== undefined && (
                <div className="space-y-1">
                  <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/50">Alignment</span>
                  <p className="text-xs font-black text-primary leading-none">{effectiveIcpProfile.fitScore}%</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Outreach Progress */}
      {outreachProgress && (
        <Card className="mb-5 border border-border bg-card/80 shadow-lg backdrop-blur">
          <CardHeader className="pb-3 border-b border-border">
            <CardTitle className="text-sm font-semibold flex items-center gap-2 text-foreground">
              <MessageSquare className="h-4 w-4 text-emerald-500 dark:text-emerald-400" />
              Outreach In Progress
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            {/* Channels & Status Row */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 bg-muted/50 border border-border rounded-lg">
                <p className="text-xs text-muted-foreground mb-2 font-medium">Channels Activated</p>
                <div className="flex flex-wrap gap-1.5">
                  {outreachProgress.channelsActivated.map((channel, idx) => (
                    <Badge key={idx} variant="outline" className="text-xs bg-muted/50 text-foreground border-border">
                      {channel === 'linkedin' && <Linkedin className="h-3 w-3 mr-1" />}
                      {channel === 'email' && <Mail className="h-3 w-3 mr-1" />}
                      {channel === 'calls' && <Phone className="h-3 w-3 mr-1" />}
                      {channel}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="p-3 bg-muted/50 border border-border rounded-lg">
                <p className="text-xs text-muted-foreground mb-2 font-medium">Messaging Status</p>
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 dark:text-emerald-400" />
                  <span className="text-sm font-medium capitalize text-foreground">{outreachProgress.messagingStatus}</span>
                </div>
              </div>
            </div>

            {/* What Prospects See */}
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground font-medium">What Prospects Are Seeing</p>
              <div className="grid grid-cols-3 gap-2">
                <div className="p-2 bg-muted/50 border border-border rounded-lg text-center">
                  <Linkedin className="h-4 w-4 mx-auto text-blue-500 dark:text-blue-400 mb-1" />
                  <p className="text-xs text-muted-foreground">LinkedIn</p>
                </div>
                <div className="p-2 bg-muted/50 border border-border rounded-lg text-center">
                  <Mail className="h-4 w-4 mx-auto text-orange-500 dark:text-orange-400 mb-1" />
                  <p className="text-xs text-muted-foreground">Email</p>
                </div>
                <div className="p-2 bg-muted/50 border border-border rounded-lg text-center">
                  <Phone className="h-4 w-4 mx-auto text-teal-500 dark:text-teal-400 mb-1" />
                  <p className="text-xs text-muted-foreground">Calls</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Engagement Activity (Live Updates) */}
      {(liveSignals.length > 0 || outreachProgress) && (
        <Card className="mb-5 border border-border bg-card/80 shadow-lg backdrop-blur">
          <CardHeader className="pb-3 border-b border-border">
            <CardTitle className="text-sm font-semibold flex items-center gap-2 text-foreground">
              <TrendingUp className="h-4 w-4 text-yellow-500 dark:text-yellow-400" />
              Engagement Activity (Real-time)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm pt-4">
            {outreachProgress && (
              <div className="space-y-2.5">
                <div className="flex justify-between py-1.5">
                  <span className="text-muted-foreground text-xs font-medium">Messages queued:</span>
                  <span className="font-semibold text-foreground">{outreachProgress.messagesQueued}</span>
                </div>
                <div className="flex justify-between py-1.5">
                  <span className="text-muted-foreground text-xs font-medium">First responses expected:</span>
                  <span className="font-semibold text-foreground">{outreachProgress.firstResponsesExpected}</span>
                </div>
                <div className="flex justify-between items-center py-1.5">
                  <span className="text-muted-foreground text-xs font-medium">Engagement tracking:</span>
                  <Badge variant="outline" className={outreachProgress.engagementTracking === 'active' ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-600 dark:border-emerald-700' : 'bg-muted text-muted-foreground border-border text-xs'}>
                    {outreachProgress.engagementTracking === 'active' ? 'Active' : 'Pending'}
                  </Badge>
                </div>
              </div>
            )}
            {liveSignals.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border">
                {liveSignals.slice(0, 5).map((signal, idx) => (
                  <div key={idx} className="flex items-center gap-2 py-1.5 text-xs text-muted-foreground">
                    {signal.type === 'open' && <Mail className="h-3 w-3 text-blue-500 dark:text-blue-400" />}
                    {signal.type === 'click' && <TrendingUp className="h-3 w-3 text-emerald-500 dark:text-emerald-400" />}
                    {signal.type === 'reply' && <MessageSquare className="h-3 w-3 text-violet-500 dark:text-violet-400" />}
                    <span>{signal.prospect || 'Prospect'} {signal.type}ed {signal.platform} message</span>
                  </div>
                ))}
              </div>
            )}
            {liveSignals.length === 0 && (
              <p className="text-xs text-muted-foreground italic">
                Updates will appear here as prospects open, click, or reply.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Recent Actions List */}
      {Object.keys(latestActions).length > 0 && (
        <Card className="border border-border bg-card/80 shadow-lg backdrop-blur">
          <CardHeader className="pb-3 border-b border-border">
            <CardTitle className="text-sm font-semibold text-foreground">Recent Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-4">
            {Object.values(latestActions).map((action) => (
              <div key={action.id} className="flex items-center justify-between p-2.5 bg-muted/50 border border-border rounded-lg hover:bg-muted/70 transition-colors">
                <div className="flex items-center gap-2 text-muted-foreground">
                  {getActionIcon(action.type)}
                  <span className="text-xs font-medium">{action.title}</span>
                </div>
                {getStatusBadge(action.action)}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
