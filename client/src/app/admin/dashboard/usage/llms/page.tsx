"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import { PageErrorState } from "@/components/ui/page-state";
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
  Brain,
  Hash,
  Coins,
  Clock,
  Activity,
  Bot,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { formatShortDateTime as formatDate } from "@/lib/display-format";

interface UsageSummary {
  totalCalls: number;
  totalTokens: number | null;
  totalCost: number | null;
  avgLatency: number | null;
  measuredDurationCount?: number;
  totalDurationMs?: number;
  byPurpose?: Record<string, { calls: number; tokens: number | null; costCents: number | null }>;
}

interface ModelBreakdown {
  model: string;
  calls: number;
  tokens: number | null;
  cost: number | null;
}

interface PurposeBreakdown {
  purpose: string;
  calls: number;
  tokens: number | null;
  costCents: number | null;
}

interface RecentActivity {
  id: number;
  model?: string;
  tokens?: number | null;
  cost?: number | null;
  latency?: number | null;
  purpose?: string;
  threadId?: string | number | null;
  userName?: string;
  user_name?: string;
  userEmail?: string;
  createdAt?: string;
  created_at?: string;
}

const TIME_RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

const PROVIDERS = [
  { value: "all", label: "All Providers" },
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "gemini", label: "Gemini LLM" },
  { value: "custom_ai", label: "Custom API" },
];

interface LlmResponse {
  summary?: UsageSummary;
  breakdown?: ModelBreakdown[];
  recentActivity?: RecentActivity[];
}

const EMPTY_SUMMARY: UsageSummary = {
  totalCalls: 0,
  totalTokens: 0,
  totalCost: 0,
  avgLatency: null,
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The usage request did not complete.";
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400",
  openrouter: "bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400",
  gemini: "bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400",
  custom_ai: "bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400",
};

