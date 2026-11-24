"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { StatusBadge } from "@/components/ui/status-badge";
import { PageErrorState } from "@/components/ui/page-state";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { ArrowLeft, Users } from "lucide-react";

interface Lead {
  id: number;
  name?: string;
  email?: string;
  company?: string;
  score?: number;
  status?: string;
  source?: string;
}

export default function UserLeadsPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const fetchLeads = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<Lead[] | { leads?: Lead[]; data?: Lead[] }>(`/api/admin/users/${id}/leads`);
      setLeads(
        Array.isArray(data) ? data : data.leads || data.data || []
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load leads";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  const filteredLeads = leads.filter((l) => {
    const q = searchQuery.toLowerCase();
    return (
      (l.name || "").toLowerCase().includes(q) ||
      (l.email || "").toLowerCase().includes(q) ||
      (l.company || "").toLowerCase().includes(q)
    );
  });

  if (loading) {
    return <LoadingState size="page" label="Loading leads…" />;
  }


  if (loadError) {
    return <PageErrorState title="Leads could not be loaded" description={loadError} reset={() => void fetchLeads()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-start gap-2 sm:gap-4">
        <Button asChild variant="ghost" size="icon" className="shrink-0">
          <Link href={`/admin/dashboard/users/${id}/view`} aria-label="Back to user details">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="text-xl font-black tracking-tighter sm:text-2xl">User Leads</h1>
          <p className="text-muted-foreground mt-1">
            Leads managed by this user
          </p>
        </div>
      </div>

      <SearchInput
        aria-label="Search leads by name, email, or company"
        placeholder="Search leads by name, email, or company..."
        value={searchQuery}
        onValueChange={setSearchQuery}
        wrapperClassName="sm:max-w-md"
      />

      {filteredLeads.length === 0 ? (
        <div className="text-center py-12">
          <Users className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground">No leads found</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredLeads.map((lead) => (
                <TableRow key={lead.id}>
                  <TableCell className="font-medium">
                    {lead.name || "—"}
                  </TableCell>
                  <TableCell>{lead.email || "—"}</TableCell>
                  <TableCell>{lead.company || "—"}</TableCell>
                  <TableCell>
                    {lead.score != null ? (
                      <span
                        className={`font-medium ${
                          lead.score >= 80
                            ? "text-emerald-700 dark:text-emerald-400"
                            : lead.score >= 50
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-red-700 dark:text-red-400"
                        }`}
                      >
                        {lead.score}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell><StatusBadge status={lead.status} toneOverrides={{ qualified: "success", converted: "success", contacted: "info", unqualified: "danger" }} /></TableCell>
                  <TableCell>
                    <span className="text-muted-foreground">
                      {lead.source || "—"}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="text-sm text-muted-foreground">
        Showing {filteredLeads.length} of {leads.length} leads
      </div>
    </div>
  );
}
