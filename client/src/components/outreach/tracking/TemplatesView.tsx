"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useTrackingQuery } from "@/hooks/use-outreach-tracking";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { DateRangeField, presetDateRange } from "@/components/ui/date-range-field";
import { SearchInput } from "@/components/ui/search-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageEmptyState } from "@/components/EmptyState";
import { outreachReportChannels } from "../../../../../shared/campaignReporting";
import { MAX_DAILY_RANGE_DAYS, trackingChannelLabel, type TemplatePerformance, type TemplatePerformanceReport } from "../../../../../shared/outreachTracking";
import { viewerTimezone } from "./DayByDayCard";
import { chartPaletteClass } from "./chartPalette";
import { TemplatesChart } from "./TemplatesChart";
import { RefreshStatus, TrackingTotalsGrid } from "./TrackingSummary";
import { formatCount, formatDateTime, formatShare } from "./status";

const withShare = (part: number, whole: number) => (
  <span className="inline-flex flex-col items-end leading-tight">
    <span className="tabular-nums">{formatCount(part)}</span>
    <span className="text-xs tabular-nums text-muted-foreground">{formatShare(part, whole)}</span>
  </span>
);

/** Every template used in the dates chosen, with how its messages did. */
export function TemplatesView({ onShowOutreaches }: { onShowOutreaches: (templateName: string) => void }) {
  const [range, setRange] = useState(() => presetDateRange("last30"));
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("all");
  const [timezone] = useState(viewerTimezone);
  const params = useMemo(() => ({
    from: range.from, to: range.to, tz: timezone, q: search || undefined, channel: channel === "all" ? undefined : channel,
  }), [range, timezone, search, channel]);
  // Receipts keep arriving after a message is sent, so the numbers are read again every minute while the tab is open.
  const report = useTrackingQuery<TemplatePerformanceReport>("/api/outreach/templates/performance", params, 60_000);
  const templates = report.data?.templates;

  const totals = useMemo(() => templates?.reduce((sum, row) => ({
    sent: sum.sent + row.sent, delivered: sum.delivered + row.delivered, read: sum.read + row.read, failed: sum.failed + row.failed,
  }), { sent: 0, delivered: 0, read: 0, failed: 0 }), [templates]);

  const columns = useMemo<DataTableColumn<TemplatePerformance>[]>(() => [
    {
      id: "template", header: "Template", className: "min-w-[12rem]", sortValue: row => row.templateName,
      cell: row => (
        <div className="min-w-0">
          <button type="button" onClick={() => onShowOutreaches(row.templateName)}
            className="break-all text-left font-medium underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
            aria-label={`Show outreaches that used ${row.templateName}`}>
            {row.templateName}
          </button>
          <p className="text-xs text-muted-foreground">
            {row.templateLanguage || "Language not recorded"}
            <span className="md:hidden"> · {formatCount(row.outreaches)} {row.outreaches === 1 ? "outreach" : "outreaches"}</span>
          </p>
        </div>
      ),
    },
    { id: "outreaches", header: "Outreaches", align: "right", hideBelow: "md", sortValue: row => row.outreaches, cell: row => formatCount(row.outreaches) },
    { id: "sent", header: "Sent", align: "right", sortValue: row => row.sent, cell: row => <span className="tabular-nums">{formatCount(row.sent)}</span> },
    { id: "delivered", header: "Delivered", align: "right", sortValue: row => row.delivered, cell: row => withShare(row.delivered, row.sent) },
    { id: "read", header: "Read", align: "right", hideBelow: "sm", sortValue: row => row.read, cell: row => withShare(row.read, row.delivered) },
    {
      id: "failed", header: "Failed", align: "right", hideBelow: "sm", sortValue: row => row.failed,
      cell: row => row.failed > 0 ? <span className="font-medium tabular-nums text-destructive">{formatCount(row.failed)}</span> : <span className="tabular-nums">0</span>,
    },
    { id: "last", header: "Last sent", hideBelow: "lg", className: "whitespace-nowrap", sortValue: row => row.lastSentAt, cell: row => formatDateTime(row.lastSentAt) || "—" },
  ], [onShowOutreaches]);

  const filtered = Boolean(search) || channel !== "all";

  return (
    <div className={`space-y-5 ${chartPaletteClass}`}>
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
          <SearchInput aria-label="Search template names" placeholder="Search template names"
            onSearch={setSearch} loading={report.loading && Boolean(search)} wrapperClassName="sm:w-64" />
          <DateRangeField value={range} onChange={setRange} maxDays={MAX_DAILY_RANGE_DAYS} aria-label="Dates for messages by template"
            hint={`Both dates are included. Days follow ${timezone.replace(/_/g, " ")} time.`} />
          <Select value={channel} onValueChange={setChannel}>
            <SelectTrigger className="sm:w-40" aria-label="Channel"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              {outreachReportChannels.map(option => <SelectItem key={option} value={option}>{trackingChannelLabel(option)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <RefreshStatus updatedAt={report.updatedAt} loading={report.loading} live={false} onRefresh={report.refetch} />
      </div>

      {report.error && !report.data ? null : <TrackingTotalsGrid totals={totals} loading={report.loading} />}

      <Card>
        <CardHeader>
          <CardTitle>Messages by template</CardTitle>
          <CardDescription>How each template did for the messages sent with it in the dates you choose. Select a template to see its outreaches.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {templates ? (
            <div className={report.loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
              <TemplatesChart templates={templates} onSelect={onShowOutreaches} />
            </div>
          ) : report.loading ? (
            <div className="space-y-3" aria-hidden="true">
              <Skeleton className="h-3 w-48" />
              {[0, 1, 2].map(index => <Skeleton key={index} className="h-6" style={{ width: `${80 - index * 20}%` }} />)}
            </div>
          ) : null}
          <DataTable
            caption="Templates used in these dates"
            columns={columns}
            data={templates}
            getRowId={row => `${row.templateName}:${row.templateLanguage ?? ""}`}
            loading={report.loading}
            skeletonRows={4}
            error={report.error ? `We couldn't load the template numbers. ${report.error}` : undefined}
            onRetry={report.refetch}
            emptyState={filtered
              ? <PageEmptyState compact title="No template matches these filters" description="Try a different name or channel, or wider dates." />
              : <PageEmptyState compact title="No template messages were sent in these dates" description="Choose different dates, or send an outreach with a template." />}
          />
          <p className="text-xs text-muted-foreground">
            Sent counts messages the provider accepted in these dates. Delivered is a share of sent, and read is a share of delivered.
            Failed counts messages that failed in these dates.{" "}
            <Link href="/dashboard/integrations/whatsapp/templates" className="font-medium text-foreground underline underline-offset-2">Manage templates</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
