"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  BarChart3, CheckCircle2,
  Ticket, Zap, Activity,
  PieChart
} from "lucide-react";
import { useSupportAuth } from "@/contexts/SupportAuthContext";
import { supportApi } from "@/lib/support-api";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import { LoadingState } from "@/components/ui/loading-state";
import { PageErrorState } from "@/components/ui/page-state";

interface Stats {
  total: number;
  open: number;
  inProgress: number;
  waitingOnCustomer: number;
  resolved: number;
  closed: number;
  handoffVolume: number;
  avgClaimMinutes: number;
  avgHumanMinutes: number;
  aiResumeRate: number;
}

export default function SupportAnalytics() {
  const router = useRouter();
  const { toast } = useToast();
  const { isAuthenticated, isLoading: authLoading } = useSupportAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const fetchStats = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await supportApi.get<Stats>("/api/support-portal/stats");
      setStats(data);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
      toast({ title: "Error", description: "Failed to load analytics data", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) router.push("/support/login");
    if (isAuthenticated) fetchStats();
  }, [authLoading, isAuthenticated, router, fetchStats]);

  if (authLoading || (isAuthenticated && isLoading)) {
    return <LoadingState label="Loading support analytics…" />;
  }
  // A failed load must not read as "0 tickets".
  if (loadFailed && !stats) {
    return <PageErrorState title="Support analytics could not be loaded" description="The request did not complete. Please try again." reset={() => void fetchStats()} />;
  }

  const activeTickets = (stats?.open ?? 0) + (stats?.inProgress ?? 0) + (stats?.waitingOnCustomer ?? 0);
  const completedTickets = (stats?.resolved ?? 0) + (stats?.closed ?? 0);
  const completionRate = stats?.total ? Math.round((completedTickets / stats.total) * 100) : 0;

  const kpiCards: Array<{ label: string; value: number; icon: React.ComponentType<{ className?: string }>; color: string; bg: string }> = [
    { label: "Total Tickets", value: stats?.total ?? 0, icon: Ticket, color: "text-primary", bg: "bg-primary/10" },
    { label: "Active", value: activeTickets, icon: Activity, color: "text-info", bg: "bg-info/10" },
    { label: "Resolved", value: stats?.resolved ?? 0, icon: CheckCircle2, color: "text-success", bg: "bg-success/10" },
    { label: "Closed", value: stats?.closed ?? 0, icon: Zap, color: "text-warning", bg: "bg-warning/10" },
  ];

  const distribution = [
    { label: "Open", value: stats?.open ?? 0, color: "bg-info" },
    { label: "In progress", value: stats?.inProgress ?? 0, color: "bg-warning" },
    { label: "Waiting on customer", value: stats?.waitingOnCustomer ?? 0, color: "bg-primary" },
    { label: "Resolved", value: stats?.resolved ?? 0, color: "bg-success" },
    { label: "Closed", value: stats?.closed ?? 0, color: "bg-muted-foreground/60" },
  ];

  return (
    <div className="space-y-5 max-w-screen-xl mx-auto">
      {/* Header */}
      <PageHeader
        icon={BarChart3}
        title="My performance"
        subtitle="Ticket workload and outcomes assigned to you"
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpiCards.map((s, i) => (
          <Card key={i} className="border border-border/50 rounded-xl shadow-none">
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0", s.bg)}>
                  <s.icon className={cn("w-4 h-4", s.color)} />
                </div>
              </div>
              <p className="text-2xl font-bold mt-2 leading-tight">{s.value}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{s.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Distribution */}
        <Card className="border border-border/50 rounded-xl shadow-none">
          <CardHeader className="px-5 pt-5 pb-4 border-b border-border/30">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <PieChart className="w-4 h-4" /> Ticket Distribution
            </CardTitle>
          </CardHeader>
          <CardContent className="p-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                {distribution.map((item, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={cn("w-2.5 h-2.5 rounded-full flex-shrink-0", item.color)} />
                      <span className="text-xs text-muted-foreground">{item.label}</span>
                    </div>
                    <span className="text-sm font-semibold">{item.value}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col items-center justify-center">
                <div className="w-28 h-28 rounded-full border-[10px] border-muted flex flex-col items-center justify-center">
                  <span className="text-xl font-bold">{stats?.total ?? 0}</span>
                  <span className="text-xs text-muted-foreground">Total</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Completion snapshot */}
        <Card className="border border-border/50 rounded-xl shadow-none">
          <CardHeader className="px-5 pt-5 pb-4 border-b border-border/30">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> Workload completion
            </CardTitle>
          </CardHeader>
          <CardContent className="p-5">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-3xl font-bold">{completionRate}%</p>
                <p className="mt-1 text-xs text-muted-foreground">Resolved or closed</p>
              </div>
              <p className="text-right text-xs text-muted-foreground">
                {completedTickets} completed<br />{activeTickets} active
              </p>
            </div>
            <div className="mt-5 h-2 overflow-hidden rounded-full bg-muted" aria-label={`${completionRate}% workload completion`}>
              <div className="h-full rounded-full bg-success transition-[width]" style={{ width: `${completionRate}%` }} />
            </div>
            <div className="mt-5 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-info/10 p-3"><p className="text-lg font-semibold">{activeTickets}</p><p className="text-[11px] text-muted-foreground">Active</p></div>
              <div className="rounded-lg bg-success/10 p-3"><p className="text-lg font-semibold">{stats?.resolved ?? 0}</p><p className="text-[11px] text-muted-foreground">Resolved</p></div>
              <div className="rounded-lg bg-muted p-3"><p className="text-lg font-semibold">{stats?.closed ?? 0}</p><p className="text-[11px] text-muted-foreground">Closed</p></div>
            </div>
          </CardContent>
        </Card>
      </div>
      <Card className="rounded-xl border border-border/50 shadow-none">
        <CardHeader className="border-b border-border/30 px-5 pb-4 pt-5"><CardTitle className="flex items-center gap-2 text-sm"><Activity className="h-4 w-4" />AI handoff operations</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 p-5 lg:grid-cols-4">
          {[{ label: "Handoff volume", value: stats?.handoffVolume ?? 0, suffix: "" }, { label: "Average claim", value: stats?.avgClaimMinutes ?? 0, suffix: " min" }, { label: "Human-owned time", value: stats?.avgHumanMinutes ?? 0, suffix: " min" }, { label: "AI resumed", value: stats?.aiResumeRate ?? 0, suffix: "%" }].map((metric) => <div key={metric.label} className="rounded-xl border border-border/50 bg-muted/20 p-4"><p className="text-xl font-bold">{metric.value}{metric.suffix}</p><p className="mt-1 text-xs text-muted-foreground">{metric.label}</p></div>)}
        </CardContent>
      </Card>
    </div>
  );
}
