"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquare, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LoadError, TABS, WA_API, useAdminData, type Overview, type TabId } from "./_components/shared";
import { OverviewTab } from "./_components/OverviewTab";
import { RateCardsTab } from "./_components/RateCardsTab";
import { MarketsTab } from "./_components/MarketsTab";
import { AccountsTab } from "./_components/AccountsTab";
import { ReviewTab } from "./_components/ReviewTab";
import { ReconciliationTab } from "./_components/ReconciliationTab";
import { StatementTab } from "./_components/StatementTab";
import { FeesTab } from "./_components/FeesTab";

const isTab = (value: string | null): value is TabId => (TABS as readonly string[]).includes(value ?? "");

/** The open tab lives in ?tab= so a refresh or a shared link opens the same tab. */
function useTabParam(): [TabId, (tab: TabId) => void] {
  const [tab, setTab] = useState<TabId>("overview");
  useEffect(() => {
    const read = () => {
      const value = new URLSearchParams(window.location.search).get("tab");
      setTab(isTab(value) ? value : "overview");
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const change = useCallback((next: TabId) => {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url);
  }, []);
  return [tab, change];
}

export default function WhatsAppBillingPage() {
  const overview = useAdminData<Overview>(`${WA_API}/overview`);
  const refresh = () => void overview.reload();
  const data = overview.data;
  const [tab, setTab] = useTabParam();

  return <div className="space-y-6 p-4 sm:p-6">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold sm:text-2xl">
          <MessageSquare className="h-6 w-6 text-[#25D366]" aria-hidden />
          WhatsApp billing
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">We pay Meta for customers&apos; WhatsApp messages through our credit line and charge each delivered message to their wallet.</p>
      </div>
      <Button variant="outline" onClick={refresh} loading={overview.loading && Boolean(data)} loadingText="Refreshing…" className="gap-2 self-start">
        <RefreshCw className="h-4 w-4" aria-hidden />Refresh
      </Button>
    </div>

    {data && !data.settings.featureEnabled && <Callout tone="warning" title="Billing is switched off on this server">
      WHATSAPP_PLATFORM_BILLING_ENABLED is not set. You can prepare rates, markets, fees and accounts, but no message is charged and no credit line is attached until it is on.
    </Callout>}

    {overview.error && !data ? <LoadError message={overview.error} onRetry={refresh} /> : !data ? <LoadingState label="Loading WhatsApp billing…" showLabel /> :
      <Tabs value={tab} onValueChange={value => setTab(value as TabId)} className="space-y-4">
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="rates">Rate cards</TabsTrigger>
            <TabsTrigger value="markets">Markets</TabsTrigger>
            <TabsTrigger value="accounts">Accounts{data.paymentIssues.length > 0 ? ` (${data.paymentIssues.length} ⚠)` : ""}</TabsTrigger>
            <TabsTrigger value="review">Review{data.counts.needsReview > 0 ? ` (${data.counts.needsReview})` : ""}</TabsTrigger>
            <TabsTrigger value="reconciliation">Reconciliation</TabsTrigger>
            <TabsTrigger value="statement">Monthly statement</TabsTrigger>
            <TabsTrigger value="fees">Fees</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview"><OverviewTab overview={data} onChanged={refresh} onNavigate={setTab} /></TabsContent>
        <TabsContent value="rates"><RateCardsTab overview={data} onChanged={refresh} /></TabsContent>
        <TabsContent value="markets"><MarketsTab onChanged={refresh} /></TabsContent>
        <TabsContent value="accounts"><AccountsTab onChanged={refresh} /></TabsContent>
        <TabsContent value="review"><ReviewTab onChanged={refresh} /></TabsContent>
        <TabsContent value="reconciliation"><ReconciliationTab onChanged={refresh} /></TabsContent>
        <TabsContent value="statement"><StatementTab defaultCurrency={data.settings.currency} /></TabsContent>
        <TabsContent value="fees"><FeesTab /></TabsContent>
      </Tabs>}
  </div>;
}
