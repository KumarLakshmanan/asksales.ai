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
  Globe,
  Hash,
  Coins,
  Clock,
  Activity,
} from "lucide-react";
import { formatShortDateTime as formatDate } from "@/lib/display-format";
import { type LlmRecentActivity as RecentActivity } from "../activity-types";

interface UsageSummary {
  totalCalls: number;
  totalTokens: number | null;
  totalCost: number | null;
  avgLatency: number | null;
}

interface ModelBreakdown {
  model: string;
  calls: number;
  tokens: number | null;
  cost: number | null;
}

interface LLMProviderResponse {
  summary?: UsageSummary;
  breakdown?: ModelBreakdown[];
  recentActivity?: RecentActivity[];
  activity?: RecentActivity[];
  recent?: RecentActivity[];
  modelBreakdown?: ModelBreakdown[];
  totalCalls?: number;
  totalTokens?: number | null;
  totalCost?: number | null;
  avgLatency?: number | null;
}

const TIME_RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

export default function OpenRouterUsagePage() {
  const [summary, setSummary] = useState<UsageSummary>({
    totalCalls: 0,
    totalTokens: 0,
    totalCost: 0,
    avgLatency: 0,
  });
  const [breakdown, setBreakdown] = useState<ModelBreakdown[]>([]);
  const [activity, setActivity] = useState<RecentActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState("30");
  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const params = new URLSearchParams({
        provider: "openrouter",
        days: timeRange,
      });
      const data = await api.get<LLMProviderResponse>(`/api/admin/usage/llm?${params.toString()}`);

      setSummary(
        data.summary || {
          totalCalls: data.totalCalls || 0,
          totalTokens: data.totalTokens ?? null,
          totalCost: data.totalCost ?? null,
          avgLatency: data.avgLatency ?? null,
        }
      );
      setBreakdown(data.breakdown || data.modelBreakdown || []);
      setActivity(data.recentActivity || data.activity || data.recent || []);
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
    return (
      <LoadingState size="page" label="Loading OpenRouter usage…" />
    );
  }

  if (loadError) return <PageErrorState title="OpenRouter usage could not be loaded" description={loadError} reset={() => void fetchData()} />;

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
            <Globe className="h-8 w-8 text-purple-600" />
            OpenRouter Usage
          </h1>
          <p className="text-muted-foreground mt-1">
            Monitor multi-model routing usage and costs
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
          label="Total Calls"
          icon={<Hash className="text-purple-600" />}
          value={summary.totalCalls.toLocaleString()}
        />
        <StatCard
          label="Total Tokens"
          icon={<Activity className="text-blue-600" />}
          value={summary.totalTokens?.toLocaleString() ?? "Unavailable"}
        />
        <StatCard
          label="Total Cost"
          icon={<Coins className="text-amber-600" />}
          value={summary.totalCost == null ? "Unavailable" : `$${summary.totalCost.toFixed(2)}`}
        />
        <StatCard
          label="Avg Latency"
          icon={<Clock className="text-purple-600" />}
          value={summary.avgLatency == null ? "Unavailable" : `${summary.avgLatency.toFixed(0)}ms`}
        />
      </StatGrid>

      {/* Model Breakdown */}
      {breakdown.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Breakdown by Model</CardTitle>
            <CardDescription>
              Usage distribution across routed models
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {breakdown.map((item, idx) => (
                    <TableRow key={idx}>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className="bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400"
                        >
                          {item.model}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {item.calls.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.tokens?.toLocaleString() ?? "Unavailable"}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.cost == null ? "Unavailable" : `$${item.cost.toFixed(4)}`}
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
          <CardDescription>Latest API calls via OpenRouter</CardDescription>
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
                    <TableHead>Model</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Latency</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activity.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {item.model || "—"}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[150px] truncate">
                        {item.purpose || "—"}
                      </TableCell>
                      <TableCell>
                        {item.userName || item.user_name || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.tokens?.toLocaleString() || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.cost != null ? `${item.cost == null ? "Unavailable" : `$${item.cost.toFixed(4)}`}` : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.latency != null ? `${item.latency}ms` : "—"}
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
