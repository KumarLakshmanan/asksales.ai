"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import api from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Pagination } from "@/components/ui/pagination";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  AlertTriangle,
  Info,
  XCircle,
  Bug,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useAdminAuth } from "@/contexts/AdminAuthContext";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SystemLog {
  id: number;
  level: "error" | "warn" | "info" | "debug";
  message: string;
  source?: string | null;
  stack?: string | null;
  context?: Record<string, unknown> | null;
  createdAt: string;
}

interface LogStats {
  error?: number;
  warn?: number;
  info?: number;
  debug?: number;
}

interface ApiResponse {
  success: boolean;
  data: SystemLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  retentionDays: number;
}

interface LogFilters {
  level: string;
  source: string;
  search: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: LogFilters = {
  level: "all",
  source: "",
  search: "",
  from: "",
  to: "",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LEVEL_CONFIG: Record<
  string,
  { label: string; color: string; badgeClass: string; Icon: React.ComponentType<{ size?: number }> }
> = {
  error: {
    label: "Error",
    color: "text-red-600",
    badgeClass: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    Icon: XCircle,
  },
  warn: {
    label: "Warning",
    color: "text-yellow-600",
    badgeClass: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
    Icon: AlertTriangle,
  },
  info: {
    label: "Info",
    color: "text-blue-600",
    badgeClass: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    Icon: Info,
  },
  debug: {
    label: "Debug",
    color: "text-gray-500",
    badgeClass: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
    Icon: Bug,
  },
};

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
}

// ─── Row sub-component ────────────────────────────────────────────────────────

function LogRow({ log }: { log: SystemLog }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = LEVEL_CONFIG[log.level] ?? LEVEL_CONFIG.info;
  const hasDetails = !!(log.stack || (log.context && Object.keys(log.context).length));

  return (
    <>
      <TableRow
        className={`cursor-pointer hover:bg-muted/50 ${expanded ? "bg-muted/30" : ""}`}
        onClick={() => hasDetails && setExpanded((v) => !v)}
      >
        <TableCell className="w-24">
          <Badge className={`${cfg.badgeClass} flex items-center gap-1 w-fit text-xs`}>
            <cfg.Icon size={12} />
            {cfg.label}
          </Badge>
        </TableCell>
        <TableCell className="font-mono text-sm max-w-xs truncate">{log.source ?? "—"}</TableCell>
        <TableCell className="text-sm max-w-md">
          <div className="flex items-center gap-1">
            {hasDetails && (
              <Button
                variant="ghost" size="icon" className="h-7 w-7 shrink-0"
                aria-label={`${expanded ? "Hide" : "Show"} details for log ${log.id}`}
                aria-expanded={expanded}
                aria-controls={expanded ? `log-details-${log.id}` : undefined}
                onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }}
              >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </Button>
            )}
            <span className="truncate">{log.message}</span>
          </div>
        </TableCell>
        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
          {formatDate(log.createdAt)}
        </TableCell>
      </TableRow>

