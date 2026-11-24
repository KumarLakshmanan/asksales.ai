"use client";
import { useBillingOrganizations } from "@/hooks/use-billing-organizations";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBillingApi } from "@/hooks/use-billing-api";
import {
  MessageSquare,
  FileText,
  Users,
  Send,
  BarChart3,
  Globe,
  BookOpen,
  HelpCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import dynamic from "next/dynamic";

const Chart = dynamic(() => import("react-apexcharts"), { ssr: false });

interface SpendingItem {
  referenceType: string;
  totalCredits: number;
  totalApiCostCents: number;
  eventCount: number;
  firstUsed: string;
  lastUsed: string;
}

// Group raw reference_types into broader categories
const CATEGORY_MAP: Record<string, string> = {
  chat_thread: "AI & Chat",
  content: "Content Creation",
  content_asset: "Content Creation",
  media_generation: "Content Creation",
  lead_gen: "Lead Management",
  lead: "Lead Management",
  icp: "Lead Management",
  crm_contact: "Lead Management",
  outreach: "Outreach",
  sent_message: "Outreach",
  outreach_message: "Outreach",
  whatsapp_outreach: "Outreach",
  whatsapp_message_charge: "Outreach",
  whatsapp_message_charge_topup: "Outreach",
  campaign: "Marketing",
  analytics: "Marketing",
  ai_visibility_audit: "Marketing",
  ai_visibility_audit_usage: "Marketing",
  apify_run: "Web Scraping",
  knowledge_base: "Knowledge Base",
  other: "Other",
};

const CATEGORY_META: Record<
  string,
  { icon: React.ReactNode; color: string; bg: string; chart: string }
> = {
  "AI & Chat": {
    icon: <MessageSquare className="w-5 h-5" />,
    color: "text-purple-600 dark:text-purple-400",
    bg: "bg-purple-50 dark:bg-purple-900/20",
    chart: "#8b5cf6",
  },
  "Content Creation": {
    icon: <FileText className="w-5 h-5" />,
    color: "text-blue-600 dark:text-blue-400",
    bg: "bg-blue-50 dark:bg-blue-900/20",
    chart: "#3b82f6",
  },
  "Lead Management": {
    icon: <Users className="w-5 h-5" />,
    color: "text-green-600 dark:text-green-400",
    bg: "bg-green-50 dark:bg-green-900/20",
    chart: "#22c55e",
  },
  Outreach: {
    icon: <Send className="w-5 h-5" />,
    color: "text-amber-700 dark:text-amber-400",
    bg: "bg-amber-50 dark:bg-amber-900/20",
    chart: "#f59e0b",
  },
  Marketing: {
    icon: <BarChart3 className="w-5 h-5" />,
    color: "text-rose-600 dark:text-rose-400",
    bg: "bg-rose-50 dark:bg-rose-900/20",
    chart: "#f43f5e",
  },
  "Web Scraping": {
    icon: <Globe className="w-5 h-5" />,
    color: "text-yellow-700 dark:text-yellow-400",
    bg: "bg-yellow-50 dark:bg-yellow-900/20",
    chart: "#eab308",
  },
  "Knowledge Base": {
    icon: <BookOpen className="w-5 h-5" />,
    color: "text-teal-700 dark:text-teal-400",
    bg: "bg-teal-50 dark:bg-teal-900/20",
    chart: "#14b8a6",
  },
  Other: {
    icon: <HelpCircle className="w-5 h-5" />,
    color: "text-muted-foreground",
    bg: "bg-gray-50 dark:bg-gray-800",
    chart: "#6b7280",
  },
};

interface CategoryData {
  name: string;
  credits: number;
  cost: number;
  events: number;
}

export default function CategorySpends() {
  const api = useBillingApi();
  const { billingScopeKey } = useBillingOrganizations();
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    return params.toString();
  }, [startDate, endDate]);

  const { data, isLoading, isError, refetch } = useQuery<SpendingItem[]>({
    queryKey: ["wallet-campaign-spending", billingScopeKey, startDate, endDate],
    queryFn: () =>
      api.get<SpendingItem[]>(
        `/api/wallet/campaign-spending${queryParams ? `?${queryParams}` : ""}`
      ),
  });

  const categories = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, CategoryData>();
    for (const item of data) {
      const cat = CATEGORY_MAP[item.referenceType] ?? "Other";
      const existing = map.get(cat);
      if (existing) {
        existing.credits += item.totalCredits;
        existing.cost += item.totalApiCostCents;
        existing.events += item.eventCount;
      } else {
        map.set(cat, {
          name: cat,
          credits: item.totalCredits,
          cost: item.totalApiCostCents,
          events: item.eventCount,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.credits - a.credits);
  }, [data]);

  const totalCredits = useMemo(
    () => categories.reduce((s, c) => s + c.credits, 0),
    [categories]
  );

  const chartOptions: ApexCharts.ApexOptions = useMemo(
    () => ({
      chart: { type: "donut", fontFamily: "inherit", background: "transparent" },
      labels: categories.map((c) => c.name),
      colors: categories.map((c) => CATEGORY_META[c.name]?.chart || "#6b7280"),
      dataLabels: { enabled: false },
      legend: { position: "bottom", fontSize: "12px" },
      plotOptions: {
        pie: {
          donut: {
            size: "65%",
            labels: {
              show: true,
              total: {
                show: true,
                label: "Total Credits",
                formatter: () => totalCredits.toLocaleString(),
              },
            },
          },
        },
      },
      tooltip: {
        y: { formatter: (val: number) => `${val.toLocaleString()} credits` },
      },
    }),
    [categories, totalCredits]
  );

  if (isLoading) {
    return (
      <LoadingState size="section" className="py-16" label="Loading category spending…" />
    );
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-sm font-medium">Category spending could not be loaded.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
        </CardContent>
      </Card>
    );
  }

  if (!categories.length) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <BarChart3 className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm font-medium">No spending data yet</p>
          <p className="text-xs mt-1">Credits used across categories will appear here</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Date Filters */}
      <div className="flex items-end gap-4 flex-wrap">
        <div className="w-full space-y-1 sm:w-auto">
          <Label className="text-xs text-muted-foreground">From</Label>
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="h-9 w-full sm:w-40"
          />
        </div>
        <div className="w-full space-y-1 sm:w-auto">
          <Label className="text-xs text-muted-foreground">To</Label>
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="h-9 w-full sm:w-40"
          />
        </div>
        {(startDate || endDate) && (
          <button
            onClick={() => { setStartDate(""); setEndDate(""); }}
            className="pb-2 text-xs text-purple-600 hover:underline dark:text-purple-400"
          >
            Clear
          </button>
        )}
      </div>

      {/* Category Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {categories.map((cat) => {
          const meta = CATEGORY_META[cat.name] ?? CATEGORY_META.Other;
          const pct = totalCredits > 0 ? (cat.credits / totalCredits) * 100 : 0;
          return (
            <Card key={cat.name} className="hover:shadow-md transition-shadow">
              <CardContent className="pt-5">
                <div className="flex items-center gap-3 mb-4">
                  <div
                    className={`w-10 h-10 rounded-xl ${meta.bg} flex items-center justify-center ${meta.color}`}
                  >
                    {meta.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground">
                      {cat.name}
                    </p>
                    <p className="text-xs text-muted-foreground">{cat.events.toLocaleString()} events</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-lg font-bold ${meta.color}`}>
                      {cat.credits.toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">{pct.toFixed(1)}%</p>
                  </div>
                </div>
                <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-2">
                  <div
                    className="h-2 rounded-full transition-all"
                    style={{
                      width: `${Math.max(pct, 2)}%`,
                      backgroundColor: meta.chart,
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Donut Chart */}
      <Card>
        <CardContent className="pt-6">
          <h3 className="mb-4 text-sm font-semibold text-foreground">
            Category Distribution
          </h3>
          <div className="max-w-md mx-auto">
            <Chart
              options={chartOptions}
              series={categories.map((c) => c.credits)}
              type="donut"
              height={320}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
