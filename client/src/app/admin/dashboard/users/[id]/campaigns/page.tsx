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
import { ArrowLeft, Megaphone } from "lucide-react";
import { formatMediumDate as formatDate } from "@/lib/display-format";

interface Campaign {
  id: number;
  name: string;
  status?: string;
  budget?: number;
  startDate?: string;
  start_date?: string;
  endDate?: string;
  end_date?: string;
  createdAt?: string;
  created_at?: string;
}

export default function UserCampaignsPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const fetchCampaigns = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<Campaign[] | { campaigns?: Campaign[]; data?: Campaign[] }>(`/api/admin/users/${id}/campaigns`);
      setCampaigns(
        Array.isArray(data)
          ? data
          : data.campaigns || data.data || []
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load campaigns";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  const filteredCampaigns = campaigns.filter((c) =>
    (c.name || "").toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (loading) {
    return <LoadingState size="page" label="Loading campaigns…" />;
  }

  if (loadError) {
    return <PageErrorState title="Campaigns could not be loaded" description={loadError} reset={() => void fetchCampaigns()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href={`/admin/dashboard/users/${id}/view`} aria-label="Back to user details">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">User Campaigns</h1>
          <p className="text-muted-foreground mt-1">
            Campaigns created by this user
          </p>
        </div>
      </div>

      <SearchInput
        aria-label="Search campaigns"
        placeholder="Search campaigns..."
        value={searchQuery}
        onValueChange={setSearchQuery}
        wrapperClassName="max-w-md"
      />

      {filteredCampaigns.length === 0 ? (
        <div className="text-center py-12">
          <Megaphone className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground">No campaigns found</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table className="min-w-[700px]">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Budget</TableHead>
                <TableHead>Start Date</TableHead>
                <TableHead>End Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredCampaigns.map((campaign) => (
                <TableRow key={campaign.id}>
                  <TableCell className="font-medium">
                    {campaign.name || "—"}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={campaign.status} toneOverrides={{ running: "success", completed: "info", finished: "info" }} />
                  </TableCell>
                  <TableCell>
                    {campaign.budget != null
                      ? `₹${campaign.budget.toLocaleString()}`
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {formatDate(campaign.startDate || campaign.start_date)}
                  </TableCell>
                  <TableCell>
                    {formatDate(campaign.endDate || campaign.end_date)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="text-sm text-muted-foreground">
        Showing {filteredCampaigns.length} of {campaigns.length} campaigns
      </div>
    </div>
  );
}
