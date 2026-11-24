"use client";
import { ProposalPerformance } from "@/components/proposals/ProposalPerformance";
import { proposalStatusLabel } from '@/lib/proposal-status';

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import {
  ArrowLeft, CircleDollarSign, CheckCircle2, XCircle, TrendingUp, BarChart3
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { useRouter } from "next/navigation";
import { PageErrorState } from "@/components/ui/page-state";

interface ProposalAnalytics {
  totalProposals: number;
  sentProposals: number;
  acceptedProposals: number;
  rejectedProposals: number;
  valueByCurrency: Array<{ currency: string | null; totalValue: number; acceptedValue: number }>;
  winRate: number;
  avgDaysToClose: number;
  avgDaysToDecision: number;
  avgHoursToView: number;
  viewRate: number;
  decisionRate: number;
  statusDistribution: Record<string, number>;
  funnel: { created:number;delivered:number;viewed:number;decided:number;accepted:number };
  overdueByCurrency: Array<{currency:string;count:number;value:number}>;
  declineReasons: Array<{reason:string;count:number}>;
}

const STATUS_COLORS: Record<string, string> = {
  accepted: "bg-emerald-500",
  rejected: "bg-rose-500",
  sent: "bg-blue-500",
  sending: "bg-amber-400",
  draft: "bg-slate-400",
  expired: "bg-amber-500",
};

export default function ProposalAnalyticsPage() {
  const { toast } = useToast();
  const router = useRouter();
  const [analytics, setAnalytics] = useState<ProposalAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchAnalytics = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const res = await api.get<ProposalAnalytics>("/api/proposals/analytics");
      setAnalytics(res || null);
    } catch (error: unknown) {
      setLoadError(error instanceof Error ? error.message : "Failed to load analytics");
      toast({ title: "Error", description: "Failed to load analytics", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchAnalytics(); }, [fetchAnalytics]);

  if (!loading && loadError) {
    return <PageErrorState title="Proposal analytics could not be loaded" description={loadError} reset={() => void fetchAnalytics()} />;
  }

  const data = analytics || {
    totalProposals: 0,
    sentProposals: 0,
    acceptedProposals: 0,
    rejectedProposals: 0,
    valueByCurrency: [],
    winRate: 0,
    avgDaysToClose: 0,
    avgDaysToDecision: 0,
    avgHoursToView: 0,
    viewRate: 0,
    decisionRate: 0,
    statusDistribution: {},
    funnel: {created:0,delivered:0,viewed:0,decided:0,accepted:0},
    overdueByCurrency: [],
    declineReasons: [],
  };

  return (
    <div className="mx-auto max-w-screen-2xl space-y-6 px-4 py-5 [&_button]:min-h-10 [&_button]:min-w-10 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-10 w-10 rounded-lg" aria-label="Back to proposals"
          onClick={() => router.push("/dashboard/proposals")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <BarChart3 className="w-4 h-4 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Proposal analytics</h1>
          <p className="mt-1 text-sm text-muted-foreground">Track delivery, customer decisions, and value by currency.</p>
        </div>
      </div>

      {/* KPI Stats */}
      <StatGrid columns={4}>
        <StatCard label="Total Proposals" value={data.totalProposals} description="All time" loading={loading} />
        <StatCard label="Sent" value={data.sentProposals} description="Delivered to clients" loading={loading} />
        <StatCard label="Conversion Rate" value={`${(data.winRate ?? 0).toFixed(1)}%`} description="Accepted / decided" loading={loading} />
        <StatCard label="Accepted" value={data.acceptedProposals} description="Customer approvals" loading={loading} />
      </StatGrid>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Revenue Breakdown */}
        <Card className="lg:col-span-2 border border-border/50 shadow-none rounded-xl">
          <CardHeader className="px-4 pt-3 pb-2 border-b">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" />
              Proposal value by currency
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-4">
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="space-y-3">
                {data.valueByCurrency.length === 0 ? (
                  <p className="py-6 text-sm text-muted-foreground">No proposal value recorded yet.</p>
                ) : data.valueByCurrency.map((entry) => {
                  const currency = entry.currency || "USD";
                  const ratio = entry.totalValue > 0 ? (entry.acceptedValue / entry.totalValue) * 100 : 0;
                  const format = (value: number) => new Intl.NumberFormat(undefined, {
                    style: "currency", currency, maximumFractionDigits: 0,
                  }).format(value);
                  return (
                    <div key={currency} className="rounded-lg border border-border/50 p-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm font-medium">{currency}</span>
                        <span className="text-sm font-semibold">{format(entry.acceptedValue)} accepted</span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, ratio)}%` }} />
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">{format(entry.totalValue)} total · {ratio.toFixed(1)}% accepted value</p>
                    </div>
                  );
                })}
              </div>

              <Card className="border border-border/40 shadow-none rounded-xl bg-muted/20">
                <CardContent className="p-4 text-center">
                  <p className="text-xs text-muted-foreground mb-1">Avg. decision time</p>
                  <div className="text-3xl font-bold tabular-nums">
                    {data.avgDaysToDecision > 0 ? data.avgDaysToDecision.toFixed(1) : "—"}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">days</p>
                  <p className="mt-4 text-xs text-muted-foreground">First view: {data.avgHoursToView > 0 ? `${data.avgHoursToView.toFixed(1)} hours` : "No view data"}</p>
                </CardContent>
              </Card>
            </div>
          </CardContent>
        </Card>

        {/* Status breakdown */}
        <Card className="border border-border/50 shadow-none rounded-xl">
          <CardHeader className="px-4 pt-3 pb-2 border-b">
            <CardTitle className="text-sm font-semibold">Status Distribution</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner size="md" label="Loading status distribution" className="text-muted-foreground/40" />
              </div>
            ) : Object.keys(data.statusDistribution ?? {}).length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">No data yet</p>
            ) : (
              <div className="space-y-4">
                {Object.entries(data.statusDistribution ?? {}).map(([status, count]) => {
                  const pct = data.totalProposals > 0 ? (count / data.totalProposals) * 100 : 0;
                  const barColor = STATUS_COLORS[status] || "bg-secondary";
                  return (
                    <div key={status} className="space-y-1.5">
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-foreground">{proposalStatusLabel(status)}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold">{count}</span>
                          <span className="text-xs text-muted-foreground">{pct.toFixed(1)}%</span>
                        </div>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div className={`h-full ${barColor} rounded-full transition-all duration-700`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="border border-border/50 shadow-none rounded-xl lg:col-span-2"><CardHeader className="border-b px-4 py-3"><CardTitle className="text-sm">Proposal funnel</CardTitle></CardHeader><CardContent className="space-y-3 p-4">{Object.entries(data.funnel).map(([label,count])=>{const width=data.funnel.created?Math.max(2,Number(count)/data.funnel.created*100):0;return <div key={label}><div className="flex justify-between text-xs"><span className="capitalize">{label}</span><span>{count}</span></div><div className="mt-1 h-3 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{width:`${width}%`}}/></div></div>})}<p className="pt-2 text-xs text-muted-foreground">{data.viewRate.toFixed(1)}% of delivered proposals were viewed · {data.decisionRate.toFixed(1)}% reached a decision.</p></CardContent></Card>
        <Card className="border border-border/50 shadow-none rounded-xl"><CardHeader className="border-b px-4 py-3"><CardTitle className="text-sm">Overdue value</CardTitle></CardHeader><CardContent className="space-y-3 p-4">{data.overdueByCurrency.map(item=><div className="flex items-baseline justify-between gap-3" key={item.currency}><span className="text-sm">{item.count} {item.currency} proposal{item.count===1?"":"s"}</span><strong>{new Intl.NumberFormat(undefined,{style:"currency",currency:item.currency,maximumFractionDigits:0}).format(item.value)}</strong></div>)}{!data.overdueByCurrency.length&&<p className="text-sm text-muted-foreground">No expired proposal value.</p>}</CardContent></Card>
      </div>

      <Card className="border border-border/50 shadow-none rounded-xl"><CardHeader className="border-b px-4 py-3"><CardTitle className="text-sm">Decline reasons</CardTitle></CardHeader><CardContent className="p-4">{data.declineReasons.length?<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Customer reason</th><th className="p-2 text-right">Proposals</th></tr></thead><tbody>{data.declineReasons.map(item=><tr className="border-t" key={item.reason}><td className="p-2">{item.reason}</td><td className="p-2 text-right tabular-nums">{item.count}</td></tr>)}</tbody></table></div>:<p className="text-sm text-muted-foreground">No declined proposals in this workspace.</p>}</CardContent></Card>

      <ProposalPerformance/>
      {/* Summary cards */}
      <StatGrid columns={3}>
        <StatCard label="Accepted" value={data.acceptedProposals} icon={<CheckCircle2 className="text-emerald-600" />} description="Proposals successfully accepted" loading={loading} />
        <StatCard label="Rejected" value={data.rejectedProposals} icon={<XCircle className="text-rose-600" />} description="Proposals declined by clients" loading={loading} />
        <StatCard label="Currencies" value={data.valueByCurrency.length} icon={<CircleDollarSign className="text-primary" />} description="Values are kept separate to avoid invalid cross-currency totals" loading={loading} />
      </StatGrid>
    </div>
  );
}
