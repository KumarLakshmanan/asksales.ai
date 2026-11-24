"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/admin-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Pagination } from "@/components/ui/pagination";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertCircle, History, RefreshCw } from "lucide-react";

type AuditDomain = "credit_pricing" | "api_pricing" | "storage_pricing" | "storage_plan";

interface AuditEntry {
  id: number;
  domain: AuditDomain;
  recordId: number | null;
  pricingKey: string | null;
  action: "create" | "update" | "delete" | "seed";
  adminId: number | null;
  adminName: string | null;
  adminEmail: string | null;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
  effectiveAt: string;
  createdAt: string;
}

interface AuditPage {
  entries: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

const DOMAIN_LABELS: Record<AuditDomain, string> = {
  credit_pricing: "Credit pricing",
  api_pricing: "API pricing",
  storage_pricing: "Storage pricing",
  storage_plan: "Storage plan",
};

const IGNORED_DIFF_FIELDS = new Set(["id", "createdAt", "updatedAt", "metadata"]);

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function changedFields(entry: AuditEntry) {
  const before = entry.beforeValue ?? {};
  const after = entry.afterValue ?? {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => !IGNORED_DIFF_FIELDS.has(key))
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => ({ key, before: before[key], after: after[key] }));
}

export default function PricingHistoryPage() {
  const [domain, setDomain] = useState<AuditDomain | "all">("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const pageSize = 50;
  const query = useQuery({
    queryKey: ["admin-pricing-audit", domain, page],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
      if (domain !== "all") params.set("domain", domain);
      return api.get<AuditPage>(`/api/admin/pricing-audit?${params.toString()}`);
    },
  });
  const data = query.data;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold"><History className="h-6 w-6 text-primary" />Pricing history</h1>
          <p className="mt-1 text-sm text-muted-foreground">Immutable, immediately effective changes to credit, API, and storage pricing.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={domain} onValueChange={(value) => { setDomain(value as AuditDomain | "all"); setPage(0); }}>
            <SelectTrigger className="w-full sm:w-[190px]" aria-label="Filter pricing domain"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All pricing domains</SelectItem>
              {Object.entries(DOMAIN_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>
            <RefreshCw className={`mr-2 h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />Refresh
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Change log {data ? `(${data.total})` : ""}</CardTitle>
          <CardDescription>Every recorded change takes effect at the listed timestamp.</CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <LoadingState size="section" className="py-16" label="Loading pricing history…" />
          ) : query.isError ? (
            <div className="flex flex-col items-center py-14 text-center">
              <AlertCircle className="mb-3 h-9 w-9 text-destructive" />
              <p className="font-medium">Pricing history could not be loaded</p>
              <p className="mt-1 text-sm text-muted-foreground">No pricing records were changed.</p>
              <Button className="mt-4" variant="outline" onClick={() => query.refetch()}>Try again</Button>
            </div>
          ) : !data?.entries.length ? (
            <div className="flex flex-col items-center py-14 text-center text-muted-foreground">
              <History className="mb-3 h-10 w-10 opacity-40" />
              <p className="font-medium text-foreground">No pricing changes recorded</p>
              <p className="mt-1 text-sm">Changes made after migration 140 will appear here.</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border">
                <Table className="min-w-[850px]">
                  <TableHeader><TableRow><TableHead>Effective</TableHead><TableHead>Domain</TableHead><TableHead>Record</TableHead><TableHead>Action</TableHead><TableHead>Changed by</TableHead><TableHead>Summary</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {data.entries.map((entry) => {
                      const changes = changedFields(entry);
                      return (
                        <TableRow key={entry.id} className="cursor-pointer" onClick={() => setSelected(entry)}>
                          <TableCell className="whitespace-nowrap text-sm">{new Date(entry.effectiveAt).toLocaleString()}</TableCell>
                          <TableCell><Badge variant="outline">{DOMAIN_LABELS[entry.domain]}</Badge></TableCell>
                          <TableCell><div className="font-medium">{entry.pricingKey || `#${entry.recordId}`}</div><div className="text-xs text-muted-foreground">Record #{entry.recordId ?? "—"}</div></TableCell>
                          <TableCell><Badge variant={entry.action === "delete" ? "destructive" : "secondary"} className="capitalize">{entry.action}</Badge></TableCell>
                          <TableCell><div className="text-sm">{entry.adminName || "System"}</div><div className="text-xs text-muted-foreground">{entry.adminEmail || "Automated seed"}</div></TableCell>
                          <TableCell className="max-w-[300px] truncate text-sm text-muted-foreground">{changes.slice(0, 2).map((change) => change.key).join(", ") || "Record state captured"}{changes.length > 2 ? ` +${changes.length - 2}` : ""}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <Pagination
                className="mt-4"
                page={page + 1}
                pageSize={pageSize}
                totalItems={data.total}
                onPageChange={(next) => setPage(next - 1)}
                itemLabel="changes"
              />
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>Pricing change details</DialogTitle><DialogDescription>{selected ? `${DOMAIN_LABELS[selected.domain]} · ${new Date(selected.effectiveAt).toLocaleString()}` : ""}</DialogDescription></DialogHeader>
          {selected && (
            <div className="space-y-3">
              {changedFields(selected).length === 0 ? <p className="text-sm text-muted-foreground">The complete record state was captured without a field-level difference.</p> : changedFields(selected).map((change) => (
                <div key={change.key} className="rounded-lg border p-3">
                  <p className="mb-2 text-sm font-medium">{change.key}</p>
                  <div className="grid gap-2 text-xs sm:grid-cols-2"><div className="rounded bg-muted p-2"><span className="block text-muted-foreground">Before</span><span className="break-all">{displayValue(change.before)}</span></div><div className="rounded bg-muted p-2"><span className="block text-muted-foreground">After</span><span className="break-all">{displayValue(change.after)}</span></div></div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
