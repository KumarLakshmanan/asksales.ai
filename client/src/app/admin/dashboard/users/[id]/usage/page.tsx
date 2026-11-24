"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { PageErrorState } from "@/components/ui/page-state";
import { LoadingState } from "@/components/ui/loading-state";
import type { AdminUserUsageResponse } from "../../../../../../../../shared/adminUserUsage";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ArrowLeft,
  Activity,
  Cpu,
  Coins,
  Zap,
} from "lucide-react";

interface UsageProvider {
  provider?: string;
  apiCalls?: number;
  api_calls?: number;
  tokens?: number;
  totalTokens?: number;
  total_tokens?: number;
  itemsScraped?: number;
  emailsValidated?: number;
  cost?: number;
  totalCost?: number;
  total_cost?: number;
}

interface UsageData {
  reportedPeriod?: { days: number; start: string; end: string };
  providers?: UsageProvider[];
  summary?: {
    totalApiCalls?: number;
    total_api_calls?: number;
    totalTokens?: number;
    total_tokens?: number;
    itemsScraped?: number;
    emailsValidated?: number;
    totalCost?: number;
    total_cost?: number;
  };
  apiCalls?: number;
  tokens?: number;
  cost?: number;
}

export default function UserUsagePage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<AdminUserUsageResponse>(`/api/admin/users/${id}/usage`);
      if (!data?.usage || !data?.totals || typeof data.usage !== 'object' || Array.isArray(data.usage)) {
        throw new Error('Usage measurements were not returned. Try again.');
      }
      // Server returns { usage: { openai, apify, gemini, zerobounce }, totals }
      // Transform into { summary, providers } for display
      const usageObj = data.usage;
      const totals = data.totals;

      const providers: UsageProvider[] = [];
      if (usageObj.openai) {
        providers.push({
          provider: 'OpenAI / LLM',
          apiCalls: usageObj.openai.totalCalls || 0,
          tokens: usageObj.openai.totalTokens || 0,
          cost: (usageObj.openai.estimatedCostCents || 0) / 100,
        });
      }
      if (usageObj.apify) {
        providers.push({
          provider: 'Apify',
          apiCalls: usageObj.apify.totalRuns || 0,
          itemsScraped: usageObj.apify.totalItemsScraped || 0,
          cost: (usageObj.apify.totalCostCents || 0) / 100,
        });
      }
      if (usageObj.gemini) {
        providers.push({
          provider: 'Gemini',
          apiCalls: usageObj.gemini.totalRequests || 0,
          tokens: (usageObj.gemini.totalInputTokens || 0) + (usageObj.gemini.totalOutputTokens || 0),
          cost: (usageObj.gemini.totalCostCents || 0) / 100,
        });
      }
      if (usageObj.zerobounce) {
        providers.push({
          provider: 'ZeroBounce',
          apiCalls: usageObj.zerobounce.totalRequests || 0,
          emailsValidated: usageObj.zerobounce.totalEmailsValidated || 0,
          cost: (usageObj.zerobounce.totalCostCents || 0) / 100,
        });
      }

      if (!providers.length) throw new Error('Usage measurements were not returned. Try again.');
      const totalTokens = providers.reduce((s, p) => s + (p.tokens ?? 0), 0);
      const totalCost = (totals.totalCostCents || 0) / 100;

      setUsage({
        reportedPeriod: data.dateRange && data.days
          ? { days: data.days, ...data.dateRange } : undefined,
        summary: {
          totalApiCalls: totals.totalApiCalls || providers.reduce((s, p) => s + (p.apiCalls ?? 0), 0),
          totalTokens,
          itemsScraped: usageObj.apify?.totalItemsScraped || 0,
          emailsValidated: usageObj.zerobounce?.totalEmailsValidated || 0,
          totalCost,
        },
        providers,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load usage";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  if (loading) {
    return <LoadingState size="page" label="Loading usage…" />;
  }


  if (loadError) {
    return <PageErrorState title="Usage could not be loaded" description={loadError} reset={() => void fetchUsage()} />;
  }

  const summary = usage?.summary || {};
  const totalCalls =
    summary.totalApiCalls ??
    summary.total_api_calls ??
    usage?.apiCalls ??
    0;
  const totalTokens =
    summary.totalTokens ?? summary.total_tokens ?? usage?.tokens ?? 0;
  const totalCost =
    summary.totalCost ?? summary.total_cost ?? usage?.cost ?? 0;

  const summaryCards = [
    {
      label: "Total API Calls",
      value: totalCalls.toLocaleString(),
      icon: Zap,
      color: "text-blue-500",
      borderColor: "border-blue-200/50",
    },
    {
      label: "Total Tokens",
      value: totalTokens.toLocaleString(),
      icon: Cpu,
      color: "text-purple-500",
      borderColor: "border-purple-200/50",
    },
    {
      label: "Items Scraped",
      value: (summary.itemsScraped ?? 0).toLocaleString(),
      icon: Activity,
      color: "text-cyan-500",
      borderColor: "border-cyan-200/50",
    },
    {
      label: "Emails Validated",
      value: (summary.emailsValidated ?? 0).toLocaleString(),
      icon: Activity,
      color: "text-blue-500",
      borderColor: "border-blue-200/50",
    },
    {
      label: "Total Cost",
      value: `$${Number(totalCost).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      })}`,
      icon: Coins,
      color: "text-amber-500",
      borderColor: "border-amber-200/50",
    },
  ];

  const providers = usage?.providers || [];
  const hasRecordedUsage = totalCalls !== 0 || totalTokens !== 0 || totalCost !== 0
    || providers.some(provider => (provider.itemsScraped ?? 0) !== 0 || (provider.emailsValidated ?? 0) !== 0);

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon">
          <Link href={`/admin/dashboard/users/${id}/view`} aria-label="Back to user details">
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-black tracking-tighter">Usage Analytics</h1>
          <p className="text-muted-foreground mt-1">
            API usage and cost breakdown for this user
          </p>
          {usage?.reportedPeriod && (
            <p className="text-sm text-muted-foreground mt-2">
              Reported period ({usage.reportedPeriod.days} days):{' '}
              <time dateTime={usage.reportedPeriod.start}>{new Date(usage.reportedPeriod.start).toLocaleString(undefined, { timeZoneName: 'short' })}</time>
              {' – '}<time dateTime={usage.reportedPeriod.end}>{new Date(usage.reportedPeriod.end).toLocaleString(undefined, { timeZoneName: 'short' })}</time>
            </p>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {summaryCards.map((card) => (
          <Card key={card.label} className={card.borderColor}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {card.label}
                </CardTitle>
                <card.icon className={`h-4 w-4 ${card.color}`} />
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{card.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Per-Provider Breakdown */}
      {providers.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-4">By Provider</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {providers.map((p, index) => {
              const calls = p.apiCalls ?? p.api_calls ?? 0;
              const tokens =
                p.tokens ?? p.totalTokens ?? p.total_tokens ?? 0;
              const measurement = p.itemsScraped !== undefined
                ? { label: "Items scraped", value: p.itemsScraped }
                : p.emailsValidated !== undefined
                  ? { label: "Emails validated", value: p.emailsValidated }
                  : { label: "Tokens", value: tokens };
              const cost = p.cost ?? p.totalCost ?? p.total_cost ?? 0;

              return (
                <Card
                  key={p.provider || index}
                  className="hover:border-purple-300 transition-colors"
                >
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Activity className="h-4 w-4 text-cyan-500" />
                      {p.provider || `Provider ${index + 1}`}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">API Calls</span>
                      <span className="font-medium">
                        {calls.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{measurement.label}</span>
                      <span className="font-medium">
                        {measurement.value.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Cost</span>
                      <span className="font-medium text-amber-600">
                        ${Number(cost).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 4,
                        })}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {!hasRecordedUsage && (
        <div className="text-center py-12">
          <Activity className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground">No recorded usage in this period.</p>
        </div>
      )}
    </div>
  );
}
