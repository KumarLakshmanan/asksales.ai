"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Bot, Gauge, Lightbulb, Megaphone, Plus, Target } from "lucide-react";
import AdCampaignsWorkspace from "../ads-campaigns/page";
import AdsPerformanceWorkspace from "../ads-analytics/page";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  PaidAdsAdvancedViewProvider,
  PaidAdsNavigationProvider,
  PaidAdsSectionProvider,
  type PaidAdsQueryUpdates,
} from "@/components/performance-marketing/PaidAdsSectionContext";
import { trackPerformanceMarketingEvent } from "@/lib/performanceMarketingAnalytics";
import { campaignPageTab, managedCampaignHref, providerCampaignHref } from "@/components/performance-marketing/campaignRoutes";
import styles from "@/components/marketing/marketing.module.css";

type WorkspaceTab = "overview" | "campaigns" | "recommendations" | "automation";
const VALID_TABS = new Set<WorkspaceTab>(["overview", "campaigns", "recommendations", "automation"]);
export default function PaidAdsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab") as WorkspaceTab | null;
  const urlTab: WorkspaceTab = requestedTab && VALID_TABS.has(requestedTab) ? requestedTab : "overview";
  const [advanced, setAdvanced] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(urlTab);

  useEffect(() => { setActiveTab(urlTab); }, [urlTab]);

  useEffect(() => {
    const managedId = searchParams.get("campaign");
    const provider = searchParams.get("provider");
    const providerCampaign = searchParams.get("providerCampaign");
    const tab = campaignPageTab(searchParams.get("detail"));
    const unit = searchParams.get("unit");
    if (managedId) router.replace(managedCampaignHref(managedId, tab, unit));
    else if (providerCampaign && (provider === "meta" || provider === "google")) router.replace(providerCampaignHref(provider, providerCampaign, tab, unit));
  }, [router, searchParams]);

  const updateQuery = useCallback((updates: PaidAdsQueryUpdates) => {
    const next = new URLSearchParams(typeof window === "undefined" ? searchParams.toString() : window.location.search);
    Object.entries(updates).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key));
    const href = `/dashboard/ads?${next.toString()}`;
    // Let Next observe the old-to-new navigation first so mounted workspace
    // children receive new search params. Then keep the shareable browser URL
    // correct even when a same-route replace is coalesced by the router.
    router.replace(href, { scroll: false });
    if (typeof window !== "undefined") window.history.replaceState(window.history.state, "", href);
  }, [router, searchParams]);

  const navigate = useCallback((tab: WorkspaceTab, updates: PaidAdsQueryUpdates = {}) => {
    setActiveTab(tab);
    const opensDetail = ["campaign", "provider", "providerCampaign", "detail", "unit"].some((key) => Object.prototype.hasOwnProperty.call(updates, key));
    updateQuery({
      tab,
      research: null, creativeCampaign: null, creativeResearch: null, creativeBrief: null,
      ...(!opensDetail ? { campaign: null, provider: null, providerCampaign: null, detail: null, unit: null, action: null } : {}),
      ...updates,
    });
  }, [updateQuery]);

  const researchView = activeTab === "recommendations" && ["research", "creativeCampaign", "creativeResearch", "creativeBrief"].some(key => searchParams.has(key));

  const navigationValue = useMemo(() => ({ navigate, updateQuery }), [navigate, updateQuery]);

  return <PageShell maxWidth="2xl" padding="md" className={styles.surface}>
    <PageHeader
      className={styles.header}
      icon={Target}
      title={researchView ? "Competitor creative research" : "Paid Ads"}
      subtitle={researchView ? "Turn competitor observations into original ad concepts. Review every draft before publishing." : "Manage delivery, understand performance, and review AI decisions from one workspace."}
      actions={<Button asChild><Link href="/dashboard/ads/create"><Plus className="mr-2 h-4 w-4"/>Create campaign</Link></Button>}
    />

    <PaidAdsNavigationProvider value={navigationValue}>
    <PaidAdsAdvancedViewProvider advanced={advanced}>
    <Tabs value={activeTab} onValueChange={(value) => { const next = value as WorkspaceTab; trackPerformanceMarketingEvent("workspace_tab_changed", { workspace: "paid_ads", tab: next }); navigate(next); }}>
      <div className="flex flex-col gap-2 pb-1 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 overflow-x-auto"><TabsList className={styles.tabs}>
          <TabsTrigger value="overview" className="gap-2 px-4"><Gauge className="h-4 w-4"/>Overview</TabsTrigger>
          <TabsTrigger value="campaigns" className="gap-2 px-4"><Megaphone className="h-4 w-4"/>Campaigns</TabsTrigger>
          <TabsTrigger value="recommendations" className="gap-2 px-4"><Lightbulb className="h-4 w-4"/>Recommendations</TabsTrigger>
          <TabsTrigger value="automation" className="gap-2 px-4"><Bot className="h-4 w-4"/>Automation &amp; activity</TabsTrigger>
        </TabsList></div>
        <Button variant="outline" size="sm" aria-pressed={advanced} onClick={() => setAdvanced(value => !value)}>{advanced ? "Hide operational details" : "Show operational details"}</Button>
      </div>
      <TabsContent value="overview" className="mt-3"><PaidAdsSectionProvider section="overview"><AdsPerformanceWorkspace/></PaidAdsSectionProvider></TabsContent>
      <TabsContent value="campaigns" className="mt-3"><AdCampaignsWorkspace/></TabsContent>
      <TabsContent value="recommendations" className="mt-3"><PaidAdsSectionProvider section="recommendations"><AdsPerformanceWorkspace/></PaidAdsSectionProvider></TabsContent>
      <TabsContent value="automation" className="mt-3"><PaidAdsSectionProvider section="automation"><AdsPerformanceWorkspace/></PaidAdsSectionProvider></TabsContent>
    </Tabs>
    </PaidAdsAdvancedViewProvider>
    </PaidAdsNavigationProvider>
  </PageShell>;
}
