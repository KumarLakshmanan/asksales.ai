"use client";
import { getBillingProviderMeta } from "@/app/dashboard/(main)/billing/_components/billingMetadata";
import { useProviderCreditUsage } from "@/hooks/use-provider-credit-usage";
import { useBillingOrganizations } from "@/hooks/use-billing-organizations";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useBillingApi } from "@/hooks/use-billing-api";
import {
  ArrowLeft,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { Badge } from "@/components/ui/badge";
import { PageErrorState } from "@/components/ui/page-state";
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
import { type EventLog, formatApiCost } from "../_components/billingFormat";
import { usageCredits } from "@/lib/usageCredits";

// ─── Page ────────────────────────────────────────────────────────────────────

export default function SpendingByProviderPage() {
  const api = useBillingApi();
  const { billingScopeKey } = useBillingOrganizations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialProvider = searchParams.get("provider") || "";

  const [selectedProvider, setSelectedProvider] = useState(initialProvider);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const limit = 50;

  // Provider usage summary
  const { data: providerData, isLoading: provLoading, isError: providerError, refetch: refetchProviders } = useProviderCreditUsage();

  // Event logs for selected provider
  const { data: eventsData, isLoading: eventsLoading, isError: eventsError, refetch: refetchEvents } = useQuery<{
    logs: EventLog[];
    total: number;
  }>({
    queryKey: ["provider-events", billingScopeKey, selectedProvider, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(page * limit),
      });
      if (selectedProvider) params.set("apiProvider", selectedProvider);
      const res = await api.get<{ logs: EventLog[]; total: number }>(
        `/api/wallet/event-logs?${params.toString()}`
      );
      return res;
    },
    enabled: !!selectedProvider,
  });

  const filteredLogs = (eventsData?.logs || []).filter((e) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      e.eventKey.toLowerCase().includes(q) ||
      (e.description?.toLowerCase().includes(q) ?? false) ||
      (e.service?.toLowerCase().includes(q) ?? false)
    );
  });

  const isLoading = provLoading || eventsLoading;

  if (providerError) {
    return (
      <PageErrorState
        title="Provider spending could not be loaded"
        description="The provider usage summary is unavailable. No spending totals are being inferred from missing data."
        reset={() => void refetchProviders()}
      />
    );
  }

  return (
    <div className="page-shell space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => router.push("/dashboard/billing")} className="gap-1.5 -ml-2">
          <ArrowLeft className="w-4 h-4" /> Billing
        </Button>
        <div className="h-5 w-px bg-border" />
        <div>
          <h1 className="text-xl font-bold text-foreground">Spending by Provider</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">View credit transactions grouped by API provider</p>
        </div>
      </div>

      {/* Provider selector + Search */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select
          value={selectedProvider || "select"}
          onValueChange={(v) => {
            setSelectedProvider(v === "select" ? "" : v);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-full sm:w-[200px]" aria-label="Select API provider">
            <SelectValue placeholder="Select a provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="select" disabled>Select a provider</SelectItem>
            {[...(providerData || [])]
              .sort((a, b) => b.totalCredits - a.totalCredits)
              .map((p) => {
                const meta = getBillingProviderMeta(p.apiProvider);
                return (
                  <SelectItem key={p.apiProvider} value={p.apiProvider}>
                    {meta.label} ({p.totalCredits.toLocaleString()} credits)
                  </SelectItem>
                );
              })}
          </SelectContent>
        </Select>

        {selectedProvider && (
          <SearchInput
            aria-label="Search provider transactions"
            value={search}
            onValueChange={setSearch}
            placeholder="Search by event, description, or service..."
            wrapperClassName="max-w-md flex-1"
          />
        )}
      </div>

      {/* Provider summary cards */}
      {!selectedProvider && !provLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...(providerData || [])]
            .sort((a, b) => b.totalCredits - a.totalCredits)
            .map((p) => {
              const meta = getBillingProviderMeta(p.apiProvider);
              return (
                <button
                  key={p.apiProvider}
                  onClick={() => { setSelectedProvider(p.apiProvider); setPage(0); }}
                  className={`text-left p-4 rounded-xl border ${meta.bg} hover:shadow-md transition-shadow`}
                >
                  <div className="flex items-center gap-2.5 mb-2">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${meta.bg} ${meta.color}`}>
                      {meta.icon}
                    </div>
                    <span className="text-sm font-semibold text-foreground">{meta.label}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className={`text-lg font-bold ${meta.color}`}>{p.totalCredits.toLocaleString()}</span>
                    <span className="text-xs text-muted-foreground">{p.eventCount} events</span>
                  </div>
                  {p.totalApiCostCents > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">API cost: {formatApiCost(p.totalApiCostCents)}</p>
                  )}
                </button>
              );
            })}
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <LoadingState size="section" className="py-16" label="Loading provider spending…" />
      )}

      {/* Transaction table for selected provider */}
      {selectedProvider && !eventsLoading && eventsError && (
        <Callout
          tone="danger"
          title="Transactions for this provider could not be loaded."
          actions={<Button variant="outline" size="sm" onClick={() => void refetchEvents()}>Try again</Button>}
        />
      )}

      {selectedProvider && !eventsLoading && !eventsError && (
        <>
          <div className="overflow-x-auto rounded-xl border">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[200px]">Event</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead className="text-right">Credits</TableHead>
                  <TableHead className="text-right">API Cost</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="text-right">Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLogs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                      No transactions found for this provider
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredLogs.map((ev) => {
                    const isApify = ev.apiProvider === "apify";
                    const meta = ev.metadata as Record<string, unknown> | null;
                    return (
                    <TableRow key={ev.id}>
                      <TableCell>
                        <Badge variant="outline" className="text-xs px-1.5 py-0">{ev.eventKey}</Badge>
                      </TableCell>
                      <TableCell className="max-w-[250px] text-sm text-foreground">
                        <span className="truncate block">{ev.description || "—"}</span>
                        {isApify && meta && (
                          <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                            {String(meta.actorName ?? "") && (
                              <div>Actor: <span className="font-mono font-medium text-foreground">{String(meta.actorName)}</span></div>
                            )}
                            {String(meta.runId ?? "") && (
                              <div>Run: <span className="font-mono">{String(meta.runId)}</span></div>
                            )}
                            {meta.itemsScraped != null && (
                              <div>Items: <span className="font-medium">{Number(meta.itemsScraped).toLocaleString()}</span></div>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{ev.service || "—"}</TableCell>
                      <TableCell className={`text-right text-sm font-semibold ${usageCredits(ev.creditsUsed).className}`}>
                        {usageCredits(ev.creditsUsed).label}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {(ev.apiCostCents ?? 0) > 0 ? formatApiCost(ev.apiCostCents || 0) : "—"}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {parseFloat(ev.balanceAfter).toLocaleString()}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-sm text-muted-foreground">
                        <span className="flex items-center justify-end gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(ev.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </TableCell>
                    </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {(eventsData?.total || 0) > limit && (
            <Pagination
              className="border-t border-border pt-4"
              page={page + 1}
              pageSize={limit}
              totalItems={eventsData?.total || 0}
              onPageChange={(next) => setPage(next - 1)}
              itemLabel="events"
            />
          )}
        </>
      )}
    </div>
  );
}
