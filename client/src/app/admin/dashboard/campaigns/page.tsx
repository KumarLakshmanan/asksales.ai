"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { StatusBadge } from "@/components/ui/status-badge";
import { SearchInput } from "@/components/ui/search-input";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
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
import { PageErrorState } from "@/components/ui/page-state";
import {
  BarChart3,
  Archive,
  Plus,
  IndianRupee,
  Users,
  TrendingUp,
} from "lucide-react";
import { formatMediumDate as formatDate } from "@/lib/display-format";

interface Campaign {
  id: number;
  name?: string;
  goal?: string;
  status?: string;
  budget?: number;
  spent?: number;
  startDate?: string;
  start_date?: string;
  endDate?: string;
  end_date?: string;
  leadsCount?: number;
  leads_count?: number;
  createdAt?: string;
  created_at?: string;
  userId?: number;
  userName?: string;
  userEmail?: string;
}

interface StatsData {
  totalCampaigns: number;
  active: number;
  totalSpend: number;
  totalLeads: number;
}

interface CampaignResponse {
  campaigns?: Campaign[];
  data?: Campaign[];
  stats?: StatsData;
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [stats, setStats] = useState<StatsData>({
    totalCampaigns: 0,
    active: 0,
    totalSpend: 0,
    totalLeads: 0,
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("current");
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const { toast } = useToast();

  const fetchCampaigns = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<CampaignResponse | Campaign[]>("/api/admin/campaigns");
      const campaignsList = Array.isArray(data)
        ? data
        : data.campaigns || data.data || [];
      setCampaigns(campaignsList);

      if (!Array.isArray(data) && data.stats) {
        setStats(data.stats);
      } else {
        computeStats(campaignsList);
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load campaigns";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const computeStats = (campaignsList: Campaign[]) => {
    const total = campaignsList.length;
    const active = campaignsList.filter(
      (c) =>
        c.status?.toLowerCase() === "active" ||
        c.status?.toLowerCase() === "running"
    ).length;
    const totalSpend = campaignsList.reduce(
      (sum, c) => sum + Number(c.spent ?? 0),
      0,
    );
    const totalLeads = campaignsList.reduce(
      (sum, c) => sum + (c.leadsCount || c.leads_count || 0),
      0
    );
    setStats({ totalCampaigns: total, active, totalSpend, totalLeads });
  };

  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  const handleDelete = async (campaignId: number) => {
    try {
      setActionLoading(campaignId);
      await api.delete(`/api/admin/campaigns/${campaignId}`);

      toast({ title: "Campaign archived", description: "The campaign remains available in the archived filter." });
      fetchCampaigns();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to archive campaign";
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setActionLoading(null);
    }
  };

  const formatCurrency = (amount?: number) => {
    if (amount == null) return "—";
    return `₹${amount.toLocaleString("en-IN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })}`;
  };

  const filteredCampaigns = campaigns.filter((campaign) => {
    const q = searchQuery.trim().toLowerCase();
    const normalizedStatus = campaign.status?.toLowerCase() || "unknown";
    const matchesStatus = statusFilter === "all"
      || (statusFilter === "current" && normalizedStatus !== "archived")
      || normalizedStatus === statusFilter;
    return matchesStatus && (
      campaign.name?.toLowerCase().includes(q) ||
      campaign.goal?.toLowerCase().includes(q) ||
      campaign.status?.toLowerCase().includes(q) ||
      campaign.userName?.toLowerCase().includes(q) ||
      campaign.userEmail?.toLowerCase().includes(q)
    );
  });

  const totalPages = Math.ceil(filteredCampaigns.length / pageSize);
  const paginatedCampaigns = filteredCampaigns.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter, pageSize]);

  const statCards = [
    {
      title: "Total Campaigns",
      value: stats.totalCampaigns.toLocaleString(),
      icon: BarChart3,
      gradient: "from-purple-500 to-purple-700",
      bgGradient: "from-purple-500/10 to-purple-700/10",
    },
    {
      title: "Active",
      value: stats.active.toLocaleString(),
      icon: TrendingUp,
      gradient: "from-green-500 to-green-700",
      bgGradient: "from-green-500/10 to-green-700/10",
    },
    {
      title: "Total Spend",
      value: formatCurrency(stats.totalSpend),
      icon: IndianRupee,
      gradient: "from-blue-500 to-blue-700",
      bgGradient: "from-blue-500/10 to-blue-700/10",
    },
    {
      title: "Total Leads",
      value: stats.totalLeads.toLocaleString(),
      icon: Users,
      gradient: "from-indigo-500 to-indigo-700",
      bgGradient: "from-indigo-500/10 to-indigo-700/10",
    },
  ];

