"use client";
import { getBillingProviderMeta } from "@/app/dashboard/(main)/billing/_components/billingMetadata";
import { useProviderCreditUsage } from "@/hooks/use-provider-credit-usage";

import { useState, useMemo } from "react";

import { useRouter } from "next/navigation";

import {
  PieChart,
  ChevronRight,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { Label } from "@/components/ui/label";
import dynamic from "next/dynamic";

const Chart = dynamic(() => import("react-apexcharts"), { ssr: false });

function getMeta(key: string) {
  return getBillingProviderMeta(key);
}

export default function ProviderSpends() {

  const router = useRouter();
  const [search, setSearch] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const { data: providerData, isLoading, isError, refetch } = useProviderCreditUsage(startDate, endDate);

  const totalSpent = useMemo(() => providerData?.reduce((s, d) => s + d.totalCredits, 0) ?? 0, [providerData]);

  const filtered = useMemo(() => {
    if (!providerData) return [];
    const sorted = [...providerData].sort((a, b) => b.totalCredits - a.totalCredits);
    if (!search) return sorted;
    const q = search.toLowerCase();
    return sorted.filter((p) => getMeta(p.apiProvider).label.toLowerCase().includes(q));
  }, [providerData, search]);

  const donutOptions: ApexCharts.ApexOptions = useMemo(() => {
    const sorted = [...(providerData || [])].sort((a, b) => b.totalCredits - a.totalCredits);
    return {
      chart: { type: "donut", fontFamily: "inherit", background: "transparent" },
      labels: sorted.map((p) => getMeta(p.apiProvider).label),
      colors: sorted.map((p) => getMeta(p.apiProvider).chartColor),
      dataLabels: { enabled: false },
      legend: { position: "bottom", fontSize: "11px" },
      plotOptions: {
        pie: {
          donut: {
            size: "65%",
            labels: {
              show: true,
              total: {
                show: true,
                label: "Total Credits",
                formatter: () => totalSpent.toLocaleString(),
              },
            },
          },
        },
      },
      tooltip: {
        y: { formatter: (val: number) => `${val.toLocaleString()} credits` },
      },
    };
  }, [providerData, totalSpent]);

  const donutSeries = useMemo(
    () => [...(providerData || [])].sort((a, b) => b.totalCredits - a.totalCredits).map((p) => p.totalCredits),
    [providerData]
  );

  if (isLoading) {
    return (
      <LoadingState size="section" className="py-16" label="Loading provider spending…" />
    );
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-sm font-medium">Provider spending could not be loaded.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
        </CardContent>
      </Card>
    );
  }

  if (!providerData?.length) {
    return (
      <Card className="border-dashed border-2">
        <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <PieChart className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm font-medium">No provider spending data yet</p>
          <p className="text-xs mt-1">Usage will appear once you start using AI and API features.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex items-end gap-4 flex-wrap">
        <SearchInput
          aria-label="Search providers"
          placeholder="Search providers..."
          value={search}
          onValueChange={setSearch}
          size="sm"
          wrapperClassName="sm:w-52"
        />
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

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        {/* Provider Cards — 3/5 */}
        <div className="lg:col-span-3 space-y-3">
          {filtered.map((item) => {
            const meta = getMeta(item.apiProvider);
            const pct = totalSpent > 0 ? (item.totalCredits / totalSpent) * 100 : 0;
            return (
              <button
                key={item.apiProvider}
                type="button"
                className="group w-full rounded-2xl border bg-card p-4 text-left transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                onClick={() => router.push(`/dashboard/billing/spending-by-provider?provider=${encodeURIComponent(item.apiProvider)}`)}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className={`w-9 h-9 ${meta.bgColor} rounded-xl flex items-center justify-center shadow-sm`}>
                      {meta.icon}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">{meta.label}</p>
                      <p className="text-xs text-muted-foreground">{item.eventCount.toLocaleString()} events</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-right">
                      <p className={`text-sm font-bold ${meta.color}`}>{item.totalCredits.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground">{pct.toFixed(1)}%</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground/50 transition-colors group-hover:text-purple-500" />
                  </div>
                </div>
                <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-2">
                  <div className={`${meta.bgColor} h-2 rounded-full transition-all`} style={{ width: `${Math.max(pct, 2)}%` }} />
                </div>
              </button>
            );
          })}
        </div>

        {/* Donut Chart — 2/5 */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Distribution</CardTitle>
              <CardDescription className="text-xs">Credits used per provider</CardDescription>
            </CardHeader>
            <CardContent>
              <Chart options={donutOptions} series={donutSeries} type="donut" height={320} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
