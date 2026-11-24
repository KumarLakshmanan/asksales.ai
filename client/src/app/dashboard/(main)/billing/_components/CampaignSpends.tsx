"use client";
import { useBillingOrganizations } from "@/hooks/use-billing-organizations";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBillingApi } from "@/hooks/use-billing-api";
import {
  BarChart2,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Clock,
  MessageSquare,
  PieChart,
  X,
  Zap,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  BILLING_PROVIDER_META,
  getBillingReferenceMeta,
} from "./billingMetadata";
import { type ReferenceGroup, type EventLog, timeAgo, formatCredits, formatApiCost, getRefTitle, getRefKey } from "./billingFormat";
import { usageCredits } from "@/lib/usageCredits";

// ─── Component ───────────────────────────────────────────────────────────────

export default function CampaignSpends() {
  const api = useBillingApi();
  const { billingScopeKey } = useBillingOrganizations();
  const [search, setSearch] = useState("");
  const [selectedRef, setSelectedRef] = useState<ReferenceGroup | null>(null);
  const [detailsPage, setDetailsPage] = useState(0);
  const detailsLimit = 50;

  // ── Fetch all spending references (all categories) ──
  const { data: refsData, isLoading: refsLoading, isError: refsError, refetch: refetchRefs } = useQuery<{
    groups: ReferenceGroup[];
    total: number;
    totalCreditsSum: number;
    totalEventsSum: number;
  }>({
    queryKey: ["wallet-drilldown-campaign-refs", billingScopeKey],
    queryFn: () =>
      api.get<{ groups: ReferenceGroup[]; total: number; totalCreditsSum: number; totalEventsSum: number }>(
        `/api/wallet/drilldown/references?limit=200`
      ),
  });

  const allRefs = useMemo(() => refsData?.groups ?? [], [refsData]);

  // ── Fetch credit events for selected reference ──
  const { data: creditData, isLoading: creditLoading, isError: creditError, refetch: refetchCredits } = useQuery<{
    logs: EventLog[];
    total: number;
  }>({
    queryKey: ["campaign-ref-credits", billingScopeKey, selectedRef?.referenceType, selectedRef?.referenceId, detailsPage],
    queryFn: async () => {
      const params = new URLSearchParams({
        referenceType: selectedRef!.referenceType,
        referenceId: selectedRef!.referenceId,
        limit: String(detailsLimit),
        offset: String(detailsPage * detailsLimit),
      });
      return api.get<{ logs: EventLog[]; total: number }>(
        `/api/wallet/drilldown/details?${params.toString()}`
      );
    },
    enabled: !!selectedRef,
  });

  // ── Filtered references (latest first) ──
  const filteredRefs = useMemo(() => {
    let filtered = allRefs;
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          (r.title || "").toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q) ||
          r.referenceId.toLowerCase().includes(q)
      );
    }
    return [...filtered].sort((a, b) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime());
  }, [allRefs, search]);

  // ── Stats ──
  const stats = useMemo(() => {
    if (!refsData) return { totalRefs: 0, totalCredits: 0, totalEvents: 0 };
    return {
      totalRefs: refsData.total || allRefs.length,
      totalCredits: refsData.totalCreditsSum ?? allRefs.reduce((sum, r) => sum + r.totalCredits, 0),
      totalEvents: refsData.totalEventsSum ?? allRefs.reduce((sum, r) => sum + r.eventCount, 0),
    };
  }, [refsData, allRefs]);

  // ── Loading ──
  if (refsLoading) {
    return (
      <LoadingState size="section" className="py-16" label="Loading campaign spending…" />
    );
  }

  if (refsError) {
    return (
      <Card><CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <AlertTriangle className="h-9 w-9 text-destructive/70" />
        <p className="text-sm text-muted-foreground">Campaign spending could not be loaded.</p>
        <Button variant="outline" size="sm" onClick={() => void refetchRefs()}>Try again</Button>
      </CardContent></Card>
    );
  }

  if (!allRefs.length) {
    return (
      <Card className="border-dashed border-2">
        <CardContent className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <PieChart className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm font-medium">No spending data yet</p>
          <p className="text-xs mt-1">Credit usage will appear here once you start using campaigns and features.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex h-[calc(100vh-180px)] min-h-[560px] flex-col overflow-hidden rounded-xl border bg-background md:flex-row">
      {/* ─── Left Drawer: Transaction Details ─── */}
      <div
        className={cn(
          "border-r bg-card transition-all duration-300 ease-in-out overflow-hidden flex flex-col",
          selectedRef
            ? "h-[45%] w-full min-w-0 border-b md:h-auto md:w-[420px] md:min-w-[420px] md:border-b-0"
            : "h-0 w-full min-w-0 border-b-0 md:h-auto md:w-0"
        )}
      >
        {selectedRef && (() => {
          const meta = getBillingReferenceMeta(selectedRef.referenceType);
          return (
            <>
              {/* Drawer Header */}
              <div className="p-5 border-b bg-gradient-to-b from-muted/40 to-background">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-bold text-base truncate pr-2">{getRefTitle(selectedRef)}</h3>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full shrink-0"
                    onClick={() => { setSelectedRef(null); setDetailsPage(0); }}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>

                <div className="flex items-center gap-2 mb-4">
                  <Badge variant="outline" className={cn("text-xs border gap-1", meta.color)}>
                    {meta.icon}
                    {meta.label}
                  </Badge>
                  <span className="text-xs text-muted-foreground font-mono">
                    #{selectedRef.referenceId}
                  </span>
                </div>

                {selectedRef.description && (
                  <p className="text-sm text-muted-foreground leading-relaxed mb-4">{selectedRef.description}</p>
                )}

                {/* Key Metrics */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 rounded-xl bg-background border">
                    <p className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-1">Credits</p>
                    <p className="text-lg font-bold text-red-600 dark:text-red-400">{formatCredits(selectedRef.totalCredits)}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-background border">
                    <p className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-1">Events</p>
                    <p className="text-lg font-bold">{selectedRef.eventCount}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-background border">
                    <p className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-1">Last Used</p>
                    <p className="text-sm font-bold">{timeAgo(selectedRef.lastUsed)}</p>
                  </div>
                </div>
              </div>

              {/* Credit Usage Events */}
              <div className="flex-1 overflow-hidden flex flex-col">
                <div className="px-5 py-3 border-b">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    Transactions
                    {creditData?.total ? (
                      <span className="ml-1.5 text-foreground">({creditData.total})</span>
                    ) : null}
                  </h4>
                </div>

                <ScrollArea className="flex-1">
                  {creditLoading ? (
                    <LoadingState size="section" label="Loading transaction details…" />
                  ) : creditError ? (
                    <div className="flex flex-col items-center gap-2 p-8 text-center text-muted-foreground">
                      <AlertTriangle className="h-7 w-7 text-destructive/70" />
                      <p className="text-sm">Transaction details could not be loaded.</p>
                      <Button variant="outline" size="sm" onClick={() => void refetchCredits()}>Try again</Button>
                    </div>
                  ) : !creditData?.logs?.length ? (
                    <div className="p-8 text-center text-muted-foreground">
                      <Zap className="w-8 h-8 mx-auto mb-2 opacity-20" />
                      <p className="text-sm">No transactions found</p>
                    </div>
                  ) : (
                    <div className="p-3 space-y-2">
                      {creditData.logs.map((ev) => {
                        const provMeta = BILLING_PROVIDER_META[ev.apiProvider || "platform"] || BILLING_PROVIDER_META.platform;
                        const isApify = ev.apiProvider === "apify";
                        const meta = ev.metadata as Record<string, unknown> | null;
                        return (
                          <div
                            key={ev.id}
                            className="p-3 rounded-xl border bg-background hover:bg-muted/30 transition-colors"
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <Badge variant="outline" className="text-xs px-1.5 py-0 h-5">
                                {ev.eventKey}
                              </Badge>
                              <span className={`text-sm font-bold ${usageCredits(ev.creditsUsed).className}`}>
                                {usageCredits(ev.creditsUsed).label}
                              </span>
                            </div>
                            {ev.description && (
                              <p className="text-xs text-muted-foreground line-clamp-2 mb-1.5">{ev.description}</p>
                            )}
                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                              <span className={cn("flex items-center gap-1 font-medium", provMeta.color)}>
                                {provMeta.icon}
                                {provMeta.label}
                              </span>
                              {ev.service && <span>{ev.service}</span>}
                              <span className="ml-auto flex items-center gap-0.5">
                                <Clock className="w-3 h-3" />
                                {timeAgo(ev.createdAt)}
                              </span>
                            </div>

                            {/* Apify breakdown */}
                            {isApify && meta && (
                              <div className="mt-2 pt-2 border-t border-dashed space-y-1">
                                {String(meta.actorName ?? "") && (
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-muted-foreground">Actor</span>
                                    <span className="font-mono font-medium truncate ml-2 max-w-[200px]">{String(meta.actorName)}</span>
                                  </div>
                                )}
                                {String(meta.runId ?? "") && (
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-muted-foreground">Run ID</span>
                                    <span className="font-mono text-muted-foreground truncate ml-2 max-w-[200px]">{String(meta.runId)}</span>
                                  </div>
                                )}
                                {meta.itemsScraped != null && (
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-muted-foreground">Items Scraped</span>
                                    <span className="font-medium">{Number(meta.itemsScraped).toLocaleString()}</span>
                                  </div>
                                )}
                                {ev.apiCostCents != null && ev.apiCostCents > 0 && (
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-muted-foreground">API Cost</span>
                                    <span className="font-medium text-amber-600 dark:text-amber-400">{formatApiCost(ev.apiCostCents)}</span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </ScrollArea>

                {/* Drawer Pagination */}
                {(creditData?.total || 0) > detailsLimit && (
                  <div className="px-5 py-3 border-t">
                    <div className="flex items-center justify-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDetailsPage((p) => p - 1)}
                        disabled={detailsPage === 0}
                        className="w-8 h-8 p-0"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </Button>
                      <span className="text-xs text-muted-foreground px-2">
                        {detailsPage + 1} / {Math.ceil(creditData!.total / detailsLimit)}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDetailsPage((p) => p + 1)}
                        disabled={detailsPage + 1 >= Math.ceil(creditData!.total / detailsLimit)}
                        className="w-8 h-8 p-0"
                      >
                        <ChevronRight className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </>
          );
        })()}
      </div>

      {/* ─── Main Content: Campaign List ─── */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-5xl mx-auto p-6 space-y-6">
          {/* Stats Cards */}
          <StatGrid columns={3}>
            <StatCard label="Total Campaigns" value={stats.totalRefs} icon={<MessageSquare />} />
            <StatCard label="Credits Used" value={formatCredits(stats.totalCredits)} icon={<Zap />} />
            <StatCard label="Total Events" value={stats.totalEvents.toLocaleString()} icon={<BarChart2 />} />
          </StatGrid>

          {/* Search */}
          <div className="flex items-center gap-3 flex-wrap">
            <SearchInput
              aria-label="Search campaigns"
              value={search}
              onValueChange={setSearch}
              placeholder="Search by name or ID..."
              wrapperClassName="max-w-md flex-1"
            />
          </div>

          {/* Campaign List */}
          {!filteredRefs.length ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center py-16 text-muted-foreground">
                <Zap className="w-8 h-8 mb-2 opacity-20" />
                <p className="text-sm font-medium">No campaigns found</p>
                <p className="text-xs mt-1">Try adjusting your search or filters.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {filteredRefs.map((ref) => {
                const meta = getBillingReferenceMeta(ref.referenceType);
                const isSelected = selectedRef && getRefKey(selectedRef) === getRefKey(ref);
                return (
                  <button
                    key={getRefKey(ref)}
                    onClick={() => {
                      setSelectedRef(isSelected ? null : ref);
                      setDetailsPage(0);
                    }}
                    className={cn(
                      "w-full text-left flex items-center justify-between p-4 rounded-xl border transition-all group",
                      isSelected
                        ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                        : "border-border bg-card hover:border-primary/30 hover:shadow-sm"
                    )}
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div className={cn(
                        "w-11 h-11 rounded-xl flex items-center justify-center shrink-0 text-white",
                        isSelected ? "bg-primary" : meta.bgColor
                      )}>
                        {meta.icon}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate">{getRefTitle(ref)}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <Badge variant="outline" className={cn("text-xs px-1.5 py-0 h-4 border", meta.color)}>
                            {meta.label}
                          </Badge>
                          <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                            <Clock className="w-3 h-3" />
                            {timeAgo(ref.lastUsed)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {ref.eventCount} event{ref.eventCount !== 1 ? "s" : ""}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <div className="text-right">
                        <p className="text-sm font-bold text-red-600 dark:text-red-400">
                          -{formatCredits(ref.totalCredits)}
                        </p>
                        <p className="text-xs text-muted-foreground">credits</p>
                      </div>
                      <ChevronRight className={cn(
                        "w-4 h-4 transition-colors",
                        isSelected ? "text-primary" : "text-muted-foreground/30 group-hover:text-primary/50"
                      )} />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
