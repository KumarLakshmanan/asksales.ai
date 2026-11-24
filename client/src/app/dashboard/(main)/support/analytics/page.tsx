"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, Bot, CheckCircle2, Clock3, Gauge, Handshake, MessageSquareReply, Radio, Star, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageErrorState, PageLoadingState } from "@/components/ui/page-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSupportRealtimeRefresh } from "@/hooks/use-support-realtime-refresh";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { SupportCurrentQueue } from '../../../../../../../shared/supportQueueMetrics';

interface SupportAnalytics {
  currentQueue?: SupportCurrentQueue;
  totalTickets: number; openTickets: number; activeTickets: number; waitingOnCustomerTickets: number; resolvedTickets: number;
  avgResolutionHours: number; avgFirstResponseHours: number; slaBreaches: number; handoffs: number; deliveryFailures: number;
  // The API reports 0 when no ticket in the window has a measured time, so 0 means "no data", not an instant response.
  // (see formatHoursOrNoData)
  reviewCount: number; averageRating: number; days: number; priorityDistribution: Record<string, number>;
  statusDistribution: Record<string, number>; ticketsByDay: { date: string; count: number }[];
}

const STATUS_COLORS: Record<string, string> = { open: "bg-info", in_progress: "bg-warning", waiting_on_customer: "bg-primary", resolved: "bg-success", closed: "bg-muted-foreground/60" };
const PRIORITY_COLORS: Record<string, string> = { low: "bg-muted-foreground/60", medium: "bg-warning", high: "bg-info", urgent: "bg-destructive", critical: "bg-destructive" };

/** Zero means no measured time in the window; show that instead of an instant "0.0h". */
function formatHoursOrNoData(hours: number): string {
  return Number.isFinite(hours) && hours > 0 ? `${hours.toFixed(1)}h` : "No data yet";
}