export default function LLMsUsagePage() {
  const [summary, setSummary] = useState<UsageSummary>({ totalCalls: 0, totalTokens: 0, totalCost: 0, avgLatency: 0 });
  const [breakdown, setBreakdown] = useState<ModelBreakdown[]>([]);
  const [purposeBreakdown, setPurposeBreakdown] = useState<PurposeBreakdown[]>([]);
  const [activity, setActivity] = useState<RecentActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [failedSections, setFailedSections] = useState<string[]>([]);
  const [timeRange, setTimeRange] = useState("30");
  const [provider, setProvider] = useState("all");

  // Gemini LLM data (stored separately since it uses a different endpoint)
  const [geminiSummary, setGeminiSummary] = useState<UsageSummary>({ totalCalls: 0, totalTokens: 0, totalCost: 0, avgLatency: 0 });
  const [_geminiBreakdown, setGeminiBreakdown] = useState<ModelBreakdown[]>([]);
  const [_geminiActivity, setGeminiActivity] = useState<RecentActivity[]>([]);

  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      setFailedSections([]);

      const llmParams = new URLSearchParams({ days: timeRange });
      if (provider !== "all" && provider !== "gemini" && provider !== "custom_ai") {
        llmParams.set("provider", provider);
      }
      const geminiParams = new URLSearchParams({ days: timeRange, operationType: "content_generation" });

      if (provider === "custom_ai") {
        llmParams.set("provider", "custom_ai");
      }

      const needsLlm = provider !== "gemini";
      const needsGemini = provider === "all" || provider === "gemini";
      const [llmResult, geminiResult] = await Promise.all([
        needsLlm
          ? api.get<LlmResponse>(`/api/admin/usage/llm?${llmParams.toString()}`)
              .then((value) => ({ status: "fulfilled" as const, value }))
              .catch((reason: unknown) => ({ status: "rejected" as const, reason }))
          : Promise.resolve({ status: "fulfilled" as const, value: {} as LlmResponse }),
        needsGemini
          ? api.get<LlmResponse>(`/api/admin/usage/gemini?${geminiParams.toString()}`)
              .then((value) => ({ status: "fulfilled" as const, value }))
              .catch((reason: unknown) => ({ status: "rejected" as const, reason }))
          : Promise.resolve({ status: "fulfilled" as const, value: {} as LlmResponse }),
      ]);

      const failures: string[] = [];
      if (needsLlm && llmResult.status === "rejected") {
        failures.push(`${provider === "custom_ai" ? "Custom API" : "OpenAI/OpenRouter"}: ${getErrorMessage(llmResult.reason)}`);
      }
      if (needsGemini && geminiResult.status === "rejected") {
        failures.push(`Gemini: ${getErrorMessage(geminiResult.reason)}`);
      }

      const everyRequestedSourceFailed =
        (!needsLlm || llmResult.status === "rejected") &&
        (!needsGemini || geminiResult.status === "rejected");
      if (everyRequestedSourceFailed) {
        setLoadError(failures.join(" "));
        return;
      }
      setFailedSections(failures);

      const llmData = llmResult.status === "fulfilled" ? llmResult.value : {};
      const geminiData = geminiResult.status === "fulfilled" ? geminiResult.value : {};

      const gemSum: UsageSummary = geminiData.summary ?? EMPTY_SUMMARY;
      setGeminiSummary(gemSum);
      setGeminiBreakdown(geminiData.breakdown || []);
      setGeminiActivity(geminiData.recentActivity || []);

      // If showing "all" or a specific LLM provider, set main data from LLM endpoint
      if (provider === "gemini") {
        // Show only Gemini LLM data
        setSummary(gemSum);
        setBreakdown(geminiData.breakdown || []);
        setActivity(geminiData.recentActivity || []);
        setPurposeBreakdown([]);
      } else if (provider === "custom_ai") {
        setSummary(llmData.summary || EMPTY_SUMMARY);
        setBreakdown(llmData.breakdown || []);
        setActivity(llmData.recentActivity || []);
        const purposeMap = llmData.summary?.byPurpose || {};
        setPurposeBreakdown(
          Object.entries(purposeMap).map(([purpose, stats]) => ({
            purpose,
            ...(stats as { calls: number; tokens: number | null; costCents: number | null }),
          })).sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0))
        );
      } else if (provider === "all") {
        // Combine LLM (OpenAI + OpenRouter) + Gemini LLM
        const llmSum = llmData.summary || { totalCalls: 0, totalTokens: 0, totalCost: 0, avgLatency: 0 };
        const measuredSources = [llmData.summary, geminiData.summary].filter((source): source is UsageSummary => Boolean(source));
        const coverageKnown = measuredSources.every(source => Number.isFinite(source.measuredDurationCount) && Number.isFinite(source.totalDurationMs));
        const measuredDurationCount = coverageKnown ? measuredSources.reduce((sum, source) => sum + source.measuredDurationCount!, 0) : undefined;
        const totalDurationMs = coverageKnown ? measuredSources.reduce((sum, source) => sum + source.totalDurationMs!, 0) : undefined;
        setSummary({
          totalCalls: llmSum.totalCalls + gemSum.totalCalls,
          totalTokens: measuredSources.every(source => source.totalTokens != null) ? measuredSources.reduce((sum, source) => sum + source.totalTokens!, 0) : null,
          totalCost: measuredSources.every(source => source.totalCost != null) ? measuredSources.reduce((sum, source) => sum + source.totalCost!, 0) : null,
          avgLatency: measuredDurationCount ? totalDurationMs! / measuredDurationCount : null,
          measuredDurationCount, totalDurationMs,
        });
        setBreakdown([...(llmData.breakdown || []), ...(geminiData.breakdown || [])]);
        setActivity([
          ...(llmData.recentActivity || []),
          ...(geminiData.recentActivity || []),
        ]
          .sort((a, b) => {
            return (
              new Date(b.createdAt ?? b.created_at ?? 0).getTime() -
              new Date(a.createdAt ?? a.created_at ?? 0).getTime()
            );
          })
          .slice(0, 100));
        const purposeMap = llmData.summary?.byPurpose || {};
        setPurposeBreakdown(
          Object.entries(purposeMap).map(([purpose, stats]) => ({
            purpose,
            ...(stats as { calls: number; tokens: number | null; costCents: number | null }),
          })).sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0))
        );
      } else {
        // Specific LLM provider (openai or openrouter)
        setSummary(llmData.summary || { totalCalls: 0, totalTokens: 0, totalCost: 0, avgLatency: 0 });
        setBreakdown(llmData.breakdown || []);
        setActivity(llmData.recentActivity || []);
        const purposeMap = llmData.summary?.byPurpose || {};
        setPurposeBreakdown(
          Object.entries(purposeMap).map(([purpose, stats]) => ({
            purpose,
            ...(stats as { calls: number; tokens: number | null; costCents: number | null }),
          })).sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0))
        );
      }
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [timeRange, provider, toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <LoadingState size="page" label="Loading LLM usage…" />
    );
  }

  if (loadError) {
    return (
      <PageErrorState
        title="LLM usage could not be loaded"
        description={loadError}
        reset={() => void fetchData()}
      />
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3 sm:gap-4">
        <Link href="/admin/dashboard/usage">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-black tracking-tighter flex items-center gap-2">
            <Brain className="h-8 w-8 text-purple-600" />
            LLM Usage
          </h1>
          <p className="text-muted-foreground mt-1">
            Track usage across all LLM providers — OpenAI, OpenRouter, Gemini, Custom API
          </p>
        </div>
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger className="w-full sm:w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={timeRange} onValueChange={setTimeRange}>
          <SelectTrigger className="w-full sm:w-[160px]">
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

      {failedSections.length > 0 && (
        <Callout
          tone="warning"
          announce
          title="Some provider data is unavailable"
          actions={
            <Button variant="outline" size="sm" onClick={() => void fetchData()}>
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          }
        >
          {failedSections.join(" ")} Available provider data is shown below and is not a complete total.
        </Callout>
      )}

      {/* Summary Cards */}
      <StatGrid columns={4}>
        <StatCard label="Total Calls" icon={<Hash className="text-purple-600" />} value={summary.totalCalls.toLocaleString()} />
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
          description={
            summary.measuredDurationCount == null
              ? "Duration coverage unavailable"
              : `${summary.measuredDurationCount} of ${summary.totalCalls} calls have measured duration`
          }
        />
      </StatGrid>

      {/* Provider Quick Stats (only when "all") */}
      {provider === "all" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: "OpenAI", key: "openai", color: "text-green-600" },
            { label: "OpenRouter", key: "openrouter", color: "text-blue-600" },
            { label: "Gemini LLM", key: "gemini", color: "text-amber-600" },
            { label: "Custom API", key: "custom_ai", color: "text-purple-600" },
          ].map((p) => {
            return (
              <Card key={p.key} className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setProvider(p.key)}>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{p.label}</span>
                    <Badge variant="outline" className={PROVIDER_COLORS[p.key]}>{p.key === "gemini" ? geminiSummary.totalCalls : "→"}</Badge>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Model Breakdown */}
      {breakdown.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Breakdown by Model</CardTitle>
            <CardDescription>Usage distribution across models</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border">
              <Table className="min-w-[560px]">
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
                        <Badge variant="outline" className="bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400">
                          {item.model}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{item.calls.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{item.tokens?.toLocaleString() ?? "Unavailable"}</TableCell>
                      <TableCell className="text-right">{item.cost == null ? "Unavailable" : `$${item.cost.toFixed(4)}`}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* By Agent/Purpose Breakdown */}
      {purposeBreakdown.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-purple-600" />
              Breakdown by Agent / Purpose
            </CardTitle>
            <CardDescription>Token consumption per AI agent type and action</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border">
              <Table className="min-w-[560px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent / Purpose</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead className="text-right">Est. Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {purposeBreakdown.map((item, idx) => (
                    <TableRow key={idx}>
                      <TableCell>
                        <Badge variant="outline" className="bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400">
                          {item.purpose.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{item.calls.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{item.tokens?.toLocaleString() ?? "Unavailable"}</TableCell>
                      <TableCell className="text-right">{item.costCents == null ? "Unavailable" : `$${(item.costCents / 100).toFixed(4)}`}</TableCell>
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
          <CardTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-blue-600" />
            Recent Activity
          </CardTitle>
          <CardDescription>Latest LLM API calls</CardDescription>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">No recent activity</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table className="min-w-[820px]">
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
                        <Badge variant="outline">{item.model || "—"}</Badge>
                      </TableCell>
                      <TableCell className="max-w-[150px] truncate">
                        {item.purpose ? item.purpose.replace(/_/g, " ") : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span>{item.userName || item.user_name || "—"}</span>
                          {item.userEmail && (
                            <span className="text-xs text-muted-foreground">{item.userEmail}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{item.tokens?.toLocaleString() || "—"}</TableCell>
                      <TableCell className="text-right">
                        {item.cost != null ? `${item.cost == null ? "Unavailable" : `$${item.cost.toFixed(4)}`}` : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.latency != null ? `${item.latency}ms` : "—"}
                      </TableCell>
                      <TableCell>{formatDate(item.createdAt || item.created_at)}</TableCell>
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
