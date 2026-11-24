"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft, BarChart3, BookOpen, Clock, Globe, Hash, Layers,
  Mail, Megaphone, MessageSquare, PieChart, Send, Server, Target,
  TrendingDown, UserCheck, Zap,
  AlertCircle,
} from "lucide-react";
import { PROVIDER_META } from "@/components/admin/creditProviderMeta";

const Chart = dynamic(() => import("react-apexcharts"), { ssr: false });

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProviderUsage {
  apiProvider: string;
  totalCredits: number;
  totalApiCostINR: number;
  eventCount: number;
}

interface DailyUsage {
  date: string;
  totalCredits: number;
  eventCount: number;
}

interface ReferenceUsage {
  referenceType: string;
  referenceId: string;
  totalCredits: number;
  eventCount: number;
  lastUsed: string;
  title: string | null;
}

interface UserAnalytics {
  providers: ProviderUsage[];
  daily: DailyUsage[];
  references: ReferenceUsage[];
  totals: {
    totalCredits: number;
    totalApiCostINR: number;
    totalEvents: number;
  };
}

// ─── Metadata ────────────────────────────────────────────────────────────────

const PROVIDER_COLORS: Record<string, string> = {
  openai: "#22c55e", openrouter: "#6366f1", apify: "#eab308", gemini: "#3b82f6",
  zerobounce: "#14b8a6", custom_ai: "#f59e0b", platform: "#64748b",
};

