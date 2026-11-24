"use client";
import styles from "@/components/marketing/marketing.module.css";
import { formatReportingMoney } from '@/lib/reportingMoney';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from '@/contexts/AuthContext';
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';
import type React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, ArrowLeft, Bot, CheckCircle2, ExternalLink, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PerformanceAiStateBadge } from "@/components/performance-marketing/WorkspacePrimitives";
import {
  AdCreativePreviewWorkspace,
  type AdCreativePreviewData,
  type ProviderAccountIdentity,
} from "@/components/performance-marketing/AdCreativePreviewDialog";
import { campaignResult, objectiveMetricKey } from "@/lib/performancePresentation";
import { rankAds } from "@/lib/adPerformanceRanking";
import { trackPerformanceMarketingEvent } from "@/lib/performanceMarketingAnalytics";
import { campaignPageTab, managedCampaignHref, paidAdsReturnHref, providerCampaignHref, withPaidAdsContext, type CampaignPageTab } from "./campaignRoutes";
import { compact, recommendationTitle } from "@/lib/paid-ads-display";

type Platform = "meta" | "google";
type TargetType = "campaign" | "ad_set" | "ad_group" | "ad";
interface Blocker { code: string; message: string }
interface UnitMetric { measurementWindow?: string; platform: Platform; targetType: TargetType; targetKey: string; parentTargetKey?: string | null; name?: string | null; providerStatus?: string | null; metricsUpdatedAt?: string | null; aggregate: Record<string, number>; creative?: AdCreativePreviewData | null; dailyInsights?: Array<Record<string, unknown>> }
interface Evaluation { id: number; target_type?: TargetType; state: "learning" | "healthy" | "watch" | "recommendation" | "ai_paused" | "manual_hold" | "insufficient_data"; confidence: number; rationale?: string | null; expected_direction?: string | null; suggested_next_step?: string | null; metrics_snapshot?: Record<string, number>; rule_results?: Record<string, unknown>; created_at: string }
interface RecommendationEvent { id: number | string; actor_type: string; from_status: string; to_status: string; note?: string | null; evidence?: Record<string, unknown>; created_at: string }
interface RecommendationEvidence { objective?: string; affectedUnit?: { platform?: Platform; targetType?: TargetType; targetKey?: string; name?: string | null }; evidenceWindow?: { start?: string; end?: string; metricsUpdatedAt?: string | null }; currentMetrics?: Record<string, unknown>; targetMetrics?: Record<string, unknown>; ruleResults?: Record<string, unknown> }
interface ObservedWindow { start?: string; end?: string; measuredDays?: number; refreshedAt?: string | null; spend?: number; leads?: number | null; conversions?: number; impressions?: number; clicks?: number; cpl?: number | null; cpa?: number | null; ctr?: number | null; roas?: number | null }
interface RecommendationOutcome { before?: ObservedWindow; after?: ObservedWindow; comparison?: string; causalClaim?: boolean; note?: string; changes?: Record<string, number | null> }
interface Recommendation { id: number; evaluation_id?: number | string; target_type?: TargetType; target_key?: string; category: string; title: string; rationale: string; evidence?: RecommendationEvidence; expected_direction: string; suggested_next_step: string; confidence: number | null; status: string; dismiss_reason?: string | null; snoozed_until?: string | null; implemented_at?: string | null; implementation_note?: string | null; implementation_baseline?: ObservedWindow | null; outcome?: RecommendationOutcome | null; outcome_measured_at?: string | null; history?: RecommendationEvent[]; created_at: string }
interface Action { id: number; action_type: string; actor_type: string; rationale: string; created_at: string; metrics_snapshot?: Record<string, unknown>; budget_before?: number | string | null; budget_after?: number | string | null; provider_outcome?: Record<string, unknown> }
interface Detail {
  campaign: Record<string, unknown>;
  settings: { mode: string; analyticsSyncMinutes: number; policyVersion: string };
  policy: { enabled: boolean; reportOnly?: boolean; policyVersion: string; consentedAt?: string | null; thresholds?: Record<string, number> };
  units: UnitMetric[];
  evaluations: Evaluation[];
  recommendations: Recommendation[];
  actions: Action[];
  performanceTrace: Array<{ date: string; spend: number; conversions: number; clicks: number; reach: number; leads?: number | null; engagements?: number; installs?: number }>;
  historicalBaselines: Array<{ source: string; campaignIds: number[]; metrics: Record<string, number> }>;
  providerAggregate?: Record<string, number>;
  accountIdentity?: ProviderAccountIdentity | null;
  monitoring?: { state: "report_only" | "monitored"; importedCampaignId?: number | null; canImport: boolean };
  analysisReadiness?: { status: "ready" | "blocked" | "pending" | "import_required"; blockers: Blocker[]; baselineAvailable: boolean; successfulSyncWindows: number; latestSyncStatus?: string | null };
  automationEligibility?: { eligible: boolean; blockers: Blocker[]; nextEvaluationAt?: string; candidateTargets?: Array<{ platform?: Platform; targetType?: TargetType; targetKey?: string }> };
  currentAssessment?: { blockers: Blocker[]; rationale: string; expectedDirection: string; suggestedNextStep: string } | null;
  hierarchyState?: { status: "success" | "partial" | "empty"; groupCount: number; adCount: number };
}
interface GoogleDiagnostics { account: { name: string; customerId: string; currency?: string | null; timezone?: string | null }; campaign: Record<string, unknown>; support: { type: string; reporting: boolean; diagnostics: boolean | string; publishing: boolean; workflow: string }; searchTerms: Array<Record<string, unknown>>; keywords: Array<Record<string, unknown>>; negativeKeywordOpportunities: Array<{ searchTerm: string; matchType: string; impressions: number; clicks: number; spend: number; conversions: number; suggestion: string }>; ads: Array<Record<string, unknown>>; assets: Array<Record<string, unknown>>; conversionActions: Array<Record<string, unknown>>; landingPages: Array<Record<string, unknown>>; completeness: Record<string, number | boolean>; limitations: string[] }
interface MetaDiagnostics { account: { name: string; accountId: string; currency?: string | null; timezone?: string | null }; reportingWindow: { start: string; end: string }; campaign: Record<string, unknown>; adSets: Array<Record<string, unknown>>; placement: Array<Record<string, unknown>>; audience: Array<Record<string, unknown>>; geography: Array<Record<string, unknown>>; tracking: { state: string; pixelIds: string[]; applicationIds: string[]; configuredEvents: string[]; attributionSpecs: unknown[]; observedActionTypes: string[]; explanation: string }; leadQuality: { state:string; matchedLeads:number; qualifiedLeads:number; opportunities:number; bookings:number; bookedRevenue:number|null; wonPipelineValue:number|null; bookedRevenueByCurrency?:Record<string,number>; wonPipelineValueByCurrency?:Record<string,number>; currency:string|null; qualificationRate:number|null; attribution:string; limitation:string }; completeness: Record<string, number | boolean>; limitations: string[] }

function money(value: number, currency: string) { if (!Number.isFinite(value)) return "—"; try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(value); } catch { return `${currency} ${value.toFixed(2)}`; } }
function reportingWindowLabel(value?: string) {
  if (!value) return "Provider window";
  try { const parsed = JSON.parse(value); return typeof parsed === "string" ? parsed : parsed.start && parsed.end ? `${parsed.start} – ${parsed.end}` : value; } catch { return value; }
}
function humanStatus(value: unknown) { const text = String(value || "Unknown").replaceAll("_", " ").toLowerCase(); return text.charAt(0).toUpperCase() + text.slice(1); }
function dateLabel(value: unknown) { if (!value) return "No metrics yet"; const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? "No metrics yet" : date.toLocaleString(); }
function confidenceLabel(value: number | null | undefined, state?: Evaluation["state"]) {
  if ((state != null && ["learning", "manual_hold", "insufficient_data"].includes(state)) || value == null || !Number.isFinite(Number(value)) || Number(value) <= 0) return "Evidence incomplete";
  return `${Math.round(Number(value) * 100)}% confidence`;
}
function recommendationPriority(item: Recommendation) {
  if (item.category === "tracking") return { label: "P0 · Evidence blocker", variant: "destructive" as const };
  if (item.category === "budget") return { label: "P1 · Spend efficiency", variant: "default" as const };
  return { label: "P2 · Performance opportunity", variant: "secondary" as const };
}
function evidenceValue(key: string, value: unknown, currency: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? "—");
  if (/spend|cpa|cpl|cpc|cpm|cpe/i.test(key)) return money(numeric, currency);
  if (/ctr|rate/i.test(key)) return `${numeric.toFixed(2)}%`;
  if (/roas/i.test(key)) return `${numeric.toFixed(2)}×`;
  return compact(numeric);
}

function aggregate(detail: Detail) {
  return (detail.providerAggregate || detail.evaluations.find(item => item.target_type === "campaign")?.metrics_snapshot || {}) as Record<string, number>;
}

function objectiveChain(detail: Detail) {
  const metrics = aggregate(detail);
  const performance = campaignResult({objective: String(detail.campaign.objective || detail.campaign.raw_provider_objective || "traffic"), metrics});
  const currency = String(detail.campaign.currency || "USD");
  const showImpressions = performance.resultLabel === "Reach" || performance.resultLabel === "Clicks";
  const precedingValue = showImpressions ? metrics.impressions : metrics.clicks;
  return [["Spend", money(Number(metrics.spend ?? detail.campaign.spent_amount ?? 0), currency)],
    [showImpressions ? "Impressions" : "Clicks", compact(precedingValue == null ? Number.NaN : Number(precedingValue))],
    [performance.resultLabel, compact(performance.result)], [performance.costLabel, money(performance.cost, currency)]];
}

type CampaignDetailProps = { source: "managed" | "provider"; campaignId: string; platform?: Platform };

export default function CampaignDetailPage(props: CampaignDetailProps) {
  const params = useSearchParams();
  const { user } = useAuth();
  const businessId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  // A new account/window must never render evidence or complete navigation from
  // the previous view. Tabs stay within the same evidence context.
  const key = JSON.stringify([user?.id, businessId, props.source, props.platform, props.campaignId,
    ...['account', 'period', 'date', 'start', 'end'].map(name => params.get(name))]);
  return <CampaignDetailWorkspace key={key} {...props}/>;
}

function useActiveCampaignView() {
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  return active;
}

