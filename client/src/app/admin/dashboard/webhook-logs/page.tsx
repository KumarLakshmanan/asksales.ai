/* eslint-disable react-hooks/exhaustive-deps */
"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Pagination } from "@/components/ui/pagination";
import { Callout } from "@/components/ui/callout";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Webhook,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Search,
  X,
} from "lucide-react";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";

interface WebhookEvent {
  id: number;
  platform?: string;
  event_type?: string | null;
  page_id?: string | null;
  user_id?: number | null;
  payload?: unknown;
  signature_valid?: boolean;
  processed?: boolean;
  error?: string | null;
  created_at?: string;
}

const PLATFORMS = ["all", "whatsapp", "instagram", "facebook", "meta", "gmail", "resend", "razorpay"];

export default function AdminWebhookLogsPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [platform, setPlatform] = useState("all");
  const [userIdDraft, setUserIdDraft] = useState("");
  const [userIdFilter, setUserIdFilter] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const limit = 50;

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (platform !== "all") params.set("platform", platform);
      if (userIdFilter.trim()) params.set("userId", userIdFilter.trim());
      params.set("limit", String(limit));
      params.set("offset", String(page * limit));

      const res = await api.get<{ success: boolean; events: WebhookEvent[]; pagination: { total: number } }>(
        `/api/admin/webhook-logs?${params.toString()}`
      );
      if (res.success) {
        setEvents(res.events || []);
        setTotal(res.pagination?.total || 0);
      }
    } catch {
      toast({ title: "Error", description: "Failed to load webhook logs", variant: "destructive" });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [platform, userIdFilter, page]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRefresh = () => {
    setRefreshing(true);
    load();
  };

  const applyFilters = () => {
    setPage(0);
    setUserIdFilter(userIdDraft.trim());
  };

  const clearUserFilter = () => {
    setUserIdDraft("");
    setPage(0);
    setUserIdFilter("");
  };

  return (
    <div className="container mx-auto max-w-7xl space-y-6 px-4 py-4 sm:py-6">
      <div className="space-y-1">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground/60">
          Admin
        </p>
        <h1 className="flex items-center gap-3 text-2xl font-bold tracking-tight sm:text-3xl">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-700 dark:text-blue-400">
            <Webhook className="h-5 w-5" />
          </span>
          Webhook Logs
        </h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Inspect every webhook callback received by the platform across all integrations and users.
        </p>
      </div>

      <Card className="rounded-xl border border-border/40 shadow-sm">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="w-full space-y-1.5 sm:min-w-[180px] sm:flex-1">
            <label htmlFor="webhook-platform" className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/60">
              Platform
            </label>
            <Select
              value={platform}
              onValueChange={(v) => {
                setPage(0);
                setPlatform(v);
              }}
            >
              <SelectTrigger id="webhook-platform" className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORMS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p === "all" ? "All platforms" : p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="w-full space-y-1.5 sm:min-w-[180px] sm:flex-1">
            <label htmlFor="webhook-user-id" className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/60">
              User ID
            </label>
            <Input
              type="number"
              id="webhook-user-id"
              value={userIdDraft}
              onChange={(e) => setUserIdDraft(e.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") applyFilters(); }}
              placeholder="Filter by user ID"
              className="h-10"
            />
          </div>

          <Button onClick={applyFilters} size="sm" variant="secondary" className="h-10 w-full gap-2 sm:w-auto">
            <Search className="h-3.5 w-3.5" />Apply user filter
          </Button>
          {(userIdDraft || userIdFilter) && (
            <Button onClick={clearUserFilter} size="sm" variant="ghost" className="h-10 w-full gap-2 sm:w-auto">
              <X className="h-3.5 w-3.5" />Clear user filter
            </Button>
          )}

          <Button
            onClick={handleRefresh}
            size="sm"
            variant="outline"
            loading={refreshing}
            loadingText="Refresh"
            className="h-10 w-full gap-2 sm:ml-auto sm:w-auto"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </CardContent>
      </Card>

      <Card className="rounded-xl border border-border/40 shadow-sm">
        <CardContent className="p-4 space-y-3">
          {loading ? (
            <LoadingState size="section" label="Loading webhook events…" />
          ) : events.length === 0 ? (
            <div className="text-center py-12 space-y-2">
              <div className="inline-flex w-12 h-12 rounded-xl bg-muted/40 items-center justify-center mx-auto">
                <Webhook className="h-6 w-6 text-muted-foreground/60" />
              </div>
              <p className="text-sm text-muted-foreground">No webhook events found.</p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                {events.map((evt) => (
                  <div
                    key={evt.id}
                    className="rounded-lg border border-border/40 bg-card/40 overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedId(expandedId === evt.id ? null : evt.id)
                      }
                      className="flex w-full flex-wrap items-center gap-2 p-3 text-left transition-colors hover:bg-muted/30 sm:gap-3"
                    >
                      {expandedId === evt.id ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                      {evt.processed ? (
                        <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
                      ) : evt.error ? (
                        <XCircle className="h-4 w-4 flex-shrink-0 text-red-600 dark:text-red-400" />
                      ) : (
                        <div className="h-2 w-2 rounded-full bg-amber-400 flex-shrink-0" />
                      )}
                      <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">
                        {evt.platform || "?"}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] font-mono">
                        {evt.event_type || "event"}
                      </Badge>
                      {evt.user_id && (
                        <span className="text-xs text-muted-foreground">user #{evt.user_id}</span>
                      )}
                      {evt.page_id && (
                        <span className="text-xs text-muted-foreground font-mono truncate">
                          page {evt.page_id}
                        </span>
                      )}
                      <span className="w-full text-xs text-muted-foreground sm:ml-auto sm:w-auto sm:whitespace-nowrap">
                        {evt.created_at ? new Date(evt.created_at).toLocaleString() : ""}
                      </span>
                    </button>
                    {expandedId === evt.id && (
                      <div className="border-t border-border/40 bg-muted/10 p-3 space-y-2">
                        {evt.error && (
                          <Callout tone="danger" size="sm" announce={false} title="Error">
                            {evt.error}
                          </Callout>
                        )}
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/60 mb-1">
                            Payload
                          </p>
                          <pre className="text-xs font-mono bg-muted/30 rounded p-3 overflow-x-auto max-h-96">
                            {JSON.stringify(evt.payload, null, 2)}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <Pagination
                className="pt-2"
                page={page + 1}
                pageSize={limit}
                totalItems={total}
                onPageChange={(next) => setPage(next - 1)}
                itemLabel="events"
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