const REF_TYPE_META: Record<string, { label: string; icon: React.ReactNode; color: string; bg: string }> = {
  chat_thread:     { label: "Chat",           icon: <MessageSquare className="w-4 h-4" />, color: "text-blue-600",   bg: "bg-blue-50 dark:bg-blue-900/20" },
  lead_gen:        { label: "Lead Gen",       icon: <Target className="w-4 h-4" />,        color: "text-green-600",  bg: "bg-green-50 dark:bg-green-900/20" },
  lead:            { label: "Lead",           icon: <Target className="w-4 h-4" />,        color: "text-green-600",  bg: "bg-green-50 dark:bg-green-900/20" },
  campaign:        { label: "Campaign",       icon: <Megaphone className="w-4 h-4" />,     color: "text-purple-600", bg: "bg-purple-50 dark:bg-purple-900/20" },
  content:         { label: "Content",        icon: <Layers className="w-4 h-4" />,        color: "text-amber-600",  bg: "bg-amber-50 dark:bg-amber-900/20" },
  outreach:        { label: "Outreach",       icon: <Mail className="w-4 h-4" />,          color: "text-teal-600",   bg: "bg-teal-50 dark:bg-teal-900/20" },
  icp:             { label: "ICP",            icon: <UserCheck className="w-4 h-4" />,     color: "text-indigo-600", bg: "bg-indigo-50 dark:bg-indigo-900/20" },
  apify_run:       { label: "Scraping",       icon: <Globe className="w-4 h-4" />,         color: "text-yellow-600", bg: "bg-yellow-50 dark:bg-yellow-900/20" },
  knowledge_base:  { label: "Knowledge Base", icon: <BookOpen className="w-4 h-4" />,      color: "text-cyan-600",   bg: "bg-cyan-50 dark:bg-cyan-900/20" },
  sent_message:    { label: "Message",        icon: <Send className="w-4 h-4" />,          color: "text-pink-600",   bg: "bg-pink-50 dark:bg-pink-900/20" },
  ad:              { label: "Ad",             icon: <Zap className="w-4 h-4" />,           color: "text-orange-600", bg: "bg-orange-50 dark:bg-orange-900/20" },
  analytics:       { label: "Analytics",      icon: <BarChart3 className="w-4 h-4" />,     color: "text-rose-600",   bg: "bg-rose-50 dark:bg-rose-900/20" },
  other:           { label: "Other",          icon: <Server className="w-4 h-4" />,        color: "text-gray-600",   bg: "bg-gray-50 dark:bg-gray-800" },
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function UserBillingPage() {
  const params = useParams();
  const userId = params.id as string;
  const router = useRouter();
  const { toast } = useToast();
  const { resolvedTheme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<UserAnalytics | null>(null);
  const [days, setDays] = useState("30");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<UserAnalytics>(`/api/admin/credit-analytics/user/${userId}?days=${days}`);
      if (res) setData(res);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to load user billing data";
      setLoadError(message);
      toast({ title: "Error", description: "Failed to load user billing data", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [userId, days, toast]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Chart Data ──
  const chartData = useMemo(() => {
    if (!data) return [];
    const result: { date: string; credits: number }[] = [];
    const now = new Date();
    const numDays = parseInt(days);
    for (let i = numDays - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      const match = data.daily.find((u) => u.date === dateStr);
      result.push({ date: dateStr, credits: match?.totalCredits || 0 });
    }
    return result;
  }, [data, days]);

  const totalProviderSpent = useMemo(() => data?.providers.reduce((s, p) => s + p.totalCredits, 0) ?? 0, [data]);

  // ── ApexCharts Config ──
  const dailyOptions: ApexCharts.ApexOptions = useMemo(() => ({
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

  const dailySeries = useMemo(() => [{ name: "Credits Used", data: chartData.map((d) => d.credits) }], [chartData]);

  const donutOptions: ApexCharts.ApexOptions = useMemo(() => {
    const sorted = [...(data?.providers || [])].sort((a, b) => b.totalCredits - a.totalCredits);
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
  }, [data, resolvedTheme, totalProviderSpent]);

  const donutSeries = useMemo(() =>
    [...(data?.providers || [])].sort((a, b) => b.totalCredits - a.totalCredits).map((p) => p.totalCredits),
  [data]);

  if (loading) {
    return <LoadingState size="page" label="Loading billing…" />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push(`/admin/dashboard/users/${userId}/view`)} className="gap-1.5 -ml-2">
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <div className="hidden h-5 w-px bg-border sm:block" />
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-foreground">User Billing Report</h1>
          <p className="mt-0.5 break-all text-xs text-muted-foreground">Credit usage analytics for user #{userId}</p>
        </div>
      </div>

      {loadError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Billing report could not be loaded</AlertTitle>
          <AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void fetchData()}>Try again</Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Summary Cards */}
      {!loadError && <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="bg-gradient-to-br from-purple-600 to-purple-800 text-white border-0">
          <CardHeader className="pb-2">
            <CardDescription className="text-purple-200 text-xs font-medium">Total Credits Used</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-purple-200" />
              <span className="text-2xl font-bold">{data?.totals.totalCredits.toLocaleString() || "0"}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-medium">Total Events</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-blue-600">
              <BarChart3 className="w-5 h-5" />
              <span className="text-2xl font-bold">{data?.totals.totalEvents.toLocaleString() || "0"}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-medium">Total API Cost</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-orange-600">
              <span className="text-2xl font-bold">₹{((data?.totals.totalApiCostINR || 0)).toFixed(2)}</span>
            </div>
          </CardContent>
        </Card>
      </div>}

      {/* Daily Credit Activity */}
      {!loadError && <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-purple-600" /> Daily Credit Usage
              </CardTitle>
              <CardDescription className="text-xs mt-1">Credits consumed per day</CardDescription>
            </div>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="w-full sm:w-[130px]" aria-label="Select credit usage range"><SelectValue /></SelectTrigger>
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
          {chartData.every((d) => d.credits === 0) ? (
            <div className="flex h-48 flex-col items-center justify-center text-muted-foreground">
              <BarChart3 className="w-9 h-9 mb-2 opacity-25" />
              <p className="text-sm">No credit activity in this period</p>
            </div>
          ) : (
            <div className="-mx-2">
              <Chart options={dailyOptions} series={dailySeries} type="bar" height={260} />
            </div>
          )}
        </CardContent>
      </Card>}

      {/* Provider Breakdown */}
      {!loadError && <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        {/* Provider Cards - 3/5 */}
        <div className="lg:col-span-3">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <TrendingDown className="w-4 h-4 text-purple-500" /> Spending by Provider
          </h2>
          {!data?.providers.length ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <PieChart className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-sm">No spending data</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {data.providers.map((item) => {
                const meta = PROVIDER_META[item.apiProvider] ?? PROVIDER_META.platform;
                const pct = totalProviderSpent > 0 ? (item.totalCredits / totalProviderSpent) * 100 : 0;
                return (
                  <div key={item.apiProvider} className={`rounded-2xl border p-4 ${meta.barBg} ${meta.border}`}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2.5">
                        <div className={`w-9 h-9 ${meta.bgColor} rounded-xl flex items-center justify-center shadow-sm`}>{meta.icon}</div>
                        <div>
                          <p className="text-sm font-semibold text-foreground">{meta.label}</p>
                          <p className="text-[10px] text-muted-foreground">{item.eventCount} events</p>
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
              {!data?.providers.length ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <PieChart className="w-8 h-8 mb-2 opacity-30" />
                  <p className="text-sm">No data</p>
                </div>
              ) : (
                <Chart options={donutOptions} series={donutSeries} type="donut" height={300} />
              )}
            </CardContent>
          </Card>
        </div>
      </div>}

      {/* Top References */}
      {!loadError && <Card>
        <CardHeader>
          <CardTitle className="text-base">Top Credit References</CardTitle>
          <CardDescription className="text-xs">Where credits were spent — chats, campaigns, leads, etc.</CardDescription>
        </CardHeader>
        <CardContent>
          {!data?.references.length ? (
            <div className="py-8 text-center text-muted-foreground">
              <Hash className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No reference data</p>
            </div>
          ) : (
            <div className="space-y-2">
              {data.references.map((ref) => {
                const meta = REF_TYPE_META[ref.referenceType] ?? REF_TYPE_META.other;
                return (
                  <div
                    key={`${ref.referenceType}:${ref.referenceId}`}
                    className="flex items-center justify-between rounded-xl border border-border bg-card p-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${meta.bg} ${meta.color}`}>
                        {meta.icon}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {ref.title || `${meta.label} #${ref.referenceId}`}
                        </p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">{meta.label}</Badge>
                          {ref.referenceId !== "none" && (
                            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                              <Hash className="w-3 h-3" />{ref.referenceId}
                            </span>
                          )}
                          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                            <Clock className="w-3 h-3" />{timeAgo(ref.lastUsed)}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="text-right shrink-0 ml-4">
                      <p className="text-sm font-bold text-red-600 dark:text-red-400">{ref.totalCredits.toLocaleString()}</p>
                      <p className="text-[10px] text-muted-foreground">{ref.eventCount} events</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>}
    </div>
  );
}