function CampaignDetailWorkspace({ source, campaignId, platform }: CampaignDetailProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const active = useActiveCampaignView();
  const loadGeneration = useRef(0);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importStage, setImportStage] = useState<"idle" | "importing" | "evaluating">("idle");
  const [syncing, setSyncing] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const reportingPeriod = searchParams.get("period");
  const accountId = searchParams.get("account");
  const queryTab = campaignPageTab(searchParams.get("tab"));
  const [activeTab, setActiveTab] = useState(queryTab);

  const load = useCallback(async () => {
    if (!active.current) return;
    const generation = ++loadGeneration.current;
    const current = () => active.current && generation === loadGeneration.current;
    setLoading(true); setError(null);
    try {
      const path = source === "managed"
        ? `/api/campaigns/autonomous/${encodeURIComponent(campaignId)}/performance`
        : `/api/campaigns/analytics/provider/${platform}/${encodeURIComponent(campaignId)}`;
      const query = new URLSearchParams();
      if (reportingPeriod) query.set("period", reportingPeriod);
      if (accountId) query.set("account", accountId);
      const response = await api.get<Detail>(`${path}${query.size ? `?${query}` : ""}`);
      if (current()) setDetail(response);
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "Campaign detail could not be loaded."); }
    finally { if (current()) setLoading(false); }
  }, [accountId, active, campaignId, platform, reportingPeriod, source]);
  useEffect(() => { void load(); return () => { loadGeneration.current += 1; }; }, [load]);
  useEffect(() => { setActiveTab(queryTab); }, [queryTab]);

  const setTab = (tab: string) => {
    setActiveTab(campaignPageTab(tab));
    const next = new URLSearchParams(searchParams.toString());
    if (tab === "summary") next.delete("tab"); else next.set("tab", tab);
    router.replace(`${window.location.pathname}${next.toString() ? `?${next}` : ""}`, { scroll: false });
  };

  const importCampaign = async () => {
    if (!platform || importStage !== "idle") return;
    try {
      setImportStage("importing");
      const response = await api.post<{ campaign: { id: number }; detail?: Detail }>("/api/campaigns/autonomous/import-provider", { platform, platformCampaignId: campaignId, ...(searchParams.get("account") ? {accountId:Number(searchParams.get("account"))} : {}) });
      if (!active.current) return;
      void queryClient.invalidateQueries({queryKey:["paid-ads-dashboard"],refetchType:"none"});
      setImportStage("evaluating");
      if (response.detail) setDetail(response.detail);
      router.replace((searchParams.has("returnTo") || ["account", "period", "date", "start", "end"].some(key => searchParams.has(key))) ? withPaidAdsContext(managedCampaignHref(response.campaign.id, "summary"), searchParams.toString()) : managedCampaignHref(response.campaign.id, "summary"));
      toast({ title: "Analysis ready", description: "AskSales imported monitoring evidence and ran a read-only advisory evaluation. Meta delivery was not changed." });
    } catch (cause) { if (!active.current) return; toast({ title: "Import could not finish", description: cause instanceof Error ? cause.message : "Try again.", variant: "destructive" }); }
    finally { if (active.current) setImportStage("idle"); }
  };

  const syncAccount = async () => {
    try {
      setSyncing(true);
      let id = accountId || detail?.campaign.account_registry_id || detail?.campaign.accountRegistryId;
      if (!id) {
        const accounts = await api.get<{accounts:Array<{id:number;platform:string;provider_account_id:string}>}>("/api/campaigns/accounts");
        if (!active.current) return;
        const providerId = String(detail?.campaign.ad_account_id || detail?.accountIdentity?.adAccountId || "").replace(/^act_/, "");
        id = accounts.accounts.find(account => account.platform === String(detail?.campaign.ad_platform || platform) && account.provider_account_id.replace(/^act_/, "") === providerId)?.id;
      }
      if (!active.current) return;
      if (!id) throw new Error("Select this campaign's ad account in Paid Ads before synchronizing.");
      await api.post(`/api/campaigns/accounts/${id}/refresh`, {});
      if (!active.current) return;
      await load();
      if (!active.current) return;
      void queryClient.invalidateQueries({queryKey:["paid-ads-dashboard"],refetchType:"none"});
      toast({ title: "Account reporting refreshed" });
    } catch (cause) { if (!active.current) return; toast({ title: "Account sync failed", description: cause instanceof Error ? cause.message : "Check provider permissions.", variant: "destructive" }); }
    finally { if (active.current) setSyncing(false); }
  };

  const updatePolicy = async (enabled: boolean, thresholds: Record<string, number> = detail?.policy.thresholds || {}) => {
    if (!detail || source !== "managed") return;
    if (enabled && !window.confirm("Allow AI to pause underperforming units for this campaign under the displayed safety policy?")) return;
    try { setPolicySaving(true); const response = await api.put<{ policy: Detail["policy"] }>(`/api/campaigns/autonomous/${campaignId}/policy`, { enabled, thresholds }); if (!active.current) return; setDetail(current => current ? { ...current, policy: response.policy } : current); void queryClient.invalidateQueries({queryKey:["paid-ads-dashboard"],refetchType:"none"}); trackPerformanceMarketingEvent("campaign_policy_saved",{campaignId,enabled,targetCount:Object.keys(thresholds).length}); toast({ title: "Monitoring policy saved", description: "Targets and pause consent now use this campaign policy." }); }
    catch (cause) { if (!active.current) return; toast({ title: "Policy could not be saved", description: cause instanceof Error ? cause.message : "Try again.", variant: "destructive" }); }
    finally { if (active.current) setPolicySaving(false); }
  };

  if (loading && !detail) return <PageShell maxWidth="2xl" padding="md"><LoadingState size="page" label="Loading campaign evidence…" showLabel/></PageShell>;
  if (!detail) return <PageShell maxWidth="2xl" padding="md"><Button asChild variant="ghost"><Link href={paidAdsReturnHref(searchParams.get("returnTo"))}><ArrowLeft className="mr-2 h-4 w-4"/>Campaigns</Link></Button><Card className="mt-5 border-amber-500/30"><CardHeader><CardTitle>Campaign analytics unavailable</CardTitle><CardDescription>{error || "This campaign is not in the current account snapshot."}</CardDescription></CardHeader><CardContent><Button onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4"/>Retry</Button></CardContent></Card></PageShell>;

  const campaignName = String(detail.campaign.name || "Campaign performance");
  const status = detail.campaign.provider_status || detail.campaign.providerStatus;
  const freshness = detail.campaign.metrics_updated_at || detail.campaign.last_synced_at || detail.units[0]?.metricsUpdatedAt;
  const imported = !detail.policy.reportOnly;
  const reportingWindow = detail.campaign.reporting_window as { start: string; end: string } | undefined;
  const ads = detail.units.filter(unit => unit.targetType === "ad").map(unit => ({ id: unit.targetKey, name: unit.name || "Unnamed ad", effectiveStatus: unit.providerStatus || undefined, creative: unit.creative || undefined }));

  return <PageShell maxWidth="2xl" padding="md" className={styles.surface}>
    {error && <p role="alert" className="mb-3 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{error} Previously loaded campaign evidence is retained.</p>}
    <Button asChild variant="ghost" className="-ml-2 h-7 self-start px-2 text-xs"><Link href={paidAdsReturnHref(searchParams.get("returnTo"))}><ArrowLeft className="mr-2 h-4 w-4"/>Back to campaigns</Link></Button>
    <PageHeader className={styles.header} icon={Sparkles} title={campaignName} subtitle="Full campaign evidence, advisory analysis, creatives, and automation safety in one place." actions={<div className="flex flex-wrap gap-2"><Button variant="outline" loading={syncing} loadingText="Syncing…" disabled={loading} onClick={() => void syncAccount()}><RefreshCw className="mr-2 h-4 w-4"/>Sync account</Button><Badge variant="outline">{String(detail.campaign.ad_platform || platform)}</Badge><Badge variant="secondary">{humanStatus(status)}</Badge><Badge variant={imported ? "default" : "outline"}>{imported ? "AI monitored" : "Report only"}</Badge></div>}/>

    <div className={styles.identityBar}>
      {detail.accountIdentity && <div className="flex min-w-0 flex-wrap gap-x-5 gap-y-2"><span><span className="text-muted-foreground">Ad account </span>{detail.accountIdentity.adAccountName || detail.accountIdentity.adAccountId || "Unavailable"}</span><span><span className="text-muted-foreground">Facebook Page </span>{detail.accountIdentity.facebookPageName || detail.accountIdentity.facebookPageId || "Unavailable"}</span><span><span className="text-muted-foreground">Instagram </span>{detail.accountIdentity.instagramUsername || detail.accountIdentity.instagramAccountId || (detail.accountIdentity.facebookPageId ? "Not linked" : "Identity unavailable")}</span></div>}
      <div className={styles.reportingBar}><label className="mb-3 flex items-center gap-2 text-sm">Reporting dates <select aria-label="Reporting date range" className="rounded-md border bg-background px-3 py-2" value={searchParams.get("period") || "30d"} onChange={event => { const next = new URLSearchParams(searchParams.toString()); next.set("period",event.target.value); router.replace(`${window.location.pathname}?${next}`, {scroll:false}); }}><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option></select>{loading && <span role="status">Refreshing…</span>}</label>
    {reportingWindow && <p className="mb-3 text-sm text-muted-foreground">Reporting window: {reportingWindow.start} – {reportingWindow.end}</p>}</div>
    </div>
    <div className={styles.statusStrip}>
      <StatusFact label="Provider" value={humanStatus(status)}/><StatusFact label="Evidence freshness" value={dateLabel(freshness)}/><StatusFact label="Monitoring" value={imported ? "Monitored" : "Import required"}/><StatusFact label="Baseline" value={detail.analysisReadiness?.baselineAvailable ? "Historical available" : "Not established"}/><StatusFact label="Assessment" value={detail.evaluations[0] ? humanStatus(detail.evaluations[0].state) : detail.currentAssessment ? "Provider review" : "Not evaluated"}/>
    </div>

    <Tabs value={activeTab} onValueChange={setTab}>
      <div className="overflow-x-auto pb-1"><TabsList className={styles.tabs}>
        <TabsTrigger value="summary">Summary</TabsTrigger><TabsTrigger value="delivery">Ads &amp; ad sets</TabsTrigger><TabsTrigger value="creative">Creative preview</TabsTrigger><TabsTrigger value="recommendations">Recommendations</TabsTrigger><TabsTrigger value="automation">Automation &amp; activity</TabsTrigger>{String(detail.campaign.ad_platform || platform) === "google" && <TabsTrigger value="google">Google diagnostics</TabsTrigger>}{String(detail.campaign.ad_platform || platform) === "meta" && <TabsTrigger value="meta">Meta diagnostics</TabsTrigger>}<TabsTrigger value="technical">Technical details</TabsTrigger>
      </TabsList></div>

      <TabsContent value="summary" className="pt-3">
        <div className={styles.detailGrid}>
          <div className={styles.detailMain}>
            <ObjectiveFunnel values={objectiveChain(detail)}/>
            <PerformanceChart detail={detail}/>
            <BudgetPacing detail={detail}/>
          </div>
          <aside className={styles.detailRail} aria-label="Campaign assessment and next action">
            <AssessmentCard detail={detail} onImport={importCampaign} importStage={importStage}/>
          </aside>
        </div>
      </TabsContent>
      <TabsContent value="delivery" className="space-y-3 pt-3">{detail.hierarchyState?.status === "partial" && <Callout tone="warning" size="sm" announce>Ad sets are available, but individual ad evidence is incomplete. Cached ad-set metrics remain visible.</Callout>}<Hierarchy detail={detail} onCreative={(adId) => { const next = new URLSearchParams(searchParams.toString()); next.set("tab", "creative"); next.set("ad", adId); router.push(`${window.location.pathname}?${next}`); }}/><AdRanking detail={detail}/></TabsContent>
      <TabsContent value="creative" className="pt-3"><div className={styles.creativeGrid}><CreativeComparison detail={detail}/><Card className="overflow-hidden"><AdCreativePreviewWorkspace compact ads={ads} initialAdId={searchParams.get("ad") || undefined} identity={detail.accountIdentity}/></Card></div></TabsContent>
      <TabsContent value="recommendations" className="space-y-4 pt-3">{campaignId && !detail.policy.reportOnly && <Button variant="outline" onClick={() => router.push(`/dashboard/ads?tab=recommendations&creativeCampaign=${campaignId}#creative-research`)}>Research competitor creatives</Button>}<RecommendationPanel detail={detail} campaignId={campaignId} onImport={importCampaign} importStage={importStage} onChanged={load}/></TabsContent>
      <TabsContent value="automation" className="space-y-4 pt-3"><AutomationPanel detail={detail} onImport={importCampaign} importStage={importStage} policySaving={policySaving} onPolicy={updatePolicy}/></TabsContent>
      {String(detail.campaign.ad_platform || platform) === "google" && <TabsContent value="google" className="space-y-4 pt-3"><GoogleDiagnosticsPanel source={source} campaignId={campaignId} accountId={accountId} currency={String(detail.campaign.currency || "USD")}/></TabsContent>}
      {String(detail.campaign.ad_platform || platform) === "meta" && <TabsContent value="meta" className="space-y-4 pt-3"><MetaDiagnosticsPanel detail={detail} source={source} campaignId={campaignId} accountId={accountId} period={reportingPeriod || "30d"} currency={String(detail.campaign.currency || "USD")}/></TabsContent>}
      <TabsContent value="technical" className="space-y-4 pt-3"><TechnicalPanel detail={detail}/></TabsContent>
    </Tabs>
  </PageShell>;
}

