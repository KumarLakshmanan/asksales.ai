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
  BarChart3,
  Hash,
  Coins,
  TrendingUp,
  Brain,
  Image,
  Server,
  ShieldCheck,
} from "lucide-react";

interface ProviderData {
  provider: string;
  category: string;
  totalCalls: number;
  totalTokens?: number;
  totalImages?: number;
  totalVideos?: number;
  totalItemsScraped?: number;
  totalEmailsValidated?: number;
  totalCostCents: number;
}

interface DailyTrend {
  date: string;
  llmCalls: number;
  geminiCalls: number;
  apifyCalls: number;
  zbCalls: number;
  totalCostCents: number;
}

interface PlatformUsageResponse {
  providers?: ProviderData[];
  dailyTrend?: DailyTrend[];
  summary?: { totalCalls?: number; totalCost?: number };
}

const TIME_RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  llm: <Brain className="h-4 w-4" />,
  gemini: <Image className="h-4 w-4" />,
  scraping: <Server className="h-4 w-4" />,
  validation: <ShieldCheck className="h-4 w-4" />,
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  custom_ai: "Custom API",
  gemini_image_generation: "Gemini Image",
  gemini_video_generation: "Gemini Video",
  gemini_content_generation: "Gemini LLM",
  apify: "Apify",
  zerobounce: "ZeroBounce",
};

const PROVIDER_COLORS: Record<string, string> = {
  openai: "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400",
  openrouter: "bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400",
  custom_ai: "bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400",
  gemini_image_generation: "bg-pink-50 text-pink-700 dark:bg-pink-900/20 dark:text-pink-400",
  gemini_video_generation: "bg-indigo-50 text-indigo-700 dark:bg-indigo-900/20 dark:text-indigo-400",
  gemini_content_generation: "bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400",
  apify: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400",
  zerobounce: "bg-cyan-50 text-cyan-700 dark:bg-cyan-900/20 dark:text-cyan-400",
};

export default function PlatformUsagePage() {
  const [providers, setProviders] = useState<ProviderData[]>([]);
  const [dailyTrend, setDailyTrend] = useState<DailyTrend[]>([]);
  const [totalCalls, setTotalCalls] = useState(0);
  const [totalCost, setTotalCost] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState("30");
  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const params = new URLSearchParams({ days: timeRange });
      const data = await api.get<PlatformUsageResponse>(`/api/admin/usage/platform?${params.toString()}`);

      setProviders(data.providers || []);
      setDailyTrend(data.dailyTrend || []);
      setTotalCalls(data.summary?.totalCalls || 0);
      setTotalCost(data.summary?.totalCost || 0);
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
      <LoadingState size="page" label="Loading platform usage…" />
    );
  }

  if (loadError) return <PageErrorState title="Platform usage could not be loaded" description={loadError} reset={() => void fetchData()} />;

  const _llmProviders = providers.filter(p => p.category === "llm" || (p.category === "gemini" && p.provider.includes("content")));
  const _mediaProviders = providers.filter(p => p.category === "gemini" && !p.provider.includes("content"));
  const _otherProviders = providers.filter(p => p.category === "scraping" || p.category === "validation");

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
            <BarChart3 className="h-8 w-8 text-purple-600" />
            Platform Usage Analytics
          </h1>
          <p className="text-muted-foreground mt-1">
            Aggregated usage across all integrated services and providers
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

      {/* Top-level Summary */}
      <StatGrid columns={3}>
        <StatCard label="Total API Calls" icon={<Hash className="text-purple-600" />} value={totalCalls.toLocaleString()} />
        <StatCard label="Total Cost" icon={<Coins className="text-amber-600" />} value={`$${totalCost.toFixed(2)}`} />
        <StatCard
          label="Active Providers"
          icon={<TrendingUp className="text-green-600" />}
          value={providers.filter(p => p.totalCalls > 0).length}
        />
      </StatGrid>

      {/* Provider Breakdown Table */}
      <Card>
        <CardHeader>
          <CardTitle>Usage by Provider</CardTitle>
          <CardDescription>Detailed breakdown across all integrated services</CardDescription>
        </CardHeader>
        <CardContent>
          {providers.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">No usage data for selected period</p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">API Calls</TableHead>
                    <TableHead className="text-right">Details</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {providers.map((p, idx) => (
                    <TableRow key={idx}>
                      <TableCell>
                        <Badge variant="outline" className={PROVIDER_COLORS[p.provider] || ""}>
                          {PROVIDER_LABELS[p.provider] || p.provider}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {CATEGORY_ICONS[p.category]}
                          <span className="capitalize text-sm">{p.category}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{p.totalCalls.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {p.totalTokens ? `${p.totalTokens.toLocaleString()} tokens` : ""}
                        {p.totalImages ? `${p.totalImages.toLocaleString()} images` : ""}
                        {p.totalVideos ? `${p.totalVideos.toLocaleString()} videos` : ""}
                        {p.totalItemsScraped ? `${p.totalItemsScraped.toLocaleString()} items` : ""}
                        {p.totalEmailsValidated ? `${p.totalEmailsValidated.toLocaleString()} emails` : ""}
                      </TableCell>
                      <TableCell className="text-right">${(p.totalCostCents / 100).toFixed(2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Daily Trend Table */}
      {dailyTrend.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Daily Trend</CardTitle>
            <CardDescription>API call volume and costs per day</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border max-h-[400px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">LLM Calls</TableHead>
                    <TableHead className="text-right">Gemini Calls</TableHead>
                    <TableHead className="text-right">Apify Calls</TableHead>
                    <TableHead className="text-right">ZeroBounce Calls</TableHead>
                    <TableHead className="text-right">Total Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dailyTrend.map((d, idx) => (
                    <TableRow key={idx}>
                      <TableCell>{d.date}</TableCell>
                      <TableCell className="text-right">{d.llmCalls.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{d.geminiCalls.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{d.apifyCalls.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{d.zbCalls.toLocaleString()}</TableCell>
                      <TableCell className="text-right">${(d.totalCostCents / 100).toFixed(2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
