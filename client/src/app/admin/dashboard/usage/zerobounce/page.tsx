"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { PageErrorState } from "@/components/ui/page-state";
import { Button } from "@/components/ui/button";
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
  ShieldCheck,
  Mail,
  Coins,
  CheckCircle2,
} from "lucide-react";
import { formatShortDateTime as formatDate } from "@/lib/display-format";

interface UsageSummary {
  totalValidations: number;
  creditsUsed: number;
  creditsRemaining: number;
  validRate: number;
}

interface StatusBreakdown {
  status: string;
  count: number;
  percentage: number;
}

interface RecentValidation {
  id: number;
  email?: string;
  status?: string;
  subStatus?: string;
  sub_status?: string;
  creditsUsed?: number;
  credits_used?: number;
  userName?: string;
  user_name?: string;
  createdAt?: string;
  created_at?: string;
}

interface ZeroBounceUsageResponse {
  records?: Array<{ id?: number; email?: string; status?: string; subStatus?: string; sub_status?: string; creditsUsed?: number; credits_used?: number; userName?: string; user_name?: string; createdAt?: string; created_at?: string; emailsValidated?: number }>;
  summary?: {
    totalEmailsValidated?: number;
    totalValidations?: number;
    totalCreditsUsed?: number;
    creditsUsed?: number;
    creditsRemaining?: number;
    validRate?: number;
    emailStatusBreakdown?: Record<string, number>;
  };
  breakdown?: StatusBreakdown[];
  statusBreakdown?: StatusBreakdown[];
  recentActivity?: RecentValidation[];
  activity?: RecentValidation[];
}

const TIME_RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

/** ZeroBounce result codes, keyed the way StatusBadge normalises them (lower snake_case). */
const VALIDATION_STATUS_TONES: Record<string, StatusTone> = {
  valid: "success",
  invalid: "danger",
  catch_all: "warning",
  spamtrap: "danger",
  spam_trap: "danger",
  abuse: "warning",
  do_not_mail: "neutral",
};

const VALIDATION_STATUS_LABELS: Record<string, string> = {
  catch_all: "Catch-All",
  spamtrap: "Spam Trap",
  spam_trap: "Spam Trap",
  do_not_mail: "Do Not Mail",
};

function ValidationStatusBadge({ status }: { status?: string }) {
  if (!status) return <StatusBadge tone="neutral" label="—" dot={false} />;
  const key = status.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (
    <StatusBadge
      status={status}
      toneOverrides={VALIDATION_STATUS_TONES}
      label={VALIDATION_STATUS_LABELS[key]}
    />
  );
}

export default function ZeroBounceUsagePage() {
  const [summary, setSummary] = useState<UsageSummary>({
    totalValidations: 0,
    creditsUsed: 0,
    creditsRemaining: 0,
    validRate: 0,
  });
  const [breakdown, setBreakdown] = useState<StatusBreakdown[]>([]);
  const [activity, setActivity] = useState<RecentValidation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState("30");
  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const params = new URLSearchParams({ days: timeRange });
      const data = await api.get<ZeroBounceUsageResponse>(`/api/admin/usage/zerobounce?${params.toString()}`);

      // Server returns: { records, summary: { totalRequests, totalEmailsValidated, totalValidEmails,
      //   totalInvalidEmails, totalCreditsUsed, totalCostCents, successRate, validRate,
      //   emailStatusBreakdown: {valid, invalid, catchAll, unknown}, byOperationType, byPurpose, byDay } }
      const s = data.summary || {};
      setSummary({
        totalValidations: s.totalEmailsValidated || s.totalValidations || 0,
        creditsUsed: s.totalCreditsUsed || s.creditsUsed || 0,
        creditsRemaining: s.creditsRemaining || 0,
        validRate: s.validRate || 0,
      });

      // Transform emailStatusBreakdown into array
      const esb = s.emailStatusBreakdown || {};
      const total = Object.values(esb).reduce((sum: number, v) => sum + (v as number), 0) || 1;
      const statusBreakdown: StatusBreakdown[] = Object.entries(esb).map(([status, count]) => ({
        status: status === 'catchAll' ? 'catch-all' : status,
        count: count as number,
        percentage: Math.round(((count as number) / (total as number)) * 100),
      })).filter(s => s.count > 0);
      setBreakdown(data.breakdown || data.statusBreakdown || statusBreakdown);

      // Transform records into recent activity
      const records = (data.records || []).slice(0, 100);
      const recentAct: RecentValidation[] = records.map((r, idx) => ({
        id: r.id ?? idx,
        status: r.status || 'unknown',
        userName: r.userName || '',
        creditsUsed: r.creditsUsed || 0,
        createdAt: r.createdAt,
      }));
      setActivity(
        data.recentActivity || data.activity || recentAct
      );
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
      <LoadingState size="page" label="Loading ZeroBounce usage…" />
    );
  }

  if (loadError) return <PageErrorState title="ZeroBounce usage could not be loaded" description={loadError} reset={() => void fetchData()} />;

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
            <ShieldCheck className="h-8 w-8 text-orange-600" />
            ZeroBounce Usage
          </h1>
          <p className="text-muted-foreground mt-1">
            Track email validation usage, credits, and results
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
          label="Total Validations"
          icon={<Mail className="text-orange-600" />}
          value={summary.totalValidations.toLocaleString()}
        />
        <StatCard
          label="Credits Used"
          icon={<Coins className="text-red-600" />}
          value={summary.creditsUsed.toLocaleString()}
        />
        <StatCard
          label="Credits Remaining"
          icon={<Coins className="text-green-600" />}
          value={summary.creditsRemaining.toLocaleString()}
        />
        <StatCard
          label="Valid Rate"
          icon={<CheckCircle2 className="text-green-600" />}
          value={`${summary.validRate.toFixed(1)}%`}
        />
      </StatGrid>

      {/* Status Breakdown */}
      {breakdown.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Breakdown by Status</CardTitle>
            <CardDescription>
              Distribution of email validation results
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                    <TableHead className="text-right">Percentage</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {breakdown.map((item, idx) => (
                    <TableRow key={idx}>
                      <TableCell><ValidationStatusBadge status={item.status} /></TableCell>
                      <TableCell className="text-right">
                        {item.count.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.percentage.toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Validations */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Validations</CardTitle>
          <CardDescription>Latest email validation results</CardDescription>
        </CardHeader>
        <CardContent>
          {activity.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              No recent validations
            </p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Sub-Status</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead className="text-right">Credits</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activity.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-mono text-sm max-w-[200px] truncate">
                        {item.email || "—"}
                      </TableCell>
                      <TableCell><ValidationStatusBadge status={item.status} /></TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {item.subStatus || item.sub_status || "—"}
                      </TableCell>
                      <TableCell>
                        {item.userName || item.user_name || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.creditsUsed ?? item.credits_used ?? "—"}
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
