"use client";

import React, { useEffect, useRef, useState } from "react";
import api from "@/lib/admin-api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAdminAuth } from "@/contexts/AdminAuthContext";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Pagination } from "@/components/ui/pagination";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableHeader, TableRow, TableHead, TableBody, TableCell,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  RefreshCw,
  Trash2,
  Play,
  Pause,
  RotateCcw,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Eraser,
  ShieldAlert,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface QueueMetrics {
  queueName: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  isPaused: boolean;
}

interface QueueJob {
  id: string;
  name: string;
  status: string;
  data: Record<string, unknown>;
  opts: { attempts?: number; delay?: number; priority?: number; repeat?: unknown };
  attemptsMade: number;
  failedReason: string | null;
  stacktrace: string[];
  returnvalue: unknown;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
}

interface QueueJobsResponse {
  jobs: QueueJob[];
  total: number;
  start: number;
  end: number;
  hasMore: boolean;
}

const PAGE_SIZE = 50;
const jobDetailsId = (queue: string, job: string) => `queue-${encodeURIComponent(queue)}-job-${encodeURIComponent(job)}`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(ts: number | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  waiting: "outline",
  active: "default",
  completed: "secondary",
  failed: "destructive",
  delayed: "outline",
  paused: "outline",
};

// ─── Page ────────────────────────────────────────────────────────────────────

