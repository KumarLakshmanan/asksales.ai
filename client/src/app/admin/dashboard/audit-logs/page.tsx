"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, History, RefreshCw, Search } from "lucide-react";
import { api } from "@/lib/admin-api";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface AuditEntry {
  domain: "pricing" | "platform_access" | "credentials";
  source_id: string;
  action: string;
  target: string;
  admin_id: number | null;
  admin_name: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

interface AuditResponse { entries: AuditEntry[]; total: number; page: number; totalPages: number }

const DOMAIN_LABELS = { pricing: "Pricing", platform_access: "Platform access", credentials: "Credentials" } as const;

export default function AdminAuditLogsPage() {
  const [domain, setDomain] = useState("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ["admin-audit-logs", domain, search, page],
    queryFn: () => api.get<AuditResponse>("/api/admin/audit-logs", { params: { domain, search, page, limit: 50 } }),
    staleTime: 15_000,
  });

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-5 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3"><div className="rounded-xl bg-primary/10 p-2.5 text-primary"><History className="h-5 w-5" /></div><div><h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Administrator audit</h1><p className="mt-1 text-sm leading-6 text-muted-foreground">Immutable pricing, platform-access, and credential-control history. Secret and PII fields are redacted.</p></div></div>
        <Button variant="outline" onClick={() => void query.refetch()} loading={query.isFetching} loadingText="Refresh"><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
      </header>

      <div className="grid gap-3 sm:grid-cols-[200px_1fr_auto]">
        <Select value={domain} onValueChange={(value) => { setDomain(value); setPage(1); }}><SelectTrigger aria-label="Audit domain"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All domains</SelectItem><SelectItem value="pricing">Pricing</SelectItem><SelectItem value="platform_access">Platform access</SelectItem><SelectItem value="credentials">Credentials</SelectItem></SelectContent></Select>
        <Input aria-label="Search administrator audit" value={searchDraft} maxLength={200} placeholder="Search action, target, or administrator" onChange={(event) => setSearchDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { setSearch(searchDraft.trim()); setPage(1); } }} />
        <Button variant="secondary" onClick={() => { setSearch(searchDraft.trim()); setPage(1); }}><Search className="mr-2 h-4 w-4" />Search</Button>
      </div>

      {query.isError ? (
        <Alert variant="destructive"><AlertTitle>Audit history could not be loaded</AlertTitle><AlertDescription className="mt-2 flex items-center justify-between gap-3"><span>{query.error instanceof Error ? query.error.message : "Unknown error"}</span><Button variant="outline" size="sm" onClick={() => void query.refetch()}>Retry</Button></AlertDescription></Alert>
      ) : query.isLoading ? (
        <LoadingState size="section" className="min-h-64" label="Loading audit history…" />
      ) : !query.data?.entries.length ? (
        <Card><CardContent className="py-14 text-center">
          <History className="mx-auto h-9 w-9 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">{page > 1
            ? "No audit events on this page. Return to an earlier page or change the filters."
            : "No audit events match these filters."}</p>
          {page > 1 && <Button className="mt-4" variant="outline" onClick={() => setPage(1)}>Return to first page</Button>}
        </CardContent></Card>
      ) : (
        <div className="space-y-3">
          {query.data.entries.map((entry) => (
            <Card key={`${entry.domain}-${entry.source_id}`} className="border-border/70 shadow-none"><CardContent className="p-4 sm:p-5"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{DOMAIN_LABELS[entry.domain]}</Badge><Badge variant="secondary" className="capitalize">{entry.action.replaceAll("_", " ")}</Badge><span className="break-all text-sm font-medium">{entry.target}</span></div><details className="mt-3"><summary className="cursor-pointer text-xs font-medium text-primary">View redacted details</summary><pre className="mt-2 max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{JSON.stringify(entry.details, null, 2)}</pre></details></div><div className="shrink-0 text-xs text-muted-foreground sm:text-right"><p>{entry.admin_name || "System"}</p><time dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleString()}</time></div></div></CardContent></Card>
          ))}
        </div>
      )}

      {query.data && (query.data.totalPages > 1 || page > 1) && <div className="flex items-center justify-center gap-3"><Button variant="outline" size="sm" disabled={page <= 1 || query.isFetching} onClick={() => setPage((value) => value - 1)}><ChevronLeft className="mr-1 h-4 w-4" />Previous</Button><span className="text-sm text-muted-foreground">Page {page}{page <= query.data.totalPages && <> of {query.data.totalPages}</>} · {query.data.total.toLocaleString()} matching {query.data.total === 1 ? "event" : "events"}</span><Button variant="outline" size="sm" disabled={page >= query.data.totalPages || query.isFetching} onClick={() => setPage((value) => value + 1)}>Next<ChevronRight className="ml-1 h-4 w-4" /></Button></div>}
    </main>
  );
}