function StatusFact({ label, value }: { label: string; value: string }) { return <div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 truncate text-sm font-semibold">{value}</p></div>; }
function ObjectiveFunnel({ values }: { values: string[][] }) {
  return <Card>
    <CardHeader><CardTitle className="text-sm">Objective performance</CardTitle><CardDescription>One decision chain for this objective. Each measurement appears once.</CardDescription></CardHeader>
    <CardContent><div role="group" aria-label="Objective performance metrics" className={styles.objectiveMetrics}>{values.map(([label, value]) => <div key={label}>
      <div className="flex items-center justify-between gap-2"><p>{label}</p><Sparkles aria-hidden="true" className="h-3.5 w-3.5 text-primary"/></div><p>{value}</p>
    </div>)}</div></CardContent>
  </Card>;
}

function BudgetPacing({ detail }: { detail: Detail }) { const metrics=aggregate(detail); const currency=String(detail.campaign.currency || "USD"); const spent=Number(metrics.spend ?? detail.campaign.spent_amount ?? 0); const budget=Number(detail.campaign.budget_amount || 0); const daily=detail.campaign.budget_type==="daily"; const start=new Date(String(detail.campaign.start_date || "")); const end=new Date(String(detail.campaign.end_date || "")); const now=new Date(); const valid=budget>0 && Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end>start; const elapsed=valid?Math.max(1,Math.min(end.getTime(),now.getTime())-start.getTime()):0; const duration=valid?end.getTime()-start.getTime():0; const projected=valid?spent*duration/elapsed:null; if(!budget && !valid)return null; return <Card><CardHeader><CardTitle className="text-base">Budget pacing</CardTitle><CardDescription>Recorded spend against the planned campaign budget. Projection assumes the average spend rate since the campaign start continues.</CardDescription></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><Metric label={daily?"Daily budget":"Lifetime budget"} value={money(budget,currency)}/><Metric label="Recorded spend" value={money(spent,currency)}/><Metric label="Remaining" value={daily?"Daily cap; not a lifetime balance":money(Math.max(0,budget-spent),currency)}/><Metric label="Campaign dates" value={valid?`${start.toLocaleDateString()} – ${end.toLocaleDateString()}`:"Dates unavailable"}/><Metric label="Projected spend" value={projected==null?"—":money(projected,currency)}/></CardContent></Card>; }
function PerformanceChart({ detail }: { detail: Detail }) {
  const objective = String(detail.campaign.objective || "traffic");
  const key = objectiveMetricKey(objective);
  const metric = campaignResult({ objective, metrics: aggregate(detail) });
  const currency = String(detail.campaign.currency || "USD");
  return <Card className="min-w-0"><CardHeader><CardTitle className="text-base">Performance trend</CardTitle><CardDescription>Spend and {metric.resultLabel.toLowerCase()} over the selected reporting window. Each axis uses its own unit.</CardDescription></CardHeader><CardContent>
    {detail.performanceTrace.length ? <><div className="h-56 min-w-0" role="img" aria-label={`Campaign spend and ${metric.resultLabel.toLowerCase()} trend`}><ResponsiveContainer width="100%" height="100%" minWidth={0}><AreaChart data={detail.performanceTrace}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="date" fontSize={11}/><YAxis yAxisId="spend" fontSize={11}/><YAxis yAxisId="results" orientation="right" fontSize={11}/><Tooltip formatter={(value, name) => [name === "Spend" ? money(Number(value), currency) : compact(Number(value)), name]}/><Area yAxisId="spend" dataKey="spend" name="Spend" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / .12)"/><Area yAxisId="results" dataKey={key} name={metric.resultLabel} stroke="hsl(142 71% 45%)" fill="transparent" connectNulls={false}/></AreaChart></ResponsiveContainer></div><details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">Accessible trend values</summary><div className="mt-2 max-h-40 overflow-auto"><table className="w-full text-left"><thead><tr><th>Date</th><th>Spend ({currency})</th><th>{metric.resultLabel}</th></tr></thead><tbody>{detail.performanceTrace.map(row=><tr key={row.date}><td>{row.date}</td><td>{money(Number(row.spend),currency)}</td><td>{row[key] == null ? "Unavailable" : compact(Number(row[key]))}</td></tr>)}</tbody></table></div></details></> : <Empty text="Trend data will appear after provider metrics are synchronized."/>}
  </CardContent></Card>;
}
function AssessmentCard({ detail, onImport, importStage }: { detail: Detail; onImport: () => void; importStage: string }) {
  const evaluation = detail.evaluations[0];
  const assessment = detail.currentAssessment;
  const ready = detail.analysisReadiness?.status === "ready";
  const reporting = detail.campaign.reporting_window as { start?: string; end?: string } | undefined;
  const facts = [
    ["Objective", humanStatus(detail.campaign.objective)],
    ["Platform", humanStatus(detail.campaign.ad_platform)],
    ["Currency", String(detail.campaign.currency || "Unavailable")],
    ["Ad account", detail.accountIdentity?.adAccountName || detail.accountIdentity?.adAccountId || "Unavailable"],
    ["Reporting window", reporting?.start && reporting?.end ? `${reporting.start} – ${reporting.end}` : "Provider window"],
  ];
  return <>
    <Card className={ready ? "border-emerald-500/25" : "border-amber-500/25"}>
      <CardHeader><CardTitle className="flex items-center gap-2 text-sm">{ready ? <CheckCircle2 className="h-4 w-4 text-emerald-600"/> : <AlertTriangle className="h-4 w-4 text-amber-600"/>}Assessment</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {evaluation && <PerformanceAiStateBadge state={evaluation.state}/>}
        <p className="text-xs leading-5">{assessment?.rationale || (detail.policy.reportOnly ? "Import this reporting campaign to store a deterministic assessment." : "Evaluation is pending.")}</p>
        {Boolean(detail.analysisReadiness?.blockers.length) && <ul className="space-y-2 text-xs text-muted-foreground">{detail.analysisReadiness?.blockers.map(blocker => <li key={blocker.code}>• {blocker.message}</li>)}</ul>}
        {evaluation && !["learning", "insufficient_data", "manual_hold"].includes(evaluation.state) && <p className="text-[11px] text-muted-foreground">{confidenceLabel(evaluation.confidence, evaluation.state)}</p>}
      </CardContent>
    </Card>
    <Card className="border-primary/20 bg-primary/[.025]">
      <CardHeader><CardTitle className="text-sm">Next action</CardTitle></CardHeader>
      <CardContent className="space-y-3"><p className="text-xs leading-5">{assessment?.suggestedNextStep || (detail.policy.reportOnly ? "Import for read-only AI monitoring. Campaign pause consent remains off." : "Wait for the evaluation to finish.")}</p>{detail.policy.reportOnly && <ImportButton stage={importStage} onClick={onImport}/>}</CardContent>
    </Card>
    <Card><CardHeader><CardTitle className="text-sm">Quick details</CardTitle></CardHeader><CardContent><dl className="space-y-3">{facts.map(([label, value]) => <div key={label}><dt className="text-[10px] text-muted-foreground">{label}</dt><dd className="mt-0.5 break-words text-xs font-medium">{value}</dd></div>)}</dl></CardContent></Card>
  </>;
}

function ImportButton({ stage, onClick }: { stage: string; onClick: () => void }) { const busy = stage !== "idle"; return <Button loading={busy} loadingText={stage === "importing" ? "Importing…" : stage === "evaluating" ? "Evaluating…" : undefined} onClick={onClick}>Import for AI monitoring</Button>; }
function AdRanking({ detail }: { detail: Detail }) {
  const rows = rankAds(detail.units, String(detail.campaign.objective || "traffic"));
  const currency = String(detail.campaign.currency || "USD");
  if (!rows.length) return null;
  return <section className="overflow-hidden rounded-lg border bg-card" aria-label="Ad performance ranking">
    <div className="border-b p-4"><h2 className="font-semibold">Ad performance ranking</h2><p className="mt-1 text-sm text-muted-foreground">Ranked by {rows[0].metric.replace("conversionValue", "conversion value")}, then cost per result, within each platform and measurement window. Rankings describe observed results; they do not measure lead quality or change delivery.</p></div>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted/30 text-xs text-muted-foreground"><tr>{["Rank", "Ad", "Platform", rows[0].resultLabel, rows[0].costLabel, "Evidence"].map(label => <th key={label} className="px-4 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={`${row.ad.platform}:${row.ad.targetKey}`} className="border-t"><td className="px-4 py-3 font-semibold">{row.rank ?? "—"}</td><td className="px-4 py-3">{row.ad.name || row.ad.targetKey}</td><td className="px-4 py-3 capitalize">{row.ad.platform}</td><td className="px-4 py-3 tabular-nums">{row.result == null ? "—" : compact(row.result)}</td><td className="px-4 py-3 tabular-nums">{row.costPerResult == null ? "—" : money(row.costPerResult, currency)}</td><td className="px-4 py-3 text-xs text-muted-foreground">{row.reason || (row.result === 0 ? "No results recorded" : "Measured results")}<span className="mt-1 block">{reportingWindowLabel(row.ad.measurementWindow)}</span></td></tr>)}</tbody></table></div>
  </section>;
}

