"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Download, Plus, Trash2 } from "lucide-react";
import api from "@/lib/admin-api";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { useToast } from "@/hooks/use-toast";
import type {
  AdminDirectoryLead,
  AdminLeadDirectoryResponse,
} from "../../../../shared/adminLeadDirectory";

const nameOf = (lead: AdminDirectoryLead) =>
  lead.name ||
  [lead.firstName, lead.lastName].filter(Boolean).join(" ") ||
  "Unnamed lead";
const selectClass = "h-10 rounded-md border bg-background px-3 text-sm";

/** Both admin entry points use the same server-filtered directory and export. */
export function AdminLeadWorkspace({
  mode = "manage",
}: {
  mode?: "manage" | "inventory";
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [sortBy, setSortBy] = useState("created_at_desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [response, setResponse] = useState<AdminLeadDirectoryResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState<number>();
  const [revision, setRevision] = useState(0);
  const exportLock = useRef(false);
  useEffect(() => {
    if (search.trim() === debouncedSearch) return;
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search, debouncedSearch]);
  const filterQuery = useCallback(() => {
    const query = new URLSearchParams({ sortBy });
    if (debouncedSearch) query.set("search", debouncedSearch);
    if (status) query.set("status", status);
    if (source) query.set("source", source);
    return query;
  }, [debouncedSearch, status, source, sortBy]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    const query = filterQuery();
    query.set("page", String(page));
    query.set("pageSize", String(pageSize));
    void api
      .get<AdminLeadDirectoryResponse>(`/api/admin/leads?${query}`)
      .then((data) => {
        if (!alive) return;
        setResponse(data);
        if (data.pagination.page !== page) setPage(data.pagination.page);
      })
      .catch((failure) => {
        if (alive)
          setError(
            failure instanceof Error
              ? failure.message
              : "Leads could not be loaded",
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [filterQuery, page, pageSize, revision]);
  const exportCsv = async () => {
    if (exportLock.current) return;
    exportLock.current = true;
    setExporting(true);
    try {
      const csv = await api.get<string>(
        `/api/admin/leads/export?${filterQuery()}`,
      );
      if (typeof csv !== "string")
        throw new Error("Export returned an invalid file");
      const url = URL.createObjectURL(
        new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "leads.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast({
        title: "Export downloaded",
        description: "Includes all leads matching the current filters.",
      });
    } catch (failure) {
      toast({
        title: "Export failed",
        description: failure instanceof Error ? failure.message : "Try again",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
      exportLock.current = false;
    }
  };
  const remove = async (id: number) => {
    if (deleting !== undefined) return;
    setDeleting(id);
    try {
      await api.delete(`/api/admin/leads/${id}`);
      setRevision((value) => value + 1);
      toast({ title: "Lead deleted" });
    } catch (failure) {
      toast({
        title: "Deletion failed",
        description: failure instanceof Error ? failure.message : "Try again",
        variant: "destructive",
      });
    } finally {
      setDeleting(undefined);
    }
  };
  const stats = response?.stats;
  return (
    <div className="space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {mode === "inventory" ? "Master lead database" : "Lead management"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Search the full lead directory, review matching totals, and export
            the current selection.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            loading={exporting}
            loadingText="Exporting…"
            disabled={loading || !!error}
            onClick={() => void exportCsv()}
          >
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          <Button asChild>
            <Link href="/admin/dashboard/leads/new">
              <Plus className="h-4 w-4" />
              Create lead
            </Link>
          </Button>
        </div>
      </header>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Matching leads", stats?.totalLeads],
          [
            mode === "inventory" ? "Qualified" : "Active",
            mode === "inventory" ? stats?.qualified : stats?.active,
          ],
          ["Converted", stats?.converted],
          ["Conversion rate", stats ? `${stats.conversionRate}%` : undefined],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">{label}</p>
              <p className="mt-2 text-2xl font-semibold">
                {loading || error ? "—" : (value ?? "—")}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        <Input
          className="min-w-60 flex-1"
          aria-label="Search all leads"
          placeholder="Search name, email, company, job title…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="Lead status"
          className={selectClass}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {response?.filters.statuses.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          aria-label="Lead source"
          className={selectClass}
          value={source}
          onChange={(event) => {
            setSource(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All sources</option>
          {response?.filters.sources.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort leads"
          className={selectClass}
          value={sortBy}
          onChange={(event) => {
            setSortBy(event.target.value);
            setPage(1);
          }}
        >
          <option value="created_at_desc">Newest first</option>
          <option value="created_at_asc">Oldest first</option>
          <option value="score_desc">Highest score</option>
          <option value="score_asc">Lowest score</option>
          <option value="name_asc">Name A–Z</option>
          <option value="name_desc">Name Z–A</option>
        </select>
      </div>
      {error ? (
        <div role="alert" className="rounded-lg border p-5">
          <p>{error}</p>
          <Button
            className="mt-3"
            variant="outline"
            onClick={() => setRevision((value) => value + 1)}
          >
            Retry leads
          </Button>
        </div>
      ) : loading ? (
        <div role="status" className="flex items-center gap-3 p-8">
          <Spinner size="md" label={null} />
          Loading leads…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {[
                  "Name",
                  "Email / phone",
                  "Company",
                  "Job title",
                  "Score",
                  "Status",
                  "Source",
                  "Owner",
                  "Created",
                  "Actions",
                ].map((label) => (
                  <TableHead key={label}>{label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {!response?.items.length ? (
                <TableRow>
                  <TableCell colSpan={10} className="p-8 text-center">
                    No matching leads
                  </TableCell>
                </TableRow>
              ) : (
                response.items.map((lead) => (
                  <TableRow key={lead.id}>
                    <TableCell className="font-medium">
                      {nameOf(lead)}
                    </TableCell>
                    <TableCell>
                      <p>{lead.email || "—"}</p>
                      <p className="text-xs text-muted-foreground">
                        {lead.phone}
                      </p>
                    </TableCell>
                    <TableCell>
                      {lead.company || lead.companyName || "—"}
                    </TableCell>
                    <TableCell>{lead.jobTitle || "—"}</TableCell>
                    <TableCell>{lead.score}</TableCell>
                    <TableCell>{lead.status}</TableCell>
                    <TableCell>{lead.source}</TableCell>
                    <TableCell>
                      {lead.userName || lead.userEmail || "—"}
                    </TableCell>
                    <TableCell>
                      {new Date(lead.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Delete ${nameOf(lead)}`}
                            disabled={deleting !== undefined}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete lead?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Delete {nameOf(lead)} from the lead directory?
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => void remove(lead.id)}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
      {/* Hidden until the first page arrives and on errors, so a failed load never reads as "No matching leads". */}
      {response && !error ? (
        <Pagination
          aria-label="Lead pages"
          page={page}
          pageSize={pageSize}
          totalItems={response.pagination.total}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          pageSizeOptions={[10, 20, 50, 100]}
          itemLabel="matching leads"
          disabled={loading}
        />
      ) : null}
    </div>
  );
}
