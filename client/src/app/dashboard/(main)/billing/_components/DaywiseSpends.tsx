"use client";
import { useBillingOrganizations } from "@/hooks/use-billing-organizations";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBillingApi } from "@/hooks/use-billing-api";
import {
  BarChart3,
  Calendar,
  TrendingUp,
  TrendingDown,
  ArrowUpCircle,
  ArrowDownCircle,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import dynamic from "next/dynamic";

const Chart = dynamic(() => import("react-apexcharts"), { ssr: false });

interface DailyData {
  date: string;
  credits: number;
  debits: number;
  net: number;
  transactionCount: number;
}

export default function DaywiseSpends() {
  const api = useBillingApi();
  const { billingScopeKey } = useBillingOrganizations();
  const [days, setDays] = useState("30");

  const { data: dailyData, isLoading, isError, refetch } = useQuery<DailyData[]>({
    queryKey: ["wallet-daily-transactions", billingScopeKey, days],
    queryFn: () => api.get<DailyData[]>(`/api/wallet/daily-transactions?days=${days}`),
  });

  const chartData = useMemo(() => {
    const result: { date: string; credits: number; debits: number }[] = [];
    const now = new Date();
    const numDays = parseInt(days);
    for (let i = numDays - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      const match = dailyData?.find((u) => u.date === dateStr);
      result.push({
        date: dateStr,
        credits: match?.credits || 0,
        debits: match?.debits || 0,
      });
    }
    return result;
  }, [dailyData, days]);

  const stats = useMemo(() => {
    const totalCredits = chartData.reduce((s, d) => s + d.credits, 0);
    const totalDebits = chartData.reduce((s, d) => s + d.debits, 0);
    const activeDays = chartData.filter((d) => d.credits > 0 || d.debits > 0).length;
    const avgDaily = activeDays > 0 ? Math.round(totalDebits / activeDays) : 0;
    const peakDay = chartData.reduce((max, d) => (d.debits > max.debits ? d : max), chartData[0]);
    return { totalCredits, totalDebits, activeDays, avgDaily, peakDay };
  }, [chartData]);

  const apexOptions: ApexCharts.ApexOptions = useMemo(
    () => ({
      chart: {
        type: "bar",
        stacked: false,
        toolbar: { show: false },
        fontFamily: "inherit",
        background: "transparent",
      },
      plotOptions: { bar: { borderRadius: 4, columnWidth: "60%" } },
      colors: ["#10b981", "#8b5cf6"],
      dataLabels: { enabled: false },
      stroke: { width: 0 },
      xaxis: {
        categories: chartData.map((d) =>
          new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
        ),
        labels: {
          style: { fontSize: "10px", colors: "#9ca3af" },
          rotate: -45,
          rotateAlways: chartData.length > 14,
          hideOverlappingLabels: true,
        },
        axisBorder: { show: false },
        axisTicks: { show: false },
      },
      yaxis: {
        labels: {
          style: { fontSize: "11px", colors: "#9ca3af" },
          formatter: (val: number) =>
            val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val.toFixed(0),
        },
      },
      grid: { borderColor: "rgba(156,163,175,0.15)", strokeDashArray: 4 },
      tooltip: {
        theme: "dark",
        y: { formatter: (val: number) => `${val.toLocaleString()} credits` },
      },
      legend: {
        position: "top",
        horizontalAlign: "right",
        fontSize: "12px",
        markers: { size: 6, shape: "circle" as const },
      },
    }),
    [chartData]
  );

  const apexSeries = useMemo(
    () => [
      { name: "Received", data: chartData.map((d) => d.credits) },
      { name: "Used", data: chartData.map((d) => d.debits) },
    ],
    [chartData]
  );

  // Table rows: only days with activity, most recent first
  const tableRows = useMemo(() => {
    return [...chartData]
      .filter((d) => d.credits > 0 || d.debits > 0)
      .reverse();
  }, [chartData]);

  if (isLoading) {
    return (
      <LoadingState size="section" className="py-16" label="Loading daily spending…" />
    );
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-sm font-medium">Daily wallet activity could not be loaded.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats Row */}
      <StatGrid columns={4}>
        <StatCard label="Total Received" value={stats.totalCredits.toLocaleString()} icon={<ArrowUpCircle />} tone="success" />
        <StatCard label="Total Used" value={stats.totalDebits.toLocaleString()} icon={<ArrowDownCircle />} tone="destructive" />
        <StatCard label="Avg/Active Day" value={stats.avgDaily.toLocaleString()} icon={<TrendingDown />} />
        <StatCard
          label="Peak Day"
          value={stats.peakDay ? stats.peakDay.debits.toLocaleString() : null}
          icon={<TrendingUp />}
          description={stats.peakDay?.date ? new Date(stats.peakDay.date).toLocaleDateString() : undefined}
        />
      </StatGrid>

      {/* Chart */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-sm flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-purple-600" /> Daily Credit Activity
              </CardTitle>
              <CardDescription className="text-xs mt-1">Credits received and used per day</CardDescription>
            </div>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="w-full sm:w-[130px]" aria-label="Select date range">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="14">Last 14 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="60">Last 60 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {chartData.every((d) => d.credits === 0 && d.debits === 0) ? (
            <div className="flex h-48 flex-col items-center justify-center text-muted-foreground">
              <BarChart3 className="w-9 h-9 mb-2 opacity-25" />
              <p className="text-sm font-medium text-muted-foreground">No credit activity in this period</p>
            </div>
          ) : (
            <div className="-mx-2">
              <Chart options={apexOptions} series={apexSeries} type="bar" height={300} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Day-wise Table */}
      {tableRows.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Calendar className="w-4 h-4 text-purple-600" /> Daily Breakdown
            </CardTitle>
            <CardDescription className="text-xs">Only days with activity are shown</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-gray-50 dark:bg-gray-800/50">
                    <TableHead className="text-xs font-semibold">Date</TableHead>
                    <TableHead className="text-xs font-semibold text-right">Received</TableHead>
                    <TableHead className="text-xs font-semibold text-right">Used</TableHead>
                    <TableHead className="text-xs font-semibold text-right">Net</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tableRows.map((row) => {
                    const net = row.credits - row.debits;
                    return (
                      <TableRow key={row.date}>
                        <TableCell className="text-sm">
                          {new Date(row.date).toLocaleDateString("en-US", {
                            weekday: "short",
                            month: "short",
                            day: "numeric",
                          })}
                        </TableCell>
                        <TableCell className="text-right text-sm font-medium text-green-600 dark:text-green-400">
                          {row.credits > 0 ? `+${row.credits.toLocaleString()}` : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-right text-red-600 font-medium">
                          {row.debits > 0 ? `-${row.debits.toLocaleString()}` : "—"}
                        </TableCell>
                        <TableCell className={`text-right text-sm font-semibold ${net >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                          {net >= 0 ? `+${net.toLocaleString()}` : net.toLocaleString()}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
