"use client";
import { useBillingOrganizations } from "@/hooks/use-billing-organizations";

import { useQuery } from "@tanstack/react-query";
import { useBillingApi } from "@/hooks/use-billing-api";
import { AlertTriangle, Coins, Target, FileText, Send, BarChart3, Wrench, Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type WalletData } from "@/lib/billing-reporting";

interface PricingItem {
  eventKey: string;
  name: string;
  category: string;
  creditsPerUnit: number;
  unitLabel: string;
}

interface UsageData {
  usage: { eventKey: string; totalCredits: number; eventCount: number }[];
  pricing: PricingItem[];
}

const CATEGORY_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  recharge:  { label: "Recharge Rate",      icon: <Coins className="w-4 h-4" />, color: "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300" },
  lead:      { label: "Lead Generation",    icon: <Target className="w-4 h-4" />, color: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300" },
  content:   { label: "Content Generation", icon: <FileText className="w-4 h-4" />, color: "bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300" },
  outreach:  { label: "Outreach",           icon: <Send className="w-4 h-4" />, color: "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300" },
  marketing: { label: "Marketing",          icon: <BarChart3 className="w-4 h-4" />, color: "bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300" },
  platform:  { label: "Platform",           icon: <Wrench className="w-4 h-4" />, color: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300" },
};

export default function CreditCosts() {
  const api = useBillingApi();
  const { billingScopeKey } = useBillingOrganizations();

  const { data: walletData, isError: walletError, refetch: refetchWallet } = useQuery<WalletData>({
    queryKey: ["wallet", billingScopeKey],
    queryFn: async () => {
      return api.get<WalletData>("/api/wallet");
    },
  });

  const { data: usageData, isLoading: usageLoading, isError: usageError, refetch: refetchUsage } = useQuery<UsageData>({
    queryKey: ["wallet-usage", billingScopeKey],
    queryFn: async () => {
      return api.get<UsageData>("/api/wallet/usage");
    },
  });

  const categories = (["recharge", "lead", "content", "outreach", "marketing", "platform"] as const);

  if (walletError || usageError) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <AlertTriangle className="h-9 w-9 text-destructive/70" />
          <div>
            <p className="text-sm font-medium text-foreground">Credit pricing is unavailable</p>
            <p className="mt-1 text-xs text-muted-foreground">We could not load the current wallet rate and pricing catalog.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => { void refetchWallet(); void refetchUsage(); }}>Try again</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <header><h2 className="text-xl font-semibold">Credit costs</h2><p className="mt-2 text-sm text-muted-foreground">Current recharge rate: {walletData ? `${walletData.rechargeRate} credits per ₹1` : 'Loading…'}. Subscription deposits are fixed by your plan.</p></header>

      {/* Info note */}
      <Callout tone="warning" icon={Lightbulb}>
        <span className="font-semibold">Note:</span> AI/API usage (OpenAI, Apify, Gemini, etc.) credits are calculated based on actual usage cost, not fixed pricing.
      </Callout>

      {usageLoading ? (
        <LoadingState className="py-16" label="Loading credit costs…" />
      ) : usageData?.pricing?.length ? (
        <div className="space-y-6">
          {categories.map((category) => {
            const items = usageData.pricing.filter(p => p.category === category);
            if (!items.length) return null;
            const meta = CATEGORY_META[category];
            return (
              <Card key={category}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <span>{meta.icon}</span> {meta.label}
                  </CardTitle>
                  <CardDescription className="text-xs">{items.length} item{items.length !== 1 ? "s" : ""}</CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {items.map((item) => (
                      <div
                        key={item.eventKey}
                        className="flex items-center justify-between rounded-xl border border-border bg-muted/40 p-3"
                      >
                        <span className="text-sm text-foreground">{item.name}</span>
                        <Badge className={`font-mono text-xs ${meta.color}`}>
                          {item.creditsPerUnit} {item.unitLabel}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Coins className="mb-2 h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm font-medium text-muted-foreground">No pricing configured</p>
            <p className="mt-0.5 text-xs text-muted-foreground/80">Pricing will appear once the system is set up</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
