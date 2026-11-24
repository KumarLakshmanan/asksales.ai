"use client";
import { getBillingProviderMeta } from "@/app/dashboard/(main)/billing/_components/billingMetadata";
import { useProviderCreditUsage } from "@/hooks/use-provider-credit-usage";
import { averageActiveDaySpend, billingWindowStart, type DailyTransaction } from "@/lib/billing-reporting";
import { useBillingOrganizations } from "@/hooks/use-billing-organizations";

import { type ReactNode, useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useBillingApi } from "@/hooks/use-billing-api";
import {
  Activity,
  AlertTriangle,
  BarChart2,
  BarChart3,
  ChevronLeft,
  IndianRupee,
  Info,
  PieChart,
  Send,
  Server,
  Target,
  TrendingDown,
  Wrench,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DeductionSummaryItem {
  category: string;
  totalCredits: number;
  transactionCount: number;
}

const CATEGORY_META: Record<string, { label: string; icon: ReactNode; color: string; bgColor: string; barBg: string; border: string }> = {
  leads:     { label: "Lead Operations",  icon: <Target className="w-4 h-4 text-white" />,    color: "text-blue-600",    bgColor: "bg-blue-500",    barBg: "bg-blue-50 dark:bg-blue-900/20",     border: "border-blue-100 dark:border-blue-900/40" },
  outreach:  { label: "Outreach",         icon: <Send className="w-4 h-4 text-white" />,       color: "text-emerald-600", bgColor: "bg-emerald-500", barBg: "bg-emerald-50 dark:bg-emerald-900/20", border: "border-emerald-100 dark:border-emerald-900/40" },
  api_usage: { label: "API Usage",        icon: <Zap className="w-4 h-4 text-white" />,        color: "text-orange-600",  bgColor: "bg-orange-500",  barBg: "bg-orange-50 dark:bg-orange-900/20",  border: "border-orange-100 dark:border-orange-900/40" },
  marketing: { label: "Marketing",        icon: <BarChart2 className="w-4 h-4 text-white" />,  color: "text-violet-600",  bgColor: "bg-violet-500",  barBg: "bg-violet-50 dark:bg-violet-900/20",  border: "border-violet-100 dark:border-violet-900/40" },
  platform:  { label: "Platform",         icon: <Wrench className="w-4 h-4 text-white" />,     color: "text-slate-600",   bgColor: "bg-slate-500",   barBg: "bg-slate-50 dark:bg-slate-900/20",   border: "border-slate-100 dark:border-slate-800" },
  general:   { label: "General",          icon: <IndianRupee className="w-4 h-4 text-white" />, color: "text-gray-500",    bgColor: "bg-gray-400",    barBg: "bg-gray-50 dark:bg-gray-800/20",     border: "border-gray-100 dark:border-gray-800" },
};

export default function BillingAnalyticsPage() {
  const api = useBillingApi();
  const { billingScopeKey } = useBillingOrganizations();
  const router = useRouter();
  const [trendDays, setTrendDays] = useState("30");
  const windowStart = billingWindowStart(Number(trendDays));

  const { data: deductionData, isLoading: deductionLoading, isError: deductionError, refetch: refetchDeductions } = useQuery<DeductionSummaryItem[]>({
    queryKey: ["wallet-deduction-summary", billingScopeKey, windowStart],
    queryFn: async () => {
      return api.get<DeductionSummaryItem[]>(`/api/wallet/deduction-summary?startDate=${encodeURIComponent(windowStart)}`);
    },
  });

  const { data: providerData, isError: providerError, refetch: refetchProviders } = useProviderCreditUsage(windowStart);

  const { data: trendData, isLoading: trendLoading, isError: trendError, refetch: refetchTrend } = useQuery<DailyTransaction[]>({
    queryKey: ["wallet-daily-transactions", billingScopeKey, trendDays, windowStart],
    queryFn: async () => {
      return api.get<DailyTransaction[]>(`/api/wallet/daily-transactions?days=${trendDays}`);
    },
  });

  const totalSpent = useMemo(() => deductionData?.reduce((s, d) => s + Number(d.totalCredits), 0) ?? 0, [deductionData]);
  const totalDeductions = useMemo(() => deductionData?.reduce((s, d) => s + Number(d.transactionCount), 0) ?? 0, [deductionData]);
  const topCategory = useMemo(() => {
    if (!deductionData?.length) return null;
    return [...deductionData].sort((a, b) => Number(b.totalCredits) - Number(a.totalCredits))[0];
  }, [deductionData]);
  const avgDailySpend = useMemo(() => averageActiveDaySpend(trendData), [trendData]);

  if (deductionError || providerError || trendError) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive/70" />
          <div>
            <p className="font-medium text-foreground">Billing analytics could not be loaded</p>
            <p className="mt-1 text-sm text-muted-foreground">Your wallet data was not changed. Retry to load the latest reporting data.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => { void refetchDeductions(); void refetchProviders(); void refetchTrend(); }}>Try again</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border p-5">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push("/dashboard/billing")}
              className="-ml-2 gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="w-4 h-4" /> Back
            </Button>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Credit analytics</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">Trace every credit deduction by category and provider</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <Select value={trendDays} onValueChange={setTrendDays}>
              <SelectTrigger className="w-36 border-border bg-background text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="14">Last 14 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4 sm:divide-y-0">
          {[
            { label: "Total Spent",    value: Number(totalSpent).toLocaleString(),      sub: `credits deducted over ${trendDays} days`,       icon: <TrendingDown className="w-4 h-4" /> },
            { label: "Transactions",   value: Number(totalDeductions).toLocaleString(), sub: `deduction events over ${trendDays} days`,       icon: <Zap className="w-4 h-4" /> },
            { label: "Top Category",   value: topCategory ? (CATEGORY_META[topCategory.category]?.label ?? topCategory.category) : "—", sub: topCategory ? `${Number(topCategory.totalCredits).toLocaleString()} credits` : "no data", icon: <PieChart className="w-4 h-4" /> },
            { label: "Avg Active Day", value: avgDailySpend > 0 ? Number(avgDailySpend).toLocaleString() : "—", sub: `over ${trendDays}-day window`, icon: <BarChart3 className="w-4 h-4" /> },
          ].map((stat) => (
            <div key={stat.label} className="p-4">
              <div className="mb-1 flex items-center gap-1.5 text-muted-foreground">
                {stat.icon}
                <span className="text-xs font-medium uppercase tracking-wide">{stat.label}</span>
              </div>
              <p className="truncate font-mono text-lg font-semibold leading-none text-foreground">{stat.value}</p>
              <p className="mt-1 text-xs text-muted-foreground">{stat.sub}</p>
            </div>
          ))}
        </div>
      </section>

      {deductionLoading ? (
        <LoadingState size="section" className="py-20" label="Loading analytics…" showLabel />
      ) : !deductionData?.length ? (
        <Card className="border-dashed border-2">
          <CardContent className="flex flex-col items-center justify-center py-20">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-md border border-border bg-muted/40">
              <BarChart3 className="h-7 w-7 text-muted-foreground" />
            </div>
            <p className="text-lg font-semibold text-foreground">No spending data yet</p>
            <p className="mt-1 max-w-sm text-center text-sm text-muted-foreground">
              Credit usage will appear here once you start using features like lead generation, outreach, and content creation.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ── Category + Distribution ── */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
            {/* Category cards — 2/5 */}
            <div className="lg:col-span-2 space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <TrendingDown className="h-4 w-4 text-primary" /> Spending by category
              </h2>
              {[...deductionData].sort((a, b) => Number(b.totalCredits) - Number(a.totalCredits)).map((item) => {
                const meta = CATEGORY_META[item.category] ?? CATEGORY_META.general;
                const credits = Number(item.totalCredits);
                const pct = totalSpent > 0 ? (credits / totalSpent) * 100 : 0;
                return (
                  <div key={item.category} className={`rounded-2xl border p-4 ${meta.barBg} ${meta.border}`}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2.5">
                        <div className={`w-9 h-9 ${meta.bgColor} rounded-xl flex items-center justify-center shadow-sm`}>
                          {meta.icon}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-foreground">{meta.label}</p>
                          <p className="text-xs text-muted-foreground">{item.transactionCount} transactions</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-bold ${meta.color}`}>{credits.toLocaleString()}</p>
                        <p className="text-xs text-muted-foreground">{pct.toFixed(1)}%</p>
                      </div>
                    </div>
                    <div className="w-full bg-white/60 dark:bg-black/20 rounded-full h-2">
                      <div className={`${meta.bgColor} h-2 rounded-full`} style={{ width: `${Math.max(pct, 2)}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Distribution — 3/5 */}
            <div className="lg:col-span-3">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                <PieChart className="h-4 w-4 text-primary" /> Spending distribution
              </h2>
              <Card>
                <CardContent className="pt-5">
                  {/* Segmented bar */}
                  <div className="flex rounded-xl overflow-hidden h-10 shadow-inner mb-5">
                    {[...deductionData].sort((a, b) => Number(b.totalCredits) - Number(a.totalCredits)).map((item) => {
                      const meta = CATEGORY_META[item.category] ?? CATEGORY_META.general;
                      const pct = totalSpent > 0 ? (Number(item.totalCredits) / totalSpent) * 100 : 0;
                      if (pct < 1) return null;
                      return (
                        <div
                          key={item.category}
                          title={`${meta.label}: ${Number(item.totalCredits).toLocaleString()} credits (${pct.toFixed(1)}%)`}
                          className={`${meta.bgColor} hover:opacity-80 transition-opacity cursor-default`}
                          style={{ width: `${pct}%` }}
                        />
                      );
                    })}
                  </div>
                  {/* Legend */}
                  <div className="grid grid-cols-2 gap-3 mb-5">
                    {[...deductionData].sort((a, b) => Number(b.totalCredits) - Number(a.totalCredits)).map((item) => {
                      const meta = CATEGORY_META[item.category] ?? CATEGORY_META.general;
                      const pct = totalSpent > 0 ? (Number(item.totalCredits) / totalSpent) * 100 : 0;
                      return (
                        <div key={item.category} className="flex items-center gap-2">
                          <div className={`w-3 h-3 ${meta.bgColor} rounded-sm flex-shrink-0`} />
                          <div className="min-w-0">
                            <p className="truncate text-xs font-medium text-foreground">{meta.label}</p>
                            <p className="text-xs text-muted-foreground">{Number(item.totalCredits).toLocaleString()} · {pct.toFixed(1)}%</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* Insights strip */}
                  <div className="rounded-lg border border-border bg-muted/35 p-4">
                    <div className="flex items-start gap-2">
                      <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
                      <div>
                        <p className="mb-1.5 text-xs font-semibold text-foreground">Spending insights</p>
                        <ul className="space-y-1 text-xs text-muted-foreground">
                          {topCategory && (
                            <li>• <strong>{CATEGORY_META[topCategory.category]?.label ?? topCategory.category}</strong> is your top expense at {((Number(topCategory.totalCredits) / totalSpent) * 100).toFixed(1)}% of spending</li>
                          )}
                          <li>• {totalDeductions} credit deduction{totalDeductions !== 1 ? "s" : ""} recorded in total</li>
                          {avgDailySpend > 0 && <li>• You spend ~{avgDailySpend.toLocaleString()} credits on active days</li>}
                        </ul>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* ── Daily Spending Trend ── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-primary" /> Daily spending trend
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">Credits spent per day over the last {trendDays} days</CardDescription>
            </CardHeader>
            <CardContent>
              {trendLoading ? (
                <LoadingState size="section" className="py-10" label="Loading spending trend…" />
              ) : !trendData?.length ? (
                <div className="py-10 text-center text-sm text-muted-foreground">No trend data available</div>
              ) : (
                <div className="overflow-x-auto pb-2">
                  <div className="flex items-end gap-1.5 min-w-max" style={{ height: "140px" }}>
                    {trendData.map((day) => {
                      const used = Number(day.debits);
                      const max = Math.max(...trendData.map(d => Number(d.debits)), 1);
                      const h = used > 0 ? Math.max((used / max) * 100, 4) : 0;
                      const label = new Date(day.date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
                      return (
                        <div key={day.date} className="flex flex-col items-center group" style={{ minWidth: "28px" }}>
                          <div className="relative w-full flex items-end" style={{ height: "110px" }}>
                            <div
                              title={`${label}: ${used.toLocaleString()} credits`}
                              className="w-full rounded-t-sm bg-primary/75 transition-colors group-hover:bg-primary"
                              style={{ height: `${h}%` }}
                            />
                            {used > 0 && (
                              <div className="absolute -top-7 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-xs px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
                                {used.toLocaleString()}
                              </div>
                            )}
                          </div>
                          <span className="mt-1.5 block origin-left rotate-45 text-xs text-muted-foreground">{label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── API Provider Cards ── */}
          {providerData && providerData.length > 0 && (
            <div>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                <Server className="h-4 w-4 text-primary" /> API provider usage
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {[...providerData].sort((a, b) => Number(b.totalCredits) - Number(a.totalCredits)).map((provider) => {
                  const meta = getBillingProviderMeta(provider.apiProvider);
                  return (
                    <Card key={provider.apiProvider} className="overflow-hidden hover:shadow-md transition-shadow">
                      <div className={`h-1.5 ${meta.dot}`} />
                      <CardContent className="pt-4 pb-4">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex items-center gap-2.5">
                            <div className="w-10 h-10 bg-gray-100 dark:bg-gray-800 rounded-xl flex items-center justify-center">
                              {meta.icon}
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-foreground">{meta.label}</p>
                              <p className="max-w-[130px] text-xs leading-tight text-muted-foreground">{meta.desc}</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-base font-bold text-foreground">{Number(provider.totalCredits).toLocaleString()}</p>
                            <p className="text-xs text-muted-foreground">credits</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4 border-t border-border pt-3 text-xs text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <Zap className="w-3 h-3" />
                            <span>{Number(provider.eventCount).toLocaleString()} calls</span>
                          </div>
                          {Number(provider.totalApiCostCents) > 0 && (
                            <div className="flex items-center gap-1">
                              <Activity className="w-3 h-3" />
                              <span>{new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(provider.totalApiCostCents) / 100)} API cost</span>
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