export default function SupportAnalyticsPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [days, setDays] = useState("30");
  const [analytics, setAnalytics] = useState<SupportAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchAnalytics = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    setLoadError(null);
    try { setAnalytics(await api.get<SupportAnalytics>(`/api/support/analytics?days=${days}`)); }
    catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load analytics";
      setLoadError(message); if (showLoader) toast({ title: "Analytics unavailable", description: message, variant: "destructive" });
    } finally { if (showLoader) setLoading(false); }
  }, [days, toast]);
  const refresh = useCallback(() => fetchAnalytics(false), [fetchAnalytics]);
  const { isRealtimeConnected } = useSupportRealtimeRefresh(refresh, 60_000);
  useEffect(() => { void fetchAnalytics(); }, [fetchAnalytics]);

  const series = useMemo(() => {
    const values = analytics?.ticketsByDay || [];
    const max = Math.max(1, ...values.map((item) => item.count));
    return { values, max };
  }, [analytics]);

  if (loading) return <PageLoadingState label="Loading support analytics…" />;
  if (loadError || !analytics) return <PageErrorState title="Support analytics could not be loaded" description={loadError || "The analytics response was empty."} reset={() => void fetchAnalytics()} />;

  const resolutionRate = analytics.totalTickets ? Math.round((analytics.resolvedTickets / analytics.totalTickets) * 100) : 0;
  const queue = analytics.currentQueue;
  const slaRate = queue?.ticketsWithSla ? Math.max(0, Math.round(((queue.ticketsWithSla - queue.slaBreaches) / queue.ticketsWithSla) * 100)) : null;

  return <div className="mx-auto max-w-screen-2xl space-y-5 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-center gap-3"><Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Back to support tickets" onClick={() => router.push("/dashboard/support")}><ArrowLeft className="h-4 w-4" /></Button><div><div className="flex items-center gap-2"><h1 className="text-base font-semibold">Support operations analytics</h1><span className={cn("flex items-center gap-1 text-[10px]", isRealtimeConnected ? "text-success" : "text-muted-foreground")}><Radio className="h-3 w-3" />{isRealtimeConnected ? "Live" : "Polling"}</span></div><p className="mt-0.5 text-xs text-muted-foreground">Truthful queue, response, handoff, delivery, and customer outcome signals</p></div></div><Select value={days} onValueChange={setDays}><SelectTrigger aria-label="Analytics date range" className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="7">Last 7 days</SelectItem><SelectItem value="30">Last 30 days</SelectItem><SelectItem value="90">Last 90 days</SelectItem><SelectItem value="365">Last year</SelectItem></SelectContent></Select></div>

    <div className="grid overflow-hidden rounded-2xl border border-border/60 bg-card sm:grid-cols-2 xl:grid-cols-6">
      {[
        { label: "Active queue", value: queue?.activeTickets ?? '—', detail: queue ? `${queue.waitingOnCustomerTickets} waiting · all dates` : 'Queue totals unavailable', icon: Clock3, tone: "text-info" },
        { label: "First response", value: formatHoursOrNoData(analytics.avgFirstResponseHours), detail: analytics.avgFirstResponseHours > 0 ? "average" : "No replies measured in this period", icon: MessageSquareReply, tone: "text-primary" },
        { label: "Resolution", value: `${resolutionRate}%`, detail: `${analytics.resolvedTickets} resolved`, icon: CheckCircle2, tone: "text-success" },
        // SLA health is hidden when no open ticket has an SLA; a 0% reading is only shown with its breakdown.
        ...(queue && slaRate !== null && queue.ticketsWithSla
          ? [{ label: "SLA met (open queue)", value: `${slaRate}%`, detail: `${queue.ticketsWithSla - queue.slaBreaches} of ${queue.ticketsWithSla} SLA tickets within target · ${queue.slaBreaches} breached`, icon: Gauge, tone: queue.slaBreaches ? "text-destructive" : "text-success" }]
          : []),
        { label: "Handoffs", value: analytics.handoffs, detail: "human escalations", icon: Handshake, tone: "text-warning" },
        { label: "Delivery issues", value: analytics.deliveryFailures, detail: "failed or uncertain", icon: AlertTriangle, tone: "text-destructive" },
      ].map((metric) => <div key={metric.label} className="border-b border-r border-border/50 p-4 last:border-r-0 xl:border-b-0"><div className="flex items-start justify-between"><div><p className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{metric.label}</p><p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{metric.value}</p><p className="text-xs text-muted-foreground">{metric.detail}</p></div><metric.icon className={cn("h-4 w-4", metric.tone)} /></div></div>)}
    </div>

    <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
      <TicketIntakeCard values={series.values} max={series.max} />
      <Card className="rounded-2xl border-border/60 shadow-none"><CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Star className="h-4 w-4 text-warning" />Customer outcome</CardTitle></CardHeader><CardContent className="space-y-4"><div className="rounded-xl bg-muted/40 p-4"><p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Average rating</p><p className="mt-1 font-mono text-3xl font-semibold">{analytics.reviewCount ? analytics.averageRating.toFixed(1) : "No data yet"}{analytics.reviewCount ? <span className="ml-1 text-sm text-muted-foreground">/ 5</span> : null}</p><p className="text-xs text-muted-foreground">{analytics.reviewCount} submitted review{analytics.reviewCount === 1 ? "" : "s"}</p></div><div className="rounded-xl border border-border/60 p-4"><p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Average resolution time</p><p className="mt-1 font-mono text-2xl font-semibold">{formatHoursOrNoData(analytics.avgResolutionHours)}</p></div></CardContent></Card>
    </div>

    <div className="grid gap-4 lg:grid-cols-2">
      <Distribution title="Status mix" values={analytics.statusDistribution} total={analytics.totalTickets} colors={STATUS_COLORS} icon={<Bot className="h-4 w-4 text-primary" />} />
      <Distribution title="Priority mix" values={analytics.priorityDistribution} total={analytics.totalTickets} colors={PRIORITY_COLORS} icon={<AlertTriangle className="h-4 w-4 text-warning" />} />
    </div>
  </div>;
}

