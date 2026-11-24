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
  MessageSquare,
  MessageCircle,
  X,
} from "lucide-react";
import { formatDateTimeWithYear as formatDate } from "@/lib/display-format";
import { type AdminPhoneOutreachMessage as SmsMessage } from "../message-types";

interface SmsStats {
  totalSent: number;
  delivered: number;
  replied: number;
}

/** A reply is the outcome outreach is after. */
const OUTREACH_STATUS_TONES: Record<string, StatusTone> = { replied: "success" };

export default function SmsOutreachPage() {
  const [stats, setStats] = useState<SmsStats>({
    totalSent: 0,
    delivered: 0,
    replied: 0,
  });
  const [messages, setMessages] = useState<SmsMessage[]>([]);
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
        `/api/admin/outreach/sms${query}`
      );

      setStats(
        (data.stats as SmsStats) || { totalSent: 0, delivered: 0, replied: 0 }
      );
      setMessages(
        Array.isArray(data.messages)
          ? data.messages
          : Array.isArray(data.data)
            ? (data.data as SmsMessage[])
            : Array.isArray(data)
              ? (data as unknown as SmsMessage[])
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
    return <LoadingState size="page" label="Loading SMS outreach…" />;
  }

  if (loadError) {
    return <PageErrorState title="SMS outreach could not be loaded" description={loadError} reset={() => void fetchData()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black tracking-tighter flex items-center gap-2">
          <MessageCircle className="h-8 w-8 text-green-600" />
          SMS Outreach
        </h1>
        <p className="text-muted-foreground mt-1">
          Monitor SMS outreach performance across all users
        </p>
      </div>

      {/* Stats Cards */}
      <StatGrid columns={3} className="sm:grid-cols-3">
        <StatCard
          className="border-green-200 dark:border-green-900/50"
          label="Total Sent"
          icon={<Send className="text-green-600" />}
          value={stats.totalSent.toLocaleString()}
        />
        <StatCard
          className="border-green-200 dark:border-green-900/50"
          label="Delivered"
          icon={<CheckCircle className="text-emerald-600" />}
          value={stats.delivered.toLocaleString()}
          description={`${rate(stats.delivered)}% rate`}
        />
        <StatCard
          className="border-green-200 dark:border-green-900/50"
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
          placeholder="Search by user, phone number..."
          value={search}
          onValueChange={setSearch}
          // SearchInput swallows Enter, so submit the filters here like the form did.
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              applyFilters();
            }
          }}
          aria-label="Search SMS outreach by user or phone number"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={loading}
          className="border-green-200 hover:bg-green-50 hover:text-green-700 dark:border-green-800 dark:hover:bg-green-950"
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
              <TableHead>Recipient (Phone)</TableHead>
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
                    No SMS conversations found
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              messages.map((msg) => (
                <TableRow key={msg.id}>
                  <TableCell className="font-medium">
                    {msg.userName || msg.user_name || "—"}
                  </TableCell>
                  <TableCell>
                    {msg.recipientPhone || msg.recipient_phone || "—"}
                  </TableCell>
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
