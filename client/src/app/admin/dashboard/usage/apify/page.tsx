"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { PageErrorState } from "@/components/ui/page-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  ArrowLeft,
  Server,
  Hash,
  Coins,
  Clock,
  Database,
} from "lucide-react";
import { formatShortDateTime as formatDate } from "@/lib/display-format";

interface UsageSummary {
  totalRuns: number;
  totalItems: number;
  totalCost: number;
  avgDuration: number;
}

interface ActorBreakdown {
  actor: string;
  runs: number;
  items: number;
  cost: number;
}

interface RecentActivity {
  id: number;
  actor?: string;
  actorName?: string;
  actor_name?: string;
  items?: number;
  cost?: number;
  duration?: number;
  status?: string;
  userName?: string;
  user_name?: string;
  createdAt?: string;
  created_at?: string;
}

interface ApifySummary {
  totalRuns?: number;
  totalItemsScraped?: number;
  totalItems?: number;
  totalCostCents?: number;
  totalCost?: number;
  byActor?: Record<string, { runs: number; items: number; costCents: number }>;
}

interface ApifyUsageResponse {
  records?: Array<{ id?: number; actorName?: string; actorId?: string; responseSuccess?: number; userName?: string; itemsScraped?: number; estimatedCostCents?: number; durationMs?: number; createdAt?: string }>;
  summary?: ApifySummary;
  breakdown?: ActorBreakdown[];
  recentActivity?: RecentActivity[];
}

const TIME_RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

/** Apify run states the shared status map doesn't cover. */
const APIFY_STATUS_TONES: Record<string, StatusTone> = { aborted: "warning" };

export default function ApifyUsagePage() {
  const [summary, setSummary] = useState<UsageSummary>({
    totalRuns: 0,
    totalItems: 0,
    totalCost: 0,
    avgDuration: 0,
  });
  const [breakdown, setBreakdown] = useState<ActorBreakdown[]>([]);
  const [activity, setActivity] = useState<RecentActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState("30");
  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const params = new URLSearchParams({ days: timeRange });
      const data = await api.get<ApifyUsageResponse>(`/api/admin/usage/apify?${params.toString()}`);

      // Server returns: { records, summary: { totalRuns, totalItemsScraped, totalComputeUnits, totalCostCents, successRate, byActor, byPurpose, byDay } }
      const s = data.summary || {};
      const totalDurationMs = (data.records || []).reduce((sum: number, r: { durationMs?: number }) => sum + (r.durationMs || 0), 0);
      const avgDuration = (data.records || []).length > 0 ? totalDurationMs / (data.records || []).length / 1000 : 0;

      setSummary({
        totalRuns: s.totalRuns || 0,
        totalItems: s.totalItemsScraped || s.totalItems || 0,
        totalCost: s.totalCostCents != null ? s.totalCostCents / 100 : (s.totalCost || 0),
        avgDuration,
      });

      // Transform byActor record into breakdown array
      const byActor = s.byActor || {} as Record<string, { runs: number; items: number; costCents: number }>;
      const actorBreakdown: ActorBreakdown[] = Object.entries(byActor).map(([actor, stats]) => {
        const st = stats as { runs: number; items: number; costCents: number };
        return {
          actor,
          runs: st.runs || 0,
          items: st.items || 0,
          cost: (st.costCents || 0) / 100,
        };
      }).sort((a, b) => b.runs - a.runs);
      setBreakdown(data.breakdown || actorBreakdown);

      // Transform records into recent activity
      const records = (data.records || []).slice(0, 100);
      const recentAct: RecentActivity[] = records.map((r, idx) => ({
        id: r.id ?? idx,
        actorName: r.actorName || r.actorId || '',
        status: r.responseSuccess === 1 ? 'succeeded' : 'failed',
        userName: r.userName || '',
        items: r.itemsScraped || 0,
        cost: (r.estimatedCostCents || 0) / 100,
        duration: r.durationMs ? Math.round(r.durationMs / 1000) : undefined,
        createdAt: r.createdAt,
      }));
      setActivity(data.recentActivity || recentAct);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load data";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [timeRange, toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return <LoadingState size="page" label="Loading Apify usage…" />;
  }

  if (loadError) return <PageErrorState title="Apify usage could not be loaded" description={loadError} reset={() => void fetchData()} />;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-4">
        <Link href="/admin/dashboard/usage">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-black tracking-tighter flex items-center gap-2">
            <Server className="h-8 w-8 text-emerald-600" />
            Apify Usage
          </h1>
          <p className="text-muted-foreground mt-1">
            Monitor actor runs, scraped items, and compute usage
          </p>
        </div>
        <Select value={timeRange} onValueChange={setTimeRange}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIME_RANGES.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Summary Cards */}
      <StatGrid columns={4}>
        <StatCard
          label="Total Runs"
          icon={<Hash className="text-emerald-600" />}
          value={summary.totalRuns.toLocaleString()}
        />
        <StatCard
          label="Items Scraped"
          icon={<Database className="text-blue-600" />}
          value={summary.totalItems.toLocaleString()}
        />
        <StatCard
          label="Total Cost"
          icon={<Coins className="text-amber-600" />}
          value={`$${summary.totalCost.toFixed(2)}`}
        />
        <StatCard
          label="Avg Duration"
          icon={<Clock className="text-purple-600" />}
          value={`${summary.avgDuration.toFixed(0)}s`}
        />
      </StatGrid>

      {/* Actor Breakdown */}
      {breakdown.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Breakdown by Actor</CardTitle>
            <CardDescription>
              Usage distribution across Apify actors
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Actor</TableHead>
                    <TableHead className="text-right">Runs</TableHead>
                    <TableHead className="text-right">Items</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {breakdown.map((item, idx) => (
                    <TableRow key={idx}>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className="bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                        >
                          {item.actor}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {item.runs.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.items.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        ${item.cost.toFixed(4)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Activity */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Latest actor runs</CardDescription>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              No recent activity
            </p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Actor</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead className="text-right">Items</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activity.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="max-w-[150px] truncate">
                        {item.actorName || item.actor_name || item.actor || "—"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={item.status} toneOverrides={APIFY_STATUS_TONES} />
                      </TableCell>
                      <TableCell>
                        {item.userName || item.user_name || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.items?.toLocaleString() || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.cost != null ? `$${item.cost.toFixed(4)}` : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.duration != null ? `${item.duration}s` : "—"}
                      </TableCell>
                      <TableCell>
                        {formatDate(item.createdAt || item.created_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
