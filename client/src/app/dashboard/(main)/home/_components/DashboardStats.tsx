"use client";

import React from "react";
import { formatReportingMoney } from "@/lib/reportingMoney";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart3, Users, TrendingUp, Banknote } from "lucide-react";

interface DashboardStatsData {
  totalLeads: number;
  newLeads: number;
  activeCampaigns: number;
  completedCampaigns: number;
  totalSpent: number | null;
  totalBudget: number | null;
  currency?: string | null;
  spendByCurrency?: Record<string,number>;
  budgetByCurrencyAndType?: Array<{currency:string;type:string;amount:number}>;
  conversionRate: string | null;
  recordedWins?: { rate: string | null };
}

interface DashboardStatsProps {
  stats: DashboardStatsData | null;
  isLoading: boolean;
}

export const DashboardStats = React.memo(function DashboardStats({ stats, isLoading }: DashboardStatsProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Total leads</CardTitle>
          <Users className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {isLoading ? <Skeleton className="h-8 w-20" /> : <div className="text-2xl font-semibold tabular-nums tracking-tight">{stats?.totalLeads || 0}</div>}
          <p className="text-xs text-muted-foreground mt-1">{stats?.newLeads || 0} new leads</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Active campaigns</CardTitle>
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {isLoading ? <Skeleton className="h-8 w-16" /> : <div className="text-2xl font-semibold tabular-nums tracking-tight">{stats?.activeCampaigns || 0}</div>}
          <p className="text-xs text-muted-foreground mt-1">{stats?.completedCampaigns || 0} completed</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Recorded CRM win rate</CardTitle>
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {isLoading ? <Skeleton className="h-8 w-16" /> : <div className="text-2xl font-semibold tabular-nums tracking-tight">{stats?.recordedWins?.rate != null ? `${stats.recordedWins.rate}%` : '—'}</div>}
          <p className="text-xs text-muted-foreground mt-1">From canonical CRM contacts</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Total spent</CardTitle>
          <Banknote className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          {isLoading ? <Skeleton className="h-8 w-24" /> : <div className="text-2xl font-semibold tabular-nums tracking-tight">{formatReportingMoney(stats?.spendByCurrency,stats?.totalSpent,stats?.currency)}</div>}
          <p className="text-xs text-muted-foreground mt-1">{stats?.budgetByCurrencyAndType?.length ? stats.budgetByCurrencyAndType.map(row=>`${formatReportingMoney({[row.currency]:row.amount})} ${row.type}`).join(" · ") : "Budget currency unavailable"}</p>
        </CardContent>
      </Card>
    </div>
  );
});
