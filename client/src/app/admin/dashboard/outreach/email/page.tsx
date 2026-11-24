"use client";

import React, { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Mail,
  Search,
  Send,
  CheckCircle,
  Eye,
  MessageSquare,
  X,
} from "lucide-react";
import { formatDateTimeWithYear as formatDate } from "@/lib/display-format";

interface EmailStats {
  totalSent: number;
  delivered: number;
  opened: number;
  replied: number;
  deliveryRate: number;
  openRate: number;
  replyRate: number;
}

interface EmailMessage {
  id: number;
  userName?: string;
  user_name?: string;
  recipientEmail?: string;
  recipient_email?: string;
  subject?: string;
  status?: string;
  sentAt?: string;
  sent_at?: string;
}

/** Delivery steps read as progress here, not as final outcomes. */
const OUTREACH_STATUS_TONES: Record<string, StatusTone> = {
  sent: "info",
  opened: "info",
  replied: "success",
};

export default function EmailOutreachPage() {
  const [stats, setStats] = useState<EmailStats>({
    totalSent: 0,
    delivered: 0,
    opened: 0,
    replied: 0,
    deliveryRate: 0,
    openRate: 0,
    replyRate: 0,
  });
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [appliedDateFilter, setAppliedDateFilter] = useState("");
  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const params = new URLSearchParams();
      if (appliedSearch) params.append("search", appliedSearch);
      if (appliedDateFilter) params.append("date", appliedDateFilter);
      const query = params.toString() ? `?${params.toString()}` : "";

      const data = await api.get<Record<string, unknown>>(
        `/api/admin/outreach/email${query}`
      );

      setStats(
        (data.stats as EmailStats) || {
          totalSent: 0,
          delivered: 0,
          opened: 0,
          replied: 0,
          deliveryRate: 0,
          openRate: 0,
          replyRate: 0,
        }
      );
      setMessages(
        Array.isArray(data.messages)
          ? data.messages
          : Array.isArray(data.data)
            ? (data.data as EmailMessage[])
            : Array.isArray(data)
              ? (data as unknown as EmailMessage[])
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
  }, [appliedSearch, appliedDateFilter, toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const applyFilters = () => {
    const nextSearch = search.trim();
    if (nextSearch === appliedSearch && dateFilter === appliedDateFilter) {
      void fetchData();
      return;
    }
    setAppliedSearch(nextSearch);
    setAppliedDateFilter(dateFilter);
  };

  const clearFilters = () => {
    setSearch("");
    setDateFilter("");
    setAppliedSearch("");
    setAppliedDateFilter("");
    if (!appliedSearch && !appliedDateFilter) void fetchData();
  };

  if (loading) {
    return <LoadingState size="page" label="Loading email outreach…" />;
  }

  if (loadError) {
    return <PageErrorState title="Email outreach could not be loaded" description={loadError} reset={() => void fetchData()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black tracking-tighter flex items-center gap-2">
          <Mail className="h-8 w-8 text-blue-600" />
          Email Outreach
        </h1>
        <p className="text-muted-foreground mt-1">
          Monitor email outreach performance across all users
        </p>
      </div>

      {/* Stats Cards */}
      <StatGrid columns={4}>
        <StatCard label="Total Sent" icon={<Send className="text-blue-600" />} value={stats.totalSent.toLocaleString()} />
        <StatCard
          label="Delivered"
          icon={<CheckCircle className="text-green-600" />}
          value={stats.delivered.toLocaleString()}
          description={`${stats.deliveryRate.toFixed(1)}% rate`}
        />
        <StatCard
          label="Opened"
          icon={<Eye className="text-purple-600" />}
          value={stats.opened.toLocaleString()}
          description={`${stats.openRate.toFixed(1)}% rate`}
        />
        <StatCard
          label="Replied"
          icon={<MessageSquare className="text-amber-600" />}
          value={stats.replied.toLocaleString()}
          description={`${stats.replyRate.toFixed(1)}% rate`}
        />
      </StatGrid>

      {/* Filters */}
      <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
        <SearchInput
          wrapperClassName="flex-1 max-w-sm"
          placeholder="Search by user, recipient, subject..."
          value={search}
          onValueChange={setSearch}
          // SearchInput swallows Enter, so submit the filters here like the form did.
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              applyFilters();
            }
          }}
          aria-label="Search email outreach by user, recipient, or subject"
        />
        <Input
          type="date"
          className="w-full sm:w-auto"
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value)}
          aria-label="Filter email outreach by sent date"
        />
        <Button type="submit" variant="outline" disabled={loading}>
          <Search className="h-4 w-4 mr-2" />
          Search
        </Button>
        {(search || dateFilter || appliedSearch || appliedDateFilter) && (
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
              <TableHead>Subject</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Sent Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {messages.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8">
                  <p className="text-muted-foreground">
                    No email conversations found
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
                    {msg.recipientEmail || msg.recipient_email || "—"}
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate">
                    {msg.subject || "—"}
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