      {expanded && hasDetails && (
        <TableRow className="bg-muted/20">
          <TableCell id={`log-details-${log.id}`} colSpan={4} className="py-3 px-6">
            {log.stack && (
              <div className="mb-3">
                <p className="text-xs font-semibold text-muted-foreground mb-1">Stack Trace</p>
                <pre className="text-xs bg-background border rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                  {log.stack}
                </pre>
              </div>
            )}
            {log.context && Object.keys(log.context).length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-1">Context</p>
                <pre className="text-xs bg-background border rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                  {JSON.stringify(log.context, null, 2)}
                </pre>
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SystemLogsPage() {
  const { toast } = useToast();
  const { admin } = useAdminAuth();
  const isSuperAdmin = admin?.role === "super_admin";

  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [stats, setStats] = useState<LogStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(false);
  const [statsUpdatedAt, setStatsUpdatedAt] = useState<Date | null>(null);
  const [logsUpdatedAt, setLogsUpdatedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [clearingLevel, setClearingLevel] = useState<string | null>(null);

  // Filters
  const [levelFilter, setLevelFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [appliedFilters, setAppliedFilters] = useState<LogFilters>(EMPTY_FILTERS);

  // Pagination
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [retentionDays, setRetentionDays] = useState(30);
  const logRequest = useRef<AbortController | null>(null);
  const statsRequest = useRef<AbortController | null>(null);

  const fetchStats = useCallback(async () => {
    statsRequest.current?.abort();
    const controller = new AbortController();
    statsRequest.current = controller;
    setStatsLoading(true);
    try {
      const res = await api.get<{ success: boolean; stats: LogStats }>("/api/admin/system-logs/stats", { signal: controller.signal });
      if (controller.signal.aborted || statsRequest.current !== controller) return;
      if (!res.stats) throw new Error("Statistics unavailable");
      setStats(res.stats);
      setStatsError(false);
      setStatsUpdatedAt(new Date());
    } catch {
      if (!controller.signal.aborted && statsRequest.current === controller) setStatsError(true);
    } finally {
      if (!controller.signal.aborted && statsRequest.current === controller) setStatsLoading(false);
    }
  }, []);

  const fetchLogs = useCallback(async (currentPage = 1) => {
    logRequest.current?.abort();
    const controller = new AbortController();
    logRequest.current = controller;
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams();
      if (appliedFilters.level !== "all") params.set("level", appliedFilters.level);
      if (appliedFilters.source) params.set("source", appliedFilters.source);
      if (appliedFilters.search) params.set("search", appliedFilters.search);
      if (appliedFilters.from) params.set("from", new Date(appliedFilters.from).toISOString());
      if (appliedFilters.to) params.set("to", new Date(appliedFilters.to).toISOString());
      params.set("page", String(currentPage));
      params.set("limit", "50");

      const res = await api.get<ApiResponse>(`/api/admin/system-logs?${params}`, { signal: controller.signal });
      if (controller.signal.aborted || logRequest.current !== controller) return;
      setLogs(res.data ?? []);
      setTotal(res.total ?? 0);
      setPage(res.page ?? 1);
      setTotalPages(res.totalPages ?? 1);
      setRetentionDays(res.retentionDays ?? 30);
      setLogsUpdatedAt(new Date());
    } catch (error) {
      if (controller.signal.aborted || logRequest.current !== controller) return;
      const message = error instanceof Error ? error.message : "Failed to load system logs";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      if (!controller.signal.aborted && logRequest.current === controller) setLoading(false);
    }
  }, [appliedFilters, toast]);

  useEffect(() => {
    fetchStats();
    fetchLogs(1);
    return () => { logRequest.current?.abort(); statsRequest.current?.abort(); };
  }, [fetchLogs, fetchStats]);

  const applyFilters = () => {
    setPage(1);
    setAppliedFilters({
      level: levelFilter,
      source: sourceFilter.trim(),
      search: searchFilter.trim(),
      from: fromDate,
      to: toDate,
    });
  };

  const handleClear = async (level?: string) => {
    setClearingLevel(level ?? "all");
    try {
      const params = level && level !== "all" ? `?level=${level}` : "";
      await api.delete(`/api/admin/system-logs${params}`);
      toast({ title: "Logs cleared", description: level ? `Cleared all ${level} logs` : "Cleared all logs" });
      await Promise.all([fetchStats(), fetchLogs(1)]);
    } catch {
      toast({ title: "Error", description: "Failed to clear logs", variant: "destructive" });
    } finally {
      setClearingLevel(null);
    }
  };

  const statCards = [
    { level: "error", label: "Errors", icon: XCircle, colorClass: "text-red-600" },
    { level: "warn", label: "Warnings", icon: AlertTriangle, colorClass: "text-yellow-600" },
    { level: "info", label: "Info", icon: Info, colorClass: "text-blue-600" },
    { level: "debug", label: "Debug", icon: Bug, colorClass: "text-gray-500" },
  ];

  return (
    <main className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">System Logs</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Application-level events with sensitive fields redacted. Records are retained for {retentionDays} days.
          </p>
        </div>
        <div className="flex gap-2 self-end sm:self-auto">
          <Button variant="outline" size="sm" loading={loading} loadingText="Refresh" onClick={() => { void fetchStats(); void fetchLogs(page); }}>
            <RefreshCw size={14} className="mr-1" /> Refresh
          </Button>

          {isSuperAdmin && <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                loading={clearingLevel === "all"}
                disabled={!!clearingLevel && clearingLevel !== "all"}
              >
                <Trash2 size={14} className="mr-1" />
                Clear All
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear All Logs?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete all system log entries. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => handleClear()}>Clear All</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>}
        </div>
      </div>

      {/* Stats Cards */}
      {statsError && <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Statistics unavailable</AlertTitle><AlertDescription className="mt-2 flex items-center justify-between gap-3"><span>{stats ? "Showing last-known counts." : "Counts could not be loaded."}</span><Button variant="outline" size="sm" disabled={statsLoading} onClick={() => void fetchStats()}>Retry statistics</Button></AlertDescription></Alert>}
      {statsUpdatedAt && <p className="text-xs text-muted-foreground">Statistics last updated: <time dateTime={statsUpdatedAt.toISOString()}>{statsUpdatedAt.toLocaleString()}</time>{statsError ? " (stale)" : ""}</p>}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {statCards.map(({ level, label, icon: Icon, colorClass }) => (
          <button
            key={level}
            type="button"
            aria-label={`Filter logs: ${label}`}
            className="cursor-pointer rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={() => {
              setLevelFilter(level);
              setPage(1);
              setAppliedFilters((current) => ({ ...current, level }));
            }}
          >
            <Card className="h-full hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Icon size={16} className={colorClass} />
                  {label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className={`text-2xl font-bold ${colorClass}`}>
                  {stats ? (stats[level as keyof LogStats] ?? 0).toLocaleString() : statsLoading ? "Loading…" : "Unavailable"}
                </p>
              </CardContent>
            </Card>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div className="space-y-1">
          <label htmlFor="system-log-level" className="text-xs font-medium">Log level</label>
          <Select value={levelFilter} onValueChange={setLevelFilter}>
            <SelectTrigger id="system-log-level" className="w-full">
              <SelectValue placeholder="All levels" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Levels</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="warn">Warning</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <label htmlFor="system-log-source" className="text-xs font-medium">Source</label>
          <Input
            id="system-log-source"
            placeholder="Filter source…"
            maxLength={255}
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyFilters()}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="system-log-search" className="text-xs font-medium">Message or source</label>
          <Input
            id="system-log-search"
            placeholder="Search message or source…"
            value={searchFilter}
            maxLength={200}
            onChange={(e) => setSearchFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyFilters()}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="system-log-from" className="text-xs font-medium">From (local time)</label>
          <Input
            id="system-log-from"
            type="datetime-local"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            title="From date"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="system-log-to" className="text-xs font-medium">To (local time)</label>
          <Input
            id="system-log-to"
            type="datetime-local"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            title="To date"
          />
        </div>

        <Button variant="secondary" size="sm" className="self-end" onClick={applyFilters}>
          Apply Filters
        </Button>

        {(levelFilter !== "all" || sourceFilter || searchFilter || fromDate || toDate) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setLevelFilter("all");
              setSourceFilter("");
              setSearchFilter("");
              setFromDate("");
              setToDate("");
              setPage(1);
              setAppliedFilters(EMPTY_FILTERS);
            }}
          >
            Clear Filters
          </Button>
        )}
      </div>

      {/* Table */}
      <p className="text-xs text-muted-foreground">Date filters use your device&apos;s time zone.</p>
      {logsUpdatedAt && <p className="text-xs text-muted-foreground">Last successful log refresh: <time dateTime={logsUpdatedAt.toISOString()}>{logsUpdatedAt.toLocaleString()}</time>{loadError ? " (stale)" : ""}</p>}
      {loadError && <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Logs could not be loaded</AlertTitle><AlertDescription className="mt-2 flex items-center justify-between gap-3"><span>{loadError}</span><Button variant="outline" size="sm" onClick={() => void fetchLogs(page)}>Retry</Button></AlertDescription></Alert>}

      <div className="overflow-hidden rounded-lg border">
        <div className="flex items-center justify-between px-4 py-2 bg-muted/30 border-b">
          <p className="text-sm text-muted-foreground">
            {logsUpdatedAt ? <>{total.toLocaleString()} log{total !== 1 ? "s" : ""} found</> : loadError ? "Log count unavailable" : "Loading log count…"}
            {totalPages > 1 && ` · Page ${page} of ${totalPages}`}
          </p>
        </div>

        {loading ? (
          <LoadingState size="section" className="py-16" label="Loading logs" />
        ) : logs.length === 0 && loadError ? (
          <p className="py-16 text-center text-muted-foreground">Log results are unavailable. Retry the request above.</p>
        ) : logs.length === 0 ? (
          <div className="text-center py-16">
            <Info size={40} className="mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground">No logs found</p>
            <p className="text-xs text-muted-foreground mt-1">
              Logs will appear here as the application generates them.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto"><Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="bg-muted/20">
                <TableHead className="w-24">Level</TableHead>
                <TableHead className="w-48">Source</TableHead>
                <TableHead>Message</TableHead>
                <TableHead className="w-44">Timestamp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <LogRow key={log.id} log={log} />
              ))}
            </TableBody>
          </Table></div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <Pagination
          page={page}
          pageSize={50}
          totalItems={total}
          onPageChange={(p) => { setPage(p); fetchLogs(p); }}
          itemLabel="logs"
          disabled={loading}
        />
      )}
    </main>
  );
}
