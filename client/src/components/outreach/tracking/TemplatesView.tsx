"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useTrackingQuery } from "@/hooks/use-outreach-tracking";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { DateRangeField, presetDateRange } from "@/components/ui/date-range-field";
import { PageEmptyState } from "@/components/EmptyState";
import { MAX_DAILY_RANGE_DAYS, type TemplatePerformance, type TemplatePerformanceReport } from "../../../../../shared/outreachTracking";
import { viewerTimezone } from "./DayByDayCard";
import { chartPaletteClass } from "./chartPalette";
import { TemplatesChart } from "./TemplatesChart";
import { formatCount, formatDateTime, formatShare } from "./status";

const withShare = (part: number, whole: number) => (
  <>{formatCount(part)}<span className="ml-1.5 text-xs text-muted-foreground">{formatShare(part, whole)}</span></>
);

/** Every template used in the dates chosen, with how its messages did. */
export function TemplatesView({ onShowOutreaches }: { onShowOutreaches: (templateName: string) => void }) {
  const [range, setRange] = useState(() => presetDateRange("last30"));
  const [timezone] = useState(viewerTimezone);
  const params = useMemo(() => ({ from: range.from, to: range.to, tz: timezone }), [range, timezone]);
  const report = useTrackingQuery<TemplatePerformanceReport>("/api/outreach/templates/performance", params);

  const columns = useMemo<DataTableColumn<TemplatePerformance>[]>(() => [
    {
      id: "template", header: "Template", sortValue: row => row.templateName,
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
    { id: "sent", header: "Sent", align: "right", sortValue: row => row.sent, cell: row => formatCount(row.sent) },
    { id: "delivered", header: "Delivered", align: "right", sortValue: row => row.delivered, cell: row => withShare(row.delivered, row.sent) },
    { id: "read", header: "Read", align: "right", hideBelow: "sm", sortValue: row => row.read, cell: row => withShare(row.read, row.delivered) },
    { id: "failed", header: "Failed", align: "right", hideBelow: "sm", sortValue: row => row.failed, cell: row => formatCount(row.failed) },
    { id: "last", header: "Last used", hideBelow: "lg", className: "whitespace-nowrap", sortValue: row => row.lastSentAt, cell: row => formatDateTime(row.lastSentAt) || "—" },
  ], [onShowOutreaches]);

  return (
    <Card className={chartPaletteClass}>
      <CardHeader>
        <CardTitle>Messages by template</CardTitle>
        <CardDescription>How each template did for the messages sent with it in the dates you choose.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <DateRangeField value={range} onChange={setRange} maxDays={MAX_DAILY_RANGE_DAYS} aria-label="Dates for messages by template"
          hint={`Both dates are included. Days follow ${timezone.replace(/_/g, " ")} time.`} />
        {report.data ? (
          <div className={report.loading ? "opacity-70 transition-opacity" : "transition-opacity"}>
            <TemplatesChart templates={report.data.templates} onSelect={onShowOutreaches} />
          </div>
        ) : null}
        <DataTable
          caption="Templates used in these dates"
          columns={columns}
          data={report.data?.templates}
          getRowId={row => `${row.templateName}:${row.templateLanguage ?? ""}`}
          loading={report.loading}
          error={report.error ? "We couldn't load the template numbers." : undefined}
          onRetry={report.refetch}
          emptyState={<PageEmptyState compact title="No template messages were sent in these dates" description="Choose different dates, or send an outreach with a template." />}
        />
        <p className="text-xs text-muted-foreground">
          Delivered is a share of sent, and read is a share of delivered. Failed counts messages that failed in these dates.{" "}
          <Link href="/dashboard/integrations/whatsapp/templates" className="font-medium text-foreground underline underline-offset-2">Manage templates</Link>
        </p>
      </CardContent>
    </Card>
  );
}
