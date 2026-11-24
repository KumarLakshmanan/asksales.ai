"use client";

import styles from "@/components/marketing/marketing.module.css";
import { CreativeResearchPanel } from "@/components/performance-marketing/CreativeResearchPanel";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, AlertTriangle, Bot, Calendar, CheckCircle2, ExternalLink, History, Megaphone, MousePointerClick, PauseCircle, RefreshCw, RotateCcw, ShieldCheck, Target, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import { usePaidAdsDashboard } from "@/hooks/usePaidAdsDashboard";
import { CampaignWorkflowList, type WorkflowCampaign } from "@/components/performance-marketing/CampaignWorkflowList";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { AnalyticsSkeleton } from "@/components/skeletons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  EvidenceDisclosure,
  FreshnessIndicator,
  HealthyState,
  PerformanceAiStateBadge,
  PerformanceMetricChain,
  PERFORMANCE_MARKETING_VIEW_KEY,
  WorkspaceFilterBar,
  type PerformanceAiState,
} from "@/components/performance-marketing/WorkspacePrimitives";
import { trackPerformanceMarketingEvent } from "@/lib/performanceMarketingAnalytics";
import { usePaidAdsAdvancedView, usePaidAdsNavigation, usePaidAdsSection } from "@/components/performance-marketing/PaidAdsSectionContext";
import { managedCampaignHref, paidAdsWorkspaceHref, providerCampaignHref, withPaidAdsContext, type CampaignPageTab } from "@/components/performance-marketing/campaignRoutes";

import { campaignAttentionReason, campaignIssueGroup, campaignResult, objectiveResultGroups, comparableCampaignGroups } from "@/lib/performancePresentation";
import { PaidAdsFilterSelect as FilterSelect } from "@/components/performance-marketing/PaidAdsFilterSelect";
import { PaidAdAccountSelector } from "@/components/performance-marketing/PaidAdAccountSelector";
import { CampaignEvidenceBadge } from "@/components/performance-marketing/CampaignEvidenceBadge";
import { compact, recommendationTitle as displayRecommendationTitle } from "@/lib/paid-ads-display";

type AiState = PerformanceAiState;
type AutonomyMode = "off" | "shadow" | "advisory" | "live_pause";
type Platform = "meta" | "google";
type TargetType = "campaign" | "ad_set" | "ad_group" | "ad";
interface DashboardSummary { totalCampaigns: number; activeCampaigns: number; totalSpend: number; totalImpressions: number; totalClicks: number; totalReach: number; totalConversions: number; avgCtr: number; avgCpc: number; avgCpm: number; changes: { impressions: number | null; clicks: number | null; spend: number | null; ctr: number | null }; includesProviderCache?: boolean }
interface AiSummary { settings: { mode: AutonomyMode; analyticsSyncMinutes: number; policyVersion: string }; consentedCampaigns: number; totalCampaigns: number; watchedUnits: number; pausedUnits: number; lastEvaluationAt: string | null; dataFreshnessAt: string | null; recentActions?: Action[]; operational?: { providerPauseFailureRate: number; manualReversalRate: number; notificationWithinTwoMinutes: number } }
interface CampaignData { id: number | string; source: "managed" | "provider_cache"; name: string; status: string; providerStatus?: string | null; objective: string; adPlatform: string; currency: string; budgetAmount: number; platformCampaignId?: string | null; accountRegistryId?: number | null; metricsUpdatedAt?: string | null; failedSyncs?: number; aiState: AiState; campaignAiConsent: boolean; openRecommendations: number; trend: number | null; targetVariance?: { metric: string; current: number; target: number; percent: number } | null; metrics: { impressions: number; clicks: number; spend: number; reach: number; conversions: number; conversionValue: number; engagements: number; leads: number; installs: number; ctr: number; cpc: number; cpm: number } }
interface DailyTrend { date: string; impressions: number; clicks: number; spend: number; reach: number; conversions: number }
interface UnitMetric { platform: Platform; targetType: TargetType; targetKey: string; parentTargetKey?: string | null; name?: string | null; providerStatus?: string | null; metricsUpdatedAt?: string | null; aggregate: Record<string, number> }
interface PerformancePoint { date: string; platform: Platform; impressions: number; clicks: number; spend: number; reach: number; conversions: number }
interface HistoricalBaseline { platform: Platform; source: string; campaignIds: number[]; metrics: Record<string, number> }
interface Evaluation { id: number; target_type: TargetType; target_key: string; platform: Platform; state: AiState; confidence: number | null; rationale?: string; metrics_snapshot?: Record<string, unknown>; rule_results?: Record<string, unknown>; created_at: string }
interface Recommendation { id: number; evaluation_id?: number | string; target_type: TargetType; target_key: string; category: string; title: string; rationale: string; evidence?: { objective?: string; evidenceWindow?: { start?: string; end?: string; metricsUpdatedAt?: string | null }; currentMetrics?: Record<string, number>; targetMetrics?: Record<string, number>; historicalComparison?: { baselineSource?: string; comparableCampaignIds?: number[] } }; expected_direction: string; suggested_next_step: string; confidence: number | null; status: string; created_at: string }
interface Action { id: number; action_type: string; actor_type: string; rationale: string; provider_outcome?: { success?: boolean; error?: string; status?: string; providerResource?: string }; created_at: string }
interface Policy { enabled: boolean; policyVersion: string; consentedAt: string | null; thresholds: Record<string, number>; reportOnly?: boolean }
interface CampaignDetail { campaign: Record<string, unknown>; policy: Policy; units: UnitMetric[]; evaluations: Evaluation[]; recommendations: Recommendation[]; actions: Action[]; performanceTrace: PerformancePoint[]; historicalBaselines: HistoricalBaseline[]; providerAggregate?: Record<string, number> }
interface CampaignDetailError { kind: "provider_not_available" | "generic"; message: string; platform?: Platform; campaignId?: string }