export default function QueuesPage() {
  const { toast } = useToast();
  const { admin, isLoading: authLoading } = useAdminAuth();
  const qc = useQueryClient();

  const [selectedQueue, setSelectedQueue] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [jobPage, setJobPage] = useState(0);
  const canManageQueues = admin?.role === "super_admin";
  const headingRef = useRef<HTMLHeadingElement>(null);
  const queueButtons = useRef(new Map<string, HTMLButtonElement>());
  const previousQueue = useRef<string | null>(null);

  const openQueue = (queueName: string) => {
    previousQueue.current = queueName;
    setSelectedQueue(queueName);
    setStatusFilter("all");
    setJobPage(0);
    setExpandedJob(null);
  };
  const toggleJob = (jobId: string) => setExpandedJob(current => current === jobId ? null : jobId);

  useEffect(() => {
    if (!canManageQueues) return;
    if (selectedQueue) headingRef.current?.focus();
    else if (previousQueue.current) {
      (queueButtons.current.get(previousQueue.current) ?? headingRef.current)?.focus();
    }
  }, [selectedQueue, canManageQueues]);

  // ── Queue list ──
  const {
    data: queuesData,
    isLoading: queuesLoading,
    isError: queuesError,
    error: queuesErrorValue,
  } = useQuery<QueueMetrics[]>({
    queryKey: ["admin-queues"],
    queryFn: () => api.get("/api/admin/queues"),
    enabled: canManageQueues,
    refetchInterval: 5000,
  });
  const queues = queuesData ?? [];

  // ── Jobs for selected queue ──
  const start = jobPage * PAGE_SIZE;
  const {
    data: jobsData,
    isLoading: jobsLoading,
    isError: jobsError,
    error: jobsErrorValue,
  } = useQuery<QueueJobsResponse>({
    queryKey: ["admin-queue-jobs", selectedQueue, statusFilter, jobPage],
    queryFn: () => api.get(
      `/api/admin/queues/${encodeURIComponent(selectedQueue!)}/jobs?status=${encodeURIComponent(statusFilter)}&start=${start}&end=${start + PAGE_SIZE - 1}`,
    ),
    enabled: canManageQueues && !!selectedQueue,
    refetchInterval: 5000,
  });
  const jobs = jobsData?.jobs ?? [];

  // ── Mutations ──
  const pauseMut = useMutation({
    mutationFn: (q: string) => api.post(`/api/admin/queues/${q}/pause`, {}),
    onSuccess: (_, q) => {
      toast({ title: "Queue paused", description: `"${q}" has been paused.` });
      qc.invalidateQueries({ queryKey: ["admin-queues"] });
    },
    onError: () => toast({ title: "Error", description: "Failed to pause queue", variant: "destructive" }),
  });

  const resumeMut = useMutation({
    mutationFn: (q: string) => api.post(`/api/admin/queues/${q}/resume`, {}),
    onSuccess: (_, q) => {
      toast({ title: "Queue resumed", description: `"${q}" has been resumed.` });
      qc.invalidateQueries({ queryKey: ["admin-queues"] });
    },
    onError: () => toast({ title: "Error", description: "Failed to resume queue", variant: "destructive" }),
  });

  const retryMut = useMutation({
    mutationFn: ({ q, jobId }: { q: string; jobId: string }) => api.post(`/api/admin/queues/${q}/jobs/${jobId}/retry`, {}),
    onSuccess: () => {
      toast({ title: "Job retried" });
      qc.invalidateQueries({ queryKey: ["admin-queue-jobs"] });
    },
    onError: () => toast({ title: "Error", description: "Failed to retry job", variant: "destructive" }),
  });

  const removeMut = useMutation({
    mutationFn: ({ q, jobId }: { q: string; jobId: string }) => api.delete<{
      cleanupPending?: boolean; intentId?: string; message?: string;
    }>(`/api/admin/queues/${q}/jobs/${jobId}`),
    onSuccess: (result) => {
      toast(result?.cleanupPending === true
        ? { title: "Job removed; cleanup pending", variant: "warning", description: [result.message || "Reservation cleanup is pending.", result.intentId ? `Reference: ${result.intentId}` : ""].filter(Boolean).join(" ") }
        : { title: "Job removed", description: result?.message });
      qc.invalidateQueries({ queryKey: ["admin-queue-jobs"] });
    },
    onError: () => toast({ title: "Error", description: "Failed to remove job", variant: "destructive" }),
  });

  const cleanMut = useMutation({
    mutationFn: async ({ q, status }: { q: string; status: string }) => {
      const res = await api.post(`/api/admin/queues/${q}/clean`, { status });
      return res as Record<string, unknown>;
    },
    onSuccess: (res) => {
      toast({ title: "Queue cleaned", description: `Removed ${res?.removed ?? 0} jobs` });
      qc.invalidateQueries({ queryKey: ["admin-queue-jobs"] });
      qc.invalidateQueries({ queryKey: ["admin-queues"] });
    },
    onError: () => toast({ title: "Error", description: "Failed to clean queue", variant: "destructive" }),
  });

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["admin-queues"] });
    if (selectedQueue) qc.invalidateQueries({ queryKey: ["admin-queue-jobs"] });
  };

  // ── Render ──
  if (authLoading || queuesLoading) {
    return (
      <LoadingState size="section" className="py-16" label="Loading queues…" />
    );
  }

  if (!canManageQueues) {
    return (
      <div className="p-4 sm:p-6">
        <Card className="mx-auto max-w-xl border-amber-500/30">
          <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
            <ShieldAlert className="h-10 w-10 text-amber-600 dark:text-amber-400" />
            <h1 className="text-xl font-semibold">Super admin access required</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              Queue inspection and global worker controls can affect every tenant and are restricted to super administrators.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {selectedQueue && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setSelectedQueue(null);
                setExpandedJob(null);
                setJobPage(0);
              }}
              aria-label="Back to queue overview"
            >
              <ArrowLeft size={18} />
            </Button>
          )}
          <div>
            <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
              {selectedQueue ? `Queue: ${selectedQueue}` : "Background Job Queues"}
            </h1>
            <p className="text-muted-foreground text-sm">
              {selectedQueue ? "View and manage individual jobs" : "Monitor and manage background job queues"}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={refreshAll}>
          <RefreshCw size={14} className="mr-1" /> Refresh
        </Button>
      </div>

      {queuesError && (
        <Card className="border-destructive/30">
          <CardContent className="p-5 text-sm text-destructive">
            {queuesErrorValue instanceof Error ? queuesErrorValue.message : "Unable to load queue metrics."}
          </CardContent>
        </Card>
      )}

      {/* ── Queue Overview ── */}
      {!selectedQueue && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {queues.map((q) => {
            const total = q.waiting + q.active + q.completed + q.failed + q.delayed;
            return (
              <Card
                key={q.queueName}
                className="cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all"
                onClick={() => openQueue(q.queueName)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base font-semibold">
                      <button type="button" aria-label={`View jobs in ${q.queueName}`}
                        ref={node => { if (node) queueButtons.current.set(q.queueName, node); else queueButtons.current.delete(q.queueName); }}
                        className="min-h-8 rounded text-left text-base font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        onClick={event => { event.stopPropagation(); openQueue(q.queueName); }}>
                        {q.queueName}
                      </button>
                    </CardTitle>
                    {q.isPaused && <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-300">Paused</Badge>}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-3 gap-2 text-center text-sm">
                    <div>
                      <div className="font-bold text-primary">{q.waiting}</div>
                      <div className="text-muted-foreground text-xs">Waiting</div>
                    </div>
                    <div>
                      <div className="font-bold text-emerald-700 dark:text-emerald-400">{q.active}</div>
                      <div className="text-muted-foreground text-xs">Active</div>
                    </div>
                    <div>
                      <div className="font-bold text-destructive">{q.failed}</div>
                      <div className="text-muted-foreground text-xs">Failed</div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{q.completed} completed</span>
                    <span>{q.delayed} delayed</span>
                    <span>{total} total</span>
                  </div>

                  {/* Queue actions */}
                  <div className="flex gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
                    {q.isPaused ? (
                      <Button
                        variant="outline" size="sm" className="flex-1 text-xs"
                        disabled={resumeMut.isPending}
                        onClick={() => resumeMut.mutate(q.queueName)}
                      >
                        <Play size={12} className="mr-1" /> Resume
                      </Button>
                    ) : (
                      <Button
                        variant="outline" size="sm" className="flex-1 text-xs"
                        disabled={pauseMut.isPending}
                        onClick={() => pauseMut.mutate(q.queueName)}
                      >
                        <Pause size={12} className="mr-1" /> Pause
                      </Button>
                    )}
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm" className="text-xs">
                          <Eraser size={12} className="mr-1" /> Clean
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Clean &ldquo;{q.queueName}&rdquo; queue?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will remove all completed jobs from the queue. This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => cleanMut.mutate({ q: q.queueName, status: "completed" })}>
                            Clean Completed
                          </AlertDialogAction>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => cleanMut.mutate({ q: q.queueName, status: "failed" })}
                          >
                            Clean Failed
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Job List ── */}
      {selectedQueue && (
        <div className="space-y-4">
          {/* Filters & queue actions */}
          <div className="flex flex-wrap items-center gap-3">
            <Select
              value={statusFilter}
              onValueChange={(value) => {
                setStatusFilter(value);
                setJobPage(0);
                setExpandedJob(null);
              }}
            >
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="waiting">Waiting</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="delayed">Delayed</SelectItem>
              </SelectContent>
            </Select>

            <div className="ml-auto flex gap-2">
              {queues.find((q) => q.queueName === selectedQueue)?.isPaused ? (
                <Button variant="outline" size="sm" disabled={resumeMut.isPending} onClick={() => resumeMut.mutate(selectedQueue)}>
                  <Play size={14} className="mr-1" /> Resume Queue
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled={pauseMut.isPending} onClick={() => pauseMut.mutate(selectedQueue)}>
                  <Pause size={14} className="mr-1" /> Pause Queue
                </Button>
              )}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Eraser size={14} className="mr-1" /> Clean
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clean &ldquo;{selectedQueue}&rdquo; queue?</AlertDialogTitle>
                    <AlertDialogDescription>Remove completed or failed jobs from this queue.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => cleanMut.mutate({ q: selectedQueue, status: "completed" })}>
                      Clean Completed
                    </AlertDialogAction>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => cleanMut.mutate({ q: selectedQueue, status: "failed" })}
                    >
                      Clean Failed
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>

          {/* Jobs table */}
          {jobsLoading ? (
            <LoadingState size="section" label="Loading queue jobs…" />
          ) : jobsError ? (
            <Card className="border-destructive/30">
              <CardContent className="p-8 text-center text-sm text-destructive">
                {jobsErrorValue instanceof Error ? jobsErrorValue.message : "Unable to load queue jobs."}
              </CardContent>
            </Card>
          ) : jobs.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                No jobs found{statusFilter !== "all" ? ` with status "${statusFilter}"` : ""}.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <div className="overflow-x-auto">
                <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10"></TableHead>
                    <TableHead>Job ID</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Processed</TableHead>
                    <TableHead>Finished</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    <React.Fragment key={job.id}>
                      <TableRow
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => toggleJob(job.id)}
                      >
                        <TableCell>
                          <button type="button"
                            aria-label={`${expandedJob === job.id ? "Hide" : "Show"} details for job ${job.id}`}
                            aria-expanded={expandedJob === job.id}
                            aria-controls={expandedJob === job.id ? jobDetailsId(selectedQueue, job.id) : undefined}
                            className="inline-flex h-8 w-8 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                            onClick={event => { event.stopPropagation(); toggleJob(job.id); }}>
                            {expandedJob === job.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{job.id}</TableCell>
                        <TableCell className="font-medium">{job.name}</TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[job.status] ?? "outline"}>{job.status}</Badge>
                        </TableCell>
                        <TableCell>{job.attemptsMade}{job.opts.attempts ? `/${job.opts.attempts}` : ""}</TableCell>
                        <TableCell className="text-xs">{formatDate(job.timestamp)}</TableCell>
                        <TableCell className="text-xs">{formatDate(job.processedOn)}</TableCell>
                        <TableCell className="text-xs">{formatDate(job.finishedOn)}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                            {job.status === "failed" && (
                              <Button
                                variant="ghost" size="icon" className="h-8 w-8"
                                disabled={retryMut.isPending}
                                onClick={() => retryMut.mutate({ q: selectedQueue, jobId: job.id })}
                                title="Retry job"
                                aria-label={`Retry job ${job.id}`}
                              >
                                <RotateCcw size={14} />
                              </Button>
                            )}
                            {job.status !== "active" && <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-destructive"
                                  title={["waiting", "delayed", "paused"].includes(job.status) ? "Cancel pending job" : "Remove job history"}
                                  aria-label={["waiting", "delayed", "paused"].includes(job.status) ? `Cancel job ${job.id}` : `Remove job ${job.id}`}
                                >
                                  <Trash2 size={14} />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>
                                    {["waiting", "delayed", "paused"].includes(job.status) ? "Cancel pending job" : "Remove job history"} {job.id}?
                                  </AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {["waiting", "delayed", "paused"].includes(job.status)
                                      ? "This prevents the pending job from being processed."
                                      : "This permanently removes the retained diagnostic record."}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    className="bg-destructive text-destructive-foreground"
                                    onClick={() => removeMut.mutate({ q: selectedQueue, jobId: job.id })}
                                  >
                                    Remove
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>}
                          </div>
                        </TableCell>
                      </TableRow>

                      {/* Expanded details */}
                      {expandedJob === job.id && (
                        <TableRow>
                          <TableCell colSpan={9} className="bg-muted/30 p-4">
                            <div id={jobDetailsId(selectedQueue, job.id)} role="region" aria-label={`Details for job ${job.id}`} className="space-y-3">
                              {job.failedReason && (
                                <div>
                                  <h4 className="text-sm font-semibold text-destructive mb-1">Error</h4>
                                  <pre className="text-xs bg-destructive/10 p-2 rounded overflow-x-auto whitespace-pre-wrap">
                                    {job.failedReason}
                                  </pre>
                                </div>
                              )}
                              {job.stacktrace.length > 0 && (
                                <div>
                                  <h4 className="text-sm font-semibold mb-1">Stack Trace</h4>
                                  <pre className="text-xs bg-muted p-2 rounded overflow-x-auto max-h-40 whitespace-pre-wrap">
                                    {job.stacktrace.join("\n")}
                                  </pre>
                                </div>
                              )}
                              <div>
                                <h4 className="text-sm font-semibold mb-1">Redacted Job Data</h4>
                                <pre className="text-xs bg-muted p-2 rounded overflow-x-auto max-h-60 whitespace-pre-wrap">
                                  {JSON.stringify(job.data, null, 2)}
                                </pre>
                              </div>
                              {job.returnvalue != null && (
                                <div>
                                  <h4 className="text-sm font-semibold mb-1">Redacted Return Value</h4>
                                  <pre className="text-xs bg-muted p-2 rounded overflow-x-auto max-h-40 whitespace-pre-wrap">
                                    {JSON.stringify(job.returnvalue, null, 2)}
                                  </pre>
                                </div>
                              )}
                              {job.opts && (
                                <div>
                                  <h4 className="text-sm font-semibold mb-1">Options</h4>
                                  <pre className="text-xs bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap">
                                    {JSON.stringify(job.opts, null, 2)}
                                  </pre>
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  ))}
                </TableBody>
                </Table>
              </div>
            </Card>
          )}
          {!jobsLoading && !jobsError && jobsData && jobsData.total > 0 && (
            <Pagination
              page={jobPage + 1}
              pageSize={PAGE_SIZE}
              totalItems={jobsData.total}
              onPageChange={(next) => {
                setJobPage(next - 1);
                setExpandedJob(null);
              }}
              itemLabel="jobs"
            />
          )}
        </div>
      )}
    </div>
  );
}