export function creativeFatigueSignal(points: Array<Record<string, unknown>>, objective = "leads") {
  const daily=points.filter(point=>Number(point.impressions || 0)>0).sort((left,right)=>String(left.date || '').localeCompare(String(right.date || '')));
  if(daily.length<6 || daily.reduce((sum,point)=>sum+Number(point.impressions || 0),0)<1000)return {state:"insufficient" as const,label:"More delivery needed",detail:"At least six delivered days and 1,000 impressions are required."};
  const split=Math.floor(daily.length/2); const summarize=(rows:typeof daily)=>{const impressions=rows.reduce((sum,row)=>sum+Number(row.impressions||0),0);const clicks=rows.reduce((sum,row)=>sum+Number(row.clicks||0),0);const spend=rows.reduce((sum,row)=>sum+Number(row.spend||0),0);const key=objectiveMetricKey(objective); const results=rows.every(row=>row[key]!=null)?rows.reduce((sum,row)=>sum+Number(row[key]),0):null;const frequencies=rows.map(row=>Number(row.frequency)).filter(Number.isFinite);return {ctr:impressions>0?100*clicks/impressions:0,cost:results!=null&&results>0?spend/results:null,frequency:frequencies.length?frequencies.reduce((a,b)=>a+b,0)/frequencies.length:null};};
  const before=summarize(daily.slice(0,split)),after=summarize(daily.slice(split)); if(before.cost==null||after.cost==null)return {state:"insufficient" as const,label:"Result evidence incomplete",detail:"Objective results are required before assessing creative fatigue."}; const deteriorating=before.ctr>0&&after.ctr<=before.ctr*.75&&before.cost!=null&&after.cost!=null&&after.cost>=before.cost*1.25;
  if(deteriorating&&after.frequency!=null&&after.frequency>=2)return {state:"fatigue" as const,label:"Fatigue signal",detail:`CTR fell ${Math.round((1-after.ctr/before.ctr)*100)}% while cost per result rose ${Math.round((Number(after.cost)/Number(before.cost)-1)*100)}%; recent frequency is ${after.frequency.toFixed(1)}.`};
  if(deteriorating)return {state:"watch" as const,label:"Efficiency declining",detail:"CTR and cost deteriorated, but frequency evidence is unavailable or below the fatigue threshold."};
  return {state:"stable" as const,label:"No sustained fatigue",detail:"The two halves of this reporting window do not show the required combined CTR, cost, and frequency deterioration."};
}