  if (loading) {
    return (
      <LoadingState size="page" label="Loading campaigns…" />
    );
  }

  if (loadError) {
    return <PageErrorState title="Campaigns could not be loaded" description={loadError} reset={() => void fetchCampaigns()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
            <BarChart3 className="h-7 w-7 text-primary sm:h-8 sm:w-8" />
            Campaigns
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage and monitor all marketing campaigns
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/dashboard/campaigns/new">
            <Plus className="h-4 w-4 mr-2" />
            Create Campaign
          </Link>
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) => (
          <Card
            key={card.title}
            className={`relative overflow-hidden bg-gradient-to-br ${card.bgGradient} border-0`}
          >
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {card.title}
              </CardTitle>
              <div
                className={`p-2 rounded-lg bg-gradient-to-br ${card.gradient}`}
              >
                <card.icon className="h-4 w-4 text-white" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{card.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Search and filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput
          aria-label="Search campaigns or owners"
          placeholder="Search campaigns or owners..."
          value={searchQuery}
          onValueChange={setSearchQuery}
          wrapperClassName="w-full sm:max-w-md"
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-44" aria-label="Filter campaigns by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="current">Current campaigns</SelectItem>
            <SelectItem value="all">All campaigns</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="planned">Planned</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table className="min-w-[1050px]">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Goal</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Budget</TableHead>
              <TableHead>Start Date</TableHead>
              <TableHead>End Date</TableHead>
              <TableHead>Leads</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedCampaigns.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-10">
                  <p className="text-muted-foreground">No campaigns found</p>
                </TableCell>
              </TableRow>
            ) : (
              paginatedCampaigns.map((campaign) => (
                <TableRow key={campaign.id}>
                  <TableCell className="font-medium">
                    {campaign.name || "—"}
                  </TableCell>
                  <TableCell>{campaign.goal || "—"}</TableCell>
                  <TableCell>
                    <div className="min-w-40">
                      <p className="font-medium">{campaign.userName || "Unknown user"}</p>
                      <p className="text-xs text-muted-foreground">{campaign.userEmail || `User #${campaign.userId ?? "—"}`}</p>
                    </div>
                  </TableCell>
                  <TableCell><StatusBadge status={campaign.status} toneOverrides={{ finished: "success" }} /></TableCell>
                  <TableCell>{formatCurrency(campaign.budget)}</TableCell>
                  <TableCell>
                    {formatDate(campaign.startDate || campaign.start_date)}
                  </TableCell>
                  <TableCell>
                    {formatDate(campaign.endDate || campaign.end_date)}
                  </TableCell>
                  <TableCell>
                    {campaign.leadsCount ?? campaign.leads_count ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {campaign.status?.toLowerCase() === "archived" ? (
                      <span className="text-xs text-muted-foreground">Archived</span>
                    ) : <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:bg-muted hover:text-foreground"
                          loading={actionLoading === campaign.id}
                          aria-label={`Archive ${campaign.name || "campaign"}`}
                        >
                          <Archive className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Archive Campaign</AlertDialogTitle>
                          <AlertDialogDescription>
                            Archive &quot;{campaign.name}&quot;? It will be removed from current campaign views while its history remains available.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDelete(campaign.id)}
                            className="bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-black dark:hover:bg-amber-400"
                          >
                            Archive
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <Pagination
          page={currentPage}
          pageSize={pageSize}
          totalItems={filteredCampaigns.length}
          onPageChange={setCurrentPage}
          onPageSizeChange={(size) => { setPageSize(size); setCurrentPage(1); }}
          pageSizeOptions={[10, 20, 50, 100]}
          itemLabel="campaigns"
        />
      )}

      {totalPages <= 1 && (
        <div className="text-sm text-muted-foreground">
          Showing {filteredCampaigns.length} of {campaigns.length} campaigns
        </div>
      )}
    </div>
  );
}
