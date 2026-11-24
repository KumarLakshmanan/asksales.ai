import { useState, useEffect, useCallback } from 'react';
import CampaignsAnalytics from "@/components/CampaignsAnalytics";
import CampaignsListView from "@/components/CampaignsListView";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  RefreshCw, Target, Play, Pause,
  ExternalLink, Facebook, BarChart3, Trash2, MoreHorizontal, Loader2
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import api from '@/lib/api';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatCount as formatNumber } from "@/lib/display-format";

interface MetaCampaign {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  objective: string;
  created_time: string;
  daily_budget?: string;
  lifetime_budget?: string;
  insights?: {
    impressions: string;
    clicks: string;
    spend: string;
    reach: string;
    cpc: string;
    cpm: string;
    ctr: string;
  };
}

interface MetaAdset {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  daily_budget?: string;
  optimization_goal?: string;
  insights?: {
    impressions: string;
    clicks: string;
    spend: string;
    reach?: string;
    ctr: string;
    cpc: string;
  };
}

interface ThreadStats {
  leadsCount: number;
  outreachCount: number;
  scrapingCount: number;
  messageCount: number;
  icpFitScore: number;
}

interface CampaignsTabProps {
  icpId?: number;
  threadId?: number;
}

export default function CampaignsTab({ icpId, threadId }: CampaignsTabProps) {
  const { toast } = useToast();
  const [activeView, setActiveView] = useState<'overview' | 'list' | 'analytics'>('overview');
  const [metaCampaigns, setMetaCampaigns] = useState<MetaCampaign[]>([]);
  const [campaignAdsets, setCampaignAdsets] = useState<Record<string, MetaAdset[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [expandedCampaigns, setExpandedCampaigns] = useState<Set<string>>(new Set());
  const [useCache, setUseCache] = useState(true);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'campaign' | 'adset'; id: string; name: string } | null>(null);
  const [allowedMetaCampaignIds, setAllowedMetaCampaignIds] = useState<string[] | null | undefined>(undefined);
  const [requiresMetaConnection, setRequiresMetaConnection] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [threadStats, setThreadStats] = useState<ThreadStats>({ leadsCount: 0, outreachCount: 0, scrapingCount: 0, messageCount: 0, icpFitScore: 0 });


  // Fetch real thread stats (leads, outreach, ICP score) to match Overview tab
  const fetchThreadStats = useCallback(async () => {
    if (!threadId) return;
    try {
      const result = await api.get<{
        stats: { leadsCount: number; outreachCount: number; scrapingCount: number; messageCount: number };
        icp: { fit_score: number } | null;
      }>(`/api/chat/threads/${threadId}/overview`);
      setThreadStats({
        leadsCount: result.stats?.leadsCount ?? 0,
        outreachCount: result.stats?.outreachCount ?? 0,
        scrapingCount: result.stats?.scrapingCount ?? 0,
        messageCount: result.stats?.messageCount ?? 0,
        icpFitScore: result.icp?.fit_score ?? 0,
      });
    } catch (err) {
      console.error('Error loading thread stats for campaigns:', err);
    }
  }, [threadId]);

  useEffect(() => {
    fetchThreadStats();
  }, [fetchThreadStats]);

  useEffect(() => {
    const loadFilteredCampaigns = async () => {
      setAllowedMetaCampaignIds(undefined);
      if (threadId || icpId) {
        try {
          const filterParam = threadId ? `thread_id=${threadId}` : `icp_id=${icpId}`;
          const response = await api.get<{ campaigns: Array<{ meta_campaign_id?: string }> }>(
            `/api/campaigns/performance/campaigns?${filterParam}`
          );
          const ids = response.campaigns?.filter(c => c.meta_campaign_id).map(c => c.meta_campaign_id!) || [];
          setAllowedMetaCampaignIds(ids);
        } catch (error) {
          console.error('Error loading filtered campaigns:', error);
          setAllowedMetaCampaignIds([]);
        }
      } else {
        setAllowedMetaCampaignIds(null);
      }
    };
    loadFilteredCampaigns();
  }, [icpId, threadId]);

  useEffect(() => {
    if (allowedMetaCampaignIds !== undefined) {
      loadCampaignsFromCache();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedMetaCampaignIds]);

  const loadCampaignsFromCache = async () => {
    try {
      setLoading(true);
      setApiError(null);
      setRequiresMetaConnection(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cacheResponse = await api.get<{ campaigns: any[], lastRefreshedAt: string | null }>('/api/campaigns/meta/cache/campaigns');
      if (cacheResponse.campaigns && cacheResponse.campaigns.length > 0) {
        let cachedCampaigns: MetaCampaign[] = cacheResponse.campaigns.map(c => ({
          id: c.platformEntityId, name: c.name || 'Unnamed Campaign', status: c.status, effective_status: c.status,
          objective: c.rawData?.campaign?.objective || 'OUTCOME_AWARENESS', created_time: c.rawData?.campaign?.created_time || new Date().toISOString(),
          insights: { impressions: String(c.impressions || 0), clicks: String(c.clicks || 0), spend: String(c.spend || 0), reach: String(c.reach || 0), cpc: String(c.cpc || 0), cpm: String(c.cpm || 0), ctr: String(c.ctr || 0) }
        }));
        if (Array.isArray(allowedMetaCampaignIds)) {
          cachedCampaigns = cachedCampaigns.filter(c => allowedMetaCampaignIds.includes(c.id));
        }
        setMetaCampaigns(cachedCampaigns);
        if (cacheResponse.lastRefreshedAt) setLastRefreshed(new Date(cacheResponse.lastRefreshedAt));
        setUseCache(true);
      } else {
        await loadMetaCampaigns();
      }
    } catch (error) {
      console.error('Error loading cached campaigns:', error);
      await loadMetaCampaigns();
    } finally {
      setLoading(false);
    }
  };

  const loadMetaCampaigns = async () => {
    try {
      setApiError(null);
      setRequiresMetaConnection(false);
      const response = await api.get<{ campaigns: MetaCampaign[], requiresConnection?: boolean, error?: string }>('/api/campaigns/meta/campaigns?datePreset=last_30d');
      if (response.requiresConnection) { setRequiresMetaConnection(true); setMetaCampaigns([]); return; }
      let campaigns = response.campaigns || [];
      if (Array.isArray(allowedMetaCampaignIds)) {
        campaigns = campaigns.filter(c => allowedMetaCampaignIds.includes(c.id));
      }
      setMetaCampaigns(campaigns);
      setLastRefreshed(new Date());
      setUseCache(false);
    } catch (error: unknown) {
      console.error('Error loading Meta campaigns:', error);
      const err = error as { response?: { data?: { requiresConnection?: boolean } }; message?: string };
      if (err?.response?.data?.requiresConnection || err?.message?.includes('credentials') || err?.message?.includes('access token')) {
        setRequiresMetaConnection(true);
        setApiError('Meta Ads access token not configured. Please connect your Meta account in Settings.');
      } else {
        setApiError(err?.message || 'Failed to load campaigns from Meta');
      }
      toast({ title: 'Error', description: err?.message || 'Failed to load campaigns from Meta', variant: 'destructive' });
    }
  };

  const refreshCampaigns = async () => {
    setRefreshing(true);
    try {
      await api.post<{ lastRefreshedAt: string }>('/api/campaigns/meta/cache/refresh', { platform: 'meta', datePreset: 'last_30d' });
      await loadCampaignsFromCache();
      toast({ title: 'Refreshed', description: 'Campaign data has been updated from Meta' });
    } catch (error) {
      console.error('Error refreshing campaigns:', error);
      toast({ title: 'Error', description: 'Failed to refresh campaign data', variant: 'destructive' });
    } finally {
      setRefreshing(false);
    }
  };

  const loadAdsets = async (campaignId: string) => {
    if (campaignAdsets[campaignId]) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cacheResponse = await api.get<{ adsets: any[] }>(`/api/campaigns/meta/cache/campaigns/${campaignId}/adsets`);
      if (cacheResponse.adsets && cacheResponse.adsets.length > 0) {
        const cachedAdsets: MetaAdset[] = cacheResponse.adsets.map(a => ({ id: a.platformEntityId, name: a.name || 'Unnamed Ad Set', status: a.status, effective_status: a.status, insights: { impressions: String(a.impressions || 0), clicks: String(a.clicks || 0), spend: String(a.spend || 0), reach: String(a.reach || 0), ctr: String(a.ctr || 0), cpc: String(a.cpc || 0) } }));
        setCampaignAdsets(prev => ({ ...prev, [campaignId]: cachedAdsets }));
      } else {
        const response = await api.get<{ adsets: MetaAdset[] }>(`/api/campaigns/meta/campaigns/${campaignId}/adsets?datePreset=last_30d`);
        setCampaignAdsets(prev => ({ ...prev, [campaignId]: response.adsets || [] }));
      }
    } catch (error) { console.error('Error loading adsets:', error); }
  };

  const toggleExpand = (campaignId: string) => {
    setExpandedCampaigns(prev => {
      const next = new Set(prev);
      if (next.has(campaignId)) { next.delete(campaignId); }
      else { next.add(campaignId); loadAdsets(campaignId); }
      return next;
    });
  };

  const handlePauseCampaign = async (campaignId: string) => {
    setActionInProgress(campaignId);
    try {
      await api.post(`/api/campaigns/meta/campaigns/${campaignId}/pause`, {});
      setMetaCampaigns(prev => prev.map(c => c.id === campaignId ? { ...c, status: 'PAUSED', effective_status: 'PAUSED' } : c));
      toast({ title: 'Campaign Paused', description: 'Campaign has been paused successfully' });
    } catch (error: unknown) {
      const err = error as { message?: string };
      toast({ title: 'Error', description: err?.message || 'Failed to pause campaign', variant: 'destructive' });
    } finally { setActionInProgress(null); }
  };

  const handleResumeCampaign = async (campaignId: string) => {
    setActionInProgress(campaignId);
    try {
      await api.post(`/api/campaigns/meta/campaigns/${campaignId}/resume`, {});
      setMetaCampaigns(prev => prev.map(c => c.id === campaignId ? { ...c, status: 'ACTIVE', effective_status: 'ACTIVE' } : c));
      toast({ title: 'Campaign Resumed', description: 'Campaign is now active' });
    } catch (error: unknown) {
      const err = error as { message?: string };
      toast({ title: 'Error', description: err?.message || 'Failed to resume campaign', variant: 'destructive' });
    } finally { setActionInProgress(null); }
  };

  const handleDeleteCampaign = async (campaignId: string) => {
    setActionInProgress(campaignId);
    try {
      await api.delete(`/api/campaigns/meta/campaigns/${campaignId}`);
      setMetaCampaigns(prev => prev.filter(c => c.id !== campaignId));
      toast({ title: 'Campaign Deleted', description: 'Campaign has been deleted successfully' });
    } catch (error: unknown) {
      const err = error as { message?: string };
      toast({ title: 'Error', description: err?.message || 'Failed to delete campaign', variant: 'destructive' });
    } finally { setActionInProgress(null); setDeleteConfirm(null); }
  };

  const handleDeleteAdset = async (adsetId: string, campaignId: string) => {
    setActionInProgress(adsetId);
    try {
      await api.delete(`/api/campaigns/meta/adsets/${adsetId}`);
      setCampaignAdsets(prev => ({ ...prev, [campaignId]: (prev[campaignId] || []).filter(a => a.id !== adsetId) }));
      toast({ title: 'Ad Set Deleted', description: 'Ad set has been deleted successfully' });
    } catch (error: unknown) {
      const err = error as { message?: string };
      toast({ title: 'Error', description: err?.message || 'Failed to delete ad set', variant: 'destructive' });
    } finally { setActionInProgress(null); setDeleteConfirm(null); }
  };

  const formatCurrency = (amount: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);

  const totals = metaCampaigns.reduce((acc, c) => {
    const ins = c.insights;
    return { spend: acc.spend + parseFloat(ins?.spend || '0'), impressions: acc.impressions + parseInt(ins?.impressions || '0'), clicks: acc.clicks + parseInt(ins?.clicks || '0'), reach: acc.reach + parseInt(ins?.reach || '0') };
  }, { spend: 0, impressions: 0, clicks: 0, reach: 0 });
  const avgCtr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;

  // Use real thread stats (from the same source as OverviewTab) for leads, outreach, ICP score
  const campaignsList = metaCampaigns.map(c => ({
    id: parseInt(c.id),
    threadTitle: c.name,
    icpScore: threadStats.icpFitScore,
    leadsCount: threadStats.leadsCount,
    outreachCount: threadStats.outreachCount,
    adSetsCount: campaignAdsets[c.id]?.length || 0,
    publishedAdsCount: 1,
    status: c.effective_status?.toLowerCase() === 'active' ? 'active' as const : c.effective_status?.toLowerCase() === 'paused' ? 'completed' as const : 'draft' as const,
    createdAt: c.created_time,
  }));
  const analyticsMetrics = {
    totalLeads: threadStats.leadsCount,
    totalOutreach: threadStats.outreachCount,
    totalAdSets: Object.values(campaignAdsets).flat().length,
    publishedAds: metaCampaigns.length,
    avgIcpScore: threadStats.icpFitScore,
    conversionRate: avgCtr,
  };

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b bg-card flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <BarChart3 className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold">Campaigns</p>
            {lastRefreshed && (
              <p className="text-xs text-muted-foreground">
                Updated {lastRefreshed.toLocaleTimeString()}{useCache ? ' (cached)' : ''}
              </p>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={refreshCampaigns} loading={refreshing} loadingText="Refreshing..."
          className="h-8 px-3 rounded-lg border-border/60 text-xs gap-1.5">
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </Button>
      </div>

      {/* Tab Nav */}
      <div className="px-3 py-2 border-b shrink-0">
        <Tabs value={activeView} onValueChange={(v) => setActiveView(v as typeof activeView)}>
          <TabsList className="h-8 bg-muted/40 p-1 rounded-lg w-full">
            <TabsTrigger value="overview" className="flex-1 h-6 rounded-md text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">Overview</TabsTrigger>
            <TabsTrigger value="list" className="flex-1 h-6 rounded-md text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">Campaign List</TabsTrigger>
            <TabsTrigger value="analytics" className="flex-1 h-6 rounded-md text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm">Analytics</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <LoadingState size="section" label="Loading campaigns…" className="h-full" />
        ) : requiresMetaConnection || apiError ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
            <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center mb-4">
              <Facebook className="w-6 h-6 text-blue-600" />
            </div>
            <p className="text-sm font-semibold mb-1">
              {requiresMetaConnection ? 'Meta Ads Connection Required' : 'Sync Failed'}
            </p>
            <p className="text-xs text-muted-foreground mb-5 max-w-[280px] leading-relaxed">
              {requiresMetaConnection ? 'Connect your Meta Ads account to see your campaigns.' : apiError || 'Failed to load campaigns from Meta.'}
            </p>
            {requiresMetaConnection ? (
              <Button size="sm" className="h-8 px-4 rounded-lg text-xs gap-1.5 bg-[#1877F2] hover:bg-[#1877F2]/90"
                onClick={() => window.location.href = '/dashboard/integrations/meta'}>
                <Facebook className="w-3.5 h-3.5" /> Connect Meta Ads
              </Button>
            ) : (
              <Button variant="outline" size="sm" className="h-8 px-3 rounded-lg text-xs gap-1.5 border-border/60"
                onClick={refreshCampaigns}>
                <RefreshCw className="w-3.5 h-3.5" /> Retry
              </Button>
            )}
          </div>
        ) : activeView === 'overview' ? (
          <div className="p-3 space-y-3">
            {/* Stats */}
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: "Reach", value: formatNumber(totals.reach), color: "text-blue-500" },
                { label: "Active", value: metaCampaigns.filter(c => c.effective_status?.toLowerCase() === 'active').length, color: "text-emerald-500" },
                { label: "CTR", value: `${avgCtr.toFixed(2)}%`, color: "text-indigo-500" },
                { label: "Spend", value: formatCurrency(totals.spend), color: "text-amber-500" },
              ].map((s) => (
                <div key={s.label} className="border border-border/40 bg-card rounded-xl p-3 shadow-sm text-center">
                  <p className="text-sm font-semibold">{s.value}</p>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </div>

            {/* Campaign cards */}
            {metaCampaigns.length === 0 ? (
              <div className="border border-border/40 bg-card rounded-xl p-6 text-center">
                <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mx-auto mb-3">
                  <Target className="w-5 h-5 text-muted-foreground/40" />
                </div>
                <p className="text-sm font-medium">No campaigns found</p>
                <p className="text-xs text-muted-foreground mt-1 mb-3">No Meta campaigns have been published yet.</p>
                <Button variant="outline" size="sm" className="h-8 px-3 rounded-lg text-xs gap-1.5 border-border/60"
                  onClick={() => window.location.href = '/dashboard/marketing/campaigns'}>
                  <ExternalLink className="w-3.5 h-3.5" /> Go to Campaigns
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {metaCampaigns.map((campaign) => (
                  <div key={campaign.id} className="border border-border/40 bg-card rounded-xl shadow-sm overflow-hidden">
                    <div className="flex items-center gap-3 p-3">
                      <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                        <Facebook className="h-4 w-4 text-blue-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{campaign.name}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <StatusBadge status={campaign.effective_status} />
                          <span className="text-xs text-muted-foreground/60">{campaign.objective?.replace(/_/g, ' ')}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button variant="ghost" size="sm" className="h-7 w-16 rounded-lg text-xs border border-border/40"
                          onClick={() => toggleExpand(campaign.id)}>
                          {expandedCampaigns.has(campaign.id) ? 'Less' : 'More'}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="outline" className="h-7 w-7 rounded-lg border-border/40 p-0" disabled={actionInProgress === campaign.id}>
                              {actionInProgress === campaign.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MoreHorizontal className="w-3.5 h-3.5" />}
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="border-border/40 bg-card rounded-xl">
                            {campaign.effective_status?.toLowerCase() === 'active' ? (
                              <DropdownMenuItem className="text-xs gap-2" onClick={() => handlePauseCampaign(campaign.id)}>
                                <Pause className="w-3.5 h-3.5" /> Pause
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem className="text-xs gap-2" onClick={() => handleResumeCampaign(campaign.id)}>
                                <Play className="w-3.5 h-3.5" /> Resume
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem className="text-xs gap-2" onClick={() => window.open(`https://business.facebook.com/adsmanager/manage/campaigns?act=${campaign.id}`, '_blank')}>
                              <ExternalLink className="w-3.5 h-3.5" /> View in Meta
                            </DropdownMenuItem>
                            <DropdownMenuSeparator className="bg-border/40" />
                            <DropdownMenuItem className="text-destructive text-xs gap-2"
                              onClick={() => setDeleteConfirm({ type: 'campaign', id: campaign.id, name: campaign.name })}>
                              <Trash2 className="w-3.5 h-3.5" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    {/* Expanded metrics */}
                    {expandedCampaigns.has(campaign.id) && (
                      <div className="border-t border-border/40 p-3 bg-muted/20 space-y-2">
                        <div className="grid grid-cols-3 gap-2">
                          {[
                            { l: 'Spend', v: formatCurrency(parseFloat(campaign.insights?.spend || '0')) },
                            { l: 'Impressions', v: formatNumber(parseInt(campaign.insights?.impressions || '0')) },
                            { l: 'Clicks', v: formatNumber(parseInt(campaign.insights?.clicks || '0')) },
                            { l: 'CTR', v: `${parseFloat(campaign.insights?.ctr || '0').toFixed(2)}%` },
                            { l: 'CPC', v: formatCurrency(parseFloat(campaign.insights?.cpc || '0')) },
                            { l: 'Reach', v: formatNumber(parseInt(campaign.insights?.reach || '0')) },
                          ].map((m) => (
                            <div key={m.l} className="text-center p-2 rounded-lg bg-card border border-border/30">
                              <p className="text-xs font-semibold">{m.v}</p>
                              <p className="text-[10px] text-muted-foreground">{m.l}</p>
                            </div>
                          ))}
                        </div>
                        {/* Ad Sets */}
                        {campaignAdsets[campaign.id]?.length > 0 && (
                          <div className="space-y-1.5 mt-2">
                            <p className="text-xs font-medium text-muted-foreground px-1">Ad Sets</p>
                            {campaignAdsets[campaign.id].map((adset) => (
                              <div key={adset.id} className="flex items-center gap-2 p-2 rounded-lg bg-card border border-border/30">
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-medium truncate">{adset.name}</p>
                                  <p className="text-[10px] text-muted-foreground">{adset.effective_status}</p>
                                </div>
                                <Button variant="ghost" size="sm" className="h-6 w-6 p-0 rounded-md text-destructive"
                                  onClick={() => setDeleteConfirm({ type: 'adset', id: adset.id, name: adset.name })}>
                                  <Trash2 className="w-3 h-3" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : activeView === 'list' ? (
          <CampaignsListView campaigns={campaignsList} />
        ) : (
          <CampaignsAnalytics campaigns={metaCampaigns} metrics={analyticsMetrics} />
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <AlertDialogContent className="rounded-xl max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base font-semibold">Delete {deleteConfirm?.type === 'campaign' ? 'Campaign' : 'Ad Set'}?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground">
              This will permanently delete &quot;{deleteConfirm?.name}&quot;. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 rounded-lg text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="h-8 rounded-lg text-xs bg-destructive hover:bg-destructive/90"
              onClick={() => {
                if (!deleteConfirm) return;
                if (deleteConfirm.type === 'campaign') handleDeleteCampaign(deleteConfirm.id);
                else {
                  const campaignId = Object.keys(campaignAdsets).find(k => campaignAdsets[k]?.some(a => a.id === deleteConfirm.id));
                  if (campaignId) handleDeleteAdset(deleteConfirm.id, campaignId);
                }
              }}
            >Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
