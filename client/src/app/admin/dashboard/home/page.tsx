"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Users,
  Shield,
  Activity,
  Target,
  Plus,
  Settings,
  BarChart3,
  ArrowUpRight,
  ScrollText,
  Webhook,
  ListTodo,
  Lock,
} from "lucide-react";
import { PageErrorState } from "@/components/ui/page-state";
import { useAdminAuth } from "@/contexts/AdminAuthContext";
import { LoadingState } from "@/components/ui/loading-state";

interface DashboardStats {
  totalUsers: number;
  totalAdmins: number;
  systemHealth: string;
  totalLeads: number;
  totalCampaigns: number;
}

export default function DashboardHomePage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { toast } = useToast();
  const { admin } = useAdminAuth();
  const isSuperAdmin = admin?.role === "super_admin";

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<DashboardStats>("/api/admin/dashboard/stats");
      setStats(data);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to load dashboard stats";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void fetchStats(); }, [fetchStats]);

  const statCards = [
    {
      title: "Total Users",
      value: typeof stats?.totalUsers === "number" && Number.isFinite(stats.totalUsers) && stats.totalUsers >= 0 ? stats.totalUsers : "Unavailable",
      icon: Users,
      note: "Registered workspaces",
    },
    {
      title: "Total Admins",
      value: typeof stats?.totalAdmins === "number" && Number.isFinite(stats.totalAdmins) && stats.totalAdmins >= 0 ? stats.totalAdmins : "Unavailable",
      icon: Shield,
      note: "Administrative accounts",
    },
    {
      title: "System Health",
      value: typeof stats?.systemHealth === "string" && stats.systemHealth.trim() ? stats.systemHealth : "Unavailable",
      icon: Activity,
      note: "Reported by the stats API",
    },
    {
      title: "Active Leads",
      value: typeof stats?.totalLeads === "number" && Number.isFinite(stats.totalLeads) && stats.totalLeads >= 0 ? stats.totalLeads : "Unavailable",
      icon: Target,
      note: "Persisted lead records",
    },
    {
      title: "Campaigns",
      value: typeof stats?.totalCampaigns === "number" && Number.isFinite(stats.totalCampaigns) && stats.totalCampaigns >= 0 ? stats.totalCampaigns : "Unavailable",
      icon: BarChart3,
      note: "Campaigns managed by the platform",
    },
  ];

  const quickActions = [
    {
      label: "Manage Users",
      href: "/admin/dashboard/users",
      icon: Users,
      description: "View and manage all users",
      superAdminOnly: false,
    },
    {
      label: "Create Admin",
      href: "/admin/dashboard/admins/new",
      icon: Plus,
      description: "Provision an administrator account",
      superAdminOnly: true,
    },
    {
      label: "View Leads",
      href: "/admin/dashboard/master-database",
      icon: Target,
      description: "Browse master lead database",
      superAdminOnly: false,
    },
    {
      label: "System Settings",
      href: "/admin/dashboard/settings",
      icon: Settings,
      description: "Configure system settings",
      superAdminOnly: false,
    },
  ];

  if (loading) {
    return (
      <LoadingState size="page" label="Loading dashboard…" />
    );
  }

  if (loadError || !stats) {
    return <PageErrorState title="Dashboard metrics could not be loaded" description={loadError || "The dashboard returned no data."} reset={() => void fetchStats()} />;
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <div className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Platform control</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Administration overview</h1>
          <p className="mt-2 text-sm text-muted-foreground">Live totals and direct paths to operational records.</p>
        </div>
        <Link href="/admin/dashboard/system-logs" className="inline-flex h-10 items-center gap-2 rounded-md border border-border px-4 text-sm font-medium hover:bg-muted">System logs<ArrowUpRight className="h-4 w-4" /></Link>
      </div>

      <div className="grid border-l border-t border-border sm:grid-cols-2 xl:grid-cols-5">
        {statCards.map((card) => (
          <Card key={card.title} className="rounded-none border-b border-r border-l-0 border-t-0 shadow-none">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.title}
              </CardTitle>
              <card.icon className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="font-mono text-2xl font-semibold tabular-nums">{card.value}</div>
              <p className="mt-2 text-xs text-muted-foreground">{card.note}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="mb-4 text-lg font-semibold">Common operations</h2>
        <div className="divide-y divide-border border-y border-border">
          {quickActions.map((action) => (
            action.superAdminOnly && !isSuperAdmin ? (
              <div key={action.label} aria-disabled="true" title="Only super admins can create administrator accounts." className="grid cursor-not-allowed gap-3 py-4 opacity-75 sm:grid-cols-[36px_220px_1fr_auto] sm:items-center">
                <action.icon className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{action.label}</span>
                <span className="text-sm text-muted-foreground">{action.description}</span>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Lock className="h-3.5 w-3.5" />Requires super admin</span>
              </div>
            ) : (
              <Link key={action.label} href={action.href} className="group grid gap-3 py-4 sm:grid-cols-[36px_220px_1fr_24px] sm:items-center">
                <action.icon className="h-4 w-4 text-primary" />
                <span className="font-medium">{action.label}</span>
                <span className="text-sm text-muted-foreground">{action.description}</span>
                <ArrowUpRight className="hidden h-4 w-4 text-muted-foreground group-hover:text-foreground sm:block" />
              </Link>
            )
          ))}
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-lg font-semibold">Operational records</h2>
        <div className="grid gap-px border border-border bg-border sm:grid-cols-3">
          {[
            { icon: ScrollText, label: "System logs", description: "Application and worker events", href: "/admin/dashboard/system-logs", superAdminOnly: false },
            { icon: Webhook, label: "Webhook logs", description: "Provider callbacks and receipts", href: "/admin/dashboard/webhook-logs", superAdminOnly: false },
            { icon: ListTodo, label: "Queues", description: "Queued and stalled work", href: "/admin/dashboard/queues", superAdminOnly: true },
          ].map((item) => {
            const Icon = item.icon;
            const locked = item.superAdminOnly && !isSuperAdmin;
            const content = <><Icon className={`h-4 w-4 ${locked ? "text-muted-foreground" : "text-primary"}`} /><p className="mt-4 font-medium">{item.label}</p><p className="mt-1 text-xs text-muted-foreground">{item.description}</p>{locked && <p className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Lock className="h-3.5 w-3.5" />Requires super admin</p>}</>;
            return locked ? (
              <div key={item.label} aria-disabled="true" title="Only super admins can inspect queue operations." className="cursor-not-allowed bg-background p-5 opacity-75">{content}</div>
            ) : (
              <Link key={item.label} href={item.href} className="bg-background p-5 hover:bg-muted/40">{content}</Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