function money(value: number, currency = "USD") { if (!Number.isFinite(value)) return "—"; try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(value); } catch { return `${currency} ${value.toFixed(2)}`; } }
function freshLabel(value?: string | null, syncMinutes?: number) { if (!value) return "No fresh data"; const raw = value.trim(); const aware = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(raw); const parsed = new Date(aware ? raw : `${raw.replace(" ", "T")}Z`); if (Number.isNaN(parsed.getTime())) return "No fresh data"; const minutes = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 60_000)); const relative = minutes < 1 ? "Just now" : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`; return syncMinutes && minutes > Math.max(30, syncMinutes * 2) ? `Stale · ${relative}` : relative; }
function recommendationCategoryLabel(category: string) { return ({ creative: "Creative / message", audience: "Audience / targeting", landing_page: "Landing page", budget: "Bid / budget allocation", placement: "Placement / schedule", tracking: "Tracking / data quality" } as Record<string, string>)[category] || category.replaceAll("_", " "); }
function performanceConfidenceLabel(value: number | null | undefined, state?: AiState) { return (state != null && ["learning", "manual_hold", "insufficient_data"].includes(state)) || value == null || !Number.isFinite(Number(value)) || Number(value) <= 0 ? "Evidence incomplete" : `${Math.round(Number(value) * 100)}% confidence`; }
const objectivePerformance = campaignResult;

function objectiveUnitPerformance(objectiveValue: unknown, metrics: Record<string, number>) {
  const objective = String(objectiveValue || "").toLowerCase();
  const spend = Number(metrics.spend || 0);
  if (objective.includes("awareness") || objective.includes("reach")) {
    const result = Number(metrics.reach || 0);
    return { result, resultLabel: "Reach", cost: Number(metrics.cpm || (result > 0 ? (spend / result) * 1000 : 0)), costLabel: "CPM" };
  }
  if (objective.includes("traffic") || objective.includes("click")) {
    const result = Number(metrics.clicks || 0);
    return { result, resultLabel: "Clicks", cost: Number(metrics.cpc || (result > 0 ? spend / result : 0)), costLabel: "CPC" };
  }
  if (objective.includes("engagement")) {
    const result = Number(metrics.engagements || metrics.conversions || 0);
    return { result, resultLabel: "Engagements", cost: result > 0 ? spend / result : 0, costLabel: "CPE" };
  }
  if (objective.includes("lead")) {
    const result = metrics.leads == null ? Number.NaN : Number(metrics.leads);
    return { result, resultLabel: "Leads", cost: !Number.isFinite(result) ? Number.NaN : result > 0 ? spend / result : 0, costLabel: "CPL" };
  }
  if (objective.includes("app") || objective.includes("install")) {
    const result = Number(metrics.installs || metrics.conversions || 0);
    return { result, resultLabel: "Installs", cost: result > 0 ? spend / result : 0, costLabel: "CPI" };
  }
  const result = Number(metrics.conversions || 0);
  return { result, resultLabel: "Results", cost: result > 0 ? spend / result : 0, costLabel: "CPA" };
}

type PerformanceSection = "overview" | "recommendations" | "automation";
const PERFORMANCE_SECTIONS = new Set<PerformanceSection>(["overview", "recommendations", "automation"]);
type TrendMetric = "spend" | "conversions" | "reach" | "clicks";
const TREND_METRICS = new Set<TrendMetric>(["spend", "conversions", "reach", "clicks"]);
const DETAIL_TABS = new Set(["performance", "units", "recommendations", "history", "evidence", "policy"]);

export default function AdsPerformanceWorkspace() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const paidAdsNavigation = usePaidAdsNavigation();
  const sectionOverride = usePaidAdsSection();
  const requestedSection = searchParams.get("tab") as PerformanceSection | null;
  const section: PerformanceSection = sectionOverride || (requestedSection && PERFORMANCE_SECTIONS.has(requestedSection) ? requestedSection : "overview");
  const [storedAdvanced, setStoredAdvanced] = useState(searchParams.get("view") === "advanced");
  const workspaceAdvanced = usePaidAdsAdvancedView();
  const advanced = workspaceAdvanced ?? storedAdvanced;
  const [refreshing, setRefreshing] = useState(false);
  const requestedPeriod = searchParams.get("period");
  const requestedComparison = searchParams.get("comparison");
  const requestedMetric = searchParams.get("metric") as TrendMetric | null;
  const [period, setPeriod] = useState<"7d" | "30d" | "90d">(requestedPeriod === "7d" || requestedPeriod === "90d" ? requestedPeriod : "30d");
  const [comparison, setComparison] = useState<"previous_period" | "previous_year">(requestedComparison === "previous_year" ? "previous_year" : "previous_period");
  const [currency, setCurrency] = useState(searchParams.get("currency") || "");
  const [account, setAccount] = useState(searchParams.get("account") || "all");
  const [platform, setPlatform] = useState(searchParams.get("platform") || "all");
  const [objective, setObjective] = useState(searchParams.get("objective") || "all");
  const [status, setStatus] = useState(searchParams.get("status") || "all");
  const [trendMetric, setTrendMetric] = useState<TrendMetric>(requestedMetric && TREND_METRICS.has(requestedMetric) ? requestedMetric : "spend");
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [detailError, setDetailError] = useState<CampaignDetailError | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const requestedDetailTab = searchParams.get("detail");
  const requestedManagedCampaignId = searchParams.get("campaign");
  const requestedProviderCampaignId = searchParams.get("providerCampaign");
  const requestedProviderPlatform = searchParams.get("provider");
  const [detailTab, setDetailTab] = useState(DETAIL_TABS.has(requestedDetailTab || "") ? requestedDetailTab! : "performance");
  const [policySaving, setPolicySaving] = useState(false);

  useEffect(() => {
    setStoredAdvanced(searchParams.has("view") ? searchParams.get("view") === "advanced" : window.localStorage.getItem(PERFORMANCE_MARKETING_VIEW_KEY) === "advanced");
  }, [searchParams]);

  const updateWorkspaceQuery = useCallback((updates: Record<string, string | null>) => {
    paidAdsNavigation.updateQuery(updates);
  }, [paidAdsNavigation]);

  useEffect(() => {
    const requested = searchParams.get("detail");
    setDetailTab(DETAIL_TABS.has(requested || "") ? requested! : section === "recommendations" ? "recommendations" : section === "automation" ? "policy" : "performance");
  }, [searchParams, section]);

  const changeFilter = <T extends string>(key: string, value: T, setter: (next: T) => void) => {
    setter(value);
    updateWorkspaceQuery({ [key]: value });
    trackPerformanceMarketingEvent("filter_changed", { workspace: "paid_ads", filter: key, value });
  };

  const dashboardQuery = usePaidAdsDashboard<{ summary: DashboardSummary; aiSummary: AiSummary; dailyTrends: DailyTrend[]; campaigns: CampaignData[]; currency: string; availableCurrencies: string[] }>({ period, comparison, account, currency, platform, objective, status });
  const { summary = null, aiSummary = null, dailyTrends = [], campaigns = [], availableCurrencies = [] } = dashboardQuery.data || {};
  const loading = dashboardQuery.isPending;
  const loadError = dashboardQuery.error?.message || null;
  const fetchDashboard = dashboardQuery.refresh;
  const syncProviderData = async (accountOverride?: number | null) => {
    try {
      setRefreshing(true);
      if(accountOverride || account !== "all") {
        await api.post(`/api/campaigns/accounts/${accountOverride || account}/refresh`, {});
        await fetchDashboard();
        toast({title:"Account refresh requested"});
        return;
      }
      const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
      const stop = new Date();
      const start = new Date(stop); start.setUTCDate(start.getUTCDate() - (days - 1));
      const jobs: Array<Promise<unknown>> = [api.post("/api/campaigns/analytics/fetch-now", { dateStart: start.toISOString().slice(0, 10), dateStop: stop.toISOString().slice(0, 10) })];
      if (platform !== "google") jobs.push(api.post("/api/campaigns/meta/cache/refresh", {
        platform: "meta", datePreset: period === "7d" ? "last_7d" : period === "90d" ? "last_90d" : "last_30d",
      }));
      const results = await Promise.allSettled(jobs);
      await fetchDashboard();
      const failures = results.filter(result => result.status === "rejected" || (result.status === "fulfilled" && Boolean((result.value as { partialSuccess?: boolean; success?: boolean })?.partialSuccess || (result.value as { success?: boolean })?.success === false)));
      if (failures.length === results.length && failures[0]?.status === "rejected") throw failures[0].reason;
      // fetch-now answers 202 { queued: true } when the worker needs longer than the request waits.
      if (results.some(result => result.status === "fulfilled" && Boolean((result.value as { queued?: boolean })?.queued))) {
        toast({ title: "Provider sync is still running", description: "Campaign results update here when it finishes. Showing the latest stored data." });
        return;
      }
      toast({ title: failures.length ? "Provider data partially synced" : "Provider data synced", description: failures.length ? `${failures.length} provider source(s) retained their previous metrics.` : "Daily history and campaign results are now up to date." });
    } catch (error) {
      await fetchDashboard();
      toast({ title: "Provider sync could not finish", description: error instanceof Error ? error.message : "Showing the latest stored data.", variant: "destructive" });
    } finally { setRefreshing(false); }
  };
  const openCampaign = useCallback(async (campaignId: number) => {
    try { setDetailLoading(true); setDetail(null); setDetailError(null); setDetail(await api.get<CampaignDetail>(`/api/campaigns/autonomous/${campaignId}/performance`)); }
    catch (error) {
      const message = error instanceof Error ? error.message : "Try again.";
      setDetailError({ kind: "generic", message });
      toast({ title: "Campaign detail unavailable", description: message, variant: "destructive" });
    }
    finally { setDetailLoading(false); }
  }, [toast]);
  const openProviderCampaign = useCallback(async (providerPlatform: Platform, campaignId: string) => {
    try { setDetailLoading(true); setDetail(null); setDetailError(null); setDetail(await api.get<CampaignDetail>(`/api/campaigns/analytics/provider/${providerPlatform}/${encodeURIComponent(campaignId)}`)); }
    catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number((error as { status?: number }).status) : 0;
      const message = error instanceof Error ? error.message : "Try again.";
      const unavailable = status === 404;
      setDetailError({ kind: unavailable ? "provider_not_available" : "generic", message, platform: providerPlatform, campaignId });
      toast({
        title: unavailable ? "Campaign is not in the current ads account" : "Provider campaign detail unavailable",
        description: unavailable ? "Open Campaigns to select a campaign from the latest analytics snapshot." : message,
        variant: "destructive",
      });
    }
    finally { setDetailLoading(false); }
  }, [toast]);
  const inspectCampaign = (campaign: WorkflowCampaign, requestedTab?: CampaignPageTab) => {
    trackPerformanceMarketingEvent("campaign_detail_opened", { source: campaign.source, platform: campaign.adPlatform });
    const nextTab: CampaignPageTab = requestedTab || (section === "recommendations" ? "recommendations" : section === "automation" ? "automation" : "summary");
    if (campaign.source === "provider_cache") {
      router.push(withPaidAdsContext(providerCampaignHref(campaign.adPlatform, String(campaign.platformCampaignId || ""), nextTab), new URLSearchParams({...Object.fromEntries(searchParams), ...(campaign.accountRegistryId ? {account:String(campaign.accountRegistryId)} : {})}).toString()));
      return;
    }
    router.push(withPaidAdsContext(managedCampaignHref(campaign.id, nextTab), searchParams.toString()));
  };
  useEffect(() => { const campaignId = Number(requestedManagedCampaignId); if (campaignId > 0) void openCampaign(campaignId); }, [openCampaign, requestedManagedCampaignId]);
  useEffect(() => {
    if (requestedProviderCampaignId && (requestedProviderPlatform === "meta" || requestedProviderPlatform === "google")) void openProviderCampaign(requestedProviderPlatform, requestedProviderCampaignId);
  }, [openProviderCampaign, requestedProviderCampaignId, requestedProviderPlatform]);
  // The API owns provider/local status and normalized objective filtering.
  const filtered = campaigns;
  const resultGroups = useMemo(() => objectiveResultGroups(filtered), [filtered]);
  const objectiveResults = resultGroups.length === 1 && !resultGroups[0].missing ? resultGroups[0].result : Number.NaN;
  const averageCostPerResult = resultGroups.length === 1 ? resultGroups[0].cost : Number.NaN;
  const averageTargetVariance = useMemo(() => {
    const values = filtered.map((campaign) => campaign.targetVariance?.percent).filter((value): value is number => Number.isFinite(value));
    return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
  }, [filtered]);
  const attentionCampaigns = useMemo(() => filtered.filter((campaign) => {
    const stale = freshLabel(campaign.metricsUpdatedAt, aiSummary?.settings.analyticsSyncMinutes).startsWith("Stale");
    return Boolean(campaignAttentionReason(campaign, stale));
  }).sort((a, b) => {
    const priority = (campaign: CampaignData) => (campaign.aiState === "ai_paused" ? 100 : 0) + Number(campaign.failedSyncs || 0) * 10 + campaign.openRecommendations;
    return priority(b) - priority(a);
  }), [aiSummary?.settings.analyticsSyncMinutes, filtered]);
  const recommendationCampaigns = useMemo(() => filtered.filter((campaign) => campaign.openRecommendations > 0), [filtered]);
  const rankedCampaigns = useMemo(() => filtered.filter((campaign) => Number.isFinite(objectivePerformance(campaign).result) && (campaign.metrics.impressions > 0 || campaign.metrics.spend > 0)).sort((a, b) => {
    const aPerformance = objectivePerformance(a);
    const bPerformance = objectivePerformance(b);
    const aScore = a.targetVariance ? -a.targetVariance.percent : aPerformance.result > 0 ? -aPerformance.cost : (a.trend ?? Number.NEGATIVE_INFINITY);
    const bScore = b.targetVariance ? -b.targetVariance.percent : bPerformance.result > 0 ? -bPerformance.cost : (b.trend ?? Number.NEGATIVE_INFINITY);
    return bScore - aScore;
  }), [filtered]);
  const managedCampaigns = filtered.filter(campaign => campaign.source !== "provider_cache");
  const campaignCoverage = `${managedCampaigns.filter(campaign=>campaign.campaignAiConsent).length}/${managedCampaigns.length} consented`;
  const freshnessText = freshLabel(aiSummary?.dataFreshnessAt, aiSummary?.settings.analyticsSyncMinutes);
  const freshnessState = !aiSummary?.dataFreshnessAt ? "disconnected" : freshnessText.startsWith("Stale") ? "stale" : "fresh";
  const hasStoredDashboard = Boolean(summary || aiSummary || campaigns.length || dailyTrends.length);
  const trendMetricLabel = trendMetric === "conversions" ? "Conversions" : trendMetric.charAt(0).toUpperCase() + trendMetric.slice(1);
  const hasActiveCampaignFilters = account !== "all" || Boolean(currency) || platform !== "all" || objective !== "all" || status !== "all" || period !== "30d" || comparison !== "previous_period" || trendMetric !== "spend";
  const clearCampaignFilters = () => {
    setAccount("all");
    setCurrency("");
    setPlatform("all");
    setObjective("all");
    setStatus("all");
    setPeriod("30d");
    setComparison("previous_period");
    setTrendMetric("spend");
    updateWorkspaceQuery({ account: null, currency: null, platform: null, objective: null, status: null, period: null, comparison: null, metric: null });
    trackPerformanceMarketingEvent("filter_changed", { workspace: "paid_ads", filter: "all", value: "cleared" });
  };

  const updatePolicy = async (enabled: boolean) => {
    if (!detail) return;
    try { setPolicySaving(true); const response = await api.put<{ policy: Policy }>(`/api/campaigns/autonomous/${detail.campaign.id}/policy`, { enabled, thresholds: detail.policy.thresholds || {} }); setDetail({ ...detail, policy: response.policy }); await fetchDashboard(); toast({ title: enabled ? "Campaign AI pause consent enabled" : "Campaign AI pause consent revoked", description: enabled ? "Only deterministic, underperformance pauses are allowed." : "Pending AI pause actions were cancelled." }); }
    catch (error) { toast({ title: "Policy could not be updated", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" }); }
    finally { setPolicySaving(false); }
  };
  const updateRecommendation = async (item: Recommendation, next: "accepted" | "dismissed") => {
    if (!detail) return;
    await api.patch(`/api/campaigns/autonomous/${detail.campaign.id}/recommendations/${item.id}`, { status: next });
    setDetail({ ...detail, recommendations: detail.recommendations.map((row) => row.id === item.id ? { ...row, status: next } : row) });
    trackPerformanceMarketingEvent("recommendation_reviewed", { status: next, category: item.category });
    if (next === "accepted") router.push(item.category === "tracking"
      ? managedCampaignHref(String(detail.campaign.id), "technical")
      : `/dashboard/ads?tab=campaigns&edit=${detail.campaign.id}&recommendation=${item.id}`);
  };
  const resumeUnit = async (unit: UnitMetric) => {
    if (!detail) return;
    await api.post(`/api/campaigns/autonomous/${detail.campaign.id}/targets/${unit.targetType}/${encodeURIComponent(unit.targetKey)}/resume`, { platform: unit.platform });
    toast({ title: "Resume queued", description: "A 72-hour AI pause hold has been applied." });
    await openCampaign(Number(detail.campaign.id));
  };
  const createImprovedVersion = async () => {
    if (!detail) return;
    try {
      const response = await api.post<{ campaign: { id: number } }>(`/api/campaigns/autonomous/${detail.campaign.id}/improved-version`, {});
      toast({ title: "Improved draft created", description: "Accepted recommendations were attached. Review and approve the draft before publishing." });
      router.push(`/dashboard/ads?tab=campaigns&draft=${response.campaign.id}`);
    } catch (error) {
      toast({ title: "Improved draft could not be created", description: error instanceof Error ? error.message : "Accept a recommendation first.", variant: "destructive" });
    }
  };
  const importProviderCampaign = async () => {
    if (!detail || detail.campaign.source !== "provider_cache") return;
    try {
      const response = await api.post<{ campaign: { id: number } }>("/api/campaigns/autonomous/import-provider", {
        platform: detail.campaign.ad_platform,
        platformCampaignId: detail.campaign.platformCampaignId,
      });
      toast({ title: "Campaign imported for AI monitoring", description: "Autonomous pausing remains off until you explicitly enable campaign consent." });
      await fetchDashboard();
      await openCampaign(Number(response.campaign.id));
      router.replace(`/dashboard/ads?tab=automation&campaign=${response.campaign.id}&detail=policy`);
    } catch (error) {
      toast({ title: "Campaign could not be imported", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    }
  };

  const workspaceFilters = <WorkspaceFilterBar label="Paid Ads filters"><PaidAdAccountSelector className={styles.accountSelector} value={account} onChange={(value) => changeFilter("account", value, setAccount)}/><FilterSelect label="Platform" value={platform} onChange={(value) => changeFilter("platform", value, setPlatform)} items={["all","meta","google"]}/><FilterSelect label="Objective" value={objective} onChange={(value) => changeFilter("objective", value, setObjective)} items={["all","awareness","traffic","engagement","leads","sales","app_promotion","conversations","conversions"]}/><FilterSelect label="Campaign status" value={status} onChange={(value) => changeFilter("status", value, setStatus)} items={["all","draft","active","published","paused","report_only","provider_failed"]}/><Select value={period} onValueChange={(value) => changeFilter("period", value as typeof period, setPeriod)}><SelectTrigger aria-label="Reporting date range" className="self-end"><Calendar className="mr-2 h-4 w-4"/><SelectValue/></SelectTrigger><SelectContent><SelectItem value="7d">Last 7 days</SelectItem><SelectItem value="30d">Last 30 days</SelectItem><SelectItem value="90d">Last 90 days</SelectItem></SelectContent></Select>{section === "overview" && <Select value={comparison} onValueChange={(value) => changeFilter("comparison", value as typeof comparison, setComparison)}><SelectTrigger aria-label="Comparison period" className="self-end"><History className="mr-2 h-4 w-4"/><SelectValue/></SelectTrigger><SelectContent><SelectItem value="previous_period">Previous period</SelectItem><SelectItem value="previous_year">Previous year</SelectItem></SelectContent></Select>}{availableCurrencies.length > 1 && <Select value={dashboardQuery.data?.currency || currency} onValueChange={value=>changeFilter("currency",value,setCurrency)}><SelectTrigger aria-label="Reporting currency" className="self-end"><SelectValue/></SelectTrigger><SelectContent>{availableCurrencies.map(value=><SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>}</WorkspaceFilterBar>;
  const researchView = section === "recommendations" && ["research", "creativeCampaign", "creativeResearch", "creativeBrief"].some(key => searchParams.has(key));
  const researchQuery = new URLSearchParams(searchParams.toString());
  researchQuery.set("tab", "recommendations");
  researchQuery.set("research", "1");
  const queueQuery = new URLSearchParams(searchParams.toString());
  ["research", "creativeCampaign", "creativeResearch", "creativeBrief"].forEach(key => queueQuery.delete(key));
  if (researchView) return <div className={styles.researchPage}>
    <Button asChild variant="ghost" size="sm" className="mb-3"><Link href={`/dashboard/ads?${queueQuery}`}>← Back to recommendations</Link></Button>
    <CreativeResearchPanel/>
  </div>;

  return <div className={styles.workspace}>
    {section === "recommendations" && <section className={styles.researchEntry} aria-label="Creative research entry">
      <div><span className={styles.metricIcon}><Target className="h-4 w-4"/></span><div><h2>Competitor creative research</h2><p>Turn competitor observations into original concepts for your business.</p></div></div>
      <Button asChild size="sm" variant="outline"><Link href={`/dashboard/ads?${researchQuery}`}>Open creative research</Link></Button>
    </section>}
    <div className={section === "automation" ? styles.automationLayout : styles.workspace}>
    <div className={styles.workspace}>
    <FreshnessIndicator state={loadError ? (hasStoredDashboard ? "partial" : "error") : freshnessState} title={loading ? "Loading provider data…" : loadError ? (hasStoredDashboard ? "Refresh incomplete" : "Paid Ads data unavailable") : freshnessText} detail={loadError && hasStoredDashboard ? "showing the last successfully loaded analytics" : "latest provider data"} action={<Button size="sm" variant="outline" onClick={() => void syncProviderData()} disabled={refreshing || dashboardQuery.isFetching}><RefreshCw className={`mr-2 h-4 w-4 motion-reduce:animate-none ${refreshing ? "animate-spin" : ""}`}/>Sync provider data</Button>}/>
    {loading ? <AnalyticsSkeleton /> : loadError && !hasStoredDashboard ? <Card><CardContent className="flex flex-col items-center gap-3 py-16 text-center"><div><p className="font-medium">Paid Ads analytics could not be loaded.</p><p className="mt-1 text-sm text-muted-foreground">{loadError}</p></div><Button variant="outline" onClick={() => void fetchDashboard()}>Try again</Button></CardContent></Card> : <>
      {dashboardQuery.isFetching && !loading && <p role="status" className="text-sm text-muted-foreground">Updating filters and reporting data… Previously loaded values remain visible.</p>}
      {loadError && <Callout tone="warning" announce actions={<Button size="sm" variant="outline" onClick={() => void fetchDashboard()}>Retry refresh</Button>}>The latest refresh did not finish. The analytics below are from the last successful load.</Callout>}
      {campaigns.length > 0 && summary?.includesProviderCache && <div role="status" className={`${styles.notice} flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-500/30 bg-sky-500/5 text-xs text-sky-800 dark:text-sky-200`}><span>Some campaigns are report-only provider records. Review one and import it before AI monitoring can begin.</span><Button size="sm" variant="outline" asChild><Link href={paidAdsWorkspaceHref('automation', searchParams.toString())}>Set up AI monitoring</Link></Button></div>}
      {section === "overview" ? workspaceFilters : <details className={styles.filterDisclosure} open={hasActiveCampaignFilters || undefined}><summary className="flex cursor-pointer items-center justify-between gap-3 text-xs font-medium">Campaign filters<span className="text-[11px] font-normal text-muted-foreground">{account === "all" ? "All ad accounts" : "Selected ad account"} · {platform === "all" ? "All platforms" : platform} · {objective === "all" ? "All objectives" : objective.replaceAll("_", " ")} · {period === "7d" ? "Last 7 days" : period === "90d" ? "Last 90 days" : "Last 30 days"}</span></summary><div className="mt-3">{workspaceFilters}</div></details>}

      {campaigns.length === 0 ? <Card><CardContent className="flex flex-col items-center gap-4 py-16 text-center"><Megaphone className="h-9 w-9 text-primary"/><div><h2 className="font-semibold">{hasActiveCampaignFilters ? "No campaigns match current filters" : "No connected ad campaigns"}</h2><p className="text-sm text-muted-foreground">{hasActiveCampaignFilters ? "Clear the selected filters to return to the complete campaign view." : "Publish or import a campaign to start measuring performance."}</p></div>{hasActiveCampaignFilters ? <Button variant="outline" onClick={clearCampaignFilters}><RotateCcw className="mr-2 h-4 w-4"/>Clear filters</Button> : <Button asChild><Link href="/dashboard/ads?tab=campaigns">Open campaigns</Link></Button>}</CardContent></Card> : <>

      {section === "overview" && <>
        <PerformanceMetricChain items={[{ icon: Wallet, label: "Spend", value: money(summary?.totalSpend || 0, dashboardQuery.data?.currency || currency || "USD"), supporting: summary?.changes.spend == null ? "Current period" : `${summary.changes.spend >= 0 ? "+" : ""}${summary.changes.spend.toFixed(1)}% vs ${comparison === "previous_year" ? "previous year" : "previous period"}` }, { icon: Target, label: resultGroups.length === 1 ? resultGroups[0].label : "Result types", value: resultGroups.length === 1 ? compact(objectiveResults) : String(resultGroups.length), supporting: resultGroups.length > 1 ? "See separate outcomes below" : resultGroups[0]?.additive === false ? "Sum across campaigns; not unique people" : "Measured objective results" }, { icon: MousePointerClick, label: resultGroups.length === 1 ? resultGroups[0].costLabel : "Cost by outcome", value: money(averageCostPerResult, dashboardQuery.data?.currency || currency || "USD"), supporting: resultGroups.length > 1 ? "Different outcomes are not blended" : "Spend divided by measured results" }, { icon: averageTargetVariance !== null && averageTargetVariance <= 0 ? TrendingUp : TrendingDown, label: "Target variance", value: averageTargetVariance === null ? "No baseline" : `${averageTargetVariance > 0 ? "+" : ""}${averageTargetVariance.toFixed(0)}%`, supporting: "Lower cost variance is better" }]}/>
        <section aria-label="Results by objective" className={styles.outcomes}>{resultGroups.map(group => <Card key={group.key}><CardContent className="p-4"><p className="text-sm font-medium">{group.label} · {group.currency}</p><p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{group.missing ? `${compact(group.result)} measured` : compact(group.result)}</p><p className="mt-1 text-xs text-muted-foreground">{group.costLabel}: {money(group.cost, group.currency)} · {group.count} campaigns</p>{group.missing > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Results unavailable for {group.missing} campaigns; total is incomplete.</p>}{!group.additive && <p className="mt-1 text-xs text-muted-foreground">Campaign reach totals may include the same people.</p>}</CardContent></Card>)}</section>
        <div className={styles.overviewGrid}><Card className="min-w-0"><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4"/>Performance trend</CardTitle><CardDescription>One selected metric for the reporting period.</CardDescription></div><Select value={trendMetric} onValueChange={(value) => changeFilter("metric", value as TrendMetric, setTrendMetric)}><SelectTrigger aria-label="Trend metric" className="w-[150px]"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="spend">Spend</SelectItem><SelectItem value="conversions">Conversions</SelectItem><SelectItem value="reach">Reach</SelectItem><SelectItem value="clicks">Clicks</SelectItem></SelectContent></Select></div></CardHeader><CardContent className={styles.trendBody}>{dailyTrends.length ? <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 1, height: 1 }}><AreaChart data={dailyTrends}><defs><linearGradient id="selectedTrend" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/><stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))"/><XAxis dataKey="date" tick={{ fontSize: 11 }}/><YAxis tick={{ fontSize: 11 }}/><Tooltip formatter={(value) => trendMetric === "spend" ? [money(Number(value), dashboardQuery.data?.currency || currency || "USD"), trendMetricLabel] : [compact(Number(value)), trendMetricLabel]}/><Area type="monotone" dataKey={trendMetric} name={trendMetricLabel} stroke="hsl(var(--primary))" fill="url(#selectedTrend)"/></AreaChart></ResponsiveContainer> : <EmptyDetail text="Performance history will appear after the next provider sync."/>}</CardContent></Card><PerformerComparison campaigns={rankedCampaigns} onInspect={inspectCampaign}/><AttentionQueue campaigns={attentionCampaigns} syncMinutes={aiSummary?.settings.analyticsSyncMinutes} onInspect={inspectCampaign} onSync={campaign => void syncProviderData(campaign.accountRegistryId)}/></div>
        <div className="flex flex-wrap justify-end gap-2"><Button asChild variant="outline" size="sm"><Link href={paidAdsWorkspaceHref('campaigns', searchParams.toString())}>Open all campaigns</Link></Button><Button asChild variant="outline" size="sm"><Link href={paidAdsWorkspaceHref('recommendations', searchParams.toString())}>Review recommendations</Link></Button></div>
      </>}

      {section === "recommendations" && <div className="space-y-4">{aiSummary?.settings.mode === "off" && <AiModeOffCard/>}<Card><CardHeader><CardTitle className="text-base">Recommended next actions</CardTitle><CardDescription>Only campaigns with an open recommendation appear here. Open one to review its evidence before deciding.</CardDescription></CardHeader><CardContent className="space-y-3">{recommendationCampaigns.length ? recommendationCampaigns.map((campaign) => <DecisionRow key={`${campaign.source}:${campaign.id}`} campaign={campaign} actionLabel="Review recommendation" onInspect={() => inspectCampaign(campaign)}/>) : <EmptyDetail text={aiSummary?.settings.mode === "off" ? "AI analysis is off. Enable Advisory mode to generate recommendations without changing provider campaigns." : "There are no open recommendations for these filters."}/>}</CardContent></Card><Card><CardHeader><CardTitle className="text-base">Campaign reviews</CardTitle><CardDescription>Find a campaign and review its evidence and recommendations.</CardDescription></CardHeader><CardContent><CampaignWorkflowList disabled={dashboardQuery.isFetching || Boolean(loadError)} campaigns={filtered} onInspect={inspectCampaign} onChanged={fetchDashboard}/></CardContent></Card></div>}

      {section === "automation" && <>
        {aiSummary?.settings.mode === "off" && <AiModeOffCard/>}
        <Card className="border-primary/20 bg-primary/[0.025]"><CardContent className="grid gap-4 p-4 lg:grid-cols-[1.2fr_repeat(5,1fr)]"><div className="flex items-center gap-3"><div className="rounded-lg border bg-background p-2"><Bot className="h-5 w-5 text-primary"/></div><div><p className="text-xs text-muted-foreground">Account AI mode</p><p className="font-semibold capitalize">{aiSummary?.settings.mode.replace("_", " ") || "Off"}</p></div></div><ControlMetric label="Campaign consent" value={campaignCoverage}/><ControlMetric label="Last evaluation" value={freshLabel(aiSummary?.lastEvaluationAt)}/><ControlMetric label="Data freshness" value={freshLabel(aiSummary?.dataFreshnessAt, aiSummary?.settings.analyticsSyncMinutes)}/><ControlMetric label="Units watched" value={String(aiSummary?.watchedUnits || 0)}/><ControlMetric label="AI paused" value={String(aiSummary?.pausedUnits || 0)}/></CardContent></Card>
        <section aria-label="Automation coverage"><h2 className="mb-3 text-sm font-semibold">Campaign automation coverage</h2><CampaignWorkflowList disabled={dashboardQuery.isFetching || Boolean(loadError)} campaigns={filtered} automation mode={aiSummary?.settings.mode} onInspect={inspectCampaign} onChanged={fetchDashboard}/></section>
      </>}
      </>}
    </>}
    </div>
    {section === "automation" && <aside className={styles.automationRail} aria-label="Automation controls and activity"><Card><CardHeader><CardTitle className="text-base">AI safety controls</CardTitle><CardDescription>Autonomous execution remains pause-only.</CardDescription></CardHeader><CardContent className="space-y-3 text-sm"><SafetyLine ok text="Evaluate objective-specific performance"/><SafetyLine ok text="Recommend evidence-backed changes"/><SafetyLine ok={aiSummary?.settings.mode === "live_pause"} text="Pause with account and campaign consent"/><SafetyLine text="Resume, edit targeting, or increase spend"/>{advanced && <div className="grid grid-cols-3 gap-2 rounded-lg border p-2 text-center text-[11px]"><div><p className="font-mono font-semibold">{(aiSummary?.operational?.providerPauseFailureRate || 0).toFixed(1)}%</p><p className="text-muted-foreground">Failures</p></div><div><p className="font-mono font-semibold">{(aiSummary?.operational?.manualReversalRate || 0).toFixed(1)}%</p><p className="text-muted-foreground">Reversals</p></div><div><p className="font-mono font-semibold">{(aiSummary?.operational?.notificationWithinTwoMinutes ?? 100).toFixed(0)}%</p><p className="text-muted-foreground">Notify SLA</p></div></div>}</CardContent></Card><AutomationActivity actions={aiSummary?.recentActions || []}/></aside>}
    </div>
    <Sheet open={Boolean(detail) || Boolean(detailError) || detailLoading} onOpenChange={(open) => { if (!open) { setDetail(null); setDetailError(null); setDetailTab(section === "recommendations" ? "recommendations" : section === "automation" ? "policy" : "performance"); updateWorkspaceQuery({ campaign: null, provider: null, providerCampaign: null, detail: null, action: null, unit: null }); } }}><SheetContent className="w-[calc(100vw-1rem)] overflow-y-auto sm:max-w-3xl">{detailLoading && !detail && !detailError ? <><SheetHeader className="sr-only"><SheetTitle>Loading campaign evidence</SheetTitle><SheetDescription>The provider campaign detail is loading.</SheetDescription></SheetHeader><div className="py-20 text-center text-sm text-muted-foreground">Loading campaign evidence…</div></> : detailError ? <><SheetHeader><SheetTitle>Campaign analytics unavailable</SheetTitle><SheetDescription>{detailError.kind === "provider_not_available" ? "This link does not match a campaign in the latest analytics snapshot for the ads account currently connected." : "The campaign detail could not be loaded."}</SheetDescription></SheetHeader><Card className="mt-6 border-amber-500/30 bg-amber-500/[0.04]"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="h-4 w-4 text-amber-600"/>{detailError.kind === "provider_not_available" ? "Stale or mismatched campaign link" : "Campaign detail could not be loaded"}</CardTitle><CardDescription>{detailError.kind === "provider_not_available" ? "The campaign may have been removed, may belong to another Meta or Google ads account, or the link may contain an ad-account, ad-set, or ad ID instead of a campaign ID." : detailError.message}</CardDescription></CardHeader><CardContent className="space-y-4"><div className="rounded-lg border bg-background p-3 text-sm"><p className="font-medium">No campaign data was changed</p><p className="mt-1 text-muted-foreground">No sync, provider action, or AI pause was started. Return to Campaigns and open analytics from a campaign in the current list.</p>{detailError.campaignId && <p className="mt-2 font-mono text-xs text-muted-foreground">{advanced ? `Requested ${detailError.platform || "provider"} campaign: ${detailError.campaignId}` : `Reference ending ${detailError.campaignId.slice(-6)}`}</p>}</div><Button onClick={() => paidAdsNavigation.navigate("campaigns", { campaign: null, provider: null, providerCampaign: null, detail: null, action: null, unit: null })}>Return to current campaigns</Button></CardContent></Card></> : detail && <><SheetHeader><SheetTitle>{String(detail.campaign.name || "Campaign performance")}</SheetTitle><SheetDescription>{detail.policy.reportOnly ? "Latest cached provider evidence. Importing is required before AI evaluation or consent." : advanced ? "Provider evidence and AI decisions are immutable and account-scoped." : "Review performance, affected units, and recommended next actions."}</SheetDescription></SheetHeader><Tabs value={detailTab} onValueChange={(value) => { setDetailTab(value); updateWorkspaceQuery({ detail: value }); }} className="mt-6"><div className="overflow-x-auto pb-1"><TabsList className={`grid h-auto min-w-max grid-cols-3 ${advanced ? "sm:grid-cols-6" : section === "automation" ? "sm:grid-cols-5" : "sm:grid-cols-3"}`}><TabsTrigger value="performance">Summary</TabsTrigger><TabsTrigger value="units">Ads / ad sets</TabsTrigger><TabsTrigger value="recommendations">Recommendations</TabsTrigger>{(advanced || section === "automation") && <TabsTrigger value="history">Action history</TabsTrigger>}{advanced && <TabsTrigger value="evidence">Evidence</TabsTrigger>}{(advanced || section === "automation") && <TabsTrigger value="policy">Automation</TabsTrigger>}</TabsList></div>
      <TabsContent value="performance" className="space-y-4 pt-3"><DetailTrace campaign={detail.campaign} evaluation={detail.evaluations[0]} aggregate={detail.providerAggregate}/><DetailPerformanceChart points={detail.performanceTrace || []} baselines={detail.historicalBaselines || []} currency={String(detail.campaign.currency || "USD")}/>{detail.policy.reportOnly && <Card className="border-primary/30"><CardHeader><CardTitle className="text-sm">Start AI analysis for this campaign</CardTitle><CardDescription>Importing creates a monitoring record only. It does not change the provider and pause consent remains off.</CardDescription></CardHeader><CardContent><Button onClick={() => void importProviderCampaign()}>Import for AI monitoring</Button></CardContent></Card>}<Card><CardHeader><CardTitle className="text-sm">Latest deterministic decision</CardTitle></CardHeader><CardContent>{detail.evaluations[0] ? <div className="space-y-3"><div className="flex justify-between gap-3"><PerformanceAiStateBadge state={detail.evaluations[0].state}/><span className="text-right font-mono text-xs text-muted-foreground">{performanceConfidenceLabel(detail.evaluations[0].confidence, detail.evaluations[0].state)}</span></div><p className="text-sm text-muted-foreground">{detail.evaluations[0].rationale || "Evidence is stored in the rule result snapshot."}</p></div> : <EmptyDetail text={detail.policy.reportOnly ? "Import this campaign to begin storing deterministic evaluations." : aiSummary?.settings.mode === "off" ? "AI analysis is off at the account level. Enable Advisory mode to store decisions without provider changes." : "No evaluation has been stored yet."}/>}</CardContent></Card></TabsContent>
      <TabsContent value="units" className="space-y-2 pt-3">{detail.units.length ? <UnitHierarchy detail={detail} advanced={advanced} focusedUnitKey={searchParams.get("unit")} onResume={(unit) => void resumeUnit(unit)}/> : <EmptyDetail text="Ad-set and ad metrics will appear after the next successful provider sync."/>}</TabsContent>
      <TabsContent value="recommendations" className="space-y-3 pt-3">{detail.recommendations.length ? detail.recommendations.map((item) => <Card key={item.id}><CardHeader><div className="flex justify-between gap-3"><div><Badge variant="outline" className="mb-2">{recommendationCategoryLabel(item.category)}</Badge><CardTitle className="text-sm">{displayRecommendationTitle(item)}</CardTitle></div><span className="text-right font-mono text-xs text-muted-foreground">{performanceConfidenceLabel(item.confidence)}</span></div><CardDescription>{item.rationale}</CardDescription></CardHeader><CardContent className="space-y-3">{item.evidence && <div className="grid gap-2 rounded-lg border p-3 text-xs sm:grid-cols-2"><div><span className="text-muted-foreground">Affected unit</span><p className="font-medium capitalize">{item.target_type.replaceAll("_", " ")}{advanced ? ` · ${item.target_key}` : ""}</p></div><div><span className="text-muted-foreground">Objective</span><p className="font-medium capitalize">{item.evidence.objective?.replaceAll("_", " ") || "—"}</p></div><div><span className="text-muted-foreground">Evidence window</span><p className="font-medium">{item.evidence.evidenceWindow?.start || "—"} → {item.evidence.evidenceWindow?.end || "—"}</p></div><div><span className="text-muted-foreground">Comparison</span><p className="font-medium capitalize">{item.evidence.historicalComparison?.baselineSource?.replaceAll("_", " ") || "No baseline"} · {item.evidence.historicalComparison?.comparableCampaignIds?.length || 0} campaigns</p></div><RecommendationMetricComparison current={item.evidence.currentMetrics || {}} targets={item.evidence.targetMetrics || {}} /></div>}<div className="rounded-lg bg-muted/60 p-3 text-sm"><b>Expected direction</b><p className="text-muted-foreground">{item.expected_direction}</p><b className="mt-2 block">Suggested next step</b><p className="text-muted-foreground">{item.suggested_next_step}</p></div>{item.status === "open" ? <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => void updateRecommendation(item, "accepted")}>{item.category === "tracking" ? "Accept & inspect data" : "Accept & edit"}</Button><Button size="sm" variant="ghost" onClick={() => void updateRecommendation(item, "dismissed")}>Dismiss</Button></div> : <Badge className="capitalize" variant="secondary">{item.status}</Badge>}</CardContent></Card>) : <EmptyDetail text="No open recommendations for this campaign."/>}{["completed","ended"].includes(String(detail.campaign.local_status)) && <Button className="w-full" onClick={() => void createImprovedVersion()}>Create improved version</Button>}</TabsContent>
      {(advanced || section === "automation") && <TabsContent value="history" className="space-y-2 pt-3">{detail.actions.length ? detail.actions.map((action) => <div key={action.id} className="flex gap-3 border-b py-3"><History className="mt-0.5 h-4 w-4 text-muted-foreground"/><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium capitalize">{action.action_type.replaceAll("_", " ")} · {action.actor_type}</p>{action.provider_outcome?.success === false ? <Badge variant="destructive">Provider failed</Badge> : action.provider_outcome?.success === true ? <Badge variant="outline">Provider completed</Badge> : null}</div><p className="text-sm text-muted-foreground">{action.rationale}</p>{action.provider_outcome?.error && <p className="mt-1 text-xs text-destructive">{action.provider_outcome.error}</p>}{action.provider_outcome?.providerResource && <p className="mt-1 break-all text-xs text-muted-foreground">Resource: {action.provider_outcome.providerResource}</p>}<p className="mt-1 text-xs text-muted-foreground">{new Date(action.created_at).toLocaleString()}</p></div></div>) : <EmptyDetail text="No automation or provider actions have been recorded for this campaign."/>}</TabsContent>}
      {advanced && <TabsContent value="evidence" className="space-y-3 pt-3"><Card><CardHeader><CardTitle className="text-sm">Provider identifiers and diagnostics</CardTitle><CardDescription>Technical identifiers are shown only in Advanced view and do not grant additional permissions.</CardDescription></CardHeader><CardContent className="space-y-3 text-xs"><div className="grid gap-3 sm:grid-cols-2"><ControlMetric label="Platform" value={String(detail.campaign.ad_platform || "unknown")}/><ControlMetric label="Provider campaign" value={String(detail.campaign.platformCampaignId || detail.campaign.platform_campaign_id || "not created")}/></div><EvidenceDisclosure title="View raw evaluation evidence"><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-[11px]">{JSON.stringify(detail.evaluations.map(evaluation => ({ id: evaluation.id, state: evaluation.state, confidence: evaluation.confidence, targetType: evaluation.target_type, targetKey: evaluation.target_key, metrics: evaluation.metrics_snapshot, rules: evaluation.rule_results, createdAt: evaluation.created_at })), null, 2)}</pre></EvidenceDisclosure><EvidenceDisclosure title="View baseline diagnostics"><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-[11px]">{JSON.stringify(detail.historicalBaselines || [], null, 2)}</pre></EvidenceDisclosure></CardContent></Card></TabsContent>}
      <TabsContent value="policy" className="pt-3">
        {detail.policy.reportOnly ? <Card><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4"/>Import required for automation</CardTitle><CardDescription>This provider campaign is report-only. Importing creates an account-owned monitoring record; it does not change Meta or Google and leaves AI pause consent off.</CardDescription></CardHeader><CardContent><Button onClick={() => void importProviderCampaign()}>Import for AI monitoring</Button></CardContent></Card> : <Card><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4"/>Campaign pause consent</CardTitle><CardDescription>Separate from account consent. AI may pause only; it cannot resume, edit targeting, or increase spend.</CardDescription></CardHeader><CardContent className="space-y-4">
          <div className="flex items-center justify-between"><div><p className="text-sm font-medium">Allow AI to pause underperforming ads</p>{advanced && <p className="text-xs text-muted-foreground">Policy {detail.policy.policyVersion}</p>}</div><Switch aria-label="Allow AI to pause underperforming ads" checked={detail.policy.enabled} disabled={policySaving} onCheckedChange={(enabled) => void updatePolicy(enabled)}/></div>
          <div className="grid grid-cols-2 gap-3 rounded-lg border p-3 text-xs"><div><span className="text-muted-foreground">Allowed</span><p className="font-medium">Pause only</p></div><div><span className="text-muted-foreground">Notification</span><p className="font-medium">In-app + email</p></div><div><span className="text-muted-foreground">Consented</span><p className="font-medium">{detail.policy.consentedAt ? new Date(detail.policy.consentedAt).toLocaleString() : "Not consented"}</p></div><div><span className="text-muted-foreground">Revocation</span><p className="font-medium">Immediate cancellation</p></div></div>
          {advanced && <PolicyThresholdEditor thresholds={detail.policy.thresholds || {}} onChange={(thresholds) => setDetail({ ...detail, policy: { ...detail.policy, thresholds } })} onSave={() => void updatePolicy(detail.policy.enabled)} saving={policySaving}/>}
        </CardContent></Card>}
      </TabsContent>
    </Tabs></>}</SheetContent></Sheet>
  </div>;
}

function DecisionRow({ campaign, actionLabel, onInspect }: { campaign: CampaignData; actionLabel: string; onInspect: () => void }) {
  const performance = objectivePerformance(campaign);
  return <div className="group flex flex-col gap-3 rounded-xl border p-4 transition-colors hover:border-primary/30 hover:bg-primary/[0.02] sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-medium">{campaign.name}</p><CampaignEvidenceBadge campaign={campaign}/></div><p className="mt-1 text-sm text-muted-foreground">{performance.resultLabel}: {compact(performance.result)} · {performance.costLabel}: {money(performance.cost, campaign.currency)}{campaign.targetVariance ? ` · ${campaign.targetVariance.percent > 0 ? "+" : ""}${campaign.targetVariance.percent.toFixed(0)}% vs target` : " · no reliable baseline"}</p>{campaign.openRecommendations > 0 && <p className="mt-1 text-xs font-medium text-primary">{campaign.openRecommendations} recommendation{campaign.openRecommendations === 1 ? "" : "s"} ready to review</p>}</div><Button size="sm" variant="outline" onClick={onInspect}>{actionLabel}</Button></div>;
}

function AiModeOffCard() { return <Card className="border-amber-500/30 bg-amber-500/[0.04]"><CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium">AI analysis is off</p><p className="text-sm text-muted-foreground">Enable Advisory mode to evaluate campaigns and create recommendations without changing provider campaigns.</p></div><Button asChild size="sm" variant="outline"><Link href="/dashboard/settings/ads">Open Ad Settings</Link></Button></CardContent></Card>; }

function AttentionQueue({ campaigns, syncMinutes, onInspect, onSync }: { campaigns: CampaignData[]; syncMinutes?: number; onInspect: (campaign: CampaignData, tab?: CampaignPageTab) => void; onSync: (campaign: CampaignData) => void }) {
  const groups = ["Delivery issues", "Measurement issues", "Data connection issues", "Decisions waiting"];
  return <Card><CardHeader><CardTitle className="text-sm">Attention queue</CardTitle><CardDescription>{campaigns.length} campaigns need review.</CardDescription></CardHeader><CardContent className={styles.attentionList}>
    {groups.map(group => {
      const rows = campaigns.filter(c => campaignIssueGroup(c, freshLabel(c.metricsUpdatedAt, syncMinutes).startsWith("Stale")) === group);
      return rows.length > 0 && <details key={group} className="group border-b border-border last:border-b-0">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 py-3 text-xs font-medium"><span className="flex items-center gap-2"><span className={group === "Measurement issues" ? "h-1.5 w-1.5 rounded-full bg-destructive" : "h-1.5 w-1.5 rounded-full bg-amber-500"}/>{group}</span><span className="flex items-center gap-2 text-muted-foreground">{rows.length}<span aria-hidden="true" className="group-open:rotate-90">›</span></span></summary>
        <div className="divide-y">{rows.map(c => <div className="py-3" key={c.id}><p className="font-medium">{c.name}</p><p className="mt-1 text-muted-foreground">{campaignAttentionReason(c, freshLabel(c.metricsUpdatedAt, syncMinutes).startsWith("Stale"))}</p><div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => onInspect(c, group === "Decisions waiting" ? "recommendations" : group === "Delivery issues" ? "delivery" : c.adPlatform === "google" ? "google" : "meta")}>{group === "Decisions waiting" ? "Review recommendation" : group === "Delivery issues" ? "Inspect delivery" : "Open provider diagnostics"}</Button>{group === "Data connection issues" && <Button size="sm" variant="ghost" onClick={() => onSync(c)}>Sync account data</Button>}</div></div>)}</div>
      </details>;
    })}
    {!campaigns.length && <HealthyState>No delivery, measurement, connection, or recommendation issues in the selected campaigns.</HealthyState>}
  </CardContent></Card>;
}

function AutomationActivity({ actions }: { actions: Action[] }) {
  return <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><History className="h-4 w-4"/>Recent automation activity</CardTitle><CardDescription>Recorded AI, user, and provider actions. Failed provider requests are called out explicitly.</CardDescription></CardHeader><CardContent className="divide-y p-0">{actions.length ? actions.slice(0, 10).map((action) => <div key={action.id} className="flex gap-3 px-4 py-3"><History className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"/><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium capitalize">{action.action_type.replaceAll("_", " ")} · {action.actor_type}</p>{action.provider_outcome?.success === false ? <Badge variant="destructive">Provider failed</Badge> : action.provider_outcome?.success === true ? <Badge variant="outline">Provider completed</Badge> : <Badge variant="secondary">Recorded</Badge>}</div><p className="mt-1 text-sm text-muted-foreground">{action.rationale}</p>{action.provider_outcome?.error && <p className="mt-1 text-xs text-destructive">{action.provider_outcome.error}</p>}<p className="mt-1 text-xs text-muted-foreground">{new Date(action.created_at).toLocaleString()}</p></div></div>) : <HealthyState>No automation or provider-changing actions have been recorded.</HealthyState>}</CardContent></Card>;
}

function PerformerComparison({ campaigns, onInspect }: { campaigns: CampaignData[]; onInspect: (campaign: CampaignData) => void }) {
  const groups = comparableCampaignGroups(campaigns);
  const [selectedGroup, setSelectedGroup] = useState("");
  const group = groups.find(item => item.key === selectedGroup) || groups[0];
  const rows = group ? [group.members[0], ...(group.members.length > 1 ? [group.members[group.members.length - 1]] : [])] : [];
  const maximum = Math.max(...rows.map(campaign => campaignResult(campaign).cost), 1);
  return <Card><CardHeader><CardTitle className="text-sm">Same-outcome comparison</CardTitle><CardDescription>Observed costs within one outcome and currency.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {group && <Select value={group.key} onValueChange={setSelectedGroup}><SelectTrigger aria-label="Comparison outcome"><SelectValue/></SelectTrigger><SelectContent>{groups.map(item => <SelectItem value={item.key} key={item.key}>{item.label} · {item.members[0].currency}</SelectItem>)}</SelectContent></Select>}
      <div className={styles.compareRows}>{rows.map(campaign => <button key={campaign.id} className={styles.compareRow} onClick={() => onInspect(campaign)}><span><span>{campaign.name}</span><strong>{money(campaignResult(campaign).cost, campaign.currency)}</strong></span><span className={styles.compareBar}><i style={{ width: `${Math.max(3, campaignResult(campaign).cost / maximum * 100)}%` }}/></span></button>)}</div>
      {!group ? <EmptyDetail text="No campaigns have measured outcome costs for comparison."/> : <p className="text-[11px] text-muted-foreground">{group.members.length === 1 ? "Another measured campaign is needed for comparison." : group.withTargets ? "Closest and furthest from the recorded target." : `Lower and higher observed ${group.costLabel}.`} Costs alone do not establish quality.</p>}
    </CardContent>
  </Card>;
}

function UnitHierarchy({ detail, advanced, focusedUnitKey, onResume }: { detail: CampaignDetail; advanced: boolean; focusedUnitKey?: string | null; onResume: (unit: UnitMetric) => void }) {
  const groups = detail.units.filter((unit) => unit.targetType === "ad_set" || unit.targetType === "ad_group");
  const ads = detail.units.filter((unit) => unit.targetType === "ad");
  const ungroupedAds = ads.filter((ad) => !groups.some((group) => group.targetKey === ad.parentTargetKey));
  return <div className="space-y-3" aria-label="Campaign delivery hierarchy">
    {groups.map((group) => {
      const children = ads.filter((ad) => ad.parentTargetKey === group.targetKey);
      return <Card key={`${group.platform}:${group.targetType}:${group.targetKey}`} className={`overflow-hidden ${focusedUnitKey === group.targetKey ? "ring-2 ring-primary ring-offset-2" : ""}`}>
        <UnitMetricRow unit={group} detail={detail} advanced={advanced} onResume={onResume}/>
        <div className="border-t bg-muted/25 px-3 py-3 sm:px-5">
          <div className="mb-2 flex items-center justify-between gap-3"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Ads</p><Badge variant="outline">{children.length}</Badge></div>
          {children.length ? <div className="space-y-2 border-l-2 border-primary/20 pl-3">{children.map((ad) => <Card key={`${ad.platform}:ad:${ad.targetKey}`} className={`bg-background ${focusedUnitKey === ad.targetKey ? "ring-2 ring-primary ring-offset-2" : ""}`}><UnitMetricRow unit={ad} detail={detail} advanced={advanced} onResume={onResume} compactRow/></Card>)}</div> : <p className="rounded-lg border border-dashed bg-background px-3 py-4 text-sm text-muted-foreground">No individual ads were returned by the latest provider sync.</p>}
        </div>
      </Card>;
    })}
    {ungroupedAds.length > 0 && <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Ads without an ad-set match</CardTitle><CardDescription>The provider returned these ads before their parent hierarchy was available.</CardDescription></CardHeader><CardContent className="space-y-2">{ungroupedAds.map((ad) => <Card key={`${ad.platform}:ad:${ad.targetKey}`}><UnitMetricRow unit={ad} detail={detail} advanced={advanced} onResume={onResume} compactRow/></Card>)}</CardContent></Card>}
    {!groups.length && ads.map((ad) => <Card key={`${ad.platform}:ad:${ad.targetKey}`}><UnitMetricRow unit={ad} detail={detail} advanced={advanced} onResume={onResume}/></Card>)}
  </div>;
}

function UnitMetricRow({ unit, detail, advanced, onResume, compactRow = false }: { unit: UnitMetric; detail: CampaignDetail; advanced: boolean; onResume: (unit: UnitMetric) => void; compactRow?: boolean }) {
  const unitLabel = unit.name || `${unit.targetType.replace("_", " ")} without a provider name`;
  const campaignPaused = String(detail.campaign.provider_status || detail.campaign.providerStatus || "").toUpperCase().includes("PAUS");
  const unitActive = String(unit.providerStatus || "").toUpperCase() === "ACTIVE";
  const deliveryLabel = campaignPaused && unitActive ? "Configured active · campaign paused" : unit.providerStatus || "Unknown";
  const spend = Number(unit.aggregate.spend || 0);
  const performance = objectiveUnitPerformance(detail.campaign.objective || detail.campaign.raw_provider_objective, unit.aggregate);
  const providerHref = unit.platform === "meta"
    ? unit.targetType === "ad"
      ? `https://business.facebook.com/adsmanager/manage/ads?selected_ad_ids=${encodeURIComponent(unit.targetKey)}`
      : `https://business.facebook.com/adsmanager/manage/adsets?selected_adset_ids=${encodeURIComponent(unit.targetKey)}`
    : null;
  return <CardContent className={`flex flex-col gap-4 ${compactRow ? "p-3" : "p-4 sm:p-5"}`}>
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-medium">{unitLabel}</p><Badge variant={campaignPaused && unitActive ? "secondary" : "outline"} className="capitalize">{deliveryLabel}</Badge></div><p className="mt-1 text-xs capitalize text-muted-foreground">{unit.platform} · {unit.targetType.replace("_", " ")}</p>{advanced && <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">Provider key: {unit.targetKey}</p>}</div>
      <div className="grid grid-cols-3 gap-x-5 gap-y-2 text-sm sm:grid-cols-6 lg:text-right"><UnitValue label="Spend" value={money(spend, String(detail.campaign.currency || "USD"))}/><UnitValue label="Impressions" value={compact(Number(unit.aggregate.impressions || 0))}/><UnitValue label="Clicks" value={compact(Number(unit.aggregate.clicks || 0))}/><UnitValue label="CTR" value={`${Number(unit.aggregate.ctr || 0).toFixed(2)}%`}/><UnitValue label={performance.resultLabel} value={compact(performance.result)}/><UnitValue label={performance.costLabel} value={performance.result > 0 ? money(performance.cost, String(detail.campaign.currency || "USD")) : "—"}/></div>
    </div>
    <div className="flex flex-wrap justify-end gap-2">{providerHref && <Button size="sm" variant="ghost" asChild><a href={providerHref} target="_blank" rel="noreferrer"><ExternalLink className="mr-2 h-3.5 w-3.5"/>View in Meta</a></Button>}{!detail.policy.reportOnly && String(unit.providerStatus || "").toUpperCase().includes("PAUS") && <Button aria-label={`Resume ${unitLabel}`} size="sm" variant="outline" onClick={() => onResume(unit)}><RotateCcw className="mr-2 h-3.5 w-3.5"/>Resume</Button>}</div>
  </CardContent>;
}