function CreativeComparison({ detail }: { detail: Detail }) { const ads=detail.units.filter(unit=>unit.targetType==="ad"); const currency=String(detail.campaign.currency||"USD"); if(!ads.length)return <StateCard title="Creative comparison" text="Ad-level creative and delivery evidence will appear after the next complete provider sync."/>; return <Card><CardHeader><CardTitle className="text-base">Creative comparison</CardTitle><CardDescription>Hooks, headlines, calls to action, spend, objective results, cost, and fatigue evidence side by side.</CardDescription></CardHeader><CardContent className="overflow-x-auto p-0"><table className="w-full min-w-[700px] text-left text-sm"><thead className="bg-muted/30 text-xs text-muted-foreground"><tr>{["Creative","Hook / headline","CTA","Spend",campaignResult({objective:String(detail.campaign.objective),metrics:aggregate(detail)}).resultLabel,campaignResult({objective:String(detail.campaign.objective),metrics:aggregate(detail)}).costLabel,"CTR","Fatigue"].map(label=><th key={label} className="px-4 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{ads.map(unit=>{const creative=object(unit.creative);const spend=Number(unit.aggregate.spend||0);const result=campaignResult({objective:String(detail.campaign.objective||"traffic"),metrics:unit.aggregate});const leads=result.result;const fatigue=creativeFatigueSignal(unit.dailyInsights||[],String(detail.campaign.objective||"traffic"));return <tr key={`${unit.platform}:${unit.targetKey}`} className="border-t align-top"><td className="px-4 py-3 font-medium">{unit.name||unit.targetKey}<span className="mt-1 block text-xs font-normal capitalize text-muted-foreground">{creative.imageUrl?"Image":creative.thumbnailUrl?"Video":"Format unavailable"}</span></td><td className="max-w-xs px-4 py-3"><p className="line-clamp-2">{String(creative.primaryText||creative.headline||"Copy unavailable")}</p>{Boolean(creative.headline&&creative.primaryText)&&<p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{String(creative.headline)}</p>}</td><td className="px-4 py-3">{humanStatus(creative.callToActionType)}</td><td className="px-4 py-3 tabular-nums">{money(spend,currency)}</td><td className="px-4 py-3 tabular-nums">{Number.isFinite(leads)?compact(leads):"Unavailable"}</td><td className="px-4 py-3 tabular-nums">{money(result.cost,currency)}</td><td className="px-4 py-3 tabular-nums">{Number(unit.aggregate.ctr||0).toFixed(2)}%</td><td className="max-w-xs px-4 py-3"><Badge variant={fatigue.state==="fatigue"?"destructive":"outline"}>{fatigue.label}</Badge><p className="mt-1 text-xs leading-5 text-muted-foreground">{fatigue.detail}</p></td></tr>;})}</tbody></table></CardContent></Card>; }

function Hierarchy({ detail, onCreative }: { detail: Detail; onCreative: (id: string) => void }) { const groups = detail.units.filter(unit => unit.targetType === "ad_set" || unit.targetType === "ad_group"); const ads = detail.units.filter(unit => unit.targetType === "ad"); if (!groups.length && !ads.length) return <Empty text="No ad sets or ads were returned by the latest provider evidence. Retry after the next successful synchronization."/>; return <div className="space-y-3">{groups.map(group => <details key={group.targetKey} className="overflow-hidden rounded-xl border bg-card"><summary className="cursor-pointer list-none"><UnitRow unit={group} detail={detail}/></summary><div className="border-t bg-muted/20 p-3 sm:p-4"><p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Ads · {ads.filter(ad => ad.parentTargetKey === group.targetKey).length}</p><div className="space-y-2">{ads.filter(ad => ad.parentTargetKey === group.targetKey).map(ad => <div key={ad.targetKey} className="rounded-lg border bg-background"><UnitRow unit={ad} detail={detail} onCreative={() => onCreative(ad.targetKey)}/></div>)}</div></div></details>)}{!groups.length && ads.map(ad => <div key={ad.targetKey} className="rounded-xl border bg-card"><UnitRow unit={ad} detail={detail} onCreative={() => onCreative(ad.targetKey)}/></div>)}</div>; }
function UnitRow({ unit, detail, onCreative }: { unit: UnitMetric; detail: Detail; onCreative?: () => void }) { const currency = String(detail.campaign.currency || "USD"); const spend = Number(unit.aggregate.spend || 0); const impressions = Number(unit.aggregate.impressions || 0); const clicks = Number(unit.aggregate.clicks || 0); const objective = String(detail.campaign.objective || ""); const result = campaignResult({objective,metrics:unit.aggregate}); return <div className="grid min-w-0 gap-4 p-4 xl:grid-cols-[minmax(240px,1fr)_minmax(570px,1.4fr)_auto] xl:items-center"><div className="min-w-0"><p className="truncate font-medium">{unit.name || `Unnamed ${unit.targetType.replace("_", " ")}`}</p><div className="mt-1 flex flex-wrap gap-2"><Badge variant="outline">{humanStatus(unit.providerStatus)}</Badge><span className="text-xs capitalize text-muted-foreground">{unit.targetType.replace("_", " ")}</span></div></div><div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6"><Metric label="Spend" value={money(spend, currency)}/><Metric label="Impressions" value={compact(impressions)}/><Metric label="Clicks" value={compact(clicks)}/><Metric label="CTR" value={impressions ? `${((clicks / impressions) * 100).toFixed(2)}%` : "—"}/><Metric label={result.resultLabel} value={compact(result.result)}/><Metric label={result.costLabel} value={money(result.cost, currency)}/></div><div className="flex flex-wrap justify-end gap-2">{onCreative && <Button size="sm" variant="outline" onClick={(event) => { event.preventDefault(); onCreative(); }}>Preview</Button>}{unit.platform === "meta" && <Button size="sm" variant="ghost" asChild><a href={`https://business.facebook.com/adsmanager/manage/${unit.targetType === "ad" ? "ads" : "adsets"}?act=${encodeURIComponent(String(detail.accountIdentity?.adAccountId||""))}&${unit.targetType === "ad" ? "selected_ad_ids" : "selected_adset_ids"}=${encodeURIComponent(unit.targetKey)}`} target="_blank" rel="noreferrer"><ExternalLink className="mr-2 h-4 w-4"/>Meta</a></Button>}</div></div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="min-w-0"><p className="whitespace-nowrap text-[11px] text-muted-foreground">{label}</p><p className="mt-1 whitespace-nowrap font-mono text-sm font-semibold tabular-nums">{value}</p></div>; }
function RecommendationPanel({ detail, campaignId, onImport, importStage, onChanged }: { detail: Detail; campaignId: string; onImport: () => void; importStage: string; onChanged: () => Promise<void> | void }) {
  const activeView = useActiveCampaignView();
  const { toast } = useToast();
  const router = useRouter();
  const [editing, setEditing] = useState<{ id: number; mode: "dismiss" | "snooze" | "implement" } | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState<number | null>(null);
  if (detail.policy.reportOnly) return <div className="space-y-4"><StateCard title="Campaign review" text={detail.currentAssessment?.rationale || "Sync provider evidence to review this campaign."}><p className="text-sm text-muted-foreground">{detail.currentAssessment?.suggestedNextStep}</p></StateCard><StateCard title="Ongoing recommendations" text="Import this campaign for saved evaluations and an advisory recommendation history."><ImportButton stage={importStage} onClick={onImport}/></StateCard></div>;
  if (detail.analysisReadiness?.status === "pending") return <StateCard title="Evaluation pending" text="Monitoring is active. The first deterministic assessment is being prepared."/>;
  const active = detail.recommendations.filter(item => ["open", "accepted", "snoozed", "implemented"].includes(item.status));
  const history = detail.recommendations.filter(item => ["dismissed", "outcome_measured"].includes(item.status));
  const blocked = detail.analysisReadiness?.status === "blocked";
  if (blocked && !active.length && !history.length) return <StateCard title="Analysis blocked" text={(detail.analysisReadiness?.blockers ?? []).map(item => item.message).join(" ")}/>;
  if (!active.length && !history.length) return <StateCard title="No action required" text="There are no evidence-backed recommendations for this campaign."/>;
  const update = async (item: Recommendation, status: "open" | "accepted" | "dismissed" | "snoozed" | "implemented" | "outcome_measured", input: Record<string, string> = {}) => {
    try {
      setSaving(item.id);
      await api.patch(`/api/campaigns/autonomous/${campaignId}/recommendations/${item.id}`, { status, ...input });
      if (!activeView.current) return;
      trackPerformanceMarketingEvent("recommendation_lifecycle_changed",{campaignId,recommendationId:item.id,category:item.category,status});
      setEditing(null); setNote("");
      await onChanged();
      if (!activeView.current) return;
      if (status === "accepted") router.push(item.category === "tracking"
        ? managedCampaignHref(campaignId, "technical")
        : `/dashboard/ads?tab=campaigns&edit=${campaignId}&recommendation=${item.id}`);
    } catch (cause) {
      if (!activeView.current) return;
      toast({ title: "Recommendation could not be updated", description: cause instanceof Error ? cause.message : "Try again.", variant: "destructive" });
    } finally { if (activeView.current) setSaving(null); }
  };
  return <div className="space-y-4">
    {blocked && <Card role="status" className={`${styles.blocker} border-amber-500/30 bg-amber-500/[0.04]`}><CardHeader><CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="h-4 w-4 text-amber-600"/>Analysis blocked</CardTitle><CardDescription className="leading-6">Performance changes are unavailable until the evidence blockers are resolved. Data-quality recommendations from the stored evaluation remain reviewable below.</CardDescription></CardHeader><CardContent><ul className="space-y-2 text-sm text-muted-foreground">{detail.analysisReadiness?.blockers.map(item => <li key={item.code} className="flex gap-2"><span aria-hidden="true">•</span><span>{item.message}</span></li>)}</ul></CardContent></Card>}
    {active.length > 0 && <section className="space-y-3" aria-labelledby="active-recommendations"><div><h2 id="active-recommendations" className="font-semibold">Active recommendations</h2><p className="mt-1 text-sm text-muted-foreground">Each card keeps the affected unit, evidence, decision, and follow-up together.</p></div>{active.map(item => <RecommendationCard key={item.id} item={item} detail={detail} blocked={blocked} saving={saving === item.id} editor={editing?.id === item.id ? editing.mode : null} note={note} onNote={setNote} onEdit={(mode) => { setEditing({ id: item.id, mode }); setNote(""); }} onCancel={() => { setEditing(null); setNote(""); }} onUpdate={(status, input) => void update(item, status, input)}/>)}</section>}
    {history.length > 0 && <section className="space-y-3 border-t pt-5" aria-labelledby="recommendation-history"><div><h2 id="recommendation-history" className="font-semibold">Completed and dismissed</h2><p className="mt-1 text-sm text-muted-foreground">Decision reasons and observed outcomes remain available for audit.</p></div>{history.map(item => <RecommendationCard key={item.id} item={item} detail={detail} blocked={false} saving={saving === item.id} editor={editing?.id === item.id ? editing.mode : null} note={note} onNote={setNote} onEdit={(mode) => { setEditing({ id: item.id, mode }); setNote(""); }} onCancel={() => { setEditing(null); setNote(""); }} onUpdate={(status, input) => void update(item, status, input)}/>)}</section>}
  </div>;
}

function RecommendationCard({ item, detail, blocked, saving, editor, note, onNote, onEdit, onCancel, onUpdate }: { item: Recommendation; detail: Detail; blocked: boolean; saving: boolean; editor: "dismiss" | "snooze" | "implement" | null; note: string; onNote: (value: string) => void; onEdit: (mode: "dismiss" | "snooze" | "implement") => void; onCancel: () => void; onUpdate: (status: "open" | "accepted" | "dismissed" | "snoozed" | "implemented" | "outcome_measured", input?: Record<string, string>) => void }) {
  const priority = recommendationPriority(item);
  const evidence = item.evidence || {};
  const unit = evidence.affectedUnit;
  const currency = String(detail.campaign.currency || "USD");
  const currentMetrics = Object.entries(evidence.currentMetrics || {}).filter(([key, value]) => ["spend", "impressions", "clicks", "leads", "conversions", "ctr", "cpa", "roas"].includes(key) && value != null).slice(0, 6);
  const targetMetrics = Object.entries(evidence.targetMetrics || {});
  const outcomeAvailableAt = item.implemented_at ? new Date(new Date(item.implemented_at).setUTCDate(new Date(item.implemented_at).getUTCDate() + 8)) : null;
  const outcomeReady = outcomeAvailableAt ? outcomeAvailableAt <= new Date() : false;
  const snooze = (days: number) => { const until = new Date(); until.setUTCDate(until.getUTCDate() + days); onUpdate("snoozed", { snoozedUntil: until.toISOString() }); };
  return <Card className={`${styles.recommendation} ${item.category === "tracking" && item.status !== "outcome_measured" ? "border-destructive/30" : ""}`}>
    <CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap gap-2"><Badge variant={priority.variant}>{priority.label}</Badge><Badge variant="outline">{humanStatus(item.status)}</Badge></div><CardTitle className="mt-1.5 text-base">{recommendationTitle(item)}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{unit?.name || humanStatus(unit?.targetType || item.target_type)} · {unit?.targetKey || item.target_key || "Campaign"}</p></div><span className="text-xs text-muted-foreground">{confidenceLabel(item.confidence, blocked ? "insufficient_data" : undefined)}</span></div><CardDescription className="leading-6">{item.rationale}</CardDescription></CardHeader>
    <CardContent className={styles.recommendationBody}>
      <div className={styles.recommendationEvidence}><div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Evidence window</p><p className="mt-1 text-sm">{evidence.evidenceWindow?.start && evidence.evidenceWindow?.end ? `${evidence.evidenceWindow.start} – ${evidence.evidenceWindow.end}` : "Unavailable"}</p><p className="mt-1 text-xs text-muted-foreground">Refreshed {dateLabel(evidence.evidenceWindow?.metricsUpdatedAt)}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Why it matters</p><p className="mt-1 text-sm">{item.expected_direction}</p></div></div>
      {currentMetrics.length > 0 && <div className={styles.recommendationMetrics}><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Observed metrics</p><dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">{currentMetrics.map(([key, value]) => <div key={key} className="rounded-md bg-muted/35 px-3 py-2"><dt className="text-[11px] text-muted-foreground">{humanStatus(key)}</dt><dd className="mt-1 font-mono text-sm font-semibold tabular-nums">{evidenceValue(key, value, currency)}</dd></div>)}</dl></div>}
      {targetMetrics.length > 0 && <p className="text-sm"><span className="text-muted-foreground">Configured comparison:</span> {targetMetrics.map(([key, value]) => `${humanStatus(key)} ${evidenceValue(key, value, currency)}`).join(" · ")}</p>}
      <div className={styles.recommendationNext}><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Proposed next step</p><p className="mt-1 text-sm leading-6">{item.suggested_next_step}</p></div>
      {item.status === "snoozed" && <p className="text-sm">Hidden until <strong>{dateLabel(item.snoozed_until)}</strong>.</p>}
      {item.status === "implemented" && <div className="space-y-1 text-sm"><p><span className="text-muted-foreground">Implemented:</span> {item.implementation_note}</p><p className="text-xs text-muted-foreground">Outcome comparison uses seven days before and seven days after the change and makes no causal claim.{outcomeAvailableAt ? ` Available after ${outcomeAvailableAt.toLocaleDateString()}.` : ""}</p></div>}
      {item.status === "dismissed" && <p className="text-sm"><span className="text-muted-foreground">Dismissal reason:</span> {item.dismiss_reason}</p>}
      {item.outcome && <OutcomeComparison outcome={item.outcome} currency={currency}/>}
      {editor === "dismiss" && <DecisionEditor label="Why are you dismissing this?" value={note} placeholder="For example: this unit is intentionally limited to brand traffic." saving={saving} actionLabel="Dismiss recommendation" onChange={onNote} onCancel={onCancel} onSave={() => onUpdate("dismissed", { dismissReason: note.trim() })}/>}
      {editor === "implement" && <DecisionEditor label="What did you change?" value={note} placeholder="Describe the creative, audience, landing page, bid, or tracking change." saving={saving} actionLabel="Mark implemented" onChange={onNote} onCancel={onCancel} onSave={() => onUpdate("implemented", { implementationNote: note.trim() })}/>}
      {editor === "snooze" && <div className="rounded-lg border p-3"><p className="text-sm font-medium">Show this recommendation again in</p><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={saving} onClick={() => snooze(1)}>1 day</Button><Button size="sm" variant="outline" disabled={saving} onClick={() => snooze(7)}>7 days</Button><Button size="sm" variant="outline" disabled={saving} onClick={() => snooze(30)}>30 days</Button><Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button></div></div>}
      {!editor && <div className="flex flex-wrap gap-2">
        {item.status === "open" && <Button size="sm" disabled={saving} onClick={() => onUpdate("accepted")}>{item.category === "tracking" ? "Accept and inspect data" : "Accept and review"}</Button>}
        {item.status === "accepted" && <Button size="sm" disabled={saving} onClick={() => onEdit("implement")}>Mark implemented</Button>}
        {item.status === "implemented" && <Button size="sm" disabled={saving || !outcomeReady} onClick={() => onUpdate("outcome_measured")}>Measure observed outcome</Button>}
        {item.status === "snoozed" && <Button size="sm" disabled={saving} onClick={() => onUpdate("open")}>Show now</Button>}
        {["open", "accepted"].includes(item.status) && <Button size="sm" variant="outline" disabled={saving} onClick={() => onEdit("snooze")}>Snooze</Button>}
        {["open", "accepted", "snoozed"].includes(item.status) && <Button size="sm" variant="outline" disabled={saving} onClick={() => onEdit("dismiss")}>Dismiss</Button>}
        {item.status === "dismissed" && <Button size="sm" variant="outline" disabled={saving} onClick={() => onUpdate("open")}>Reopen</Button>}
      </div>}
      {!!item.history?.length && <details className="border-t pt-3"><summary className="cursor-pointer text-sm font-medium">Decision history · {item.history.length}</summary><ol className="mt-3 space-y-3">{item.history.map(event => <li key={event.id} className="border-l pl-3 text-sm"><p><span className="font-medium">{humanStatus(event.from_status)} → {humanStatus(event.to_status)}</span> <span className="text-muted-foreground">by {humanStatus(event.actor_type)}</span></p>{event.note && <p className="mt-1 text-muted-foreground">{event.note}</p>}<p className="mt-1 text-xs text-muted-foreground">{dateLabel(event.created_at)}</p></li>)}</ol></details>}
    </CardContent>
  </Card>;
}

function DecisionEditor({ label, value, placeholder, saving, actionLabel, onChange, onCancel, onSave }: { label: string; value: string; placeholder: string; saving: boolean; actionLabel: string; onChange: (value: string) => void; onCancel: () => void; onSave: () => void }) { return <div className="space-y-3 rounded-lg border p-3"><label className="block text-sm font-medium">{label}<textarea className="mt-2 min-h-24 w-full rounded-md border bg-background p-3 text-sm font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={value} maxLength={2000} placeholder={placeholder} onChange={event => onChange(event.target.value)}/></label><div className="flex flex-wrap gap-2"><Button size="sm" loading={saving} disabled={!value.trim()} onClick={onSave}>{actionLabel}</Button><Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button></div></div>; }

function OutcomeComparison({ outcome, currency }: { outcome: RecommendationOutcome; currency: string }) { const metrics = ["cpl", "cpa", "ctr", "roas"] as const; return <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.04] p-3"><p className="text-sm font-semibold">Observed outcome</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{outcome.note || "Seven-day windows before and after the implementation. This comparison does not establish causation."}</p><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[440px] text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="pb-2 font-medium">Metric</th><th className="pb-2 font-medium">Before</th><th className="pb-2 font-medium">After</th><th className="pb-2 font-medium">Observed change</th></tr></thead><tbody>{metrics.filter(key => outcome.before?.[key] != null || outcome.after?.[key] != null).map(key => <tr key={key} className="border-t"><td className="py-2 font-medium uppercase">{key}</td><td className="py-2 tabular-nums">{evidenceValue(key, outcome.before?.[key], currency)}</td><td className="py-2 tabular-nums">{evidenceValue(key, outcome.after?.[key], currency)}</td><td className="py-2 tabular-nums">{outcome.changes?.[key] == null ? "—" : `${Number(outcome.changes[key]).toFixed(1)}%`}</td></tr>)}</tbody></table></div></div>; }
function AutomationPanel({ detail, policySaving, onPolicy, onImport, importStage }: { onImport: () => void; importStage: string; detail: Detail; policySaving: boolean; onPolicy: (enabled: boolean, thresholds?: Record<string, number>) => void }) {
  const [thresholds, setThresholds] = useState<Record<string, number>>(detail.policy.thresholds || {});
  useEffect(() => { setThresholds(detail.policy.thresholds || {}); }, [detail.policy.thresholds]);
  const eligibility = detail.automationEligibility;
  return <div className={styles.twoColumnPanels}>
    <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-5 w-5"/>Automation safety</CardTitle><CardDescription>Campaign consent is separate from account mode. AskSales can only pause; it cannot resume, edit, or increase spend.</CardDescription></CardHeader><CardContent className="space-y-4">
      {detail.policy.reportOnly ? <div className="space-y-3"><p className="text-sm">Import for advisory monitoring, then set business targets and optionally enable pause consent.</p><ImportButton stage={importStage} onClick={onImport}/></div> : <>
        <div className="flex items-center justify-between gap-4"><div><p className="text-sm font-medium">Allow AI pause</p><p className="text-xs text-muted-foreground">Policy {detail.policy.policyVersion}</p></div><Switch aria-label="Allow AI pause" checked={detail.policy.enabled} disabled={policySaving} onCheckedChange={(enabled) => onPolicy(enabled, thresholds)}/></div>
        <BusinessTargetEditor thresholds={thresholds} currency={String(detail.campaign.currency || "USD")} saving={policySaving} onChange={setThresholds} onSave={() => onPolicy(detail.policy.enabled, thresholds)}/>
      </>}
      <Button asChild size="sm" variant="outline"><Link href="/dashboard/settings/ads">Manage automation settings</Link></Button>
    </CardContent></Card>
    <div className={styles.workspace}>
      <Card><CardHeader><CardTitle className="text-base">Pause eligibility</CardTitle></CardHeader><CardContent className="space-y-3">
        <div className={eligibility?.eligible ? "rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3" : "rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"}><p className="text-sm font-semibold">{eligibility?.eligible ? "Eligible when a rule is confirmed" : "Not eligible"}</p>{eligibility?.nextEvaluationAt && <p className="mt-1 text-xs text-muted-foreground">Next evaluation {dateLabel(eligibility.nextEvaluationAt)}</p>}</div>
        {Boolean(eligibility?.blockers.length) && <ol className="space-y-2">{eligibility?.blockers.map((item, index) => <li key={item.code} className="flex items-start gap-2 text-xs text-muted-foreground"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300">{index + 1}</span><span className="pt-0.5">{item.message}</span></li>)}</ol>}
        <div><p className="text-xs font-medium">Units currently meeting pause rules</p>{eligibility?.candidateTargets?.length ? <ul className="mt-2 space-y-1 text-xs">{eligibility.candidateTargets.map(target => <li key={[target.platform, target.targetType, target.targetKey].join(':')}><span className="capitalize">{target.targetType?.replace('_', ' ')}</span> <span className="font-mono">{target.targetKey}</span></li>)}</ul> : <p className="mt-1 text-xs text-muted-foreground">No unit currently meets a deterministic pause rule.</p>}</div>
      </CardContent></Card>
      <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Bot className="h-5 w-5"/>Action history</CardTitle><CardDescription>Requested action, provider response, state change, actor, and stored evidence.</CardDescription></CardHeader><CardContent className="space-y-4">{detail.actions.length ? detail.actions.map(action => <ActionHistoryItem key={action.id} action={action}/>) : <Empty text="No actions have been recorded."/>}</CardContent></Card>
    </div>
  </div>;
}

function BusinessTargetEditor({ thresholds, currency, saving, onChange, onSave }: { thresholds: Record<string, number>; currency: string; saving: boolean; onChange: (value: Record<string, number>) => void; onSave: () => void }) {
  const fields = [["targetCpl", `Target CPL (${currency})`], ["targetCpa", `Target CPA (${currency})`], ["targetRoas", "Target ROAS"], ["spendLimit", `Campaign spend limit (${currency})`]] as const;
  return <div className="space-y-3 rounded-lg border p-3"><div><p className="text-sm font-medium">Business targets</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Set only the targets relevant to this campaign. The spend limit creates an advisory alert and is never raised automatically.</p></div><div className="grid grid-cols-2 gap-3">{fields.map(([key, label]) => <label key={key} className="text-xs"><span className="text-muted-foreground">{label}</span><Input className="mt-1" type="number" min="0" step="0.01" value={thresholds[key] || ""} onChange={(event) => { const next = { ...thresholds }; const value = Number(event.target.value); if (value > 0) next[key] = value; else delete next[key]; onChange(next); }}/></label>)}</div><Button size="sm" variant="outline" disabled={saving} onClick={onSave}>{saving ? "Saving…" : "Save business targets"}</Button></div>;
}

function ActionHistoryItem({ action }: { action: Action }) {
  const outcome = action.provider_outcome || {};
  const targetType = String(outcome.targetType || "campaign");
  const targetKey = String(outcome.targetKey || "campaign");
  const before = outcome.beforeStatus || outcome.previousStatus;
  const after = outcome.status;
  return <div className="border-l-2 border-primary/25 pl-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{humanStatus(action.action_type)} · {humanStatus(targetType)} {targetKey}</p><Badge variant="outline">{humanStatus(action.actor_type)}</Badge></div><p className="mt-1 text-xs leading-5 text-muted-foreground">{action.rationale}</p>{Boolean(before || after) && <p className="mt-2 text-xs"><span className="text-muted-foreground">Provider state:</span> {humanStatus(before || "unknown")} → {humanStatus(after || "pending")}</p>}<p className="mt-1 text-[11px] text-muted-foreground">{dateLabel(action.created_at)}</p></div>;
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function MetaBreakdown({ title, description, rows, dimensions, currency }: { title: string; description: string; rows: Array<Record<string, unknown>>; dimensions: string[]; currency: string }) {
  return <Card><CardHeader><CardTitle className="text-base">{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent>{rows.length ? <div className="max-h-[440px] overflow-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="sticky top-0 bg-card text-xs text-muted-foreground"><tr>{dimensions.map(value=><th className="pb-2 pr-3" key={value}>{humanStatus(value)}</th>)}<th className="pb-2 pr-3">Spend</th><th className="pb-2 pr-3">Reach</th><th className="pb-2 pr-3">Clicks</th><th className="pb-2">CTR</th></tr></thead><tbody>{rows.map((row,index)=><tr className="border-t" key={`${dimensions.map(key=>row[key]).join(":")}:${index}`}>{dimensions.map(key=><td className="py-2 pr-3" key={key}>{humanStatus(row[key])}</td>)}<td className="py-2 pr-3 tabular-nums">{money(Number(row.spend||0),currency)}</td><td className="py-2 pr-3 tabular-nums">{compact(Number(row.reach||0))}</td><td className="py-2 pr-3 tabular-nums">{compact(Number(row.clicks||0))}</td><td className="py-2 tabular-nums">{Number(row.ctr||0).toFixed(2)}%</td></tr>)}</tbody></table></div> : <Empty text="Meta returned no rows for this breakdown in the selected reporting window."/>}</CardContent></Card>;
}

function MetaDiagnosticsPanel({ detail, source, campaignId, accountId, period, currency }: { detail: Detail; source: "managed" | "provider"; campaignId: string; accountId: string | null; period: string; currency: string }) {
  const workspaceSearch = useSearchParams().toString();
  const [data,setData]=useState<MetaDiagnostics|null>(null); const [error,setError]=useState<string|null>(null); const [loading,setLoading]=useState(true);
  const load=useCallback(async()=>{if(source==="provider"&&!/^\d+$/.test(accountId||"")){setError("Select the Meta ad account used by this campaign.");setLoading(false);return;}try{setLoading(true);setError(null);const path=source==="managed"?`/api/campaigns/autonomous/${campaignId}/meta-diagnostics`:`/api/campaigns/accounts/${accountId}/meta-diagnostics/${campaignId}`;setData(await api.get<MetaDiagnostics>(`${path}?period=${encodeURIComponent(period)}`));}catch(cause){setError(cause instanceof Error?cause.message:"Meta diagnostics could not be loaded.");}finally{setLoading(false);}},[accountId,campaignId,period,source]);
  useEffect(()=>{void load();},[load]);
  if(loading&&!data)return <LoadingState label="Loading Meta diagnostics…" showLabel className="min-h-48"/>;
  if (!data) {
    const context = new URLSearchParams(workspaceSearch);
    context.set("returnTo", paidAdsReturnHref(context.get("returnTo")));
    const href = (tab: CampaignPageTab) => withPaidAdsContext(source === "managed" ? managedCampaignHref(campaignId, tab) : providerCampaignHref("meta", campaignId, tab), context.toString());
    return <div className={styles.workspace}>
      <Card role="alert" className="border-destructive/30 bg-destructive/[.025]"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="h-5 w-5 text-destructive"/>Meta diagnostics unavailable</CardTitle><CardDescription>{error || "Select an account and retry."}</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-3"><Button asChild><Link href="/dashboard/integrations/meta"><ExternalLink className="mr-2 h-4 w-4"/>Review Meta Ads connection</Link></Button><Button variant="outline" onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4"/>Retry</Button></CardContent></Card>
      <div className={styles.twoColumnPanels}>
        <Card><CardHeader><CardTitle className="text-base">Current recorded campaign status</CardTitle><CardDescription>Existing campaign evidence remains available while diagnostics are unavailable.</CardDescription></CardHeader><CardContent><dl className={styles.technicalFacts}><Tech label="Provider delivery" value={humanStatus(detail.campaign.provider_status || detail.campaign.status)}/><Tech label="Connection health" value="Not verified"/><Tech label="Evidence freshness" value={dateLabel(detail.campaign.metrics_updated_at)}/><Tech label="Monitoring" value={detail.policy.reportOnly ? "Import required" : "Monitored"}/><Tech label="Baseline" value={detail.analysisReadiness?.baselineAvailable ? "Available" : "Not established"}/></dl></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">What remains available</CardTitle><CardDescription>Review stored evidence and settings without changing provider delivery.</CardDescription></CardHeader><CardContent className="grid gap-2">{([['summary', 'Campaign summary'], ['creative', 'Creative evidence'], ['recommendations', 'Saved recommendations'], ['automation', 'Automation settings'], ['technical', 'Technical details']] as const).map(([tab, label]) => <Link key={tab} href={href(tab)} className="rounded-lg border px-3 py-2 text-xs hover:bg-muted">{label}<span className="float-right text-primary" aria-hidden="true">→</span></Link>)}</CardContent></Card>
      </div>
    </div>;
  }
  const campaign=object(data.campaign); const campaignCurrency=data.account.currency||currency;
  return <div className="space-y-4">
    {error&&<p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm">{error} Previously loaded diagnostics remain visible.</p>}
    <Card><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="text-base">Meta campaign readiness</CardTitle><CardDescription>{data.account.name} · {data.account.accountId} · {campaignCurrency} · {data.account.timezone||"Timezone unavailable"}</CardDescription></div><Badge variant={data.tracking.state==="configured"?"default":data.tracking.state==="partial"?"secondary":"destructive"}>Measurement {data.tracking.state}</Badge></div></CardHeader><CardContent className="space-y-4"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><StatusFact label="Status" value={humanStatus(campaign.effective_status||campaign.status)}/><StatusFact label="Objective" value={humanStatus(campaign.objective)}/><StatusFact label="Bid strategy" value={humanStatus(campaign.bid_strategy)}/><StatusFact label="Budget" value={campaign.daily_budget?`${money(Number(campaign.daily_budget)/100,campaignCurrency)} daily`:campaign.lifetime_budget?`${money(Number(campaign.lifetime_budget)/100,campaignCurrency)} lifetime`:"Campaign budget unavailable"}/><StatusFact label="Window" value={`${data.reportingWindow.start} – ${data.reportingWindow.end}`}/></div><p className="text-sm leading-6">{data.tracking.explanation}</p><div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2"><p>Pixel IDs: {data.tracking.pixelIds.join(", ")||"Not returned"}</p><p>App IDs: {data.tracking.applicationIds.join(", ")||"Not returned"}</p><p>Optimization events: {data.tracking.configuredEvents.map(humanStatus).join(", ")||"Not returned"}</p><p>Observed actions: {data.tracking.observedActionTypes.slice(0,8).map(humanStatus).join(", ")||"Not returned"}</p></div></CardContent></Card>
    <div className="grid gap-4 xl:grid-cols-2"><MetaBreakdown title="Placement and device" description="Facebook, Instagram, Messenger or Audience Network placement performance by device." rows={data.placement} dimensions={["publisher_platform","platform_position","impression_device"]} currency={campaignCurrency}/><MetaBreakdown title="Age and gender" description="Provider-reported demographic delivery. Restricted or small segments may be omitted." rows={data.audience} dimensions={["age","gender"]} currency={campaignCurrency}/></div>
    <MetaBreakdown title="Country delivery" description="Country-level delivery for the selected measurement window." rows={data.geography} dimensions={["country"]} currency={campaignCurrency}/>
    <Card><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="text-base">CRM lead quality</CardTitle><CardDescription>{data.leadQuality.attribution}</CardDescription></div><Badge variant={data.leadQuality.state==="available"?"default":"outline"}>{humanStatus(data.leadQuality.state)}</Badge></div></CardHeader><CardContent className="space-y-3"><div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"><Metric label="Matched leads" value={String(data.leadQuality.matchedLeads)}/><Metric label="Qualified" value={String(data.leadQuality.qualifiedLeads)}/><Metric label="Qualification" value={data.leadQuality.qualificationRate==null?"—":`${data.leadQuality.qualificationRate.toFixed(1)}%`}/><Metric label="Opportunities" value={String(data.leadQuality.opportunities)}/><Metric label="Bookings" value={String(data.leadQuality.bookings)}/><Metric label="Booked revenue" value={formatReportingMoney(data.leadQuality.bookedRevenueByCurrency,data.leadQuality.bookedRevenue,data.leadQuality.currency)}/></div><p className="text-xs leading-5 text-muted-foreground">{data.leadQuality.limitation} Won CRM pipeline value: {formatReportingMoney(data.leadQuality.wonPipelineValueByCurrency,data.leadQuality.wonPipelineValue,data.leadQuality.currency)}.</p></CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">Ad set optimization and attribution</CardTitle><CardDescription>Read-only setup evidence for every returned ad set.</CardDescription></CardHeader><CardContent className="space-y-2">{data.adSets.length?data.adSets.map((row,index)=>{const promoted=object(row.promoted_object);return <div className="rounded-lg border p-3" key={String(row.id||index)}><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{String(row.name||row.id||"Unnamed ad set")}</p><Badge variant="outline">{humanStatus(row.effective_status||row.status)}</Badge></div><p className="mt-1 text-xs text-muted-foreground">Optimize for {humanStatus(row.optimization_goal)} · bill on {humanStatus(row.billing_event)} · event {humanStatus(promoted.custom_event_type)} · attribution {row.attribution_spec?JSON.stringify(row.attribution_spec):"not returned"}</p></div>}):<Empty text="No ad sets were returned for this campaign."/>}</CardContent></Card>
    <div className="space-y-1 text-xs text-muted-foreground">{data.limitations.map(note=><p key={note}>{note}</p>)}</div>
  </div>;
}

function GoogleDiagnosticsPanel({ source, campaignId, accountId, currency }: { source: "managed" | "provider"; campaignId: string; accountId: string | null; currency: string }) {
  const [data, setData] = useState<GoogleDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (source === "provider" && !/^\d+$/.test(accountId || "")) { setError("Select the Google Ads customer account used by this campaign."); setLoading(false); return; }
    try { setLoading(true); setError(null); setData(await api.get<GoogleDiagnostics>(source === "managed" ? `/api/campaigns/autonomous/${campaignId}/google-diagnostics` : `/api/campaigns/accounts/${accountId}/google-diagnostics/${campaignId}`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Google diagnostics could not be loaded."); }
    finally { setLoading(false); }
  }, [accountId, campaignId, source]);
  useEffect(() => { void load(); }, [load]);
  if (loading && !data) return <LoadingState label="Loading complete Google diagnostics…" showLabel className="min-h-48"/>;
  if (!data) return <StateCard title="Google diagnostics unavailable" text={error || "Select an account and retry."}><Button variant="outline" onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4"/>Retry</Button></StateCard>;
  const campaign = object(data.campaign.campaign);
  const budget = object(data.campaign.campaignBudget);
  const primaryReasons = Array.isArray(campaign.primaryStatusReasons) ? campaign.primaryStatusReasons.map(String) : [];
  const disapprovedAds = data.ads.filter(row => String(object(row.adGroupAd).policySummary ? object(object(row.adGroupAd).policySummary).approvalStatus : object(row.adGroupAd).approvalStatus).toUpperCase().includes("DISAPPROVED"));
  return <div className="space-y-4">
    {error && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm">{error} Previously loaded diagnostics remain visible.</p>}
    <Card><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="text-base">Google campaign readiness</CardTitle><CardDescription>{data.account.name} · {data.account.customerId} · {data.account.currency || currency} · {data.account.timezone || "Timezone unavailable"}</CardDescription></div><div className="flex flex-wrap gap-2"><Badge>{data.support.type}</Badge><Badge variant={data.support.publishing ? "default" : "outline"}>{data.support.publishing ? "Publishing supported" : "Reporting workflow"}</Badge></div></div></CardHeader><CardContent className="space-y-3"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><StatusFact label="Provider status" value={humanStatus(campaign.status)}/><StatusFact label="Primary status" value={humanStatus(campaign.primaryStatus)}/><StatusFact label="Bid strategy" value={humanStatus(campaign.biddingStrategyType)}/><StatusFact label="Budget" value={money(Number(budget.totalAmountMicros || budget.amountMicros || 0) / 1_000_000, data.account.currency || currency)}/></div><p className="text-sm">{data.support.workflow}</p>{primaryReasons.length > 0 && <ul className="space-y-1 text-sm text-amber-700 dark:text-amber-300">{primaryReasons.map(reason => <li key={reason}>• {humanStatus(reason)}</li>)}</ul>}<p className="text-xs text-muted-foreground">Every diagnostic query is fully paginated. {Object.entries(data.completeness).filter(([,value]) => typeof value === "number").map(([key,value]) => `${key} ${value}`).join(" · ")}</p></CardContent></Card>
    <div className="grid gap-4 xl:grid-cols-2">
      <Card><CardHeader><CardTitle className="text-base">Search terms and negative opportunities</CardTitle><CardDescription>Last 30 days. Suggestions require review and are never applied automatically.</CardDescription></CardHeader><CardContent>{data.negativeKeywordOpportunities.length ? <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="pb-2">Search term</th><th className="pb-2">Match</th><th className="pb-2">Spend</th><th className="pb-2">Clicks</th><th className="pb-2">Conversions</th></tr></thead><tbody>{data.negativeKeywordOpportunities.map(item => <tr className="border-t" key={item.searchTerm}><td className="py-2 pr-3 font-medium">{item.searchTerm}</td><td className="py-2 pr-3">{humanStatus(item.matchType)}</td><td className="py-2 pr-3 tabular-nums">{money(item.spend, data.account.currency || currency)}</td><td className="py-2 pr-3 tabular-nums">{item.clicks}</td><td className="py-2 tabular-nums">{item.conversions}</td></tr>)}</tbody></table></div> : <Empty text="No spend-without-conversion search term was found outside the current keyword list."/>}</CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Keywords</CardTitle><CardDescription>Match type, quality score, delivery, and 30-day performance.</CardDescription></CardHeader><CardContent className="max-h-[420px] overflow-auto space-y-2">{data.keywords.length ? data.keywords.slice(0, 200).map((row, index) => { const criterion=object(row.adGroupCriterion); const keyword=object(criterion.keyword); const quality=object(criterion.qualityInfo); const metrics=object(row.metrics); return <div key={String(criterion.criterionId || index)} className="rounded-lg border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{String(keyword.text || "Unnamed keyword")}</p><Badge variant={Boolean(criterion.negative) ? "secondary" : "outline"}>{Boolean(criterion.negative) ? "Negative" : humanStatus(keyword.matchType)}</Badge></div><p className="mt-1 text-xs text-muted-foreground">Quality {String(quality.qualityScore ?? "—")} · {humanStatus(criterion.status)} · {Number(metrics.clicks || 0)} clicks · {Number(metrics.conversions || 0)} conversions</p></div>; }) : <Empty text="No Search keywords were returned for this campaign type."/>}</CardContent></Card>
    </div>
    <div className="grid gap-4 xl:grid-cols-3">
      <Card><CardHeader><CardTitle className="text-base">Ads and assets</CardTitle><CardDescription>Responsive search ad copy, asset labels, and policy review.</CardDescription></CardHeader><CardContent className="space-y-2"><p className="text-sm"><strong>{data.ads.length}</strong> ads · <strong>{data.assets.length}</strong> assets · <strong>{disapprovedAds.length}</strong> disapproved ads</p>{disapprovedAds.length > 0 && <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">Open the disapproved ads in Google Ads and resolve their policy topics before enabling delivery.</p>}<p className="text-xs text-muted-foreground">Asset performance labels are directional and may remain unavailable until Google has enough delivery evidence.</p></CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Conversion actions</CardTitle><CardDescription>Account actions used for optimization and reporting.</CardDescription></CardHeader><CardContent className="max-h-72 space-y-2 overflow-auto">{data.conversionActions.map((row,index) => { const action=object(row.conversionAction); return <div className="rounded-lg border p-3" key={String(action.id || index)}><p className="text-sm font-medium">{String(action.name || action.id || "Unnamed action")}</p><p className="mt-1 text-xs text-muted-foreground">{humanStatus(action.category)} · {action.primaryForGoal ? "Primary goal" : "Secondary"} · {action.includeInConversionsMetric ? "Included in Conversions" : "Excluded from Conversions"}</p></div>; })}</CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Landing pages</CardTitle><CardDescription>Destinations with clicks, spend, and conversions in the last 30 days.</CardDescription></CardHeader><CardContent className="max-h-72 space-y-2 overflow-auto">{data.landingPages.length ? data.landingPages.map((row,index) => { const page=object(row.expandedLandingPageView); const metrics=object(row.metrics); return <div className="rounded-lg border p-3" key={String(page.expandedFinalUrl || index)}><p className="break-all text-sm font-medium">{String(page.expandedFinalUrl || "URL unavailable")}</p><p className="mt-1 text-xs text-muted-foreground">{Number(metrics.clicks || 0)} clicks · {money(Number(metrics.costMicros || 0)/1_000_000,data.account.currency || currency)} spend · {Number(metrics.conversions || 0)} conversions</p></div>; }) : <Empty text="No landing-page evidence was returned for this campaign type."/>}</CardContent></Card>
    </div>
    <div className="space-y-1 text-xs text-muted-foreground">{data.limitations.map(note => <p key={note}>{note}</p>)}</div>
  </div>;
}
function TechnicalPanel({ detail }: { detail: Detail }) {
  const fields = [['targetCpl', 'Target CPL'], ['targetCpa', 'Target CPA'], ['targetRoas', 'Target ROAS'], ['spendLimit', 'Campaign spend limit'], ['targetCtr', 'Target CTR'], ['targetCpc', 'Target CPC'], ['targetCpm', 'Target CPM']] as const;
  const thresholds = detail.policy.thresholds || {};
  const currency = String(detail.campaign.currency || 'USD');
  return <div className={styles.workspace}>
    <div className={styles.twoColumnPanels}>
      <ReconciliationPanel detail={detail}/>
      <Card><CardHeader><CardTitle className="text-base">Threshold overrides</CardTitle><CardDescription>Recorded campaign targets that influence advisory evaluation.</CardDescription></CardHeader><CardContent className="overflow-x-auto"><table className={styles.comparison}><thead><tr><th>Metric</th><th>Override value</th><th>Status</th></tr></thead><tbody>{fields.map(([key, label]) => <tr key={key}><td>{label}</td><td className="font-mono">{thresholds[key] == null ? 'Unavailable' : key === 'targetRoas' || key === 'targetCtr' ? thresholds[key] : money(thresholds[key], currency)}</td><td className="text-muted-foreground">{thresholds[key] == null ? 'Not set' : 'Configured'}</td></tr>)}</tbody></table></CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Sync windows</CardTitle><CardDescription>Recorded synchronization and measurement coverage.</CardDescription></CardHeader><CardContent><dl className={styles.technicalFacts}><Tech label="Refresh cadence" value={detail.settings.analyticsSyncMinutes ? 'Every ' + detail.settings.analyticsSyncMinutes + ' minutes' : null}/><Tech label="Last provider evidence" value={dateLabel(detail.campaign.metrics_updated_at || detail.campaign.last_synced_at)}/><Tech label="Successful sync windows" value={detail.analysisReadiness?.successfulSyncWindows}/><Tech label="Latest sync status" value={detail.analysisReadiness?.latestSyncStatus}/><Tech label="Reporting window" value={detail.campaign.reporting_window ? JSON.stringify(detail.campaign.reporting_window) : null}/></dl></CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Provider and evidence identifiers</CardTitle><CardDescription>References used to reproduce this reporting view.</CardDescription></CardHeader><CardContent><dl className={styles.technicalFacts}><Tech label="Campaign ID" value={detail.campaign.platformCampaignId || detail.campaign.platform_campaign_id || detail.campaign.id}/><Tech label="Ad account ID" value={detail.accountIdentity?.adAccountId}/><Tech label="Ad account name" value={detail.accountIdentity?.adAccountName}/><Tech label="Facebook Page ID" value={detail.accountIdentity?.facebookPageId}/><Tech label="Instagram account ID" value={detail.accountIdentity?.instagramAccountId}/><Tech label="Instagram" value={detail.accountIdentity?.instagramUsername}/><Tech label="Policy version" value={detail.policy.policyVersion}/></dl></CardContent></Card>
    </div>
    <details className="rounded-xl border bg-card p-4"><summary className="cursor-pointer text-sm font-semibold">Raw rule evidence</summary><p className="mt-2 text-xs text-muted-foreground">Read-only deterministic evidence from the latest evaluation.</p><pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs leading-5">{JSON.stringify(detail.evaluations[0]?.rule_results || {}, null, 2)}</pre></details>
  </div>;
}

function ReconciliationPanel({detail}:{detail:Detail}) { if(detail.policy.reportOnly)return <Card><CardHeader><CardTitle className="text-base">Provider reconciliation</CardTitle><CardDescription>This report-only campaign uses provider evidence directly. A separate managed campaign summary is not available for comparison.</CardDescription></CardHeader><CardContent><dl className={styles.technicalFacts}><Tech label="Provider status" value={humanStatus(detail.campaign.provider_status || detail.campaign.status)}/><Tech label="Policy version" value={detail.policy.policyVersion}/><Tech label="Reconciliation mode" value="Provider evidence only"/><Tech label="Last provider evidence" value={dateLabel(detail.campaign.metrics_updated_at || detail.campaign.last_synced_at)}/><Tech label="Reporting window" value={detail.campaign.reporting_window ? JSON.stringify(detail.campaign.reporting_window) : null}/></dl></CardContent></Card>; const provider=aggregate(detail); const fields=["spend","impressions","clicks","reach","conversions"] as const; const stored:Record<string,unknown>={spend:detail.campaign.spent_amount,impressions:detail.campaign.impressions,clicks:detail.campaign.clicks,reach:detail.campaign.reach,conversions:detail.campaign.conversions}; const rows=fields.map(metric=>{const raw=provider[metric]==null?null:Number(provider[metric]);const saved=stored[metric]==null?null:Number(stored[metric]);return{metric,raw,saved,difference:saved==null||raw==null?null:saved-raw};}); const aligned=rows.every(row=>row.difference!=null&&Math.abs(row.difference)<0.000001); return <Card className={aligned?"border-emerald-500/30":"border-amber-500/30"}><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="text-base">Provider reconciliation</CardTitle><CardDescription>Compares the current provider-window aggregate with campaign summary fields. Differences can occur when summary fields use another sync window or have not been refreshed yet.</CardDescription></div><Badge variant={aligned?"default":"secondary"}>{aligned?"Aligned":"Review differences"}</Badge></div></CardHeader><CardContent className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="pb-2">Metric</th><th className="pb-2">Provider window</th><th className="pb-2">Campaign summary</th><th className="pb-2">Difference</th></tr></thead><tbody>{rows.map(row=><tr className="border-t" key={row.metric}><td className="py-2 capitalize">{row.metric}</td><td className="py-2 tabular-nums">{row.raw??"Unavailable"}</td><td className="py-2 tabular-nums">{row.saved??"Unavailable"}</td><td className="py-2 tabular-nums">{row.difference??"—"}</td></tr>)}</tbody></table></CardContent></Card>; }
function Tech({ label, value }: { label: string; value: unknown }) { return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-all font-mono text-xs">{value == null || value === "" ? "Unavailable" : String(value)}</dd></div>; }
function StateCard({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) { return <Card><CardHeader><CardTitle className="text-base">{title}</CardTitle><CardDescription className="leading-6">{text}</CardDescription></CardHeader>{children && <CardContent>{children}</CardContent>}</Card>; }
function Empty({ text }: { text: string }) { return <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{text}</div>; }
