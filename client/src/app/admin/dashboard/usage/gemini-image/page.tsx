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
  Image,
  Hash,
  Coins,
  CheckCircle,
} from "lucide-react";
import { formatShortDateTime as formatDate } from "@/lib/display-format";
import { type MediaRecentActivity as RecentActivity } from "../activity-types";

interface GeminiImageSummary {
  totalCalls: number;
  totalImages: number;
  totalCost: number | null;
  successRate: number;
}

interface ModelBreakdown {
  model: string;
  calls: number;
  tokens: number | null;
  cost: number | null;
}

interface GeminiApiResponse {
  summary?: { totalCalls?: number; totalRequests?: number; totalImages?: number; totalCost?: number | null; totalCostCents?: number | null; successRate?: number };
  breakdown?: ModelBreakdown[];
  recentActivity?: RecentActivity[];
}

const TIME_RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

export default function GeminiImageUsagePage() {
  const [summary, setSummary] = useState<GeminiImageSummary>({ totalCalls: 0, totalImages: 0, totalCost: 0, successRate: 0 });
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
      const params = new URLSearchParams({ days: timeRange, operationType: "image_generation" });
      const data = await api.get<GeminiApiResponse>(`/api/admin/usage/gemini?${params.toString()}`);

      setSummary({
        totalCalls: data.summary?.totalCalls || data.summary?.totalRequests || 0,
        totalImages: data.summary?.totalImages || 0,
        totalCost: data.summary?.totalCost ?? (data.summary?.totalCostCents == null ? null : data.summary.totalCostCents / 100),
        successRate: data.summary?.successRate || 0,
      });
      setBreakdown(data.breakdown || []);
      setActivity(data.recentActivity || []);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to load data";
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
      <LoadingState size="page" label="Loading Gemini image usage…" />
    );
  }

  if (loadError) return <PageErrorState title="Gemini image usage could not be loaded" description={loadError} reset={() => void fetchData()} />;

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
            <Image className="h-8 w-8 text-pink-600" />
            Gemini Image Generation Usage
          </h1>
          <p className="text-muted-foreground mt-1">
            Track AI image generation via Google Gemini
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
          label="Total Requests"
          icon={<Hash className="text-pink-600" />}
          value={summary.totalCalls.toLocaleString()}
        />
        <StatCard
          label="Images Generated"
          icon={<Image className="text-purple-600" />}
          value={summary.totalImages.toLocaleString()}
        />
        <StatCard
          label="Total Cost"
          icon={<Coins className="text-amber-600" />}
          value={summary.totalCost == null ? "Unavailable" : `$${summary.totalCost.toFixed(2)}`}
        />
        <StatCard
          label="Success Rate"
          icon={<CheckCircle className="text-green-600" />}
          value={`${summary.successRate.toFixed(1)}%`}
        />
      </StatGrid>

      {/* Model Breakdown */}
      {breakdown.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Breakdown by Model</CardTitle>
            <CardDescription>Image generation models used</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {breakdown.map((item, idx) => (
                    <TableRow key={idx}>
                      <TableCell>
                        <Badge variant="outline" className="bg-pink-50 text-pink-700 dark:bg-pink-900/20 dark:text-pink-400">
                          {item.model}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{item.calls.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{item.cost == null ? "Unavailable" : `$${item.cost.toFixed(4)}`}</TableCell>
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
          <CardTitle>Recent Image Generations</CardTitle>
          <CardDescription>Latest Gemini image generation requests</CardDescription>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">No recent image generation activity</p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activity.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <Badge variant="outline">{item.model || "—"}</Badge>
                      </TableCell>
                      <TableCell className="max-w-[150px] truncate">
                        {item.purpose ? item.purpose.replace(/_/g, " ") : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span>{item.userName || "—"}</span>
                          {item.userEmail && (
                            <span className="text-xs text-muted-foreground">{item.userEmail}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {item.cost != null ? `${item.cost == null ? "Unavailable" : `$${item.cost.toFixed(4)}`}` : "—"}
                      </TableCell>
                      <TableCell>{formatDate(item.createdAt)}</TableCell>
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