function UnitValue({ label, value }: { label: string; value: string }) { return <div><p className="text-[11px] text-muted-foreground">{label}</p><p className="font-mono font-semibold">{value}</p></div>; }

function ControlMetric({ label, value }: { label: string; value: string }) { return <div className="border-l pl-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-mono text-sm font-semibold">{value}</p></div>; }
function SafetyLine({ ok = false, text }: { ok?: boolean; text: string }) { return <div className="flex items-start gap-2">{ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600"/> : <PauseCircle className="mt-0.5 h-4 w-4 text-muted-foreground"/>}<span>{text}</span></div>; }
function EmptyDetail({ text }: { text: string }) { return <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">{text}</div>; }
function RecommendationMetricComparison({ current, targets }: { current: Record<string, number>; targets: Record<string, number> }) { const pairs = Object.entries(targets).filter(([, value]) => Number.isFinite(Number(value))).slice(0, 4).map(([key, target]) => { const metric = key.replace(/^(target|baseline)/, ""); const currentKey = metric.charAt(0).toLowerCase() + metric.slice(1); return { metric, current: current[currentKey], target }; }); return <div className="sm:col-span-2"><span className="text-muted-foreground">Current vs target</span>{pairs.length ? <div className="mt-1 flex flex-wrap gap-2">{pairs.map((pair) => <Badge key={pair.metric} variant="secondary" className="font-mono font-normal">{pair.metric.toUpperCase()}: {Number.isFinite(Number(pair.current)) ? Number(pair.current).toFixed(2) : "—"} / {Number(pair.target).toFixed(2)}</Badge>)}</div> : <p className="font-medium">No reliable numeric target; recommendation only</p>}</div>; }
function DetailPerformanceChart({ points, baselines, currency }: { points: PerformancePoint[]; baselines: HistoricalBaseline[]; currency: string }) {
  const comparableCount = baselines.reduce((total, baseline) => total + baseline.campaignIds.length, 0);
  return <Card className="min-w-0"><CardHeader><CardTitle className="text-sm">90-day performance trace</CardTitle><CardDescription>{comparableCount >= 5 ? `Compared with ${comparableCount} account-owned campaigns.` : "No reliable five-campaign historical baseline yet."}</CardDescription></CardHeader><CardContent className="min-w-0">{points.length ? <div className="h-52 min-w-0"><ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 1, height: 1 }}><AreaChart data={points}><CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))"/><XAxis dataKey="date" tick={{ fontSize: 10 }}/><YAxis tick={{ fontSize: 10 }}/><Tooltip formatter={(value, name) => name === "spend" ? [money(Number(value), currency), "Spend"] : [compact(Number(value)), "Results"]}/><Area type="monotone" dataKey="spend" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.12)"/><Area type="monotone" dataKey="conversions" stroke="hsl(142 71% 45%)" fill="transparent"/></AreaChart></ResponsiveContainer></div> : <EmptyDetail text="Performance history will appear after provider metrics are synchronized."/>}</CardContent></Card>;
}
function DetailTrace({ campaign, evaluation, aggregate }: { campaign: Record<string, unknown>; evaluation?: Evaluation; aggregate?: Record<string, number> }) { const metrics = (evaluation?.metrics_snapshot || aggregate || {}) as Record<string, number>; const performance = objectiveUnitPerformance(campaign.objective || campaign.raw_provider_objective, metrics); const displayMetric = (value: unknown) => Number.isFinite(Number(value)) ? compact(Number(value)) : "—"; return <Card><CardHeader><CardTitle className="text-sm">Spend → Reach → Clicks → {performance.resultLabel}</CardTitle></CardHeader><CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4"><ControlMetric label="Spend" value={money(Number(metrics.spend ?? campaign.spent_amount ?? 0), String(campaign.currency || "USD"))}/><ControlMetric label="Reach" value={displayMetric(metrics.reach)}/><ControlMetric label="Clicks" value={displayMetric(metrics.clicks)}/><ControlMetric label={performance.resultLabel} value={displayMetric(performance.result)}/></CardContent></Card>; }
function PolicyThresholdEditor({ thresholds, onChange, onSave, saving }: { thresholds: Record<string, number>; onChange: (value: Record<string, number>) => void; onSave: () => void; saving: boolean }) {
  const fields = [['targetCpl', 'Target CPL'], ['targetCpa', 'Target CPA'], ['targetRoas', 'Target ROAS'], ['spendLimit', 'Campaign spend limit'], ['targetCtr', 'Target CTR %'], ['targetCpc', 'Target CPC'], ['targetCpm', 'Target CPM'], ['targetCpe', 'Target CPE'], ['targetEngagementRate', 'Engagement rate %']] as const;
  return <div className="space-y-3"><div><p className="text-sm font-medium">Campaign-specific targets</p><p className="text-xs text-muted-foreground">These override comparable history and account defaults. Leave unrelated objective metrics blank.</p></div><div className="grid gap-3 sm:grid-cols-2">{fields.map(([key, label]) => <label key={key} className="space-y-1 text-xs"><span className="text-muted-foreground">{label}</span><Input type="number" min="0" step="0.01" value={thresholds[key] || ''} onChange={(event) => { const next = { ...thresholds }; const value = Number(event.target.value); if (value > 0) next[key] = value; else delete next[key]; onChange(next); }}/></label>)}</div><Button size="sm" variant="outline" disabled={saving} onClick={onSave}>{saving ? 'Saving…' : 'Save target overrides'}</Button></div>;
}
