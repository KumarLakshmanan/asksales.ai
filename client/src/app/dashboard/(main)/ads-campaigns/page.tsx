"use client";
import styles from "@/components/marketing/marketing.module.css";
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidatePaidAdsReporting } from '@/hooks/usePaidAdsDashboard';
import { paidAdsFilterUpdates, paidAdsProviderPreset, paidCampaignFreshness } from '@/lib/paid-ads-filters';
import { UnifiedCampaignInventory } from "@/components/performance-marketing/UnifiedCampaignInventory";
import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { Callout } from '@/components/ui/callout';
import { SearchInput } from '@/components/ui/search-input';
import { Spinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { 
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { 
  Play,
  Pause,
  BarChart3,
  MoreVertical,
  RefreshCw,
  ExternalLink,
  Edit,
  Trash2,
  Target,
  Facebook,
  Eye,
  ChevronDown,
  ChevronRight,
  Calendar
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import api from '@/lib/api';
import { PageShell } from '@/components/ui/page-shell';
import { trackPerformanceMarketingEvent } from '@/lib/performanceMarketingAnalytics';
import type { AdCreativePreviewData } from '@/components/performance-marketing/AdCreativePreviewDialog';
import { managedCampaignHref, providerCampaignHref, withPaidAdsContext, type CampaignPageTab } from '@/components/performance-marketing/campaignRoutes';
import { PaidAdAccountSelector } from '@/components/performance-marketing/PaidAdAccountSelector';
import { formatCount as formatNumber } from '@/lib/display-format';

interface AdCampaign {
  id: number;
  name: string;
  status: 'active' | 'paused' | 'draft' | 'ended' | 'learning' | 'published' | 'deleted' | 'archived' | 'pending_review' | 'disapproved' | 'in_process' | 'with_issues' | string;
  objective: string;
  budget: number;
  budget_type: 'daily' | 'lifetime';
  spent: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number;
  cpc: number;
  cpm: number;
  roas: number;
  reach?: number;
  start_date: string;
  end_date?: string;
  created_at: string;
  meta_campaign_id?: string;
  platform_campaign_id?: string;
  ad_platform?: string;
  local_status?: string;
  provider_status?: string;
  validation_errors?: string[];
  currency?: string;
  total_allocated?: number;
  ad_account_id?: string;
  ad_sets?: AdSet[];
}

interface AdSet {
  id?: string;
  name?: string;
  ad_set_name?: string;
  headline?: string;
  description?: string;
  cta?: string;
  status?: string;
  ads?: Array<{
    ad_name?: string;
    format?: string;
    headline?: string;
    description?: string;
    call_to_action?: string;
    landing_page_url?: string;
    image_url?: string;
    thumbnail_url?: string;
  }>;
  // Analytics from Meta
  impressions?: number;
  clicks?: number;
  spend?: number;
  reach?: number;
  cpc?: number;
  cpm?: number;
  ctr?: number;
  actions?: MetaAction[];
}

interface MetaAction {
  action_type: string;
  value: string;
}

interface MetaCampaign {
  metricsAvailable?: boolean;
  id: string;
  name: string;
  status: string;
  objective: string;
  effective_status: string;
  created_time: string;
  updated_time: string;
  daily_budget?: string;
  lifetime_budget?: string;
  insights?: MetaInsights;
  results?: number;
  last_refreshed_at?: string;
  adAccountId?: string;
}

interface MetaInsights {
  impressions: string;
  clicks: string;
  spend: string;
  reach: string;
  cpc: string;
  cpm: string;
  ctr: string;
  conversions?: string;
  actions?: MetaAction[];
  cost_per_action_type?: { action_type: string; value: string }[];
}

function mergeMetaCampaignInventory(liveCampaigns: MetaCampaign[], cachedCampaigns: MetaCampaign[]) {
  const cachedById = new Map(cachedCampaigns.map((campaign) => [campaign.id, campaign]));
  const liveIds = new Set(liveCampaigns.map((campaign) => campaign.id));

  return [
    ...liveCampaigns.map((campaign) => {
      const cached = cachedById.get(campaign.id);
      if (!cached) return campaign;
      return {
        ...campaign,
        adAccountId: cached.adAccountId || campaign.adAccountId,
        insights: campaign.metricsAvailable === false ? cached.insights : campaign.insights,
        results: campaign.metricsAvailable === false ? cached.results : campaign.results,
        last_refreshed_at: campaign.metricsAvailable === false ? cached.last_refreshed_at : campaign.last_refreshed_at,
      };
    }),
    ...cachedCampaigns.filter((campaign) => !liveIds.has(campaign.id)),
  ];
}

interface MetaAdset {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  daily_budget?: string;
  lifetime_budget?: string;
  optimization_goal: string;
  billing_event: string;
  insights?: MetaInsights;
}

interface MetaAd {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  adset_id: string;
  creative?: AdCreativePreviewData;
  insights?: MetaInsights;
}

interface CachedProviderPerformance {
  platformEntityId: string;
  parentEntityId?: string | null;
  name?: string | null;
  status?: string | null;
  impressions?: number;
  clicks?: number;
  spend?: number;
  reach?: number;
  ctr?: number;
  cpc?: number;
  cpm?: number;
  conversions?: number;
  rawData?: {
    adset?: { daily_budget?: string; optimization_goal?: string; billing_event?: string };
    ad?: { adset_id?: string; creative?: unknown };
    creative?: AdCreativePreviewData;
  };
}

interface MetaDeleteTarget {
  type: 'campaign' | 'adset' | 'ad';
  id: string;
  campaignId?: string;
  adsetId?: string;
  name: string;
}

interface MetaProviderActionTarget {
  type: 'campaign' | 'adset' | 'ad';
  action: 'pause' | 'resume';
  id: string;
  campaignId?: string;
  adsetId?: string;
  name: string;
}

function providerDeliveryAction(status?: string): 'pause' | 'resume' | null {
  const normalized = String(status || '').toUpperCase();
  if (normalized === 'ACTIVE') return 'pause';
  if (normalized === 'PAUSED') return 'resume';
  return null;
}

interface AdPlatformCredential {
  id: number;
  platform: 'meta' | 'instagram';
  accountName: string | null;
  currency: string | null;
  isActive: boolean;
  connectedAt: string;
  expiresAt: string | null;
}

// Skeleton Shimmer Component
function _CampaignSkeleton() {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="w-full p-4 flex items-center justify-between">
          <div className="flex items-start gap-4 flex-1">
            <div className="w-5 h-5 bg-muted animate-pulse rounded" />
            <div className="w-10 h-10 rounded-lg bg-muted animate-pulse" />
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <div className="h-5 w-40 bg-muted animate-pulse rounded" />
                <div className="h-5 w-16 bg-muted animate-pulse rounded" />
              </div>
              <div className="h-4 w-64 bg-muted animate-pulse rounded" />
            </div>
          </div>
          <div className="hidden md:grid grid-cols-6 gap-6 text-right mr-4">
            {[...Array(6)].map((_, i) => (
              <div key={i}>
                <div className="h-3 w-12 bg-muted animate-pulse rounded mb-1" />
                <div className="h-5 w-16 bg-muted animate-pulse rounded" />
              </div>
            ))}
          </div>
          <div className="w-8 h-8 bg-muted animate-pulse rounded" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdCampaignsWorkspace() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const invalidateReporting = () => invalidatePaidAdsReporting(queryClient);
  const searchParams = useSearchParams();
  const [inventoryLayout, setInventoryLayout] = useState(searchParams.get('layout') === 'cards' || searchParams.has('edit') || searchParams.has('draft') || searchParams.has('recommendation') ? 'cards' : 'table');
  const requestedAccount = searchParams.get('account') || 'all';
  const hasSelectedAccount = requestedAccount !== 'all';
  const accountQuery = useQuery({
    queryKey: ['paid-ad-accounts'],
    queryFn: () => api.get<{ accounts: Array<{ id: number; platform: string; provider_account_id?: string; currency: string | null }> }>('/api/campaigns/accounts'),
    staleTime: 60_000,
    enabled: inventoryLayout === 'cards' && hasSelectedAccount,
  });
  const selectedAccount = accountQuery.data?.accounts.find(account => String(account.id) === requestedAccount);
  const requestedStatus = searchParams.get('status');
  const requestedDate = searchParams.get('date');
  const [campaigns, setCampaigns] = useState<AdCampaign[]>([]);
  const [metaCampaigns, setMetaCampaigns] = useState<MetaCampaign[]>([]);
  const [platforms, setPlatforms] = useState<AdPlatformCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState(searchParams.get('search') || '');
  const [activeTab, setActiveTab] = useState(['all', 'active', 'draft', 'paused'].includes(requestedStatus || '') ? requestedStatus! : 'all');
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; target: MetaDeleteTarget | null }>({ open: false, target: null });
  const [providerActionConfirm, setProviderActionConfirm] = useState<{ open: boolean; target: MetaProviderActionTarget | null }>({ open: false, target: null });
  const [expandedCampaigns, setExpandedCampaigns] = useState<Set<string>>(new Set());
  const [campaignAdsets, setCampaignAdsets] = useState<Record<string, MetaAdset[]>>({});
  const [campaignAds, setCampaignAds] = useState<Record<string, MetaAd[]>>({});
  const [loadingAdsets, setLoadingAdsets] = useState<Set<string>>(new Set());
  const [hierarchyErrors, setHierarchyErrors] = useState<Record<string, string>>({});
  const [datePreset, setDatePreset] = useState(paidAdsProviderPreset({date:requestedDate,period:searchParams.get('period')}));
  const [accountInsights, setAccountInsights] = useState<MetaInsights | null>(null);
  const [accountCurrency, setAccountCurrency] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [useCache, setUseCache] = useState(true);
  const [campaignsError, setCampaignsError] = useState<string | null>(null);
  const [platformsError, setPlatformsError] = useState<string | null>(null);
  const [recommendationWorkflow, setRecommendationWorkflow] = useState<{
    campaignId: number;
    campaignName: string;
    recommendationId: number;
    title: string;
    suggestedNextStep: string;
  } | null>(null);
  const [creatingReviewDraft, setCreatingReviewDraft] = useState(false);
  
  const { toast } = useToast();
  const editCampaignId = Number(searchParams.get('edit') || 0);
  const recommendationId = Number(searchParams.get('recommendation') || 0);
  const draftCampaignId = Number(searchParams.get('draft') || 0);

  const updateInventoryQuery = (updates: Record<string, string>) => {
    const next = new URLSearchParams(typeof window === 'undefined' ? searchParams.toString() : window.location.search);
    Object.entries(paidAdsFilterUpdates(updates)).forEach(([key, value]) => value && value !== 'all' ? next.set(key, value) : next.delete(key));
    router.replace(`/dashboard/ads?${next.toString()}`, { scroll: false });
  };

  useEffect(() => {
    if (draftCampaignId > 0) setActiveTab('draft');
    if (editCampaignId <= 0 || recommendationId <= 0) {
      setRecommendationWorkflow(null);
      return;
    }
    let active = true;
    void api.get<{
      campaign: { id: number; name: string };
      recommendations: Array<{ id: number; title: string; suggested_next_step: string; status: string }>;
    }>(`/api/campaigns/autonomous/${editCampaignId}/performance`).then((response) => {
      const recommendation = response.recommendations.find((item) => item.id === recommendationId && item.status === 'accepted');
      if (active && recommendation) {
        setRecommendationWorkflow({
          campaignId: response.campaign.id,
          campaignName: response.campaign.name,
          recommendationId: recommendation.id,
          title: recommendation.title,
          suggestedNextStep: recommendation.suggested_next_step,
        });
      }
    }).catch((error) => {
      if (active) toast({ title: 'Editing workflow could not be opened', description: error instanceof Error ? error.message : 'Try again.', variant: 'destructive' });
    });
    return () => { active = false; };
  }, [draftCampaignId, editCampaignId, recommendationId, toast]);

  const createRecommendationDraft = async () => {
    if (!recommendationWorkflow) return;
    try {
      setCreatingReviewDraft(true);
      const response = await api.post<{ campaign: { id: number } }>(
        `/api/campaigns/autonomous/${recommendationWorkflow.campaignId}/improved-version`,
        {},
      );
      await invalidateReporting();
      toast({ title: 'Review-only draft created', description: 'No live provider changes were made.' });
      setRecommendationWorkflow(null);
      router.push(`/dashboard/ads?tab=campaigns&draft=${response.campaign.id}`);
    } catch (error) {
      toast({ title: 'Draft could not be created', description: error instanceof Error ? error.message : 'Try again.', variant: 'destructive' });
    } finally {
      setCreatingReviewDraft(false);
    }
  };

  // Load from cache first (like CampaignsTab)
  const loadDataFromCache = async () => {
    try {
      setLoading(true);
      setLoadingProgress(10);
      setPlatformsError(null);
      let metaConnected = false;
      
      // Load connected platforms
      try {
        const platformsResponse = await api.get<{ platforms: AdPlatformCredential[] }>('/api/meta/oauth/platforms');
        const connectedPlatforms = platformsResponse.platforms || [];
        setPlatforms(connectedPlatforms);
        metaConnected = connectedPlatforms.some(platform => platform.platform === 'meta' && platform.isActive !== false);
        if (!metaConnected) setCampaignsError('Meta connection required.');
      } catch (error) {
        setPlatformsError(error instanceof Error ? error.message : 'Meta connection status could not be loaded.');
      }
      setLoadingProgress(25);

      setLoadingProgress(40);
      setLoadingProgress(55);

      // Try to load Meta campaigns from cache first
      let metaCampaignsData: MetaCampaign[] = [];
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cacheResponse = await api.get<{ campaigns: any[], lastRefreshedAt: string | null }>(`/api/campaigns/meta/cache/campaigns?datePreset=${datePreset}`);
        setLoadingProgress(70);
        
        if (cacheResponse.campaigns && cacheResponse.campaigns.length > 0) {
          // Map cached data to MetaCampaign format
          const cachedCampaigns: MetaCampaign[] = cacheResponse.campaigns.map(c => ({
            id: c.platformEntityId,
            adAccountId: c.adAccountId || c.rawData?.accountIdentity?.adAccountId,
            name: c.name || 'Unnamed Campaign',
            status: c.status,
            effective_status: c.status?.toUpperCase() || 'UNKNOWN',
            objective: c.rawData?.campaign?.objective || 'OUTCOME_AWARENESS',
            created_time: c.rawData?.campaign?.created_time || new Date().toISOString(),
            updated_time: c.rawData?.campaign?.updated_time || new Date().toISOString(),
            daily_budget: c.rawData?.campaign?.daily_budget,
            lifetime_budget: c.rawData?.campaign?.lifetime_budget,
            results: Number(c.conversions || 0),
            last_refreshed_at: c.lastRefreshedAt,
            insights: {
              impressions: String(c.impressions || 0),
              clicks: String(c.clicks || 0),
              spend: String(c.spend || 0),
              reach: String(c.reach || 0),
              cpc: String(c.cpc || 0),
              cpm: String(c.cpm || 0),
              ctr: String(c.ctr || 0),
              conversions: String(c.conversions || 0),
              actions: c.rawData?.insights?.actions || [],
            }
          }));
          // A campaign-level analytics read-through can create a deliberately
          // partial cache. Merge those cached metrics into the complete live
          // provider inventory instead of hiding every uncached sibling.
          const liveCampaigns = metaConnected ? await loadMetaCampaignsFresh() : null;
          metaCampaignsData = liveCampaigns
            ? mergeMetaCampaignInventory(liveCampaigns, cachedCampaigns)
            : cachedCampaigns;
          setMetaCampaigns(metaCampaignsData);
          if (cacheResponse.lastRefreshedAt) {
            setLastRefreshed(new Date(cacheResponse.lastRefreshedAt));
          }
          setUseCache(!liveCampaigns);
        } else {
          // No cache, load fresh from Meta
          metaCampaignsData = metaConnected ? (await loadMetaCampaignsFresh()) || [] : [];
        }
      } catch (_e) {
        metaCampaignsData = metaConnected ? (await loadMetaCampaignsFresh()) || [] : [];
      }
      setLoadingProgress(85);

      // Create a map of Meta campaign IDs to their real status
      const metaStatusMap = new Map<string, { status: string; insights: MetaInsights | undefined }>();
      metaCampaignsData.forEach((mc) => {
        metaStatusMap.set(mc.id, {
          status: mc.effective_status?.toLowerCase() || mc.status?.toLowerCase() || 'unknown',
          insights: mc.insights,
        });
      });

      // Load campaigns from local DB
      await loadLocalCampaigns(metaStatusMap);
      setLoadingProgress(100);

    } catch (_error) {
      toast({
        title: 'Error',
        description: 'Failed to load campaigns data',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
      setLoadingProgress(0);
    }
  };

  const loadMetaCampaignsFresh = async (): Promise<MetaCampaign[] | null> => {
    try {
      setCampaignsError(null);
      const metaResponse = await api.get<{ campaigns: MetaCampaign[] }>(`/api/campaigns/meta/campaigns?datePreset=${datePreset}`);
      const data = metaResponse.campaigns || [];
      if (data.some(campaign => campaign.metricsAvailable === false)) setCampaignsError('Some campaign metrics could not be refreshed. Stored evidence is shown where available.');
      setMetaCampaigns(data);
      setLastRefreshed(new Date());
      setUseCache(false);
      return data;
    } catch (_e) {
      setCampaignsError('Meta campaign data is temporarily unavailable. Your campaigns were not changed.');
      return null;
    }
  };

  const loadLocalCampaigns = async (metaStatusMap: Map<string, { status: string; insights: MetaInsights | undefined }>) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const campaignsResponse = await api.get<{ campaigns: any[] }>('/api/campaigns/autonomous');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const transformedCampaigns: AdCampaign[] = (campaignsResponse.campaigns || []).map((c: any) => {
        const metaData = c.platform_campaign_id ? metaStatusMap.get(c.platform_campaign_id) : null;
        const realStatus = c.local_status || c.status || 'draft';
        const metaInsights = metaData?.insights;
        
        return {
          id: c.id,
          name: c.name || c.icp_campaign_name || 'Untitled Campaign',
          status: realStatus as AdCampaign['status'],
          objective: c.objective || 'conversions',
          budget: c.budget_amount || 0,
          budget_type: c.budget_type || 'daily',
          spent: metaInsights ? parseFloat(metaInsights.spend || '0') : (c.spent_amount || c.spent || c.spend || 0),
          impressions: metaInsights ? parseInt(metaInsights.impressions || '0') : (c.impressions || 0),
          clicks: metaInsights ? parseInt(metaInsights.clicks || '0') : (c.clicks || 0),
          conversions: c.conversions || 0,
          ctr: metaInsights ? parseFloat(metaInsights.ctr || '0') : (c.clicks && c.impressions ? (c.clicks / c.impressions * 100) : 0),
          cpc: metaInsights ? parseFloat(metaInsights.cpc || '0') : (c.clicks && c.spent ? (c.spent / c.clicks) : 0),
          cpm: metaInsights ? parseFloat(metaInsights.cpm || '0') : (c.impressions ? ((c.spent || 0) / c.impressions * 1000) : 0),
          roas: c.roas || 0,
          reach: metaInsights ? parseInt(metaInsights.reach || '0') : undefined,
          start_date: c.start_date || c.created_at,
          end_date: c.end_date,
          created_at: c.created_at,
          meta_campaign_id: c.meta_campaign_id,
          platform_campaign_id: c.platform_campaign_id,
          ad_sets: c.ad_sets || [],
          ad_platform: c.ad_platform,
          local_status: c.local_status,
          provider_status: c.provider_status || metaData?.status,
          validation_errors: c.validation_errors || [],
          currency: c.currency || 'USD',
          total_allocated: Number(c.total_allocated || 0),
          ad_account_id: c.ad_account_id,
        };
      });
      setCampaigns(transformedCampaigns);
    } catch (_e) {
      setCampaigns([]);
    }
  };

  // Full refresh from Meta API (called when Refresh button clicked)
  const loadDataFresh = async () => {
    try {
      setRefreshing(true);
      if (hasSelectedAccount) {
        if (!selectedAccount) throw new Error('Select an available ad account before syncing.');
        const result = await api.post<{ partialSuccess?: boolean; status?: string }>(`/api/campaigns/accounts/${selectedAccount.id}/refresh`, {});
        await invalidateReporting();
        await loadDataFromCache();
        toast({ title: result.status === 'running' ? 'Account sync in progress' : result.partialSuccess ? 'Account refresh incomplete' : 'Account refreshed', description: 'Showing the latest saved reporting data for the selected account.' });
        return;
      }
      let refreshIssue: string | null = null;
      
      // Refresh cache from Meta API
      try {
        const refreshResult = await api.post<{ partialSuccess?: boolean; errors?: unknown[] }>('/api/campaigns/meta/cache/refresh', {
          platform: 'meta',
          datePreset: datePreset
        });
        if (refreshResult.partialSuccess) {
          refreshIssue = `${refreshResult.errors?.length || 0} campaign metric operation(s) could not be refreshed.`;
          setCampaignsError(`${refreshIssue} Showing the latest available data.`);
        }
      } catch (error) {
        refreshIssue = error instanceof Error ? error.message : 'Meta campaign metrics could not be refreshed.';
        setCampaignsError(`${refreshIssue} Showing the latest available data.`);
      }

      await invalidateReporting();
      // Load fresh Meta campaigns. If the provider call fails, keep the last
      // cached list that was already visible instead of replacing it with an
      // empty result while claiming stale data is being shown.
      const refreshedCampaigns = await loadMetaCampaignsFresh();
      const metaCampaignsData = refreshedCampaigns || metaCampaigns;
      
      // Create status map
      const metaStatusMap = new Map<string, { status: string; insights: MetaInsights | undefined }>();
      metaCampaignsData.forEach((mc) => {
        metaStatusMap.set(mc.id, {
          status: mc.effective_status?.toLowerCase() || mc.status?.toLowerCase() || 'unknown',
          insights: mc.insights,
        });
      });

      // Load local campaigns
      await loadLocalCampaigns(metaStatusMap);

      // Load account-level insights
      try {
        const insightsResponse = await api.get<{
          currency?: string;
          totals?: { impressions?: number; reach?: number; clicks?: number; spend?: number; cpc?: number; cpm?: number; ctr?: number; conversions?: number };
        }>(`/api/campaigns/meta/account/insights?datePreset=${datePreset}`);
        const totals = insightsResponse.totals;
        setAccountCurrency(insightsResponse.currency || null);
        setAccountInsights(totals ? {
          impressions: String(totals.impressions || 0),
          clicks: String(totals.clicks || 0),
          spend: String(totals.spend || 0),
          reach: String(totals.reach || 0),
          cpc: String(totals.cpc || 0),
          cpm: String(totals.cpm || 0),
          ctr: String(totals.ctr || 0),
          actions: totals.conversions ? [{ action_type: 'lead', value: String(totals.conversions) }] : [],
        } : null);
      } catch (_e) { /* Preserve the last account aggregate during provider outages. */ }

      if (refreshIssue) {
        setCampaignsError(`${refreshIssue} Showing the latest available data.`);
      }

      toast({
        title: refreshIssue ? 'Refresh incomplete' : 'Refreshed',
        description: refreshIssue || 'Campaign data has been updated from Meta',
        ...(refreshIssue && { variant: 'destructive' as const }),
      });
    } catch (_error) {
      toast({
        title: 'Error',
        description: 'Failed to refresh campaigns data',
        variant: 'destructive'
      });
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (inventoryLayout === 'cards') void loadDataFromCache();
  // Provider reads depend on the selected preset; manual Sync owns provider cache refresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventoryLayout, datePreset]);

  const matchesSelectedAccount = (platform: string | undefined, accountId: string | undefined) => !hasSelectedAccount || Boolean(
    selectedAccount?.provider_account_id && selectedAccount.platform === platform &&
    String(accountId || '').replace(/^act_/, '') === selectedAccount.provider_account_id.replace(/^act_/, ''),
  );
  const scopedMetaCampaigns = metaCampaigns.filter(campaign => matchesSelectedAccount('meta', campaign.adAccountId));
  const scopedCampaigns = campaigns.filter(campaign => matchesSelectedAccount(campaign.ad_platform, campaign.ad_account_id));

  const getMetaStats = () => {
    if (accountInsights && !hasSelectedAccount) {
      return {
        totalSpent: parseFloat(accountInsights.spend || '0'),
        totalImpressions: parseInt(accountInsights.impressions || '0'),
        totalClicks: parseInt(accountInsights.clicks || '0'),
        totalReach: parseInt(accountInsights.reach || '0'),
        avgCpc: parseFloat(accountInsights.cpc || '0'),
        avgCpm: parseFloat(accountInsights.cpm || '0'),
        avgCtr: parseFloat(accountInsights.ctr || '0'),
        activeCampaigns: scopedMetaCampaigns.filter(c => c.effective_status === 'ACTIVE').length,
        totalConversions: accountInsights.actions?.reduce((sum, a) => {
          if (['purchase', 'lead', 'complete_registration', 'add_to_cart'].includes(a.action_type)) {
            return sum + parseInt(a.value);
          }
          return sum;
        }, 0) || 0
      };
    }
    
    // Fallback to aggregating from campaigns
    return {
      totalSpent: scopedMetaCampaigns.reduce((sum, c) => sum + parseFloat(c.insights?.spend || '0'), 0),
      totalImpressions: scopedMetaCampaigns.reduce((sum, c) => sum + parseInt(c.insights?.impressions || '0'), 0),
      totalClicks: scopedMetaCampaigns.reduce((sum, c) => sum + parseInt(c.insights?.clicks || '0'), 0),
      totalReach: scopedMetaCampaigns.reduce((sum, c) => sum + parseInt(c.insights?.reach || '0'), 0),
      avgCpc: scopedMetaCampaigns.length > 0
        ? scopedMetaCampaigns.reduce((sum, c) => sum + parseFloat(c.insights?.cpc || '0'), 0) / scopedMetaCampaigns.length
        : 0,
      avgCpm: scopedMetaCampaigns.length > 0
        ? scopedMetaCampaigns.reduce((sum, c) => sum + parseFloat(c.insights?.cpm || '0'), 0) / scopedMetaCampaigns.length
        : 0,
      avgCtr: scopedMetaCampaigns.length > 0
        ? scopedMetaCampaigns.reduce((sum, c) => sum + parseFloat(c.insights?.ctr || '0'), 0) / scopedMetaCampaigns.length
        : 0,
      activeCampaigns: scopedMetaCampaigns.filter(c => c.effective_status === 'ACTIVE').length,
      totalConversions: 0
    };
  };

  const loadCampaignAdsets = async (campaignId: string): Promise<{ adsets: MetaAdset[]; ads: MetaAd[] }> => {
    if (campaignAdsets[campaignId] && campaignAds[campaignId]) {
      return { adsets: campaignAdsets[campaignId], ads: campaignAds[campaignId] };
    }
    
    setLoadingAdsets(prev => new Set(prev).add(campaignId));
    try {
      setHierarchyErrors(current => { const next = { ...current }; delete next[campaignId]; return next; });
      // Try cache first
      const cacheResponse = await api.get<{ adsets: CachedProviderPerformance[]; ads?: CachedProviderPerformance[] }>(
        `/api/campaigns/meta/cache/campaigns/${campaignId}/adsets`
      );
      
      if (cacheResponse.adsets && cacheResponse.adsets.length > 0) {
        const cachedAdsets: MetaAdset[] = cacheResponse.adsets.map((a) => ({
          id: a.platformEntityId,
          name: a.name || 'Unnamed Ad Set',
          status: a.status || 'unknown',
          effective_status: a.status?.toUpperCase() || 'UNKNOWN',
          daily_budget: a.rawData?.adset?.daily_budget,
          optimization_goal: a.rawData?.adset?.optimization_goal || 'unknown',
          billing_event: a.rawData?.adset?.billing_event || 'unknown',
          insights: {
            impressions: String(a.impressions || 0),
            clicks: String(a.clicks || 0),
            spend: String(a.spend || 0),
            reach: String(a.reach || 0),
            ctr: String(a.ctr || 0),
            cpc: String(a.cpc || 0),
            cpm: String(a.cpm || 0),
            conversions: String(a.conversions || 0),
          }
        }));
        setCampaignAdsets(prev => ({ ...prev, [campaignId]: cachedAdsets }));
        const cachedAds: MetaAd[] = (cacheResponse.ads || []).map((ad) => ({
          id: ad.platformEntityId,
          name: ad.name || 'Unnamed ad',
          status: ad.status || 'unknown',
          effective_status: ad.status?.toUpperCase() || 'UNKNOWN',
          adset_id: ad.parentEntityId || ad.rawData?.ad?.adset_id || '',
          creative: ad.rawData?.creative,
          insights: {
            impressions: String(ad.impressions || 0),
            clicks: String(ad.clicks || 0),
            spend: String(ad.spend || 0),
            reach: String(ad.reach || 0),
            ctr: String(ad.ctr || 0),
            cpc: String(ad.cpc || 0),
            cpm: String(ad.cpm || 0),
            conversions: String(ad.conversions || 0),
          },
        }));
        setCampaignAds(prev => ({ ...prev, [campaignId]: cachedAds }));
        return { adsets: cachedAdsets, ads: cachedAds };
      } else {
        // Fallback to live API
        const response = await api.get<{ adsets: MetaAdset[]; ads?: MetaAd[]; partialSuccess?: boolean; adsError?: string | null }>(
          `/api/campaigns/meta/campaigns/${campaignId}/adsets?datePreset=${datePreset}`
        );
        const liveAdsets = response.adsets || [];
        const liveAds = response.ads || [];
        setCampaignAdsets(prev => ({ ...prev, [campaignId]: liveAdsets }));
        setCampaignAds(prev => ({ ...prev, [campaignId]: liveAds }));
        if (response.partialSuccess) {
          toast({
            title: 'Campaign hierarchy partially loaded',
            description: response.adsError || 'Ad sets are visible, but individual ads could not be loaded.',
          });
        }
        return { adsets: liveAdsets, ads: liveAds };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load ad sets';
      setHierarchyErrors(current => ({ ...current, [campaignId]: message }));
      toast({
        title: 'Campaign hierarchy unavailable',
        description: 'Keeping the latest cached hierarchy. Retry when the provider connection is available.',
        variant: 'destructive'
      });
      return { adsets: campaignAdsets[campaignId] || [], ads: campaignAds[campaignId] || [] };
    } finally {
      setLoadingAdsets(prev => {
        const next = new Set(prev);
        next.delete(campaignId);
        return next;
      });
    }
  };

  const toggleCampaignExpand = async (campaignId: string) => {
    const newExpanded = new Set(expandedCampaigns);
    if (newExpanded.has(campaignId)) {
      newExpanded.delete(campaignId);
    } else {
      newExpanded.add(campaignId);
      await loadCampaignAdsets(campaignId);
    }
    setExpandedCampaigns(newExpanded);
  };

  const openCampaignCreativePreview = (campaign: MetaCampaign) => {
    router.push(withPaidAdsContext(providerCampaignHref('meta', campaign.id, 'creative'), searchParams.toString()));
    trackPerformanceMarketingEvent('creative_preview_opened', { scope: 'campaign', platform: 'meta' });
  };

  const openManagedCampaignCreativePreview = (campaign: AdCampaign) => {
    router.push(withPaidAdsContext(managedCampaignHref(campaign.id, 'creative'), searchParams.toString()));
    trackPerformanceMarketingEvent('creative_preview_opened', { scope: 'campaign_draft', platform: campaign.ad_platform || 'unknown' });
  };

  const openAdsetCreativePreview = (campaignId: string, adset: MetaAdset) => {
    router.push(withPaidAdsContext(providerCampaignHref('meta', campaignId, 'creative', campaignAds[campaignId]?.find(ad => ad.adset_id === adset.id)?.id), searchParams.toString()));
    trackPerformanceMarketingEvent('creative_preview_opened', { scope: 'ad_set', platform: 'meta' });
  };

  const openAdCreativePreview = (campaignId: string, ad: MetaAd) => {
    router.push(withPaidAdsContext(providerCampaignHref('meta', campaignId, 'creative', ad.id), searchParams.toString()));
    trackPerformanceMarketingEvent('creative_preview_opened', { scope: 'ad', platform: 'meta' });
  };

  const connectMeta = () => {
    window.location.href = "/api/meta/oauth";
  };

  const isMetaConnected = platforms.some(p => p.platform === 'meta' && p.isActive !== false);

  const getTotalStats = () => {
    const activeCampaigns = campaigns.filter(c => c.status === 'active' || c.status === 'published');
    return {
      totalSpent: campaigns.reduce((sum, c) => sum + c.spent, 0),
      totalImpressions: campaigns.reduce((sum, c) => sum + c.impressions, 0),
      totalClicks: campaigns.reduce((sum, c) => sum + c.clicks, 0),
      totalConversions: campaigns.reduce((sum, c) => sum + c.conversions, 0),
      avgRoas: activeCampaigns.length > 0
        ? activeCampaigns.reduce((sum, c) => sum + c.roas, 0) / activeCampaigns.length
        : 0,
      activeCampaigns: activeCampaigns.length
    };
  };

  // Meta campaign/adset management handlers
  const handlePauseMetaCampaign = async (campaignId: string) => {
    try {
      await api.post(`/api/campaigns/meta/campaigns/${campaignId}/pause`);
      await invalidateReporting();
      setMetaCampaigns(prev => prev.map(c => 
        c.id === campaignId ? { ...c, effective_status: 'PAUSED' } : c
      ));
      toast({ title: 'Success', description: 'Campaign paused successfully' });
    } catch (_error) {
      toast({ title: 'Error', description: 'Failed to pause campaign', variant: 'destructive' });
    }
  };

  const handleResumeMetaCampaign = async (campaignId: string) => {
    try {
      await api.post(`/api/campaigns/meta/campaigns/${campaignId}/resume`);
      await invalidateReporting();
      setMetaCampaigns(prev => prev.map(c => 
        c.id === campaignId ? { ...c, effective_status: 'ACTIVE' } : c
      ));
      toast({ title: 'Success', description: 'Campaign resumed successfully' });
    } catch (_error) {
      toast({ title: 'Error', description: 'Failed to resume campaign', variant: 'destructive' });
    }
  };

  const handleDeleteMetaCampaign = (campaignId: string, campaignName: string) => {
    setDeleteConfirm({ open: true, target: { type: 'campaign', id: campaignId, name: campaignName } });
  };

  const confirmMetaDelete = async () => {
    const target = deleteConfirm.target;
    if (!target) return;
    try {
      if (target.type === 'campaign') {
        await api.delete(`/api/campaigns/meta/campaigns/${target.id}`);
        await invalidateReporting();
        setMetaCampaigns(prev => prev.filter(c => c.id !== target.id));
        setCampaignAdsets(prev => { const next = { ...prev }; delete next[target.id]; return next; });
        setCampaignAds(prev => { const next = { ...prev }; delete next[target.id]; return next; });
      } else if (target.type === 'adset') {
        await api.delete(`/api/campaigns/meta/adsets/${target.id}`);
        await invalidateReporting();
        setCampaignAdsets(prev => ({
          ...prev,
          [target.campaignId || '']: prev[target.campaignId || '']?.filter(a => a.id !== target.id) || [],
        }));
        setCampaignAds(prev => ({
          ...prev,
          [target.campaignId || '']: prev[target.campaignId || '']?.filter(ad => ad.adset_id !== target.id) || [],
        }));
      } else {
        await api.delete(`/api/campaigns/meta/ads/${target.id}`);
        await invalidateReporting();
        setCampaignAds(prev => ({
          ...prev,
          [target.campaignId || '']: prev[target.campaignId || '']?.filter(ad => ad.id !== target.id) || [],
        }));
      }
      toast({ title: 'Deleted', description: `${target.type === 'campaign' ? 'Campaign' : target.type === 'adset' ? 'Ad set' : 'Ad'} deleted successfully` });
      setDeleteConfirm({ open: false, target: null });
    } catch (error) {
      toast({
        title: 'Delete failed',
        description: error instanceof Error ? error.message : `Failed to delete ${target.type}`,
        variant: 'destructive',
      });
    }
  };

  const handlePauseMetaAdset = async (adsetId: string, campaignId: string) => {
    try {
      await api.post(`/api/campaigns/meta/adsets/${adsetId}/pause`);
      await invalidateReporting();
      setCampaignAdsets(prev => ({
        ...prev,
        [campaignId]: prev[campaignId]?.map(a => 
          a.id === adsetId ? { ...a, effective_status: 'PAUSED' } : a
        ) || []
      }));
      toast({ title: 'Success', description: 'Ad set paused successfully' });
    } catch (_error) {
      toast({ title: 'Error', description: 'Failed to pause ad set', variant: 'destructive' });
    }
  };

  const handleResumeMetaAdset = async (adsetId: string, campaignId: string) => {
    try {
      await api.post(`/api/campaigns/meta/adsets/${adsetId}/resume`);
      await invalidateReporting();
      setCampaignAdsets(prev => ({
        ...prev,
        [campaignId]: prev[campaignId]?.map(a => 
          a.id === adsetId ? { ...a, effective_status: 'ACTIVE' } : a
        ) || []
      }));
      toast({ title: 'Success', description: 'Ad set resumed successfully' });
    } catch (_error) {
      toast({ title: 'Error', description: 'Failed to resume ad set', variant: 'destructive' });
    }
  };

  const handleDeleteMetaAdset = (adsetId: string, campaignId: string, adsetName: string) => {
    setDeleteConfirm({ open: true, target: { type: 'adset', id: adsetId, campaignId, name: adsetName } });
  };

  const handlePauseMetaAd = async (adId: string, campaignId: string) => {
    try {
      await api.post(`/api/campaigns/meta/ads/${adId}/pause`);
      await invalidateReporting();
      setCampaignAds(prev => ({ ...prev, [campaignId]: prev[campaignId]?.map(ad => ad.id === adId ? { ...ad, effective_status: 'PAUSED' } : ad) || [] }));
      toast({ title: 'Ad paused', description: 'The provider confirmed the ad is paused.' });
    } catch (_error) {
      toast({ title: 'Pause failed', description: 'The ad was not changed.', variant: 'destructive' });
    }
  };

  const handleResumeMetaAd = async (adId: string, campaignId: string) => {
    try {
      await api.post(`/api/campaigns/meta/ads/${adId}/resume`);
      await invalidateReporting();
      setCampaignAds(prev => ({ ...prev, [campaignId]: prev[campaignId]?.map(ad => ad.id === adId ? { ...ad, effective_status: 'ACTIVE' } : ad) || [] }));
      toast({ title: 'Ad resumed', description: 'The provider confirmed the ad is active.' });
    } catch (_error) {
      toast({ title: 'Resume failed', description: 'The ad was not changed.', variant: 'destructive' });
    }
  };

  const requestProviderAction = (target: MetaProviderActionTarget) => setProviderActionConfirm({ open: true, target });

  const confirmProviderAction = async () => {
    const target = providerActionConfirm.target;
    if (!target) return;
    if (target.type === 'campaign') {
      if (target.action === 'pause') await handlePauseMetaCampaign(target.id);
      else await handleResumeMetaCampaign(target.id);
    } else if (target.type === 'adset') {
      if (target.action === 'pause') await handlePauseMetaAdset(target.id, target.campaignId || '');
      else await handleResumeMetaAdset(target.id, target.campaignId || '');
    } else if (target.action === 'pause') {
      await handlePauseMetaAd(target.id, target.campaignId || '');
    } else {
      await handleResumeMetaAd(target.id, target.campaignId || '');
    }
    setProviderActionConfirm({ open: false, target: null });
  };

  const filteredCampaigns = scopedCampaigns.filter(campaign => {
    const matchesSearch = campaign.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesTab = activeTab === 'all' || 
      (activeTab === 'active' && (campaign.status === 'active' || campaign.status === 'published')) ||
      (activeTab === 'draft' && campaign.status === 'draft') ||
      (activeTab === 'paused' && campaign.status === 'paused');
    return matchesSearch && matchesTab;
  });

  const _stats = getTotalStats();

  const formatCurrency = (amount: number, currencyOverride?: string) => {
    const currency = currencyOverride || selectedAccount?.currency || accountCurrency || platforms.find((platform) => platform.platform === 'meta')?.currency || 'USD';
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      }).format(amount);
    } catch {
      return `${currency} ${amount.toFixed(2)}`;
    }
  };

  const metaResultSummary = (campaign: MetaCampaign) => {
    const objective = campaign.objective.toLowerCase();
    const isTraffic = objective.includes('traffic') || objective.includes('click');
    const isAwareness = objective.includes('awareness') || objective.includes('reach');
    const results = isTraffic
      ? Number(campaign.insights?.clicks || 0)
      : isAwareness
        ? Number(campaign.insights?.reach || 0)
        : Number(campaign.results ?? campaign.insights?.conversions ?? 0);
    const spend = Number(campaign.insights?.spend || 0);
    const resultLabel = objective.includes('lead') ? 'Leads' : isTraffic ? 'Clicks' : isAwareness ? 'Reach' : objective.includes('message') ? 'Conversations' : 'Results';
    return { results, resultLabel, cost: results > 0 ? spend / results : 0 };
  };

  const metaUnitResultSummary = (insights: MetaInsights | undefined, objectiveValue: string) => {
    const objective = objectiveValue.toLowerCase();
    const spend = Number(insights?.spend || 0);
    const isTraffic = objective.includes('traffic') || objective.includes('click');
    const isAwareness = objective.includes('awareness') || objective.includes('reach');
    const results = isTraffic ? Number(insights?.clicks || 0) : isAwareness ? Number(insights?.reach || 0) : Number(insights?.conversions || 0);
    const resultLabel = objective.includes('lead') ? 'Leads' : isTraffic ? 'Clicks' : isAwareness ? 'Reach' : objective.includes('message') ? 'Conversations' : 'Results';
    return { results, resultLabel, cost: results > 0 ? spend / results : 0 };
  };

  const providerFreshness = (campaign: MetaCampaign) => paidCampaignFreshness(
    campaign.last_refreshed_at || lastRefreshed?.toISOString(), campaign.metricsAvailable === false,
  );

  const visibleMetaCampaigns = scopedMetaCampaigns.filter((campaign) => {
    const matchesSearch = campaign.name.toLowerCase().includes(searchQuery.toLowerCase());
    const status = (campaign.effective_status || campaign.status || '').toUpperCase();
    const matchesTab = activeTab === 'all' ||
      (activeTab === 'active' && status === 'ACTIVE') ||
      (activeTab === 'paused' && status === 'PAUSED') ||
      (activeTab === 'draft' && ['DRAFT', 'IN_PROCESS', 'PENDING_REVIEW'].includes(status));
    return matchesSearch && matchesTab;
  });
  const monitoredMetaCampaigns = new Map(
    campaigns
      .filter(campaign => campaign.ad_platform === 'meta' && campaign.platform_campaign_id)
      .map(campaign => [String(campaign.platform_campaign_id), campaign] as const),
  );
  const openMetaCampaignAnalytics = (providerCampaignId: string, detail: 'performance' | 'units', unit: string | null = null) => {
    const monitoredCampaign = monitoredMetaCampaigns.get(providerCampaignId);
    const tab: CampaignPageTab = detail === 'units' ? 'delivery' : 'summary';
    if (monitoredCampaign) {
      router.push(withPaidAdsContext(managedCampaignHref(monitoredCampaign.id, tab, unit), searchParams.toString()));
      return;
    }
    router.push(withPaidAdsContext(providerCampaignHref('meta', providerCampaignId, tab, unit), searchParams.toString()));
  };
  const metaSummary = getMetaStats();
  const pausedCampaigns = scopedMetaCampaigns.filter((campaign) => (campaign.effective_status || campaign.status || '').toUpperCase() === 'PAUSED').length;
  const draftCampaigns = scopedCampaigns.filter((campaign) => ['draft', 'pending_review', 'in_process'].includes(String(campaign.local_status || campaign.status || '').toLowerCase())).length;

  if (inventoryLayout === 'table') return <PageShell maxWidth="2xl" padding="none" className={styles.surface}><UnifiedCampaignInventory onCreativeWorkspace={() => {setDatePreset(paidAdsProviderPreset({date:searchParams.get('date'),period:searchParams.get('period')}));setSearchQuery(searchParams.get('search') || '');setActiveTab(['all','active','draft','paused'].includes(searchParams.get('status') || '') ? searchParams.get('status')! : 'all');setInventoryLayout('cards');updateInventoryQuery({layout:'cards'});}}/></PageShell>;

  return (
    <PageShell maxWidth="2xl" padding="none" className={styles.surface}>
      {/* Loading Progress Bar - positioned at very top of viewport */}
      {loading && (
        <div className="fixed top-0 left-0 right-0 z-[var(--layer-header)]">
          <Progress value={loadingProgress} className="h-1 rounded-none bg-muted" />
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold">Campaign inventory</h2>
          <p className="text-sm text-muted-foreground">Create campaigns and manage their provider delivery state.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => {setInventoryLayout('table'); updateInventoryQuery({layout:'table'});}}>Compact inventory</Button>
          {/* Date Range Selector */}
          <Select value={datePreset} onValueChange={(value) => { setDatePreset(value); updateInventoryQuery({ date: value }); trackPerformanceMarketingEvent('filter_changed', { workspace: 'paid_ads_campaigns', filter: 'date', value }); }}>
            <SelectTrigger aria-label="Campaign reporting date range" className="w-[160px]">
              <Calendar className="mr-2 h-4 w-4" />
              <SelectValue placeholder="Date range" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="yesterday">Yesterday</SelectItem>
              <SelectItem value="last_7d">Last 7 Days</SelectItem>
              <SelectItem value="last_14d">Last 14 Days</SelectItem>
              <SelectItem value="last_30d">Last 30 Days</SelectItem>
              <SelectItem value="this_month">This Month</SelectItem>
              <SelectItem value="last_month">Last Month</SelectItem>
              <SelectItem value="last_90d">Last 90 Days</SelectItem>
              <SelectItem value="maximum">Lifetime</SelectItem>
            </SelectContent>
          </Select>
          
          <div className="flex items-center gap-2">
            {lastRefreshed && (
              <span className="text-xs text-muted-foreground">
                Updated {lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {useCache && <span className="ml-1">· cached</span>}
              </span>
            )}
            <Button variant="outline" onClick={isMetaConnected ? loadDataFresh : connectMeta} disabled={isMetaConnected && (refreshing || loading)}>
              {isMetaConnected ? <RefreshCw className={`mr-2 h-4 w-4 motion-reduce:animate-none ${refreshing ? 'animate-spin' : ''}`} /> : <Facebook className="mr-2 h-4 w-4 text-blue-600" />}
              {isMetaConnected ? refreshing ? 'Syncing...' : 'Sync' : 'Connect Meta Ads'}
            </Button>
          </div>
        </div>
      </div>

      <PaidAdAccountSelector value={requestedAccount} onChange={account => updateInventoryQuery({ account })} />
      {hasSelectedAccount && !selectedAccount && <p role="status" className="text-sm text-muted-foreground">{accountQuery.isPending ? 'Loading selected ad account…' : 'The selected ad account could not be resolved. Choose an available account above.'}</p>}

      {recommendationWorkflow && (
        <Card className="border-primary/30 bg-primary/[0.03]" role="region" aria-label="Accepted recommendation editing workflow">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Review accepted recommendation</CardTitle>
            <CardDescription>{recommendationWorkflow.campaignName} · recommendation #{recommendationWorkflow.recommendationId}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-medium">{recommendationWorkflow.title}</p>
              <p className="max-w-3xl text-sm text-muted-foreground">{recommendationWorkflow.suggestedNextStep}</p>
              <p className="text-xs text-muted-foreground">Creating a draft copies the campaign and accepted recommendations. It does not edit or publish a live provider campaign.</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="ghost" onClick={() => setRecommendationWorkflow(null)}>Close</Button>
              <Button onClick={() => void createRecommendationDraft()} disabled={creatingReviewDraft}>
                {creatingReviewDraft ? 'Creating…' : 'Create review draft'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {campaignsError && (
        <Callout
          tone={isMetaConnected ? 'danger' : 'warning'}
          icon={isMetaConnected ? undefined : Facebook}
          role="alert"
          title={isMetaConnected ? 'Campaign data could not be loaded' : 'Meta connection required'}
          actions={<Button variant="outline" size="sm" onClick={isMetaConnected ? loadDataFresh : connectMeta} disabled={isMetaConnected && refreshing}>{isMetaConnected ? 'Retry' : 'Connect Meta Ads'}</Button>}
        >
          {isMetaConnected ? campaignsError : 'Reconnect Meta Ads to refresh live delivery data. Cached campaigns remain available below and were not changed.'}
        </Callout>
      )}
      {platformsError && (
        <Callout tone="warning" size="sm">
          Meta connection status is unavailable. Local and Google campaign data remains visible.
        </Callout>
      )}

      {/* Platform Connection Status */}
      {!isMetaConnected && !campaignsError && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Facebook className="h-5 w-5 text-blue-600" />
              Connect Meta Ads
            </CardTitle>
            <CardDescription>
              Connect your Meta account to manage campaigns on Facebook & Instagram
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={connectMeta}>
              <Facebook className="h-4 w-4 mr-2 text-blue-600" />
              Connect Meta Ads
            </Button>
          </CardContent>
        </Card>
      )}

      <section className="grid grid-cols-2 overflow-hidden rounded-[14px] border border-border bg-card md:grid-cols-4" aria-label="Campaign inventory summary">
        {[
          ["Active", metaSummary.activeCampaigns],
          ["Paused", pausedCampaigns],
          ["Draft", draftCampaigns],
          ["Spend", formatCurrency(metaSummary.totalSpent)],
        ].map(([label, value], index) => (
          <div key={String(label)} className={`border-border px-4 py-4 md:px-5 ${index < 2 ? 'border-b md:border-b-0' : ''} ${index % 2 === 0 ? 'border-r' : ''} ${index % 4 !== 3 ? 'md:border-r' : 'md:border-r-0'}`}>
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="mt-2 font-mono text-xl font-semibold tracking-[-0.04em]">{hasSelectedAccount && !selectedAccount ? '—' : value}</p>
          </div>
        ))}
      </section>

      {/* Search and Filter */}
      <div className="flex items-center gap-4">
        <SearchInput
          placeholder="Search campaigns..."
          aria-label="Search campaigns"
          value={searchQuery}
          onValueChange={(value) => { setSearchQuery(value); updateInventoryQuery({ search: value }); }}
          wrapperClassName="flex-1 max-w-md"
        />
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(value) => { setActiveTab(value); updateInventoryQuery({ status: value }); trackPerformanceMarketingEvent('filter_changed', { workspace: 'paid_ads_campaigns', filter: 'status', value }); }}>
        <TabsList>
          <TabsTrigger value="all">All Campaigns</TabsTrigger>
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="draft">Draft</TabsTrigger>
          <TabsTrigger value="paused">Paused</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="mt-4">
          <div className="mb-6 space-y-3">
            {scopedCampaigns.length === 0 ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-4 py-3 text-sm"><div><p className="font-medium">No campaigns imported for AI monitoring</p><p className="text-xs text-muted-foreground">Provider campaigns remain fully report-only until one is imported.</p></div><Badge variant="outline">0 monitored</Badge></div> : <><div><h2 className="text-sm font-semibold">Managed campaigns</h2><p className="text-xs text-muted-foreground">Account-owned monitoring state is shown separately from provider delivery.</p></div>{filteredCampaigns.length === 0 ? <div className="rounded-lg border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">No managed campaigns match this filter.</div> : filteredCampaigns.map((campaign) => (
              <Card key={`local-${campaign.id}`}>
                <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate font-semibold">{campaign.name}</h3>
                      <Badge variant="secondary">Local: {campaign.local_status || campaign.status}</Badge>
                      <Badge variant="outline">Provider: {campaign.provider_status || 'not created'}</Badge>
                      <Badge variant="outline">{campaign.ad_platform === 'multi' ? 'Meta + Google' : campaign.ad_platform}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Objective: <span className="capitalize">{campaign.objective.replace(/_/g, ' ')}</span>
                    </p>
                    {Boolean(campaign.validation_errors?.length) && (
                      <p className="mt-2 text-xs text-destructive">{campaign.validation_errors!.join(' ')}</p>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-5 text-right text-sm">
                    <div><p className="text-xs text-muted-foreground">Lifetime cap</p><p className="font-semibold">{formatCurrency(Number(campaign.budget), campaign.currency)}</p></div>
                    <div><p className="text-xs text-muted-foreground">Allocated</p><p className="font-semibold">{formatCurrency(Number(campaign.total_allocated || 0), campaign.currency)}</p></div>
                    <div><p className="text-xs text-muted-foreground">Spent</p><p className="font-semibold">{formatCurrency(Number(campaign.spent || 0), campaign.currency)}</p></div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="outline" onClick={() => openManagedCampaignCreativePreview(campaign)}><Eye className="mr-2 h-4 w-4"/>Preview</Button>
                    <Button size="sm" variant="outline" onClick={() => router.push(withPaidAdsContext(managedCampaignHref(campaign.id), searchParams.toString()))}><BarChart3 className="mr-2 h-4 w-4"/>Performance</Button>
                    <Button size="sm" variant="ghost" onClick={() => router.push(`/dashboard/conversations?campaign=${campaign.id}&intent=edit-ad-campaign`)}><Edit className="mr-2 h-4 w-4"/>Edit</Button>
                  </div>
                </CardContent>
              </Card>
            ))}</>}
          </div>

          <div className="mb-3">
            <h2 className="text-sm font-semibold">Meta provider campaigns</h2>
            <p className="text-xs text-muted-foreground">Direct provider view and imported legacy Meta campaigns.</p>
          </div>
          {/* Meta Campaigns View with Live Analytics */}
          {loading ? (
            <div className="space-y-3" aria-label="Loading campaigns">
              {[0, 1, 2].map((item) => <_CampaignSkeleton key={item} />)}
            </div>
          ) : visibleMetaCampaigns.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Facebook className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">{metaCampaigns.length > 0 ? 'No campaigns match these filters' : 'No Meta campaigns found'}</h3>
                <p className="text-muted-foreground text-center mb-4 max-w-md">
                  {metaCampaigns.length > 0
                    ? 'Try another status or clear the search field.'
                    : isMetaConnected 
                    ? 'No active campaigns found in your Meta Ads account. Use the AI Chat to create and publish campaigns.'
                    : 'Connect your Meta account to view live campaigns.'}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {visibleMetaCampaigns.map(campaign => {
                    const isExpanded = expandedCampaigns.has(campaign.id);
                    const adsets = campaignAdsets[campaign.id] || [];
                    const ads = campaignAds[campaign.id] || [];
                    const isLoadingAdsets = loadingAdsets.has(campaign.id);
                    const monitoredCampaign = monitoredMetaCampaigns.get(campaign.id);
                    const resultSummary = metaResultSummary(campaign);
                    const campaignDeliveryAction = providerDeliveryAction(campaign.effective_status);
                    return (
                      <Collapsible key={campaign.id} open={isExpanded}>
                        <Card className="hover:shadow-md transition-shadow">
                          <CardContent className="p-0">
                            {/* Campaign Header */}
                            <div className="grid w-full min-w-0 gap-4 p-4 text-left transition-colors hover:bg-muted/50 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center 2xl:grid-cols-[minmax(280px,1fr)_minmax(440px,1.25fr)_auto]">
                              <div className="flex min-w-0 items-start gap-3">
                                <CollapsibleTrigger asChild>
                                  <Button type="button" variant="ghost" size="icon" className="mt-0.5 h-8 w-8 shrink-0" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${campaign.name}`} onClick={() => toggleCampaignExpand(campaign.id)}>
                                    {isExpanded ? <ChevronDown className="h-5 w-5 text-muted-foreground" /> : <ChevronRight className="h-5 w-5 text-muted-foreground" />}
                                  </Button>
                                </CollapsibleTrigger>
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-violet-500 text-white">
                                  <Facebook className="h-5 w-5" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    <h3 className="min-w-0 break-words font-semibold">{campaign.name}</h3>
                                    <StatusBadge status={campaign.effective_status} label={campaign.effective_status} />
                                  </div>
                                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                                    <span className="capitalize">{campaign.objective.replace(/_/g, ' ').toLowerCase()}</span>
                                    <span>•</span>
                                    <span>
                                      {campaign.daily_budget 
                                        ? `${formatCurrency(parseInt(campaign.daily_budget) / 100)}/day` 
                                        : campaign.lifetime_budget 
                                          ? `${formatCurrency(parseInt(campaign.lifetime_budget) / 100)} total`
                                          : 'No budget set'}
                                    </span>
                                    <span>•</span>
                                    <span>{campaign.created_time ? `${new Date(campaign.created_time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · Ref ${campaign.id.slice(-6)}` : `Ref ${campaign.id.slice(-6)}`}</span>
                                  </div>
                                  <p className="mt-2 text-xs text-muted-foreground 2xl:hidden">{resultSummary.resultLabel}: <span className="font-medium text-foreground">{formatNumber(resultSummary.results)}</span> · Cost/result: <span className="font-medium text-foreground">{resultSummary.results > 0 ? formatCurrency(resultSummary.cost) : '—'}</span> · Freshness: {providerFreshness(campaign)}</p>
                                </div>
                              </div>

                              {/* Campaign Metrics */}
                              {campaign.insights && (
                                <div className="hidden min-w-0 grid-cols-4 gap-x-4 gap-y-2 text-right 2xl:grid">
                                  <div>
                                    <p className="text-xs text-muted-foreground">Spent</p>
                                    <p className="font-semibold">{formatCurrency(parseFloat(campaign.insights.spend || '0'))}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-muted-foreground">{resultSummary.resultLabel}</p>
                                    <p className="font-semibold">{formatNumber(resultSummary.results)}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-muted-foreground">Cost / result</p>
                                    <p className="font-semibold">{resultSummary.results > 0 ? formatCurrency(resultSummary.cost) : '—'}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-muted-foreground">CTR</p>
                                    <p className="font-semibold">{parseFloat(campaign.insights.ctr || '0').toFixed(2)}%</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-muted-foreground">Target</p>
                                    <p className="font-semibold">No baseline</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-muted-foreground">Trend</p>
                                    <p className="font-semibold">—</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-muted-foreground">AI state</p>
                                    <p className="font-semibold">{monitoredCampaign ? 'Monitored' : 'Not monitored'}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs text-muted-foreground">Freshness</p>
                                    <p className="font-semibold">{providerFreshness(campaign)}</p>
                                  </div>
                                </div>
                              )}

                              <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
                              <Button type="button" variant="outline" size="sm" onClick={() => openMetaCampaignAnalytics(campaign.id, 'performance')}>
                                <BarChart3 className="mr-1 h-4 w-4" />
                                View details
                              </Button>
                              <Button type="button" variant="outline" size="sm" onClick={() => openCampaignCreativePreview(campaign)}>
                                {isLoadingAdsets ? <RefreshCw className="mr-1 h-4 w-4 animate-spin" /> : <Eye className="mr-1 h-4 w-4" />}
                                Preview
                              </Button>
                              <Button type="button" variant="outline" size="sm" onClick={() => openMetaCampaignAnalytics(campaign.id, 'performance')}>
                                <BarChart3 className="mr-1 h-4 w-4" />Analytics
                              </Button>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                                  <Button aria-label={`Actions for ${campaign.name}`} variant="ghost" size="icon" className="h-8 w-8">
                                    <MoreVertical className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {campaignDeliveryAction === 'pause' ? (
                                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); requestProviderAction({ type: 'campaign', action: 'pause', id: campaign.id, name: campaign.name }); }}>
                                      <Pause className="mr-2 h-4 w-4" />
                                      Pause Campaign
                                    </DropdownMenuItem>
                                  ) : campaignDeliveryAction === 'resume' ? (
                                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); requestProviderAction({ type: 'campaign', action: 'resume', id: campaign.id, name: campaign.name }); }}>
                                      <Play className="mr-2 h-4 w-4" />
                                      Resume Campaign
                                    </DropdownMenuItem>
                                  ) : (
                                    <DropdownMenuItem disabled>Delivery action unavailable for {campaign.effective_status.toLowerCase()}</DropdownMenuItem>
                                  )}
                                  <DropdownMenuItem onClick={() => window.open(`https://business.facebook.com/adsmanager/manage/campaigns?selected_campaign_ids=${encodeURIComponent(campaign.id)}`, '_blank', 'noopener,noreferrer')}>
                                    <ExternalLink className="mr-2 h-4 w-4" />
                                    View in Meta Ads Manager
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => openMetaCampaignAnalytics(campaign.id, 'performance')}>
                                    <BarChart3 className="mr-2 h-4 w-4" />
                                    View Detailed Analytics
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem 
                                    className="text-destructive"
                                    onClick={(e) => { e.stopPropagation(); handleDeleteMetaCampaign(campaign.id, campaign.name); }}
                                  >
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    Delete Campaign
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                              </div>
                            </div>

                            {/* Expanded Ad Sets Section */}
                            <CollapsibleContent>
                              <div className="border-t px-4 py-3 bg-muted/30">
                                <h4 className="font-medium text-sm mb-3 flex items-center gap-2">
                                  <Target className="h-4 w-4" />
                                  Delivery hierarchy
                                </h4>
                                
                                {hierarchyErrors[campaign.id] ? (
                                  <Callout tone="warning" role="alert" title="Hierarchy could not be refreshed" actions={<Button size="sm" variant="outline" onClick={() => void loadCampaignAdsets(campaign.id)}><RefreshCw className="mr-2 h-4 w-4"/>Retry</Button>}>
                                    {adsets.length || ads.length ? "Showing the latest cached units." : "No cached units are available yet."}
                                  </Callout>
                                ) : isLoadingAdsets ? (
                                  <div className="flex items-center justify-center py-4">
                                    <Spinner size="md" label={null} className="text-muted-foreground" />
                                    <span className="ml-2 text-sm text-muted-foreground">Loading ad sets...</span>
                                  </div>
                                ) : adsets.length === 0 ? (
                                  <p className="text-sm text-muted-foreground py-2">No ad sets found for this campaign.</p>
                                ) : (
                                  <div className="space-y-2">
                                    {adsets.map(adset => {
                                      const childAds = ads.filter(ad => ad.adset_id === adset.id);
                                      const adsetPerformance = metaUnitResultSummary(adset.insights, campaign.objective);
                                      const blockedByCampaign = campaign.effective_status === 'PAUSED' && adset.effective_status === 'ACTIVE';
                                      const adsetDeliveryAction = providerDeliveryAction(adset.effective_status);
                                      return (
                                        <Card key={adset.id} className="bg-background">
                                          <CardContent className="p-3">
                                            <div className="flex items-center justify-between">
                                              <div className="flex items-center gap-3">
                                                <div className="w-8 h-8 rounded bg-muted flex items-center justify-center">
                                                  <Target className="h-4 w-4 text-muted-foreground" />
                                                </div>
                                                <div>
                                                  <div className="flex items-center gap-2">
                                                    <span className="font-medium text-sm">{adset.name}</span>
                                                    <StatusBadge status={adset.effective_status} label={blockedByCampaign ? 'Configured active · campaign paused' : adset.effective_status} />
                                                  </div>
                                                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                                                    <span>Ad set</span>
                                                    <span>•</span>
                                                    <span>{childAds.length} ad{childAds.length === 1 ? '' : 's'}</span>
                                                  </div>
                                                </div>
                                              </div>
                                              
                                              {/* Ad Set Metrics */}
                                              {adset.insights && (
                                                <div className="hidden 2xl:grid grid-cols-6 gap-4 text-right text-sm">
                                                  <div>
                                                    <p className="text-xs text-muted-foreground">Spent</p>
                                                    <p className="font-medium">{formatCurrency(parseFloat(adset.insights.spend || '0'))}</p>
                                                  </div>
                                                  <div>
                                                    <p className="text-xs text-muted-foreground">Impressions</p>
                                                    <p className="font-medium">{formatNumber(parseInt(adset.insights.impressions || '0'))}</p>
                                                  </div>
                                                  <div>
                                                    <p className="text-xs text-muted-foreground">{adsetPerformance.resultLabel}</p>
                                                    <p className="font-medium">{formatNumber(adsetPerformance.results)}</p>
                                                  </div>
                                                  <div>
                                                    <p className="text-xs text-muted-foreground">CTR</p>
                                                    <p className="font-medium">{parseFloat(adset.insights.ctr || '0').toFixed(2)}%</p>
                                                  </div>
                                                  <div>
                                                    <p className="text-xs text-muted-foreground">Cost / result</p>
                                                    <p className="font-medium">{adsetPerformance.results > 0 ? formatCurrency(adsetPerformance.cost) : '—'}</p>
                                                  </div>
                                                  <div>
                                                    <p className="text-xs text-muted-foreground">Clicks</p>
                                                    <p className="font-medium">{formatNumber(parseInt(adset.insights.clicks || '0'))}</p>
                                                  </div>
                                                </div>
                                              )}
                                              
                                              {/* Ad Set Actions */}
                                              <div className="flex shrink-0 items-center gap-1">
                                              <Button type="button" variant="outline" size="sm" onClick={() => openAdsetCreativePreview(campaign.id, adset)}>
                                                <Eye className="mr-1 h-3.5 w-3.5" />Preview ads
                                              </Button>
                                              <Button type="button" variant="outline" size="sm" onClick={() => openMetaCampaignAnalytics(campaign.id, 'units', adset.id)}>
                                                <BarChart3 className="mr-1 h-3.5 w-3.5" />View details
                                              </Button>
                                              <DropdownMenu>
                                                <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                                                  <Button aria-label={`Actions for ad set ${adset.name}`} variant="ghost" size="icon" className="h-7 w-7">
                                                    <MoreVertical className="h-3 w-3" />
                                                  </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                  {adsetDeliveryAction === 'pause' ? (
                                                    <DropdownMenuItem onClick={() => requestProviderAction({ type: 'adset', action: 'pause', id: adset.id, campaignId: campaign.id, name: adset.name })}>
                                                      <Pause className="mr-2 h-4 w-4" />
                                                      Pause Ad Set
                                                    </DropdownMenuItem>
                                                  ) : adsetDeliveryAction === 'resume' ? (
                                                    <DropdownMenuItem onClick={() => requestProviderAction({ type: 'adset', action: 'resume', id: adset.id, campaignId: campaign.id, name: adset.name })}>
                                                      <Play className="mr-2 h-4 w-4" />
                                                      Resume Ad Set
                                                    </DropdownMenuItem>
                                                  ) : (
                                                    <DropdownMenuItem disabled>Delivery action unavailable for {adset.effective_status.toLowerCase()}</DropdownMenuItem>
                                                  )}
                                                  <DropdownMenuItem onClick={() => openMetaCampaignAnalytics(campaign.id, 'units', adset.id)}>
                                                    <BarChart3 className="mr-2 h-4 w-4" />
                                                    View detailed analytics
                                                  </DropdownMenuItem>
                                                  <DropdownMenuItem onClick={() => window.open(`https://business.facebook.com/adsmanager/manage/adsets?selected_adset_ids=${encodeURIComponent(adset.id)}`, '_blank', 'noopener,noreferrer')}>
                                                    <ExternalLink className="mr-2 h-4 w-4" />
                                                    View in Meta Ads Manager
                                                  </DropdownMenuItem>
                                                  <DropdownMenuSeparator />
                                                  <DropdownMenuItem 
                                                    className="text-destructive"
                                                    onClick={() => handleDeleteMetaAdset(adset.id, campaign.id, adset.name)}
                                                  >
                                                    <Trash2 className="mr-2 h-4 w-4" />
                                                    Delete Ad Set
                                                  </DropdownMenuItem>
                                                </DropdownMenuContent>
                                              </DropdownMenu>
                                              </div>
                                            </div>
                                            <div className="mt-3 border-l-2 border-primary/20 pl-3">
                                              <div className="mb-2 flex items-center justify-between"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Ads</p><Badge variant="outline" className="text-[10px]">{childAds.length}</Badge></div>
                                              {childAds.length ? <div className="space-y-2">{childAds.map(ad => {
                                                const adPerformance = metaUnitResultSummary(ad.insights, campaign.objective);
                                                const adSpend = Number(ad.insights?.spend || 0);
                                                const adBlockedByCampaign = campaign.effective_status === 'PAUSED' && ad.effective_status === 'ACTIVE';
                                                const adBlockedByAdset = adset.effective_status === 'PAUSED' && ad.effective_status === 'ACTIVE';
                                                const adStatusLabel = adBlockedByCampaign
                                                  ? 'Configured active · campaign paused'
                                                  : adBlockedByAdset
                                                    ? 'Configured active · ad set paused'
                                                    : ad.effective_status;
                                                const adDeliveryAction = providerDeliveryAction(ad.effective_status);
                                                return <div key={ad.id} className="flex flex-col gap-3 rounded-lg border bg-muted/15 p-3 lg:flex-row lg:items-center lg:justify-between">
                                                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-medium">{ad.name}</p><Badge variant="outline" className="text-[10px]">{adStatusLabel}</Badge></div><p className="mt-1 text-xs text-muted-foreground">Ad · Ref {ad.id.slice(-6)}</p></div>
                                                  <div className="grid grid-cols-3 gap-3 text-xs sm:grid-cols-6 lg:text-right"><div><p className="text-muted-foreground">Spend</p><p className="font-medium">{formatCurrency(adSpend)}</p></div><div><p className="text-muted-foreground">Impressions</p><p className="font-medium">{formatNumber(Number(ad.insights?.impressions || 0))}</p></div><div><p className="text-muted-foreground">Clicks</p><p className="font-medium">{formatNumber(Number(ad.insights?.clicks || 0))}</p></div><div><p className="text-muted-foreground">CTR</p><p className="font-medium">{Number(ad.insights?.ctr || 0).toFixed(2)}%</p></div><div><p className="text-muted-foreground">{adPerformance.resultLabel}</p><p className="font-medium">{formatNumber(adPerformance.results)}</p></div><div><p className="text-muted-foreground">Cost/result</p><p className="font-medium">{adPerformance.results > 0 ? formatCurrency(adPerformance.cost) : '—'}</p></div></div>
                                                  <div className="flex shrink-0 items-center gap-1">
                                                    <Button type="button" variant="outline" size="sm" onClick={() => openAdCreativePreview(campaign.id, ad)}>
                                                      <Eye className="mr-1 h-3.5 w-3.5" />Preview
                                                    </Button>
                                                    <DropdownMenu>
                                                      <DropdownMenuTrigger asChild><Button aria-label={`Actions for ad ${ad.name}`} variant="ghost" size="icon" className="h-7 w-7"><MoreVertical className="h-3 w-3"/></Button></DropdownMenuTrigger>
                                                      <DropdownMenuContent align="end">
                                                        {adDeliveryAction === 'pause'
                                                          ? <DropdownMenuItem onClick={() => requestProviderAction({ type: 'ad', action: 'pause', id: ad.id, campaignId: campaign.id, adsetId: adset.id, name: ad.name })}><Pause className="mr-2 h-4 w-4"/>Pause Ad</DropdownMenuItem>
                                                          : adDeliveryAction === 'resume'
                                                            ? <DropdownMenuItem onClick={() => requestProviderAction({ type: 'ad', action: 'resume', id: ad.id, campaignId: campaign.id, adsetId: adset.id, name: ad.name })}><Play className="mr-2 h-4 w-4"/>Resume Ad</DropdownMenuItem>
                                                            : <DropdownMenuItem disabled>Delivery action unavailable for {ad.effective_status.toLowerCase()}</DropdownMenuItem>}
                                                        <DropdownMenuItem onClick={() => openAdCreativePreview(campaign.id, ad)}><Eye className="mr-2 h-4 w-4"/>Preview creative</DropdownMenuItem>
                                                        <DropdownMenuItem onClick={() => openMetaCampaignAnalytics(campaign.id, 'units', ad.id)}><BarChart3 className="mr-2 h-4 w-4"/>View detailed analytics</DropdownMenuItem>
                                                        <DropdownMenuItem onClick={() => window.open(`https://business.facebook.com/adsmanager/manage/ads?selected_ad_ids=${encodeURIComponent(ad.id)}`, '_blank', 'noopener,noreferrer')}><ExternalLink className="mr-2 h-4 w-4"/>View in Meta Ads Manager</DropdownMenuItem>
                                                        <DropdownMenuSeparator/>
                                                        <DropdownMenuItem className="text-destructive" onClick={() => setDeleteConfirm({ open: true, target: { type: 'ad', id: ad.id, campaignId: campaign.id, adsetId: adset.id, name: ad.name } })}><Trash2 className="mr-2 h-4 w-4"/>Delete Ad</DropdownMenuItem>
                                                      </DropdownMenuContent>
                                                    </DropdownMenu>
                                                  </div>
                                                </div>;
                                              })}</div> : <p className="rounded-md border border-dashed bg-background px-3 py-4 text-xs text-muted-foreground">No individual ads were returned by the latest provider sync.</p>}
                                            </div>
                                          </CardContent>
                                        </Card>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </CollapsibleContent>
                          </CardContent>
                        </Card>
                      </Collapsible>
                    );
                  })}
              </div>
            )
          }
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={providerActionConfirm.open}
        onOpenChange={(open) => setProviderActionConfirm(prev => ({ ...prev, open }))}
        onConfirm={confirmProviderAction}
        title={`${providerActionConfirm.target?.action === 'resume' ? 'Resume' : 'Pause'} ${providerActionConfirm.target?.type === 'adset' ? 'ad set' : providerActionConfirm.target?.type || 'campaign'}?`}
        description={`${providerActionConfirm.target?.action === 'resume' ? 'Resume' : 'Pause'} "${providerActionConfirm.target?.name || 'this provider resource'}" in the connected Meta account. AskSales will record the provider result; AI consent is not changed.`}
        confirmText={providerActionConfirm.target?.action === 'resume' ? 'Resume' : 'Pause'}
        cancelText="Cancel"
        variant={providerActionConfirm.target?.action === 'pause' ? 'destructive' : 'default'}
      />

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm(prev => ({ ...prev, open }))}
        onConfirm={confirmMetaDelete}
        title={`Delete ${deleteConfirm.target?.type === 'adset' ? 'ad set' : deleteConfirm.target?.type === 'ad' ? 'ad' : 'campaign'}?`}
        description={`This permanently deletes "${deleteConfirm.target?.name || 'this item'}" from the connected Meta ad account. This action cannot be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />
    </PageShell>
  );
}
