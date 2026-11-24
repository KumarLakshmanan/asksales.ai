"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { PageErrorState } from "@/components/ui/page-state";
import {
  Table, TableHeader, TableRow, TableHead, TableBody, TableCell,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Activity, Award, BarChart3, IndianRupee,
  PieChart, RefreshCw, Server,
  TrendingDown, Users, Zap,
} from "lucide-react";
import { PROVIDER_META } from "@/components/admin/creditProviderMeta";

const Chart = dynamic(() => import("react-apexcharts"), { ssr: false });

// ─── Types ───────────────────────────────────────────────────────────────────

interface SummaryItem {
  eventKey: string;
  totalCredits: number;
  totalApiCostINR: number;
  eventCount: number;
  uniqueUsers: number;
}

interface DailyUsage {
  date: string;
  totalCredits: number;
  eventCount: number;
}

interface TopUser {
  userId: number;
  balance: number;
  totalCreditsAdded: number;
  totalCreditsUsed: number;
  userName: string | null;
  userEmail: string | null;
}

interface ProviderUsage {
  apiProvider: string;
  totalCredits: number;
  totalApiCostINR: number;
  eventCount: number;
  uniqueUsers: number;
}

// ─── Provider Metadata ───────────────────────────────────────────────────────

const PROVIDER_COLORS: Record<string, string> = {
  openai: "#22c55e", openrouter: "#6366f1", apify: "#eab308", gemini: "#3b82f6",
  zerobounce: "#14b8a6", custom_ai: "#f59e0b", platform: "#64748b",
};

const EVENT_KEY_LABELS: Record<string, string> = {
  recharge_rate: "Recharge Rate", lead_generation: "Lead Generation", lead_enrichment: "Lead Enrichment",
  lead_scoring: "Lead Scoring", outreach_email: "Email Outreach", outreach_sms: "SMS Outreach",
  outreach_whatsapp: "WhatsApp Outreach", outreach_instagram: "Instagram Outreach",
  api_openai: "OpenAI API", api_openrouter: "OpenRouter API", api_custom_ai: "Custom AI API", api_apify: "Apify API",
  api_gemini: "Gemini API", api_zerobounce: "ZeroBounce API", campaign_creation: "Campaign Creation",
  ad_creation: "Ad Creation", knowledge_base_upload: "Knowledge Base Upload",
};

// ─── Page ────────────────────────────────────────────────────────────────────