/** Bar chart of tickets created per day, with a y-axis, value labels, a legend and a text summary for screen readers. */
function TicketIntakeCard({ values, max }: { values: { date: string; count: number }[]; max: number }) {
  const total = values.reduce((sum, item) => sum + item.count, 0);
  const first = values[0]?.date;
  const last = values.at(-1)?.date;
  const summary = values.length
    ? `${total} ticket${total === 1 ? "" : "s"} created from ${first} to ${last}. Peak day ${values.reduce((best, item) => (item.count > best.count ? item : best), values[0]).date} with ${max} ticket${max === 1 ? "" : "s"}.`
    : "No tickets were created in this period.";
  const ticks = [max, Math.round(max / 2), 0];
  const showValueLabels = values.length <= 31;
  return <Card className="rounded-2xl border-border/60 shadow-none">
    <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><TrendingUp className="h-4 w-4 text-primary" />Ticket intake</CardTitle>
      <p className="text-xs text-muted-foreground">Tickets created per day in the selected range</p></CardHeader>
    <CardContent>
      {values.length === 1 ? <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/10 text-center"><p className="font-mono text-3xl font-semibold tabular-nums">{values[0].count}</p><p className="mt-1 text-xs text-muted-foreground">ticket{values[0].count === 1 ? "" : "s"} created on {values[0].date}</p></div> : values.length === 0 ? <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/10 text-xs text-muted-foreground">No ticket intake in this period</div> : <>
        <div className="flex gap-2">
          <div aria-hidden="true" className="flex h-56 flex-col justify-between pb-6 text-right font-mono text-[10px] text-muted-foreground">{ticks.map((tick, index) => <span key={index}>{tick}</span>)}</div>
          <div className="relative flex-1">
            <div role="img" aria-label={summary} className="flex h-56 items-end gap-1 border-b border-l border-border/60 pb-0 pl-1">
              {values.map((item) => <div key={item.date} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${item.date}: ${item.count} ticket${item.count === 1 ? "" : "s"}`}>
                {showValueLabels ? <span aria-hidden="true" className="mb-0.5 text-center font-mono text-[9px] text-muted-foreground">{item.count || ""}</span> : null}
                <div className={cn("w-full min-w-1 rounded-t-sm transition", item.count ? "bg-primary hover:bg-primary/80" : "bg-muted")} style={{ height: `${item.count ? Math.max(4, (item.count / max) * 100) : 1}%` }} />
              </div>)}
            </div>
            <div aria-hidden="true" className="mt-1 flex justify-between text-[10px] text-muted-foreground"><span>{first}</span><span>{last}</span></div>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground"><span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm bg-primary" />Tickets created (one bar per day, value shown above the bar)</div>
        <p className="sr-only">{summary}</p>
      </>}
    </CardContent>
  </Card>;
}

function Distribution({ title, values, total, colors, icon }: { title: string; values: Record<string, number>; total: number; colors: Record<string, string>; icon: React.ReactNode }) {
  return <Card className="rounded-2xl border-border/60 shadow-none"><CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm">{icon}{title}</CardTitle></CardHeader><CardContent className="space-y-3">{Object.entries(values).length ? Object.entries(values).map(([key, count]) => { const percent = total ? (count / total) * 100 : 0; return <div key={key} className="space-y-1"><div className="flex justify-between text-xs"><span className="capitalize">{key.replaceAll("_", " ")}</span><span className="font-mono">{count} · {percent.toFixed(0)}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full", colors[key] || "bg-primary")} style={{ width: `${percent}%` }} /></div></div>; }) : <p className="py-6 text-center text-xs text-muted-foreground">No data in this period</p>}</CardContent></Card>;
}
