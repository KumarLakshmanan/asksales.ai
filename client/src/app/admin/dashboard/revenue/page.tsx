"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import {
  Table, TableHeader, TableRow, TableHead, TableBody, TableCell,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Activity, ArrowLeft, Bot, Building, Globe,
  IndianRupee, Mail, RefreshCw, Server, Sparkles, TrendingUp, Zap,
} from "lucide-react";

const Chart = dynamic(() => import("react-apexcharts"), { ssr: false });

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProviderRevenue {
  apiProvider: string;
  totalCreditsCharged: number;
  grossRevenueINR: number;
  totalApiCostINR: number;
  netRevenueINR: number;
  eventCount: number;
  uniqueUsers: number;
}

interface DailyRevenue {
  date: string;
  totalCreditsCharged: number;
  grossRevenueINR: number;
  totalApiCostINR: number;
  netRevenueINR: number;
  eventCount: number;
}

interface DrillDownItem {
  eventKey: string;
  service: string;
  apiProvider: string;
  totalCreditsCharged: number;
  grossRevenueINR: number;
  totalApiCostINR: number;
  netRevenueINR: number;
  eventCount: number;
}

interface TransactionItem {
  id: number;
  userId: number;
  eventKey: string;
  creditsUsed: number;
  grossRevenueINR: number;
  apiCostINR: number;
  netRevenueINR: number;
  apiProvider: string;
  service: string;
  description: string;
  createdAt: string;
}

// ─── Provider Metadata ───────────────────────────────────────────────────────

const PROVIDER_META: Record<string, { label: string; icon: React.ReactNode; color: string; bgColor: string }> = {
  openai:     { label: "OpenAI",      icon: <Bot className="w-4 h-4 text-white" />,      color: "text-green-600 dark:text-green-400",   bgColor: "bg-green-500" },
  openrouter: { label: "OpenRouter",  icon: <Globe className="w-4 h-4 text-white" />,    color: "text-blue-600 dark:text-blue-400",     bgColor: "bg-blue-500" },
  gemini:     { label: "Gemini",      icon: <Sparkles className="w-4 h-4 text-white" />, color: "text-purple-600 dark:text-purple-400", bgColor: "bg-purple-500" },
  apify:      { label: "Apify",       icon: <Server className="w-4 h-4 text-white" />,   color: "text-orange-600 dark:text-orange-400", bgColor: "bg-orange-500" },
  zerobounce: { label: "ZeroBounce",  icon: <Mail className="w-4 h-4 text-white" />,     color: "text-cyan-700 dark:text-cyan-400",     bgColor: "bg-cyan-500" },
  platform:   { label: "Platform",    icon: <Building className="w-4 h-4 text-white" />,  color: "text-muted-foreground", bgColor: "bg-gray-500" },
};

function getProviderMeta(provider: string) {
  return PROVIDER_META[provider] || { label: provider, icon: <Zap className="w-4 h-4 text-white" />, color: "text-muted-foreground", bgColor: "bg-gray-500" };
}

const formatINR = (value: number) => new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
}).format(value || 0);

interface RevenueTotals {
  totalCreditsCharged: number;
  totalGrossRevenueINR: number;
  totalApiCostINR: number;
  totalNetRevenueINR: number;
  totalEvents: number;
  rechargeRate: number;
  usdToInrRate: number;
  cashCollectedINR: number;
  rechargeCashINR: number;
  subscriptionCashINR: number;
  paidCreditsIssued: number;
  complimentaryCreditsIssued: number;
}

