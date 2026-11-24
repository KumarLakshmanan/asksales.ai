"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { PageErrorState } from "@/components/ui/page-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowLeft,
  CheckCircle,
  Clock3,
  Coins,
  Database,
  FileText,
  Hash,
  XCircle,
} from "lucide-react";

interface EmbeddingUsage {
  id: number;
  userId: number;
  provider: string;
  model: string;
  purpose: string;
  service: string;
  inputTokens: number | null;
  totalTokens: number | null;
  estimatedCostCents: number | null;
  originalCostCents: number | null;
  dimensions: number | null;
  textsCount: number | null;
  responseSuccess: number;
  durationMs: number | null;
  createdAt: string;
  userName: string | null;
  userEmail: string | null;
}

interface ProviderUsage {
  calls: number;
  tokens: number;
  costCents: number;
}

interface EmbeddingUsageResponse {
  usages: EmbeddingUsage[];
  summary: {
    totalCalls?: number;
    totalTokens?: number;
    totalCost?: number;
    totalCostCents?: number;
    totalOriginalCostCents?: number;
    revenue?: number;
    successRate?: number;
    totalTexts?: number;
    avgDurationMs?: number;
    byModel?: Record<string, ProviderUsage>;
    byProvider?: Record<string, ProviderUsage>;
  };
}

const TIME_RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

const PROVIDERS = [
  { value: "all", label: "All providers" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "openrouter", label: "OpenRouter" },
];

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function formatDate(value: string) {
  return new Date(value).toLocaleString("en-IN", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function EmbeddingUsagePage() {
  const [data, setData] = useState<EmbeddingUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState("30");
  const [provider, setProvider] = useState("all");
  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const params = new URLSearchParams({ days: timeRange });
      if (provider !== "all") params.set("provider", provider);
      const response = await api.get<EmbeddingUsageResponse>(`/api/admin/usage/embeddings?${params.toString()}`);
      setData(response);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to load embedding usage";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [provider, timeRange, toast]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <LoadingState size="page" label="Loading embedding usage" />
    );
  }

  if (loadError) {
    return <PageErrorState title="Embedding usage could not be loaded" description={loadError} reset={() => void fetchData()} />;
  }

  const summary = data?.summary || {};
  const usages = data?.usages || [];
  const byProvider = Object.entries(summary.byProvider || {}).sort((a, b) => b[1].calls - a[1].calls);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <Button asChild variant="ghost" size="icon">
          <Link href="/admin/dashboard/usage" aria-label="Back to usage overview">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-black tracking-tighter">
            <Database className="h-8 w-8 text-teal-600" />
            Embedding Usage
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Provider calls, token consumption, costs, and recent embedding activity.
          </p>
        </div>
        <div className="flex min-w-0 gap-2">
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="min-w-0 flex-1 sm:w-[145px] sm:flex-none" aria-label="Filter by embedding provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="min-w-0 flex-1 sm:w-[145px] sm:flex-none" aria-label="Filter by time range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIME_RANGES.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <StatGrid columns={5}>
        <StatCard label="Requests" icon={<Hash className="text-teal-600" />} value={(summary.totalCalls || 0).toLocaleString()} />
        <StatCard label="Texts embedded" icon={<FileText className="text-cyan-600" />} value={(summary.totalTexts || 0).toLocaleString()} />
        <StatCard label="Tokens" icon={<Database className="text-blue-600" />} value={(summary.totalTokens || 0).toLocaleString()} />
        <StatCard
          label="Estimated customer cost"
          icon={<Coins className="text-amber-600" />}
          value={`$${(summary.totalCost ?? (summary.totalCostCents || 0) / 100).toFixed(2)}`}
          description={`Provider cost ${money(summary.totalOriginalCostCents || 0)}`}
        />
        <StatCard
          label="Success / avg. time"
          icon={<Clock3 className="text-violet-600" />}
          value={`${(summary.successRate || 0).toFixed(1)}%`}
          description={`${(summary.avgDurationMs || 0).toLocaleString()} ms average`}
        />
      </StatGrid>

      {byProvider.length > 0 && (
        <section className="space-y-3" aria-labelledby="embedding-provider-breakdown">
          <div>
            <h2 id="embedding-provider-breakdown" className="text-lg font-semibold">Provider breakdown</h2>
            <p className="mt-1 text-sm text-muted-foreground">Calls, total tokens, and estimated customer cost in the selected range.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {byProvider.map(([name, stats]) => (
              <Card key={name} className="shadow-none">
                <CardContent className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="font-medium capitalize">{name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{stats.calls.toLocaleString()} calls · {stats.tokens.toLocaleString()} tokens</p>
                  </div>
                  <Badge variant="outline">{money(stats.costCents)}</Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent embedding activity</CardTitle>
        </CardHeader>
        <CardContent>
          {usages.length === 0 ? (
            <div className="py-10 text-center">
              <Database className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
              <p className="font-medium">No embedding activity found</p>
              <p className="mt-1 text-sm text-muted-foreground">Try another provider or time range.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Provider / model</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead className="text-right">Texts</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead className="text-right">Est. cost</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usages.map((usage) => {
                    const succeeded = usage.responseSuccess === 1;
                    return (
                      <TableRow key={usage.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(usage.createdAt)}</TableCell>
                        <TableCell>
                          <p className="max-w-[180px] truncate font-medium" title={usage.userName || usage.userEmail || `User ${usage.userId}`}>{usage.userName || `User ${usage.userId}`}</p>
                          {usage.userEmail && <p className="max-w-[180px] truncate text-xs text-muted-foreground">{usage.userEmail}</p>}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="capitalize">{usage.provider}</Badge>
                          <p className="mt-1 max-w-[210px] truncate text-xs text-muted-foreground" title={usage.model}>{usage.model}</p>
                          {usage.dimensions && <p className="mt-1 text-xs text-muted-foreground">{usage.dimensions} dimensions</p>}
                        </TableCell>
                        <TableCell>
                          <p className="font-medium">{usage.purpose}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{usage.service}</p>
                          {usage.durationMs !== null && <p className="mt-1 text-xs text-muted-foreground">{usage.durationMs.toLocaleString()} ms</p>}
                        </TableCell>
                        <TableCell className="text-right">{(usage.textsCount || 0).toLocaleString()}</TableCell>
                        <TableCell className="text-right">
                          <p>{(usage.totalTokens || 0).toLocaleString()}</p>
                          {usage.inputTokens !== null && <p className="mt-1 text-xs text-muted-foreground">input {usage.inputTokens.toLocaleString()}</p>}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right">
                          <p>{money(usage.estimatedCostCents || 0)}</p>
                          {usage.originalCostCents !== null && <p className="mt-1 text-xs text-muted-foreground">provider {money(usage.originalCostCents)}</p>}
                        </TableCell>
                        <TableCell>
                          <Badge variant={succeeded ? "secondary" : "destructive"} className="gap-1">
                            {succeeded ? <CheckCircle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                            {succeeded ? "Success" : "Failed"}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          {usages.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Showing up to 500 most recent requests.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