export default function CreditAnalyticsPage() {
  const { toast } = useToast();
  const { resolvedTheme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [failedSections, setFailedSections] = useState<string[]>([]);
  const [summary, setSummary] = useState<SummaryItem[]>([]);
  const [totals, setTotals] = useState({ totalCredits: 0, totalEvents: 0, totalApiCostINR: 0 });
  const [dailyUsage, setDailyUsage] = useState<DailyUsage[]>([]);
  const [topUsers, setTopUsers] = useState<TopUser[]>([]);
  const [providerUsage, setProviderUsage] = useState<ProviderUsage[]>([]);
  const [days, setDays] = useState("30");

  const requestGeneration = useRef(0);
  const fetchData = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setFailedSections([]);
    try {
      const results = await Promise.allSettled([
        api.get<{ summary: SummaryItem[]; totals: typeof totals }>("/api/admin/credit-analytics/summary"),
        api.get<DailyUsage[]>(`/api/admin/credit-analytics/daily?days=${days}`),
        api.get<TopUser[]>("/api/admin/credit-analytics/top-users?limit=20"),
        api.get<ProviderUsage[]>("/api/admin/credit-analytics/providers"),
      ]);
      if (generation !== requestGeneration.current) return;
      const labels = ["summary", "daily usage", "top users", "provider usage"];
      const failures = results.flatMap((result, index) => result.status === "rejected" ? [labels[index]] : []);
      setFailedSections(failures);
      const [summaryRes, dailyRes, usersRes, providerRes] = results;
      if (summaryRes.status === "fulfilled") { setSummary(summaryRes.value.summary); setTotals(summaryRes.value.totals); }
      if (dailyRes.status === "fulfilled") setDailyUsage(dailyRes.value);
      if (usersRes.status === "fulfilled") setTopUsers(usersRes.value);
      if (providerRes.status === "fulfilled") setProviderUsage(providerRes.value);
      if (failures.length) toast({ title: "Some analytics are unavailable", description: `Could not load: ${failures.join(", ")}.`, variant: "destructive" });
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [days, toast]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Chart Data ──
  const chartData = useMemo(() => {
    if (failedSections.includes("daily usage")) return [];
    const result: { date: string; credits: number; events: number }[] = [];
    const now = new Date();
    const numDays = parseInt(days);
    for (let i = numDays - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      const match = dailyUsage.find((u) => u.date === dateStr);
      result.push({ date: dateStr, credits: match?.totalCredits || 0, events: match?.eventCount || 0 });
    }
    return result;
  }, [dailyUsage, days, failedSections]);

  const sortedSummary = useMemo(() => [...summary].sort((a, b) => b.totalCredits - a.totalCredits), [summary]);
  const totalProviderSpent = useMemo(() => providerUsage.reduce((s, p) => s + p.totalCredits, 0), [providerUsage]);

  // ── ApexCharts Config ──
  const dailyChartOptions: ApexCharts.ApexOptions = useMemo(() => ({
    chart: { type: "bar", toolbar: { show: false }, fontFamily: "inherit", background: "transparent" },
    plotOptions: { bar: { borderRadius: 4, columnWidth: "60%" } },
    colors: ["#8b5cf6"],
    dataLabels: { enabled: false },
    stroke: { width: 0 },
    xaxis: {
      categories: chartData.map((d) => new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })),
      labels: { style: { fontSize: "10px", colors: "#9ca3af" }, rotate: -45, rotateAlways: chartData.length > 14, hideOverlappingLabels: true },
      axisBorder: { show: false }, axisTicks: { show: false },
    },
    yaxis: { labels: { style: { fontSize: "11px", colors: "#9ca3af" }, formatter: (val: number) => val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val.toFixed(0) } },
    grid: { borderColor: "rgba(156,163,175,0.15)", strokeDashArray: 4 },
    theme: { mode: resolvedTheme === "dark" ? "dark" : "light" },
    tooltip: { theme: resolvedTheme === "dark" ? "dark" : "light", y: { formatter: (val: number) => `${val.toLocaleString()} credits` } },
  }), [chartData, resolvedTheme]);

  const dailyChartSeries = useMemo(() => [{ name: "Credits Used", data: chartData.map((d) => d.credits) }], [chartData]);

  const providerDonutOptions: ApexCharts.ApexOptions = useMemo(() => {
    const sorted = [...providerUsage].sort((a, b) => b.totalCredits - a.totalCredits);
    return {
      chart: { type: "donut", fontFamily: "inherit", background: "transparent" },
      labels: sorted.map((p) => PROVIDER_META[p.apiProvider]?.label || p.apiProvider),
      colors: sorted.map((p) => PROVIDER_COLORS[p.apiProvider] || "#9ca3af"),
      dataLabels: { enabled: false },
      legend: { position: "bottom", fontSize: "11px" },
      plotOptions: { pie: { donut: { size: "65%", labels: { show: true, total: { show: true, label: "Total", formatter: () => totalProviderSpent.toLocaleString() } } } } },
      theme: { mode: resolvedTheme === "dark" ? "dark" : "light" },
      tooltip: { theme: resolvedTheme === "dark" ? "dark" : "light", y: { formatter: (val: number) => `${val.toLocaleString()} credits` } },
    };
  }, [providerUsage, resolvedTheme, totalProviderSpent]);

  const providerDonutSeries = useMemo(() =>
    [...providerUsage].sort((a, b) => b.totalCredits - a.totalCredits).map((p) => p.totalCredits),
  [providerUsage]);

  if (loading) {
    return (
      <LoadingState size="page" label="Loading credit analytics…" />
    );
  }

  if (failedSections.length === 4) {
    return <PageErrorState title="Credit analytics could not be loaded" description="All credit analytics requests failed." reset={() => void fetchData()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Credit Analytics</h1>
          <p className="mt-1 text-sm text-muted-foreground">Global credit consumption across all users and services</p>
        </div>
        <Button variant="outline" onClick={fetchData} className="gap-2">
          <RefreshCw className="w-4 h-4" /> Refresh
        </Button>
      </div>

      {failedSections.length > 0 && (
        <Callout
          tone="danger"
          title="Some credit analytics are unavailable"
          actions={<Button variant="outline" size="sm" onClick={() => void fetchData()}>Try again</Button>}
        >
          Could not load: {failedSections.join(", ")}. The remaining data is current.
        </Callout>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-gradient-to-br from-purple-600 to-purple-800 text-white border-0">
          <CardHeader className="pb-2">
            <CardDescription className="text-purple-200 text-xs font-medium">Total Credits Used</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-purple-200" />
              <span className="text-2xl font-bold">{failedSections.includes("summary") ? "Unavailable" : totals.totalCredits.toLocaleString()}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-medium">Total Events</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-blue-600">
              <Activity className="w-5 h-5" />
              <span className="text-2xl font-bold">{failedSections.includes("summary") ? "Unavailable" : totals.totalEvents.toLocaleString()}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-medium">Total API Costs</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-orange-600">
              <IndianRupee className="w-5 h-5" />
              <span className="text-2xl font-bold">{failedSections.includes("summary") ? "Unavailable" : `₹${totals.totalApiCostINR.toFixed(2)}`}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-medium">Active Users</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-green-600">
              <Users className="w-5 h-5" />
              <span className="text-2xl font-bold">{failedSections.includes("top users") ? "Unavailable" : topUsers.length}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Daily Credit Activity Chart (ApexCharts) */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-purple-600" /> Daily Credit Consumption
              </CardTitle>
              <CardDescription className="text-xs mt-1">Credits consumed per day across all users</CardDescription>
            </div>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="w-full sm:w-[140px]" aria-label="Select credit activity range"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="14">Last 14 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="60">Last 60 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {failedSections.includes("daily usage") ? <p role="status">Daily credit activity is unavailable.</p> : chartData.every((d) => d.credits === 0) ? (
            <div className="flex h-48 flex-col items-center justify-center text-muted-foreground">
              <BarChart3 className="w-9 h-9 mb-2 opacity-25" />
              <p className="text-sm">No credit activity in this period</p>
            </div>
          ) : (
            <div className="-mx-2">
              <Chart options={dailyChartOptions} series={dailyChartSeries} type="bar" height={280} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Provider Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        {/* Provider Cards - 3/5 */}
        <div className="lg:col-span-3">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <TrendingDown className="w-4 h-4 text-purple-500" /> Spending by Provider
          </h2>
          {failedSections.includes("provider usage") ? <p role="status">Provider usage is unavailable.</p> : !providerUsage.length ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <PieChart className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-sm">No spending data yet</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {providerUsage.map((item) => {
                const meta = PROVIDER_META[item.apiProvider] ?? PROVIDER_META.platform;
                const pct = totalProviderSpent > 0 ? (item.totalCredits / totalProviderSpent) * 100 : 0;
                return (
                  <div key={item.apiProvider} className={`rounded-2xl border p-4 ${meta.barBg} ${meta.border}`}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2.5">
                        <div className={`w-9 h-9 ${meta.bgColor} rounded-xl flex items-center justify-center shadow-sm`}>{meta.icon}</div>
                        <div>
                          <p className="text-sm font-semibold text-foreground">{meta.label}</p>
                          <p className="text-[10px] text-muted-foreground">{item.eventCount} events · {item.uniqueUsers} users</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-bold ${meta.color}`}>{item.totalCredits.toLocaleString()}</p>
                        <p className="text-[10px] text-muted-foreground">{pct.toFixed(1)}%{item.totalApiCostINR > 0 ? ` · ₹${item.totalApiCostINR.toFixed(2)}` : ""}</p>
                      </div>
                    </div>
                    <div className="w-full bg-white/60 dark:bg-black/20 rounded-full h-2">
                      <div className={`${meta.bgColor} h-2 rounded-full`} style={{ width: `${Math.max(pct, 2)}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Provider Donut - 2/5 */}
        <div className="lg:col-span-2">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Server className="w-4 h-4 text-purple-500" /> Distribution
          </h2>
          <Card>
            <CardContent className="pt-5">
              {failedSections.includes("provider usage") ? <p role="status">Provider usage is unavailable.</p> : !providerUsage.length ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <PieChart className="w-8 h-8 mb-2 opacity-30" />
                  <p className="text-sm">No provider data yet</p>
                </div>
              ) : (
                <Chart options={providerDonutOptions} series={providerDonutSeries} type="donut" height={320} />
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Bottom Section: Event Types + Top Users */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Usage by Event Type */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Credits by Event Type</CardTitle>
            <CardDescription className="text-xs">Breakdown of credit consumption per event</CardDescription>
          </CardHeader>
          <CardContent>
            {failedSections.includes("summary") ? <p role="status">Credit summary is unavailable.</p> : sortedSummary.length ? (
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {sortedSummary.map((item) => {
                  const pct = totals.totalCredits > 0 ? (item.totalCredits / totals.totalCredits) * 100 : 0;
                  const label = EVENT_KEY_LABELS[item.eventKey] || item.eventKey;
                  return (
                    <div key={item.eventKey} className="p-2.5 rounded-lg border border-gray-100 dark:border-gray-800">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{label}</span>
                          <Badge variant="outline" className="text-[10px]">{item.eventCount} events</Badge>
                          <Badge variant="secondary" className="text-[10px]">{item.uniqueUsers} users</Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-red-600">-{item.totalCredits.toLocaleString()}</span>
                          <span className="text-xs text-muted-foreground">{pct.toFixed(1)}%</span>
                        </div>
                      </div>
                      <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-1.5">
                        <div className="bg-purple-500 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      {item.totalApiCostINR > 0 && (
                        <p className="mt-1 text-[10px] text-muted-foreground">API Cost: ₹{item.totalApiCostINR.toFixed(2)}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground">
                <BarChart3 className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No credit usage data yet</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top Users */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Award className="w-4 h-4 text-orange-500" /> Top Credit Consumers
            </CardTitle>
            <CardDescription className="text-xs">Users ranked by total credits consumed</CardDescription>
          </CardHeader>
          <CardContent>
            {failedSections.includes("top users") ? <p role="status">Top credit consumers are unavailable.</p> : topUsers.length ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">#</TableHead>
                      <TableHead className="text-xs">User</TableHead>
                      <TableHead className="text-xs text-right">Recharged</TableHead>
                      <TableHead className="text-xs text-right">Used</TableHead>
                      <TableHead className="text-xs text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topUsers.map((user, idx) => (
                      <TableRow key={user.userId}>
                        <TableCell className="text-xs font-medium">{idx + 1}</TableCell>
                        <TableCell>
                          <div>
                            <p className="text-sm font-medium">{user.userName || `User #${user.userId}`}</p>
                            <p className="text-xs text-muted-foreground">{user.userEmail}</p>
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-sm text-green-600 font-medium">{user.totalCreditsAdded.toLocaleString()}</TableCell>
                        <TableCell className="text-right text-sm text-red-600 font-medium">{user.totalCreditsUsed.toLocaleString()}</TableCell>
                        <TableCell className="text-right text-sm font-semibold">{user.balance.toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground">
                <Users className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No user data yet</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