const EMPTY_TOTALS: RevenueTotals = {
  totalCreditsCharged: 0,
  totalGrossRevenueINR: 0,
  totalApiCostINR: 0,
  totalNetRevenueINR: 0,
  totalEvents: 0,
  rechargeRate: 0,
  usdToInrRate: 0,
  cashCollectedINR: 0,
  rechargeCashINR: 0,
  subscriptionCashINR: 0,
  paidCreditsIssued: 0,
  complimentaryCreditsIssued: 0,
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function RevenuePage() {
  const { toast } = useToast();
  const { resolvedTheme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [drillError, setDrillError] = useState<string | null>(null);
  const [transactionsError, setTransactionsError] = useState<string | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [providers, setProviders] = useState<ProviderRevenue[]>([]);
  const [totals, setTotals] = useState<RevenueTotals>(EMPTY_TOTALS);
  const [daily, setDaily] = useState<DailyRevenue[]>([]);
  const [dayRange, setDayRange] = useState("30");
  const [drillDown, setDrillDown] = useState<DrillDownItem[]>([]);
  const [drillProvider, setDrillProvider] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [txTotal, setTxTotal] = useState(0);
  const [txDialog, setTxDialog] = useState<{ provider: string; eventKey: string } | null>(null);

  const fetchSummary = useCallback(async () => {
    setSummaryError(null);
    try {
      const res = await api.get<{ providers: ProviderRevenue[]; totals: typeof totals }>("/api/admin/revenue/summary");
      if (res) {
        setProviders(res.providers);
        setTotals(res.totals);
      }
    } catch (error: unknown) {
      setSummaryError(error instanceof Error ? error.message : "Failed to load revenue summary");
      toast({ title: "Error", description: "Failed to load revenue summary", variant: "destructive" });
    }
  }, [toast]);

  const fetchDaily = useCallback(async () => {
    setDailyError(null);
    try {
      const res = await api.get<DailyRevenue[]>(`/api/admin/revenue/daily?days=${dayRange}`);
      if (res) setDaily(res);
    } catch (error: unknown) {
      setDailyError(error instanceof Error ? error.message : "Failed to load daily revenue");
    }
  }, [dayRange]);

  const fetchDrillDown = useCallback(async (provider: string) => {
    setDrillLoading(true);
    setDrillError(null);
    setDrillDown([]);
    try {
      const url = provider === "all" ? "/api/admin/revenue/drill-down" : `/api/admin/revenue/drill-down?apiProvider=${provider}`;
      const res = await api.get<DrillDownItem[]>(url);
      if (res) setDrillDown(res);
    } catch (error: unknown) {
      setDrillError(error instanceof Error ? error.message : "Failed to load drill-down");
      toast({ title: "Error", description: "Failed to load drill-down", variant: "destructive" });
    } finally {
      setDrillLoading(false);
    }
  }, [toast]);

  const fetchTransactions = useCallback(async (provider: string, eventKey: string) => {
    setTransactionsLoading(true);
    setTransactionsError(null);
    setTransactions([]);
    setTxTotal(0);
    try {
      const res = await api.get<{ data: TransactionItem[]; total: number }>(
        `/api/admin/revenue/transactions?apiProvider=${provider}&eventKey=${encodeURIComponent(eventKey)}&limit=100`
      );
      if (res) {
        setTransactions(res.data || []);
        setTxTotal(res.total || 0);
      }
    } catch (error: unknown) {
      setTransactionsError(error instanceof Error ? error.message : "Failed to load transactions");
      toast({ title: "Error", description: "Failed to load transactions", variant: "destructive" });
    } finally {
      setTransactionsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchSummary(), fetchDaily()]).finally(() => setLoading(false));
  }, [fetchSummary, fetchDaily]);

  const handleProviderClick = (provider: string) => {
    setDrillProvider(provider);
    fetchDrillDown(provider);
  };

  const handleEventClick = (provider: string, eventKey: string) => {
    setTxDialog({ provider, eventKey });
    fetchTransactions(provider, eventKey);
  };

  const marginPct = totals.totalGrossRevenueINR > 0
    ? ((totals.totalNetRevenueINR / totals.totalGrossRevenueINR) * 100).toFixed(1)
    : "0.0";

  // ─── Chart Data ──────────────────────────────────────────────────────────

  const chartOptions = useMemo(() => ({
    chart: { id: "revenue-daily", toolbar: { show: false }, background: "transparent" },
    xaxis: { categories: daily.map((d) => d.date), labels: { rotate: -45, style: { fontSize: "10px" } } },
    stroke: { curve: "smooth" as const, width: 2 },
    colors: ["#22c55e", "#ef4444", "#3b82f6"],
    legend: { position: "top" as const },
    theme: { mode: resolvedTheme === "dark" ? "dark" as const : "light" as const },
    tooltip: { shared: true, intersect: false },
  }), [daily, resolvedTheme]);

  const chartSeries = useMemo(() => [
    { name: "Gross value (INR)", data: daily.map((d) => d.grossRevenueINR) },
    { name: "API cost (INR)", data: daily.map((d) => d.totalApiCostINR) },
    { name: "Net revenue (INR)", data: daily.map((d) => d.netRevenueINR) },
  ], [daily]);

  const donutOptions = useMemo(() => ({
    chart: { background: "transparent" },
    labels: providers.map((p) => getProviderMeta(p.apiProvider).label),
    colors: providers.map((p) => {
      const map: Record<string, string> = { openai: "#22c55e", openrouter: "#3b82f6", gemini: "#a855f7", apify: "#f97316", zerobounce: "#06b6d4", platform: "#6b7280" };
      return map[p.apiProvider] || "#6b7280";
    }),
    legend: { position: "bottom" as const },
    theme: { mode: resolvedTheme === "dark" ? "dark" as const : "light" as const },
  }), [providers, resolvedTheme]);

  const donutSeries = useMemo(() => providers.map((p) => Math.max(p.netRevenueINR, 0)), [providers]);

  if (loading) {
    return (
      <LoadingState size="page" label="Loading revenue analytics…" />
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Revenue Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Credits spent (net of refunds), valued at the recharge rate in force when each was charged, against provider cost.
          </p>
          {totals.rechargeRate > 0 && totals.usdToInrRate > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Current accounting rates: {totals.rechargeRate} credits/₹ · $1 = ₹{totals.usdToInrRate} (used only for charges recorded before rates were stored)
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => { fetchSummary(); fetchDaily(); }}>
          <RefreshCw className="h-4 w-4 mr-2" /> Refresh
        </Button>
      </div>

      {summaryError && (
        <Callout
          tone="danger"
          title="Revenue summary could not be loaded"
          actions={<Button variant="outline" size="sm" onClick={() => void fetchSummary()}>Try again</Button>}
        >
          {summaryError}
        </Callout>
      )}

      {/* Summary Cards */}
      {!summaryError && <StatGrid columns={4} className="gap-4">
        <StatCard
          label="Gross Credit Value"
          value={formatINR(totals.totalGrossRevenueINR)}
          description={`${totals.totalCreditsCharged.toLocaleString()} credits, net of refunds`}
          icon={<IndianRupee className="text-emerald-600 dark:text-emerald-400" />}
        />
        <StatCard
          label="Total API Cost"
          value={formatINR(totals.totalApiCostINR)}
          icon={<IndianRupee className="text-rose-600 dark:text-rose-400" />}
        />
        <StatCard
          label="Net Revenue"
          value={
            <span className={totals.totalNetRevenueINR >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}>
              {formatINR(totals.totalNetRevenueINR)}
            </span>
          }
          description={`Margin: ${marginPct}%`}
          icon={<TrendingUp className="text-blue-600 dark:text-blue-400" />}
        />
        <StatCard
          label="Total Events"
          value={totals.totalEvents.toLocaleString()}
          icon={<Activity className="text-violet-600 dark:text-violet-400" />}
        />
      </StatGrid>}

      {/* Cash vs. complimentary credits: credit value assumes every credit was bought */}
      {!summaryError && <StatGrid columns={2} className="gap-4">
        <StatCard
          label="Cash Collected"
          value={formatINR(totals.cashCollectedINR)}
          description={`Recharges ${formatINR(totals.rechargeCashINR)} · Plans ${formatINR(totals.subscriptionCashINR)} (net of plan refunds)`}
          icon={<IndianRupee className="text-emerald-600 dark:text-emerald-400" />}
        />
        <StatCard
          label="Complimentary Credits Issued"
          value={totals.complimentaryCreditsIssued.toLocaleString()}
          description={`Admin bonuses and admin-assigned plans, never paid for · ${totals.paidCreditsIssued.toLocaleString()} paid credits issued`}
          icon={<Activity className="text-amber-600 dark:text-amber-400" />}
        />
      </StatGrid>}

      {/* Daily Revenue Chart */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Daily Revenue</CardTitle>
            <CardDescription>Gross value, provider cost, and net revenue in INR</CardDescription>
          </div>
          <Select value={dayRange} onValueChange={setDayRange}>
            <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">7 days</SelectItem>
              <SelectItem value="14">14 days</SelectItem>
              <SelectItem value="30">30 days</SelectItem>
              <SelectItem value="60">60 days</SelectItem>
              <SelectItem value="90">90 days</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {dailyError ? (
            <Callout
              tone="danger"
              title="Daily revenue could not be loaded"
              actions={<Button variant="outline" size="sm" onClick={() => void fetchDaily()}>Try again</Button>}
            >
              {dailyError}
            </Callout>
          ) : daily.length > 0 ? (
            <Chart type="line" options={chartOptions} series={chartSeries} height={320} />
          ) : (
            <p className="text-center text-muted-foreground py-8">No data for this period</p>
          )}
        </CardContent>
      </Card>

      {!summaryError && <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Provider Revenue Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Revenue by Provider</CardTitle>
            <CardDescription>Click a provider to drill down</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table className="min-w-[620px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">Gross value</TableHead>
                  <TableHead className="text-right">API Cost</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((p) => {
                  const meta = getProviderMeta(p.apiProvider);
                  return (
                    <TableRow
                      key={p.apiProvider}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => handleProviderClick(p.apiProvider)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className={`p-1 rounded ${meta.bgColor}`}>{meta.icon}</div>
                          <span className="font-medium">{meta.label}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{formatINR(p.grossRevenueINR)}</TableCell>
                      <TableCell className="text-right">{formatINR(p.totalApiCostINR)}</TableCell>
                      <TableCell className={`text-right font-medium ${p.netRevenueINR >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}>
                        {formatINR(p.netRevenueINR)}
                      </TableCell>
                      <TableCell className="text-right">{p.eventCount}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Revenue Distribution Donut */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Revenue Distribution</CardTitle>
            <CardDescription>Net revenue share by provider</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-center">
            {donutSeries.some((v) => v > 0) ? (
              <Chart type="donut" options={donutOptions} series={donutSeries} width={380} />
            ) : (
              <p className="text-muted-foreground py-8">No data available</p>
            )}
          </CardContent>
        </Card>
      </div>}

      {/* Drill-Down: Event Key Breakdown */}
      {drillProvider && (
        <Card>
          <CardHeader className="flex flex-row items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => setDrillProvider(null)}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <CardTitle className="text-base">
                Revenue Drill-Down: {getProviderMeta(drillProvider).label}
              </CardTitle>
              <CardDescription>Breakdown by event type — click a row for individual transactions</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {drillError ? (
              <Callout
                tone="danger"
                title="Revenue details could not be loaded"
                actions={<Button variant="outline" size="sm" onClick={() => void fetchDrillDown(drillProvider)}>Try again</Button>}
              >
                {drillError}
              </Callout>
            ) : drillLoading ? (
              <LoadingState size="section" className="min-h-40" label="Loading revenue details…" />
            ) : <div className="overflow-x-auto"><Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Event Key</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead className="text-right">Gross value</TableHead>
                  <TableHead className="text-right">API Cost</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drillDown.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-6">No data</TableCell>
                  </TableRow>
                ) : (
                  drillDown.map((d, i) => (
                    <TableRow
                      key={`${d.eventKey}-${d.service}-${i}`}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => handleEventClick(d.apiProvider, d.eventKey)}
                    >
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-xs">{d.eventKey}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{d.service}</TableCell>
                      <TableCell className="text-right">{formatINR(d.grossRevenueINR)}</TableCell>
                      <TableCell className="text-right">{formatINR(d.totalApiCostINR)}</TableCell>
                      <TableCell className={`text-right font-medium ${d.netRevenueINR >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}>
                        {formatINR(d.netRevenueINR)}
                      </TableCell>
                      <TableCell className="text-right">{d.eventCount}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table></div>}
          </CardContent>
        </Card>
      )}

      {/* Transaction Dialog */}
      <Dialog open={!!txDialog} onOpenChange={() => setTxDialog(null)}>
        <DialogContent className="max-h-[90dvh] max-w-4xl overflow-auto sm:max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>
              Transactions: {txDialog?.eventKey} ({txDialog?.provider})
            </DialogTitle>
          </DialogHeader>
          {!transactionsError && !transactionsLoading && <p className="text-sm text-muted-foreground mb-4">
            Showing {transactions.length} of {txTotal} transactions
          </p>}
          {transactionsError ? (
            <Callout
              tone="danger"
              title="Transactions could not be loaded"
              actions={txDialog ? <Button variant="outline" size="sm" onClick={() => void fetchTransactions(txDialog.provider, txDialog.eventKey)}>Try again</Button> : undefined}
            >
              {transactionsError}
            </Callout>
          ) : transactionsLoading ? (
            <LoadingState size="section" className="min-h-48" label="Loading transactions…" />
          ) : <div className="overflow-x-auto"><Table className="min-w-[800px]">
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Gross value</TableHead>
                <TableHead className="text-right">API Cost</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.map((tx) => (
                <TableRow key={tx.id}>
                  <TableCell className="font-mono text-xs">{tx.id}</TableCell>
                  <TableCell>{tx.userId}</TableCell>
                  <TableCell className="max-w-[200px] truncate text-sm">{tx.description}</TableCell>
                  <TableCell className="text-right" title={`${tx.creditsUsed} credits`}>{formatINR(tx.grossRevenueINR)}</TableCell>
                  <TableCell className="text-right">{formatINR(tx.apiCostINR)}</TableCell>
                  <TableCell className={`text-right font-medium ${tx.netRevenueINR >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}>
                    {formatINR(tx.netRevenueINR)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(tx.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
              {transactions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-6">No transactions</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table></div>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
