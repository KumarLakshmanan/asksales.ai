"use client";

import React, { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { PageErrorState } from "@/components/ui/page-state";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { StatCard, StatGrid } from "@/components/ui/stat-card";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Search,
  Send,
  CheckCircle,
  Eye,
  MessageSquare,
  Instagram,
  X,
} from "lucide-react";
import { formatDateTimeWithYear as formatDate } from "@/lib/display-format";

interface InstagramStats {
  totalSent: number;
  delivered: number;
  viewed: number;
  replied: number;
}

interface InstagramMessage {
  id: number;
  userName?: string;
  user_name?: string;
  recipient?: string;
  contentPreview?: string;
  content_preview?: string;
  status?: string;
  sentAt?: string;
  sent_at?: string;
}

/** Delivery steps read as progress here, not as final outcomes. */
const OUTREACH_STATUS_TONES: Record<string, StatusTone> = {
  sent: "info",
  viewed: "info",
  replied: "success",
};

export default function InstagramOutreachPage() {
  const [stats, setStats] = useState<InstagramStats>({
    totalSent: 0,
    delivered: 0,
    viewed: 0,
    replied: 0,
  });
  const [messages, setMessages] = useState<InstagramMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const params = new URLSearchParams();
      if (appliedSearch) params.append("search", appliedSearch);
      const query = params.toString() ? `?${params.toString()}` : "";

      const data = await api.get<Record<string, unknown>>(
        `/api/admin/outreach/instagram${query}`
      );

      setStats(
        (data.stats as InstagramStats) || { totalSent: 0, delivered: 0, viewed: 0, replied: 0 }
      );
      setMessages(
        Array.isArray(data.messages)
          ? data.messages
          : Array.isArray(data.data)
            ? (data.data as InstagramMessage[])
            : Array.isArray(data)
              ? (data as unknown as InstagramMessage[])
              : []
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load data";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const applyFilters = () => {
    const nextSearch = search.trim();
    if (nextSearch === appliedSearch) {
      void fetchData();
      return;
    }
    setAppliedSearch(nextSearch);
  };
  const clearFilters = () => {
    setSearch("");
    setAppliedSearch("");
    if (!appliedSearch) void fetchData();
  };

  const rate = (count: number) =>
    stats.totalSent ? ((count / stats.totalSent) * 100).toFixed(1) : 0;

  if (loading) {
    return <LoadingState size="page" label="Loading Instagram outreach…" />;
  }

  if (loadError) {
    return <PageErrorState title="Instagram outreach could not be loaded" description={loadError} reset={() => void fetchData()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black tracking-tighter flex items-center gap-2">
          <Instagram className="h-8 w-8 text-pink-600" />
          Instagram Outreach
        </h1>
        <p className="text-muted-foreground mt-1">
          Monitor Instagram DM outreach across all users
        </p>
      </div>

      {/* Stats Cards */}
      <StatGrid columns={4}>
        <StatCard
          className="border-pink-200 dark:border-pink-900/50"
          label="Total Sent"
          icon={<Send className="text-pink-600" />}
          value={stats.totalSent.toLocaleString()}
        />
        <StatCard
          className="border-pink-200 dark:border-pink-900/50"
          label="Delivered"
          icon={<CheckCircle className="text-green-600" />}
          value={stats.delivered.toLocaleString()}
          description={`${rate(stats.delivered)}% rate`}
        />
        <StatCard
          className="border-pink-200 dark:border-pink-900/50"
          label="Viewed"
          icon={<Eye className="text-purple-600" />}
          value={stats.viewed.toLocaleString()}
          description={`${rate(stats.viewed)}% rate`}
        />
        <StatCard
          className="border-pink-200 dark:border-pink-900/50"
          label="Replied"
          icon={<MessageSquare className="text-amber-600" />}
          value={stats.replied.toLocaleString()}
          description={`${rate(stats.replied)}% rate`}
        />
      </StatGrid>

      {/* Filters */}
      <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
        <SearchInput
          wrapperClassName="flex-1 max-w-sm"
          placeholder="Search by user, recipient..."
          value={search}
          onValueChange={setSearch}
          // SearchInput swallows Enter, so submit the filters here like the form did.
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              applyFilters();
            }
          }}
          aria-label="Search Instagram outreach by user or recipient"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={loading}
          className="border-pink-200 hover:bg-pink-50 hover:text-pink-700 dark:border-pink-800 dark:hover:bg-pink-950"
        >
          <Search className="h-4 w-4 mr-2" />
          Search
        </Button>
        {(search || appliedSearch) && (
          <Button type="button" variant="ghost" onClick={clearFilters} disabled={loading}>
            <X className="h-4 w-4 mr-2" />Clear filters
          </Button>
        )}
        <span className="text-xs text-muted-foreground sm:ml-auto">Filters apply when you search.</span>
      </form>

      {/* Conversations Table */}
      <div className="overflow-x-auto rounded-md border">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Recipient</TableHead>
              <TableHead>Content Preview</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Sent Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {messages.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8">
                  <p className="text-muted-foreground">
                    No Instagram conversations found
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              messages.map((msg) => (
                <TableRow key={msg.id}>
                  <TableCell className="font-medium">
                    {msg.userName || msg.user_name || "—"}
                  </TableCell>
                  <TableCell>{msg.recipient || "—"}</TableCell>
                  <TableCell className="max-w-[200px] truncate">
                    {msg.contentPreview || msg.content_preview || "—"}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={msg.status} toneOverrides={OUTREACH_STATUS_TONES} />
                  </TableCell>
                  <TableCell>
                    {formatDate(msg.sentAt || msg.sent_at)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="text-sm text-muted-foreground">
        {messages.length} conversation{messages.length !== 1 ? "s" : ""}
      </div>
    </div>
  );
}
